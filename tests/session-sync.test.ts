import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  SessionSyncError,
  SessionSyncManager,
  type RemoteSessionRecord,
  type SessionTurnRecord,
} from "../src/index";

const json = (payload: unknown, status = 200): Response => Response.json(payload, { status });

interface MockServerState {
  sessions: Map<string, RemoteSessionRecord>;
  turns: Map<string, SessionTurnRecord[]>;
  seenAuthHeaders: string[];
  nextSessionSeq: number;
  nextTurnSeq: number;
}

const state: MockServerState = {
  sessions: new Map(),
  turns: new Map(),
  seenAuthHeaders: [],
  nextSessionSeq: 1,
  nextTurnSeq: 1,
};

let server: ReturnType<typeof Bun.serve>;
let coreUrl: string;
let tempDir: string;

function resetServerState(): void {
  state.sessions.clear();
  state.turns.clear();
  state.seenAuthHeaders = [];
  state.nextSessionSeq = 1;
  state.nextTurnSeq = 1;
}

beforeAll(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "mw-dx-session-sync-"));
  server = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      const auth = req.headers.get("authorization");
      if (auth) state.seenAuthHeaders.push(auth);

      if (url.pathname === "/health" && req.method === "GET") {
        return json({ status: "ok", service: "mw-rocksoul-core" });
      }

      if (url.pathname === "/v1/sessions") {
        if (req.method === "GET") {
          const limitParam = Number.parseInt(url.searchParams.get("limit") ?? "100", 10);
          const all = Array.from(state.sessions.values()).slice(0, Number.isNaN(limitParam) ? 100 : limitParam);
          return json({ sessions: all });
        }

        if (req.method === "POST") {
          const body = (await req.json()) as Record<string, unknown>;
          const id = `sess_${state.nextSessionSeq++}`;
          const now = new Date().toISOString();
          const record: RemoteSessionRecord = {
            id,
            title: typeof body.title === "string" ? body.title : "Untitled Session",
            mode: typeof body.mode === "string" ? body.mode : "act",
            ...(typeof body.workDir === "string" ? { workDir: body.workDir } : {}),
            ...(typeof body.project === "string" ? { project: body.project } : {}),
            ...(typeof body.model === "string" ? { model: body.model } : {}),
            status: "idle",
            createdAt: now,
            updatedAt: now,
          };
          state.sessions.set(id, record);
          state.turns.set(id, []);
          return json({ session: record }, 201);
        }
      }

      if (url.pathname.startsWith("/v1/sessions/")) {
        const sessionId = decodeURIComponent(url.pathname.slice("/v1/sessions/".length));
        const session = state.sessions.get(sessionId);
        if (!session) {
          return json({ error: "Session not found", sessionId }, 404);
        }

        if (req.method === "GET") {
          return json({ session, turns: state.turns.get(sessionId) ?? [] });
        }

        if (req.method === "POST") {
          const body = (await req.json()) as Record<string, unknown>;
          const existingTurns = state.turns.get(sessionId) ?? [];
          const nextSeq = existingTurns.length + 1;
          const turn: SessionTurnRecord = {
            id: `turn_${state.nextTurnSeq++}`,
            sessionId,
            seq: nextSeq,
            role: body.role as SessionTurnRecord["role"],
            content: String(body.content ?? ""),
            ...(typeof body.toolCallId === "string" ? { toolCallId: body.toolCallId } : {}),
            ...(typeof body.toolName === "string" ? { toolName: body.toolName } : {}),
            createdAt: new Date().toISOString(),
          };
          existingTurns.push(turn);
          state.turns.set(sessionId, existingTurns);
          session.updatedAt = turn.createdAt;
          return json({ turn }, 201);
        }
      }

      return json({ error: "Not Found" }, 404);
    },
  });
  coreUrl = `http://127.0.0.1:${server.port}`;
});

afterAll(async () => {
  server.stop(true);
  await rm(tempDir, { recursive: true, force: true });
});

beforeEach(() => {
  resetServerState();
});

