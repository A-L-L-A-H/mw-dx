import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { DEFAULT_BASE_URLS, type JsonObject, RocksoulDesktopBridge } from "./rocksoul-bridge";

export type SessionRole = "system" | "user" | "assistant" | "tool";
export type RemoteSessionStatus = "idle" | "running" | "completed" | "error" | "aborted";
export type SyncStatus = "synced" | "pending" | "conflict" | "offline";
export type SessionSyncErrorReason =
  | "unreachable"
  | "http"
  | "invalid-response"
  | "not-found"
  | "conflict"
  | "validation";

export interface SessionTurnRecord {
  id: string;
  sessionId: string;
  seq: number;
  role: SessionRole;
  content: string;
  toolCallId?: string;
  toolName?: string;
  meta?: JsonObject;
  createdAt: string;
}

export interface PendingSessionTurn {
  clientTurnId: string;
  role: SessionRole;
  content: string;
  toolCallId?: string;
  toolName?: string;
  meta?: JsonObject;
  createdAt: string;
}

export interface RemoteSessionRecord {
  id: string;
  title: string;
  mode: string;
  workDir?: string;
  project?: string;
  agentProfile?: string;
  model?: string;
  status?: RemoteSessionStatus;
  totalTokensIn?: number;
  totalTokensOut?: number;
  rtkTokensSaved?: number;
  createdAt?: string;
  updatedAt?: string;
  parentSessionId?: string;
}

export interface LocalSessionSnapshot {
  id: string;
  title: string;
  mode: string;
  workDir?: string;
  project?: string;
  model?: string;
  status: RemoteSessionStatus;
  turns: SessionTurnRecord[];
  pendingTurns: PendingSessionTurn[];
  lastSyncedSeq: number;
  updatedAt: string;
  syncStatus: SyncStatus;
}

export interface CreateRemoteSessionInput {
  title?: string;
  workDir?: string;
  project?: string;
  agentProfile?: string;
  model?: string;
  mode?: string;
}

export interface QueueTurnInput {
  clientTurnId?: string;
  role: SessionRole;
  content: string;
  toolCallId?: string;
  toolName?: string;
  meta?: JsonObject;
  createdAt?: string;
}

export interface SessionSyncConfig {
  coreUrl?: string;
  ridUrl?: string;
  bearerToken?: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
  snapshotFilePath?: string;
  bridge?: RocksoulDesktopBridge;
}

export interface SessionSyncResult {
  session: LocalSessionSnapshot;
  pulledCount: number;
  pushedCount: number;
  syncedAt: string;
}

export interface SyncAllPendingResult {
  synced: string[];
  failed: Array<{ sessionId: string; error: string }>;
}

export class SessionSyncError extends Error {
  constructor(
    readonly path: string,
    readonly reason: SessionSyncErrorReason,
    readonly status?: number,
    readonly sessionId?: string,
    message?: string,
  ) {
    super(
      message ??
        `session sync ${path} failed: ${reason}${status === undefined ? "" : ` (${status})`}${
          sessionId === undefined ? "" : ` [session=${sessionId}]`
        }`,
    );
    this.name = "SessionSyncError";
  }
}