describe("SessionSyncManager", () => {
  test("listRemoteSessions and createRemoteSession attach bearer auth and initialize local snapshot", async () => {
    const manager = new SessionSyncManager({ coreUrl, bearerToken: "mw_k_test_token" });
    expect(await manager.checkCoreHealth()).toBe(true);

    const created = await manager.createRemoteSession({
      title: "Build DX",
      mode: "plan",
      project: "mw-dx",
      model: "claude-sonnet",
    });

    expect(created.id).toBe("sess_1");
    expect(created.syncStatus).toBe("synced");
    expect(created.lastSyncedSeq).toBe(0);
    expect(created.pendingTurns).toHaveLength(0);

    const remoteList = await manager.listRemoteSessions(10);
    expect(remoteList).toHaveLength(1);
    expect(remoteList[0]?.title).toBe("Build DX");
    expect(state.seenAuthHeaders).toEqual([
      "Bearer mw_k_test_token",
      "Bearer mw_k_test_token",
      "Bearer mw_k_test_token",
    ]);
  });

  test("queueTurn and pushPendingTurns push turns incrementally and advance lastSyncedSeq", async () => {
    const manager = new SessionSyncManager({ coreUrl });
    const session = await manager.createRemoteSession({ title: "Push Flow", mode: "act" });

    const q1 = manager.queueTurn(session.id, { role: "user", content: "Analyze repo" });
    expect(q1.syncStatus).toBe("pending");
    expect(q1.pendingTurns).toHaveLength(1);

    manager.queueTurn(session.id, {
      role: "assistant",
      content: "Running check",
      toolName: "read_file",
      toolCallId: "call_1",
    });

    const pushed = await manager.pushPendingTurns(session.id);
    expect(pushed.pushedCount).toBe(2);
    expect(pushed.snapshot.syncStatus).toBe("synced");
    expect(pushed.snapshot.lastSyncedSeq).toBe(2);
    expect(pushed.snapshot.pendingTurns).toHaveLength(0);
    expect(pushed.snapshot.turns.map((t) => t.content)).toEqual(["Analyze repo", "Running check"]);
  });

  test("pullSession pulls new remote turns while preserving unpushed local pendingTurns", async () => {
    const manager = new SessionSyncManager({ coreUrl });
    const session = await manager.createRemoteSession({ title: "Pull Delta", mode: "act" });

    manager.queueTurn(session.id, { role: "user", content: "Turn 1" });
    await manager.pushPendingTurns(session.id);

    // Queue another local turn not yet pushed
    manager.queueTurn(session.id, { role: "user", content: "Local unsynced" });

    // Meanwhile another client appends turn 2 directly on remote
    const remoteTurns = state.turns.get(session.id)!;
    remoteTurns.push({
      id: "turn_remote_2",
      sessionId: session.id,
      seq: 2,
      role: "assistant",
      content: "Remote turn 2",
      createdAt: new Date().toISOString(),
    });

    const pulled = await manager.pullSession(session.id);
    expect(pulled.pulledCount).toBe(1);
    expect(pulled.snapshot.lastSyncedSeq).toBe(2);
    expect(pulled.snapshot.turns).toHaveLength(2);
    expect(pulled.snapshot.pendingTurns).toHaveLength(1);
    expect(pulled.snapshot.pendingTurns[0]?.content).toBe("Local unsynced");
    expect(pulled.snapshot.syncStatus).toBe("pending");
  });

  test("syncSession pulls remote delta then pushes local pending turns end-to-end", async () => {
    const manager = new SessionSyncManager({ coreUrl });
    const session = await manager.createRemoteSession({ title: "Full Sync", mode: "act" });

    state.turns.get(session.id)!.push({
      id: "turn_remote_1",
      sessionId: session.id,
      seq: 1,
      role: "system",
      content: "System boot",
      createdAt: new Date().toISOString(),
    });

    manager.queueTurn(session.id, { role: "user", content: "Hello core" });
    const result = await manager.syncSession(session.id);

    expect(result.pulledCount).toBe(1);
    expect(result.pushedCount).toBe(1);
    expect(result.session.syncStatus).toBe("synced");
    expect(result.session.lastSyncedSeq).toBe(2);
    expect(result.session.turns.map((t) => t.content)).toEqual(["System boot", "Hello core"]);
  });

  test("fail-closed conflict detection when remote history diverges at seq <= lastSyncedSeq", async () => {
    const manager = new SessionSyncManager({ coreUrl });
    const session = await manager.createRemoteSession({ title: "Conflict", mode: "act" });
    manager.queueTurn(session.id, { role: "user", content: "Original prompt" });
    await manager.pushPendingTurns(session.id);

    // Mutate remote history at seq 1
    state.turns.set(session.id, [
      {
        id: "turn_diverged",
        sessionId: session.id,
        seq: 1,
        role: "user",
        content: "Rewritten prompt",
        createdAt: new Date().toISOString(),
      },
    ]);

    await expect(manager.pullSession(session.id)).rejects.toMatchObject({ reason: "conflict" });
    expect(manager.getLocalSession(session.id)?.syncStatus).toBe("conflict");

    manager.queueTurn(session.id, { role: "user", content: "Blocked while conflicted" });
    await expect(manager.pushPendingTurns(session.id)).rejects.toMatchObject({ reason: "conflict" });
  });

  test("fail-closed errors for 404, 500, malformed payload, validation, and unreachable core", async () => {
    const manager = new SessionSyncManager({ coreUrl });
    await expect(manager.pullSession("does-not-exist")).rejects.toMatchObject({
      reason: "not-found",
      status: 404,
    });
    await expect(manager.listRemoteSessions(0)).rejects.toMatchObject({ reason: "validation" });

    const created = await manager.createRemoteSession({ title: "Valid", mode: "act" });
    expect(() => manager.queueTurn(created.id, { role: "user", content: "" })).toThrow(SessionSyncError);

    const httpFail = new SessionSyncManager({
      fetchImpl: (async () => json({ error: "boom" }, 500)) as unknown as typeof fetch,
    });
    await expect(httpFail.listRemoteSessions()).rejects.toMatchObject({ reason: "http", status: 500 });

    const malformed = new SessionSyncManager({
      fetchImpl: (async () => json({ sessions: [{ id: 123 }] })) as unknown as typeof fetch,
    });
    await expect(malformed.listRemoteSessions()).rejects.toMatchObject({ reason: "invalid-response" });

    // Unreachable core preserves pendingTurns and marks syncStatus = offline in syncAllPending
    const offlineManager = new SessionSyncManager({ coreUrl: "http://127.0.0.1:1", timeoutMs: 400 });
    // Seed via snapshot file then queue turn
    const snapPath = join(tempDir, "offline-seed.json");
    await writeFile(
      snapPath,
      JSON.stringify({
        version: 1,
        sessions: [
          {
            id: "sess_offline",
            title: "Offline Session",
            mode: "act",
            status: "idle",
            turns: [],
            pendingTurns: [],
            lastSyncedSeq: 0,
            updatedAt: new Date().toISOString(),
            syncStatus: "synced",
          },
        ],
      }),
      "utf8",
    );
    const offlineWithSnap = new SessionSyncManager({
      coreUrl: "http://127.0.0.1:1",
      timeoutMs: 400,
      snapshotFilePath: snapPath,
    });
    expect(await offlineWithSnap.loadSnapshots()).toBe(1);
    offlineWithSnap.queueTurn("sess_offline", { role: "user", content: "Queued offline" });

    const summary = await offlineWithSnap.syncAllPending();
    expect(summary.synced).toEqual([]);
    expect(summary.failed).toHaveLength(1);
    expect(summary.failed[0]?.sessionId).toBe("sess_offline");

    const after = offlineWithSnap.getLocalSession("sess_offline");
    expect(after?.syncStatus).toBe("offline");
    expect(after?.pendingTurns).toHaveLength(1);
    expect(await offlineManager.checkCoreHealth()).toBe(false);
  });

  test("atomic snapshot persistence saveSnapshots and loadSnapshots round-trip", async () => {
    const snapshotFilePath = join(tempDir, "nested", "snapshots.json");
    const writer = new SessionSyncManager({ coreUrl, snapshotFilePath });
    const created = await writer.createRemoteSession({ title: "Persist Me", mode: "act" });
    writer.queueTurn(created.id, { role: "user", content: "Saved pending turn" });
    await writer.saveSnapshots();

    const rawText = await readFile(snapshotFilePath, "utf8");
    const parsed = JSON.parse(rawText) as { version: number; sessions: unknown[] };
    expect(parsed.version).toBe(1);
    expect(parsed.sessions).toHaveLength(1);

    const reader = new SessionSyncManager({ coreUrl, snapshotFilePath });
    const count = await reader.loadSnapshots();
    expect(count).toBe(1);

    const restored = reader.getLocalSession(created.id);
    expect(restored?.title).toBe("Persist Me");
    expect(restored?.pendingTurns).toHaveLength(1);
    expect(restored?.pendingTurns[0]?.content).toBe("Saved pending turn");

    const syncResult = await reader.syncSession(created.id);
    expect(syncResult.pushedCount).toBe(1);
    expect(syncResult.session.syncStatus).toBe("synced");
  });

  test("syncAllPending marks active post-pull snapshot offline when pullSession succeeds and pushPendingTurns is unreachable", async () => {
    let failPush = false;
    const manager = new SessionSyncManager({
      coreUrl: "http://mock-core.local",
      fetchImpl: (async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url);
        const method = init?.method ?? "GET";

        if (url.pathname === "/v1/sessions" && method === "POST") {
          return json(
            {
              session: {
                id: "sess_partial",
                title: "Initial Title",
                mode: "act",
                status: "idle",
                createdAt: "2026-11-27T00:00:00.000Z",
                updatedAt: "2026-11-27T00:00:00.000Z",
              },
            },
            201,
          );
        }

        if (url.pathname === "/v1/sessions/sess_partial" && method === "GET") {
          return json({
            session: {
              id: "sess_partial",
              title: "Pulled Remote Title",
              mode: "act",
              status: "idle",
              createdAt: "2026-11-27T00:00:00.000Z",
              updatedAt: "2026-11-27T00:01:00.000Z",
            },
            turns: [],
          });
        }

        if (url.pathname === "/v1/sessions/sess_partial" && method === "POST" && failPush) {
          throw new Error("ECONNREFUSED");
        }

        return json({ error: "Not Found" }, 404);
      }) as unknown as typeof fetch,
    });

    const created = await manager.createRemoteSession({ title: "Initial Title", mode: "act" });
    manager.queueTurn(created.id, { role: "user", content: "Pending turn after pull" });
    failPush = true;

    const summary = await manager.syncAllPending();
    expect(summary.synced).toEqual([]);
    expect(summary.failed).toHaveLength(1);
    expect(summary.failed[0]?.sessionId).toBe("sess_partial");

    const active = manager.getLocalSession("sess_partial");
    expect(active?.title).toBe("Pulled Remote Title");
    expect(active?.syncStatus).toBe("offline");
    expect(active?.pendingTurns).toHaveLength(1);
  });
});