const VALID_ROLES = new Set<SessionRole>(["system", "user", "assistant", "tool"]);
const VALID_STATUSES = new Set<RemoteSessionStatus>(["idle", "running", "completed", "error", "aborted"]);
const VALID_SYNC_STATUSES = new Set<SyncStatus>(["synced", "pending", "conflict", "offline"]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isValidRole(value: unknown): value is SessionRole {
  return typeof value === "string" && VALID_ROLES.has(value as SessionRole);
}

function isValidStatus(value: unknown): value is RemoteSessionStatus {
  return typeof value === "string" && VALID_STATUSES.has(value as RemoteSessionStatus);
}

function isValidSyncStatus(value: unknown): value is SyncStatus {
  return typeof value === "string" && VALID_SYNC_STATUSES.has(value as SyncStatus);
}

function parseRemoteSessionRecord(
  raw: unknown,
  path: string,
  status?: number,
  sessionId?: string,
): RemoteSessionRecord {
  if (!isRecord(raw)) {
    throw new SessionSyncError(path, "invalid-response", status, sessionId, "Expected session object.");
  }
  if (
    typeof raw.id !== "string" ||
    raw.id.trim().length === 0 ||
    typeof raw.title !== "string" ||
    typeof raw.mode !== "string"
  ) {
    throw new SessionSyncError(
      path,
      "invalid-response",
      status,
      sessionId,
      "Session record requires non-empty id, title, and mode.",
    );
  }
  if (raw.status !== undefined && !isValidStatus(raw.status)) {
    throw new SessionSyncError(path, "invalid-response", status, sessionId, "Invalid remote session status.");
  }

  return {
    id: raw.id,
    title: raw.title,
    mode: raw.mode,
    ...(typeof raw.workDir === "string" ? { workDir: raw.workDir } : {}),
    ...(typeof raw.project === "string" ? { project: raw.project } : {}),
    ...(typeof raw.agentProfile === "string" ? { agentProfile: raw.agentProfile } : {}),
    ...(typeof raw.model === "string" ? { model: raw.model } : {}),
    ...(raw.status !== undefined ? { status: raw.status } : {}),
    ...(typeof raw.totalTokensIn === "number" ? { totalTokensIn: raw.totalTokensIn } : {}),
    ...(typeof raw.totalTokensOut === "number" ? { totalTokensOut: raw.totalTokensOut } : {}),
    ...(typeof raw.rtkTokensSaved === "number" ? { rtkTokensSaved: raw.rtkTokensSaved } : {}),
    ...(typeof raw.createdAt === "string" ? { createdAt: raw.createdAt } : {}),
    ...(typeof raw.updatedAt === "string" ? { updatedAt: raw.updatedAt } : {}),
    ...(typeof raw.parentSessionId === "string" ? { parentSessionId: raw.parentSessionId } : {}),
  };
}

function parseSessionTurnRecord(
  raw: unknown,
  path: string,
  status?: number,
  sessionId?: string,
): SessionTurnRecord {
  if (!isRecord(raw)) {
    throw new SessionSyncError(path, "invalid-response", status, sessionId, "Expected turn object.");
  }
  if (
    typeof raw.id !== "string" ||
    raw.id.trim().length === 0 ||
    typeof raw.sessionId !== "string" ||
    typeof raw.seq !== "number" ||
    !Number.isInteger(raw.seq) ||
    raw.seq < 0 ||
    !isValidRole(raw.role) ||
    typeof raw.content !== "string" ||
    typeof raw.createdAt !== "string"
  ) {
    throw new SessionSyncError(path, "invalid-response", status, sessionId, "Malformed session turn payload.");
  }

  return {
    id: raw.id,
    sessionId: raw.sessionId,
    seq: raw.seq,
    role: raw.role,
    content: raw.content,
    ...(typeof raw.toolCallId === "string" ? { toolCallId: raw.toolCallId } : {}),
    ...(typeof raw.toolName === "string" ? { toolName: raw.toolName } : {}),
    ...(isRecord(raw.meta) ? { meta: raw.meta as JsonObject } : {}),
    createdAt: raw.createdAt,
  };
}

function parsePendingTurnRecord(raw: unknown, path: string): PendingSessionTurn {
  if (!isRecord(raw)) {
    throw new SessionSyncError(path, "invalid-response", undefined, undefined, "Expected pending turn object.");
  }
  if (
    typeof raw.clientTurnId !== "string" ||
    raw.clientTurnId.trim().length === 0 ||
    !isValidRole(raw.role) ||
    typeof raw.content !== "string" ||
    typeof raw.createdAt !== "string"
  ) {
    throw new SessionSyncError(path, "invalid-response", undefined, undefined, "Malformed pending turn snapshot.");
  }

  return {
    clientTurnId: raw.clientTurnId,
    role: raw.role,
    content: raw.content,
    ...(typeof raw.toolCallId === "string" ? { toolCallId: raw.toolCallId } : {}),
    ...(typeof raw.toolName === "string" ? { toolName: raw.toolName } : {}),
    ...(isRecord(raw.meta) ? { meta: raw.meta as JsonObject } : {}),
    createdAt: raw.createdAt,
  };
}

function cloneSnapshot(snapshot: LocalSessionSnapshot): LocalSessionSnapshot {
  return {
    ...snapshot,
    turns: snapshot.turns.map((turn) => ({ ...turn, ...(turn.meta ? { meta: { ...turn.meta } } : {}) })),
    pendingTurns: snapshot.pendingTurns.map((turn) => ({
      ...turn,
      ...(turn.meta ? { meta: { ...turn.meta } } : {}),
    })),
  };
}

function requireSessionId(sessionId: string, path: string): string {
  const trimmed = sessionId.trim();
  if (trimmed.length === 0) {
    throw new SessionSyncError(path, "validation", undefined, sessionId, "sessionId must be a non-empty string.");
  }
  return trimmed;
}

export class SessionSyncManager {
  private readonly coreUrl: string;
  private readonly ridUrl: string;
  private readonly bearerToken?: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;
  private readonly snapshotFilePath?: string;
  private readonly bridge?: RocksoulDesktopBridge;
  private readonly sessions = new Map<string, LocalSessionSnapshot>();

  constructor(config: SessionSyncConfig = {}) {
    this.coreUrl = (config.coreUrl ?? DEFAULT_BASE_URLS.core).replace(/\/+$/, "");
    this.ridUrl = (config.ridUrl ?? DEFAULT_BASE_URLS.rid).replace(/\/+$/, "");
    this.bearerToken = config.bearerToken?.trim() || undefined;
    this.timeoutMs = config.timeoutMs ?? 5000;
    this.fetchImpl = config.fetchImpl ?? fetch;
    this.snapshotFilePath = config.snapshotFilePath;
    this.bridge = config.bridge;
  }

  private async request(
    path: string,
    method: "GET" | "POST",
    body?: unknown,
    sessionId?: string,
  ): Promise<Record<string, unknown>> {
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (this.bearerToken) {
      headers.authorization = `Bearer ${this.bearerToken}`;
    }

    let response: Response;
    try {
      response = await this.fetchImpl(`${this.coreUrl}${path}`, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (caught) {
      const detail = caught instanceof Error ? caught.message : "network error";
      throw new SessionSyncError(path, "unreachable", undefined, sessionId, `Core daemon unreachable: ${detail}`);
    }

    if (response.status === 404) {
      throw new SessionSyncError(path, "not-found", 404, sessionId);
    }
    if (!response.ok) {
      throw new SessionSyncError(path, "http", response.status, sessionId);
    }

    let parsed: unknown;
    try {
      parsed = await response.json();
    } catch {
      throw new SessionSyncError(path, "invalid-response", response.status, sessionId, "Response is not valid JSON.");
    }
    if (!isRecord(parsed)) {
      throw new SessionSyncError(path, "invalid-response", response.status, sessionId, "Response JSON must be an object.");
    }
    return parsed;
  }

  async checkCoreHealth(): Promise<boolean> {
    if (this.bridge) {
      const snapshot = await this.bridge.getFleetSnapshot();
      const core = snapshot.daemons.find((d) => d.daemon === "core");
      if (core) return core.ok;
    }
    try {
      const raw = await this.request("/health", "GET");
      return raw.status === "ok" || raw.ok === true;
    } catch {
      return false;
    }
  }

  async listRemoteSessions(limit = 100): Promise<RemoteSessionRecord[]> {
    const path = `/v1/sessions?limit=${encodeURIComponent(String(limit))}`;
    if (!Number.isInteger(limit) || limit <= 0) {
      throw new SessionSyncError(path, "validation", undefined, undefined, "limit must be a positive integer.");
    }

    const raw = await this.request(path, "GET");
    if (!Array.isArray(raw.sessions)) {
      throw new SessionSyncError(path, "invalid-response", 200, undefined, "Expected sessions array.");
    }
    return raw.sessions.map((entry) => parseRemoteSessionRecord(entry, path, 200));
  }

  async createRemoteSession(input: CreateRemoteSessionInput = {}): Promise<LocalSessionSnapshot> {
    const path = "/v1/sessions";
    const raw = await this.request(path, "POST", input);
    const candidate = isRecord(raw.session) ? raw.session : raw;
    const remote = parseRemoteSessionRecord(candidate, path, 201);

    const now = new Date().toISOString();
    const snapshot: LocalSessionSnapshot = {
      id: remote.id,
      title: remote.title,
      mode: remote.mode,
      ...(remote.workDir !== undefined ? { workDir: remote.workDir } : {}),
      ...(remote.project !== undefined ? { project: remote.project } : {}),
      ...(remote.model !== undefined ? { model: remote.model } : {}),
      status: remote.status ?? "idle",
      turns: [],
      pendingTurns: [],
      lastSyncedSeq: 0,
      updatedAt: remote.updatedAt ?? now,
      syncStatus: "synced",
    };

    this.sessions.set(snapshot.id, snapshot);
    return cloneSnapshot(snapshot);
  }

  getLocalSession(sessionId: string): LocalSessionSnapshot | undefined {
    const snapshot = this.sessions.get(sessionId);
    return snapshot ? cloneSnapshot(snapshot) : undefined;
  }

  listLocalSessions(): LocalSessionSnapshot[] {
    return Array.from(this.sessions.values(), cloneSnapshot);
  }

  queueTurn(sessionId: string, turn: QueueTurnInput): LocalSessionSnapshot {
    const path = `/v1/sessions/${encodeURIComponent(sessionId)}`;
    const validId = requireSessionId(sessionId, path);
    const local = this.sessions.get(validId);
    if (!local) {
      throw new SessionSyncError(path, "not-found", undefined, validId, `Local session '${validId}' does not exist.`);
    }
    if (!isValidRole(turn.role)) {
      throw new SessionSyncError(path, "validation", undefined, validId, "Turn role must be system, user, assistant, or tool.");
    }
    if (typeof turn.content !== "string" || turn.content.length === 0) {
      throw new SessionSyncError(path, "validation", undefined, validId, "Turn content must be a non-empty string.");
    }

    const now = new Date().toISOString();
    const pending: PendingSessionTurn = {
      clientTurnId: turn.clientTurnId?.trim() || crypto.randomUUID(),
      role: turn.role,
      content: turn.content,
      ...(turn.toolCallId !== undefined ? { toolCallId: turn.toolCallId } : {}),
      ...(turn.toolName !== undefined ? { toolName: turn.toolName } : {}),
      ...(turn.meta !== undefined ? { meta: { ...turn.meta } } : {}),
      createdAt: turn.createdAt ?? now,
    };

    local.pendingTurns.push(pending);
    local.updatedAt = now;
    if (local.syncStatus !== "conflict") {
      local.syncStatus = "pending";
    }
    return cloneSnapshot(local);
  }

  async pullSession(sessionId: string): Promise<{ snapshot: LocalSessionSnapshot; pulledCount: number }> {
    const validId = requireSessionId(sessionId, "/v1/sessions/:id");
    const path = `/v1/sessions/${encodeURIComponent(validId)}`;
    const raw = await this.request(path, "GET", undefined, validId);

    const remoteSession = parseRemoteSessionRecord(raw.session, path, 200, validId);
    if (!Array.isArray(raw.turns)) {
      throw new SessionSyncError(path, "invalid-response", 200, validId, "Expected turns array in session payload.");
    }
    const remoteTurns = raw.turns
      .map((entry) => parseSessionTurnRecord(entry, path, 200, validId))
      .sort((a, b) => a.seq - b.seq);

    const existing = this.sessions.get(validId);
    const prevLastSyncedSeq = existing?.lastSyncedSeq ?? 0;

    if (existing && prevLastSyncedSeq > 0) {
      const remoteBySeq = new Map<number, SessionTurnRecord>();
      for (const remoteTurn of remoteTurns) {
        remoteBySeq.set(remoteTurn.seq, remoteTurn);
      }

      for (const localTurn of existing.turns) {
        if (localTurn.seq > prevLastSyncedSeq) continue;
        const remoteMatch = remoteBySeq.get(localTurn.seq);
        if (
          !remoteMatch ||
          remoteMatch.id !== localTurn.id ||
          remoteMatch.role !== localTurn.role ||
          remoteMatch.content !== localTurn.content
        ) {
          existing.syncStatus = "conflict";
          existing.updatedAt = new Date().toISOString();
          throw new SessionSyncError(
            path,
            "conflict",
            undefined,
            validId,
            `History conflict detected at seq ${localTurn.seq} for session '${validId}'.`,
          );
        }
      }
    }

    const maxRemoteSeq = remoteTurns.reduce((max, turn) => Math.max(max, turn.seq), 0);
    const pulledCount = remoteTurns.filter((turn) => turn.seq > prevLastSyncedSeq).length;
    const preservedPending = existing ? existing.pendingTurns : [];
    const nextSnapshot: LocalSessionSnapshot = {
      id: remoteSession.id,
      title: remoteSession.title,
      mode: remoteSession.mode,
      ...(remoteSession.workDir !== undefined ? { workDir: remoteSession.workDir } : {}),
      ...(remoteSession.project !== undefined ? { project: remoteSession.project } : {}),
      ...(remoteSession.model !== undefined ? { model: remoteSession.model } : {}),
      status: remoteSession.status ?? existing?.status ?? "idle",
      turns: remoteTurns,
      pendingTurns: preservedPending,
      lastSyncedSeq: maxRemoteSeq,
      updatedAt: remoteSession.updatedAt ?? new Date().toISOString(),
      syncStatus: preservedPending.length > 0 ? "pending" : "synced",
    };

    this.sessions.set(validId, nextSnapshot);
    return { snapshot: cloneSnapshot(nextSnapshot), pulledCount };
  }

  async pushPendingTurns(sessionId: string): Promise<{ snapshot: LocalSessionSnapshot; pushedCount: number }> {
    const validId = requireSessionId(sessionId, "/v1/sessions/:id");
    const path = `/v1/sessions/${encodeURIComponent(validId)}`;
    const local = this.sessions.get(validId);
    if (!local) {
      throw new SessionSyncError(path, "not-found", undefined, validId, `Local session '${validId}' does not exist.`);
    }
    if (local.syncStatus === "conflict") {
      throw new SessionSyncError(
        path,
        "conflict",
        undefined,
        validId,
        `Cannot push turns while session '${validId}' is in conflict state.`,
      );
    }

    let pushedCount = 0;
    while (local.pendingTurns.length > 0) {
      const nextTurn = local.pendingTurns[0];
      if (!nextTurn) break;

      const payload: Record<string, unknown> = {
        role: nextTurn.role,
        content: nextTurn.content,
        ...(nextTurn.toolCallId !== undefined ? { toolCallId: nextTurn.toolCallId } : {}),
        ...(nextTurn.toolName !== undefined ? { toolName: nextTurn.toolName } : {}),
        ...(nextTurn.meta !== undefined ? { meta: nextTurn.meta } : {}),
      };

      const raw = await this.request(path, "POST", payload, validId);
      const savedTurn = parseSessionTurnRecord(raw.turn, path, 201, validId);
      if (savedTurn.seq <= local.lastSyncedSeq) {
        local.syncStatus = "conflict";
        local.updatedAt = new Date().toISOString();
        throw new SessionSyncError(
          path,
          "conflict",
          undefined,
          validId,
          `Remote returned non-monotonic seq ${savedTurn.seq} (lastSyncedSeq=${local.lastSyncedSeq}).`,
        );
      }

      local.turns.push(savedTurn);
      local.lastSyncedSeq = savedTurn.seq;
      local.pendingTurns.shift();
      local.updatedAt = savedTurn.createdAt;
      pushedCount += 1;
    }

    local.syncStatus = local.pendingTurns.length === 0 ? "synced" : "pending";
    return { snapshot: cloneSnapshot(local), pushedCount };
  }

  async syncSession(sessionId: string): Promise<SessionSyncResult> {
    const validId = requireSessionId(sessionId, "/v1/sessions/:id");
    const pullResult = await this.pullSession(validId);
    let pushedCount = 0;
    let finalSnapshot = pullResult.snapshot;

    if (finalSnapshot.pendingTurns.length > 0) {
      const pushResult = await this.pushPendingTurns(validId);
      pushedCount = pushResult.pushedCount;
      finalSnapshot = pushResult.snapshot;
    }

    return {
      session: finalSnapshot,
      pulledCount: pullResult.pulledCount,
      pushedCount,
      syncedAt: new Date().toISOString(),
    };
  }

  async syncAllPending(): Promise<SyncAllPendingResult> {
    const synced: string[] = [];
    const failed: Array<{ sessionId: string; error: string }> = [];

    for (const [sessionId, snapshot] of this.sessions.entries()) {
      if (snapshot.pendingTurns.length === 0) continue;
      try {
        await this.syncSession(sessionId);
        synced.push(sessionId);
      } catch (caught) {
        if (caught instanceof SessionSyncError && caught.reason === "unreachable") {
          snapshot.syncStatus = "offline";
          snapshot.updatedAt = new Date().toISOString();
        }
        failed.push({
          sessionId,
          error: caught instanceof Error ? caught.message : String(caught),
        });
      }
    }

    return { synced, failed };
  }

  async saveSnapshots(): Promise<void> {
    if (!this.snapshotFilePath) {
      throw new SessionSyncError("snapshotFilePath", "validation", undefined, undefined, "snapshotFilePath is not configured.");
    }
    const targetPath = this.snapshotFilePath;
    await mkdir(dirname(targetPath), { recursive: true });
    const tempPath = `${targetPath}.tmp-${process.pid}-${crypto.randomUUID()}`;
    const payload = JSON.stringify(
      {
        version: 1,
        ridUrl: this.ridUrl,
        savedAt: new Date().toISOString(),
        sessions: this.listLocalSessions(),
      },
      null,
      2,
    );

    try {
      await writeFile(tempPath, payload, "utf8");
      await rename(tempPath, targetPath);
    } catch (caught) {
      await rm(tempPath, { force: true }).catch(() => undefined);
      throw caught;
    }
  }

  async loadSnapshots(): Promise<number> {
    if (!this.snapshotFilePath) {
      throw new SessionSyncError("snapshotFilePath", "validation", undefined, undefined, "snapshotFilePath is not configured.");
    }
    const targetPath = this.snapshotFilePath;

    let rawText: string;
    try {
      rawText = await readFile(targetPath, "utf8");
    } catch (caught) {
      if (isRecord(caught) && caught.code === "ENOENT") {
        return 0;
      }
      throw caught;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(rawText);
    } catch {
      throw new SessionSyncError(targetPath, "invalid-response", undefined, undefined, "Snapshot file contains invalid JSON.");
    }

    if (!isRecord(parsed) || !Array.isArray(parsed.sessions)) {
      throw new SessionSyncError(
        targetPath,
        "invalid-response",
        undefined,
        undefined,
        "Snapshot file must contain a sessions array.",
      );
    }

    const loaded = new Map<string, LocalSessionSnapshot>();
    for (const entry of parsed.sessions) {
      if (!isRecord(entry)) {
        throw new SessionSyncError(targetPath, "invalid-response", undefined, undefined, "Invalid session snapshot entry.");
      }
      if (
        typeof entry.id !== "string" ||
        entry.id.trim().length === 0 ||
        typeof entry.title !== "string" ||
        typeof entry.mode !== "string" ||
        !isValidStatus(entry.status) ||
        !Array.isArray(entry.turns) ||
        !Array.isArray(entry.pendingTurns) ||
        typeof entry.lastSyncedSeq !== "number" ||
        !Number.isInteger(entry.lastSyncedSeq) ||
        entry.lastSyncedSeq < 0 ||
        typeof entry.updatedAt !== "string" ||
        !isValidSyncStatus(entry.syncStatus)
      ) {
        throw new SessionSyncError(targetPath, "invalid-response", undefined, undefined, "Malformed session snapshot fields.");
      }

      const snapshot: LocalSessionSnapshot = {
        id: entry.id,
        title: entry.title,
        mode: entry.mode,
        ...(typeof entry.workDir === "string" ? { workDir: entry.workDir } : {}),
        ...(typeof entry.project === "string" ? { project: entry.project } : {}),
        ...(typeof entry.model === "string" ? { model: entry.model } : {}),
        status: entry.status,
        turns: entry.turns.map((t) => parseSessionTurnRecord(t, targetPath)),
        pendingTurns: entry.pendingTurns.map((t) => parsePendingTurnRecord(t, targetPath)),
        lastSyncedSeq: entry.lastSyncedSeq,
        updatedAt: entry.updatedAt,
        syncStatus: entry.syncStatus,
      };
      loaded.set(snapshot.id, snapshot);
    }

    this.sessions.clear();
    for (const [id, snapshot] of loaded.entries()) {
      this.sessions.set(id, snapshot);
    }
    return this.sessions.size;
  }
}
