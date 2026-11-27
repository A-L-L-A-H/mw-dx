import { readdir, readFile, stat } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";

export type PlanFormat = "plan-taskos/v1" | "legacy-markdown";
export type PlanTaskLifecycleStatus =
  | "backlog"
  | "todo"
  | "in_progress"
  | "review"
  | "blocked"
  | "done"
  | "skipped"
  | "cancelled";
export type TaskPanelDagState = "done" | "active" | "ready" | "blocked" | "skipped";
export type PlanPanelErrorReason = "not-found" | "invalid-plan" | "invalid-path";

export interface PlanPanelTask {
  code: string;
  urn: string;
  title: string;
  waveId: string;
  waveTitle: string;
  status: PlanTaskLifecycleStatus;
  dagState: TaskPanelDagState;
  dependsOn: string[];
  ownerFiles: string[];
  modelTier?: string;
  riskTier?: string;
  attempts: number;
  verifyCommands: string[];
  acceptanceCriteria: string[];
  hasProof: boolean;
  commitSha: string | null;
}

export interface PlanPanelWaveSummary {
  waveId: string;
  title: string;
  dependsOn: string[];
  total: number;
  done: number;
  active: number;
  ready: number;
  blocked: number;
  skipped: number;
  percent: number;
  tasks: PlanPanelTask[];
}

export interface PlanPanelModel {
  planId: string;
  title: string;
  format: PlanFormat;
  sourcePath: string;
  total: number;
  done: number;
  active: number;
  ready: number;
  blocked: number;
  skipped: number;
  percent: number;
  nextReadyTaskIds: string[];
  criticalPathIds: string[];
  cycles: string[][];
  waves: PlanPanelWaveSummary[];
  tasks: PlanPanelTask[];
  warnings: string[];
}

export interface PlanTaskFilter {
  waveId?: string;
  dagState?: TaskPanelDagState;
  query?: string;
}

export class PlanPanelError extends Error {
  constructor(
    readonly path: string,
    readonly reason: PlanPanelErrorReason,
    message?: string,
  ) {
    super(message ?? `plan panel ${path} failed: ${reason}`);
    this.name = "PlanPanelError";
  }
}

const VALID_LIFECYCLE_STATUSES = new Set<PlanTaskLifecycleStatus>([
  "backlog",
  "todo",
  "in_progress",
  "review",
  "blocked",
  "done",
  "skipped",
  "cancelled",
]);

const DONE_STATES = new Set<PlanTaskLifecycleStatus>(["done"]);
const ACTIVE_STATES = new Set<PlanTaskLifecycleStatus>(["in_progress", "review"]);
const BLOCKED_STATES = new Set<PlanTaskLifecycleStatus>(["blocked"]);
const SKIPPED_STATES = new Set<PlanTaskLifecycleStatus>(["skipped", "cancelled"]);
const SATISFIED_DEP_STATES = new Set<PlanTaskLifecycleStatus>(["done", "skipped", "cancelled"]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isLifecycleStatus(value: unknown): value is PlanTaskLifecycleStatus {
  return typeof value === "string" && VALID_LIFECYCLE_STATUSES.has(value as PlanTaskLifecycleStatus);
}

function computePercent(done: number, skipped: number, total: number): number {
  if (total <= 0) return 0;
  return Math.round(((done + skipped) / total) * 1000) / 10;
}

function resolveInside(baseDir: string, unsafeRelativePath: string): string {
  if (unsafeRelativePath.includes("\0") || isAbsolute(unsafeRelativePath)) {
    throw new PlanPanelError(unsafeRelativePath, "invalid-path", `Unsafe relative path: '${unsafeRelativePath}'.`);
  }
  const baseResolved = resolve(baseDir);
  const targetResolved = resolve(baseResolved, unsafeRelativePath);
  const rel = relative(baseResolved, targetResolved);
  if (rel === ".." || rel.startsWith("..\\") || rel.startsWith("../") || isAbsolute(rel)) {
    throw new PlanPanelError(unsafeRelativePath, "invalid-path", `Path escapes plan directory: '${unsafeRelativePath}'.`);
  }
  return targetResolved;
}

export function validatePlanId(planId: string): string {
  const trimmed = planId.trim();
  if (
    trimmed.length === 0 ||
    trimmed === "." ||
    trimmed === ".." ||
    trimmed.includes("/") ||
    trimmed.includes("\\") ||
    trimmed.includes("..") ||
    trimmed.includes("\0")
  ) {
    throw new PlanPanelError(planId, "invalid-path", `Invalid planId: '${planId}'.`);
  }
  return trimmed;
}

interface RawTaskNode {
  code: string;
  urn: string;
  title: string;
  waveId: string;
  waveTitle: string;
  status: PlanTaskLifecycleStatus;
  dependsOn: string[];
  ownerFiles: string[];
  modelTier?: string;
  riskTier?: string;
  attempts: number;
  verifyCommands: string[];
  acceptanceCriteria: string[];
  hasProof: boolean;
  commitSha: string | null;
}

function detectCycles(tasks: readonly RawTaskNode[], tasksByCode: ReadonlyMap<string, RawTaskNode>): string[][] {
  const cycles: string[][] = [];
  const visited = new Set<string>();
  const inStack = new Set<string>();
  const stack: string[] = [];

  function dfs(code: string): void {
    if (inStack.has(code)) {
      const cycleStart = stack.indexOf(code);
      if (cycleStart >= 0) {
        cycles.push([...stack.slice(cycleStart), code]);
      }
      return;
    }
    if (visited.has(code)) return;

    visited.add(code);
    inStack.add(code);
    stack.push(code);

    const task = tasksByCode.get(code);
    if (task) {
      for (const dep of task.dependsOn) {
        if (tasksByCode.has(dep)) {
          dfs(dep);
        }
      }
    }

    stack.pop();
    inStack.delete(code);
  }

  for (const task of tasks) {
    dfs(task.code);
  }
  return cycles;
}

function deriveDagState(
  task: RawTaskNode,
  tasksByCode: ReadonlyMap<string, RawTaskNode>,
  cyclicCodes: ReadonlySet<string>,
): TaskPanelDagState {
  const status = task.status;
  if (DONE_STATES.has(status)) return "done";
  if (SKIPPED_STATES.has(status)) return "skipped";
  if (ACTIVE_STATES.has(status)) return "active";
  if (BLOCKED_STATES.has(status)) return "blocked";
  if (cyclicCodes.has(task.code)) return "blocked";

  for (const dep of task.dependsOn) {
    const depTask = tasksByCode.get(dep);
    if (!depTask) continue;
    if (!SATISFIED_DEP_STATES.has(depTask.status)) {
      return "blocked";
    }
  }
  return "ready";
}

function computeCriticalPath(tasks: readonly PlanPanelTask[]): string[] {
  const taskByCode = new Map<string, PlanPanelTask>();
  const dependents = new Map<string, string[]>();

  for (const task of tasks) {
    taskByCode.set(task.code, task);
    if (!dependents.has(task.code)) {
      dependents.set(task.code, []);
    }
  }

  for (const task of tasks) {
    for (const dep of task.dependsOn) {
      const list = dependents.get(dep);
      if (list) {
        list.push(task.code);
      }
    }
  }

  const memo = new Map<string, string[]>();

  function longestPendingChain(code: string, visiting: Set<string>): string[] {
    const cached = memo.get(code);
    if (cached) return cached;
    if (visiting.has(code)) return [code];

    visiting.add(code);
    const children = dependents.get(code) ?? [];
    let bestTail: string[] = [];

    for (const childCode of children) {
      const child = taskByCode.get(childCode);
      if (!child) continue;
      if (child.dagState === "done" || child.dagState === "skipped") continue;
      const chain = longestPendingChain(childCode, visiting);
      if (chain.length > bestTail.length) {
        bestTail = chain;
      }
    }

    visiting.delete(code);
    const result = [code, ...bestTail];
    memo.set(code, result);
    return result;
  }

  let bestPath: string[] = [];
  for (const task of tasks) {
    if (task.dagState !== "ready" && task.dagState !== "active") continue;
    const chain = longestPendingChain(task.code, new Set());
    if (chain.length > bestPath.length) {
      bestPath = chain;
    }
  }
  return bestPath;
}

function finalizeModel(params: {
  planId: string;
  title: string;
  format: PlanFormat;
  sourcePath: string;
  waveSpecs: ReadonlyArray<{ waveId: string; title: string; dependsOn: string[] }>;
  rawTasks: readonly RawTaskNode[];
  warnings: string[];
}): PlanPanelModel {
  const tasksByCode = new Map<string, RawTaskNode>();
  for (const task of params.rawTasks) {
    if (!tasksByCode.has(task.code)) {
      tasksByCode.set(task.code, task);
    } else {
      params.warnings.push(`Duplicate task code '${task.code}' ignored.`);
    }
  }

  for (const task of tasksByCode.values()) {
    for (const dep of task.dependsOn) {
      if (!tasksByCode.has(dep)) {
        params.warnings.push(`Task '${task.code}' references unknown dependency '${dep}'.`);
      }
    }
  }

  const uniqueRawTasks = Array.from(tasksByCode.values());
  const cycles = detectCycles(uniqueRawTasks, tasksByCode);
  const cyclicCodes = new Set(cycles.flat());
  if (cycles.length > 0) {
    params.warnings.push(`Detected ${cycles.length} dependency cycle(s).`);
  }

  const evaluatedTasks: PlanPanelTask[] = uniqueRawTasks.map((raw) => ({
    code: raw.code,
    urn: raw.urn,
    title: raw.title,
    waveId: raw.waveId,
    waveTitle: raw.waveTitle,
    status: raw.status,
    dagState: deriveDagState(raw, tasksByCode, cyclicCodes),
    dependsOn: [...raw.dependsOn],
    ownerFiles: [...raw.ownerFiles],
    ...(raw.modelTier !== undefined ? { modelTier: raw.modelTier } : {}),
    ...(raw.riskTier !== undefined ? { riskTier: raw.riskTier } : {}),
    attempts: raw.attempts,
    verifyCommands: [...raw.verifyCommands],
    acceptanceCriteria: [...raw.acceptanceCriteria],
    hasProof: raw.hasProof,
    commitSha: raw.commitSha,
  }));

  const tasksByWave = new Map<string, PlanPanelTask[]>();
  for (const spec of params.waveSpecs) {
    tasksByWave.set(spec.waveId, []);
  }
  for (const task of evaluatedTasks) {
    const bucket = tasksByWave.get(task.waveId);
    if (bucket) {
      bucket.push(task);
    } else {
      tasksByWave.set(task.waveId, [task]);
    }
  }

  const waveSpecMap = new Map(params.waveSpecs.map((w) => [w.waveId, w]));
  const waves: PlanPanelWaveSummary[] = [];

  for (const [waveId, waveTasks] of tasksByWave.entries()) {
    const spec = waveSpecMap.get(waveId);
    const waveTitle = spec?.title ?? waveTasks[0]?.waveTitle ?? waveId;
    const dependsOn = spec ? [...spec.dependsOn] : [];

    let done = 0;
    let active = 0;
    let ready = 0;
    let blocked = 0;
    let skipped = 0;
    for (const t of waveTasks) {
      if (t.dagState === "done") done += 1;
      else if (t.dagState === "active") active += 1;
      else if (t.dagState === "ready") ready += 1;
      else if (t.dagState === "blocked") blocked += 1;
      else if (t.dagState === "skipped") skipped += 1;
    }
    const total = waveTasks.length;
    waves.push({
      waveId,
      title: waveTitle,
      dependsOn,
      total,
      done,
      active,
      ready,
      blocked,
      skipped,
      percent: computePercent(done, skipped, total),
      tasks: waveTasks,
    });
  }

  let done = 0;
  let active = 0;
  let ready = 0;
  let blocked = 0;
  let skipped = 0;
  const nextReadyTaskIds: string[] = [];

  for (const t of evaluatedTasks) {
    if (t.dagState === "done") done += 1;
    else if (t.dagState === "active") active += 1;
    else if (t.dagState === "ready") {
      ready += 1;
      nextReadyTaskIds.push(t.code);
    } else if (t.dagState === "blocked") blocked += 1;
    else if (t.dagState === "skipped") skipped += 1;
  }

  const total = evaluatedTasks.length;
  const criticalPathIds = computeCriticalPath(evaluatedTasks);

  return {
    planId: params.planId,
    title: params.title,
    format: params.format,
    sourcePath: params.sourcePath,
    total,
    done,
    active,
    ready,
    blocked,
    skipped,
    percent: computePercent(done, skipped, total),
    nextReadyTaskIds,
    criticalPathIds,
    cycles,
    waves,
    tasks: evaluatedTasks,
    warnings: params.warnings,
  };
}

function deriveWaveIdFromHeading(heading: string, index: number, usedIds: Set<string>): string {
  const wCode = heading.match(/^(W\d+[A-Za-z0-9_-]*)\b/i);
  const waveNum = heading.match(/^Wave\s+(\d+[A-Za-z0-9_-]*)\b/i);
  let candidate = wCode?.[1]?.toUpperCase() ?? (waveNum?.[1] ? `W${waveNum[1]}` : `wave-${index + 1}`);
  if (usedIds.has(candidate)) {
    candidate = `${candidate}-${index + 1}`;
  }
  usedIds.add(candidate);
  return candidate;
}

export function parseLegacyPlanMarkdown(
  markdown: string,
  planId: string,
  sourcePath = `.plan/${planId}.md`,
): PlanPanelModel {
  const validId = validatePlanId(planId);
  const lines = markdown.split(/\r?\n/);

  let title = validId;
  for (const line of lines) {
    const h1 = line.match(/^#\s+(.+)$/);
    if (h1?.[1]) {
      title = h1[1].trim();
      break;
    }
  }

  const waveSpecs: Array<{ waveId: string; title: string; dependsOn: string[] }> = [];
  const usedWaveIds = new Set<string>();
  const rawTasks: RawTaskNode[] = [];
  const seenCodes = new Set<string>();
  const warnings: string[] = [];

  let currentWave: { waveId: string; title: string } | null = null;

  for (const line of lines) {
    const waveMatch = line.match(/^###\s+(.+)$/);
    if (waveMatch?.[1] && !waveMatch[1].trim().startsWith("[")) {
      const waveTitle = waveMatch[1].trim();
      const waveId = deriveWaveIdFromHeading(waveTitle, waveSpecs.length, usedWaveIds);
      currentWave = { waveId, title: waveTitle };
      waveSpecs.push({ waveId, title: waveTitle, dependsOn: [] });
      continue;
    }

    const taskMatch =
      line.match(/^\s*-\s+\[([ xX])\]\s+\*\*([A-Za-z0-9_-]+)\*\*\s*[—-]\s*(.+)$/) ??
      line.match(/^####\s+-\s+\[([ xX])\]\s+([A-Za-z0-9_-]+)\s*[—-]\s*(.+)$/);
    if (!taskMatch?.[1] || !taskMatch[2] || !taskMatch[3]) continue;

    const code = taskMatch[2].trim();
    if (seenCodes.has(code)) {
      warnings.push(`Duplicate task code '${code}' in markdown ignored.`);
      continue;
    }
    seenCodes.add(code);

    if (!currentWave) {
      const waveId = "general";
      if (!usedWaveIds.has(waveId)) {
        usedWaveIds.add(waveId);
        waveSpecs.push({ waveId, title: "General", dependsOn: [] });
      }
      currentWave = { waveId, title: "General" };
    }

    const isDone = taskMatch[1].toLowerCase() === "x";
    rawTasks.push({
      code,
      urn: `urn:mw:work:legacy:${validId}:${currentWave.waveId}/${code}`,
      title: taskMatch[3].trim(),
      waveId: currentWave.waveId,
      waveTitle: currentWave.title,
      status: isDone ? "done" : "todo",
      dependsOn: [],
      ownerFiles: [],
      attempts: 0,
      verifyCommands: [],
      acceptanceCriteria: [],
      hasProof: false,
      commitSha: null,
    });
  }

  return finalizeModel({
    planId: validId,
    title,
    format: "legacy-markdown",
    sourcePath,
    waveSpecs,
    rawTasks,
    warnings,
  });
}

interface ParsedProofEntry {
  code?: string;
  taskUrn?: string;
  commitSha: string | null;
}

function parseProofList(proofs: unknown[] | undefined, warnings: string[]): {
  byCode: Map<string, ParsedProofEntry>;
  byUrn: Map<string, ParsedProofEntry>;
} {
  const byCode = new Map<string, ParsedProofEntry>();
  const byUrn = new Map<string, ParsedProofEntry>();
  if (!proofs) return { byCode, byUrn };

  for (const item of proofs) {
    if (!isRecord(item)) {
      warnings.push("Ignored non-object proof envelope.");
      continue;
    }
    const code = typeof item.code === "string" && item.code.trim().length > 0 ? item.code.trim() : undefined;
    const taskUrn =
      typeof item.task_urn === "string" && item.task_urn.trim().length > 0 ? item.task_urn.trim() : undefined;
    if (!code && !taskUrn) {
      warnings.push("Ignored proof envelope missing code and task_urn.");
      continue;
    }
    const commitSha = typeof item.commit_sha === "string" ? item.commit_sha : null;
    const entry: ParsedProofEntry = { code, taskUrn, commitSha };
    if (code) byCode.set(code, entry);
    if (taskUrn) byUrn.set(taskUrn, entry);
  }

  return { byCode, byUrn };
}

export function buildPlanPanelFromV2(
  manifest: unknown,
  waves: unknown[],
  proofs?: unknown[],
  sourcePath = ".plan/manifest.json",
): PlanPanelModel {
  if (!isRecord(manifest)) {
    throw new PlanPanelError(sourcePath, "invalid-plan", "Manifest must be a JSON object.");
  }
  if (typeof manifest.plan_id !== "string" || manifest.plan_id.trim().length === 0) {
    throw new PlanPanelError(sourcePath, "invalid-plan", "Manifest requires a non-empty plan_id.");
  }
  if (typeof manifest.title !== "string" || manifest.title.trim().length === 0) {
    throw new PlanPanelError(sourcePath, "invalid-plan", "Manifest requires a non-empty title.");
  }
  if (!Array.isArray(manifest.waves)) {
    throw new PlanPanelError(sourcePath, "invalid-plan", "Manifest requires a waves array.");
  }

  const planId = validatePlanId(manifest.plan_id);
  const warnings: string[] = [];
  const { byCode: proofByCode, byUrn: proofByUrn } = parseProofList(proofs, warnings);

  const waveSpecs: Array<{ waveId: string; title: string; dependsOn: string[] }> = [];
  const waveSpecIds = new Set<string>();
  for (const entry of manifest.waves) {
    if (!isRecord(entry) || typeof entry.id !== "string" || typeof entry.title !== "string") {
      throw new PlanPanelError(sourcePath, "invalid-plan", "Manifest wave entry requires id and title.");
    }
    const dependsOn = Array.isArray(entry.depends_on)
      ? entry.depends_on.filter((d): d is string => typeof d === "string")
      : [];
    waveSpecs.push({ waveId: entry.id, title: entry.title, dependsOn });
    waveSpecIds.add(entry.id);
  }

  const rawTasks: RawTaskNode[] = [];
  for (const waveRaw of waves) {
    if (!isRecord(waveRaw)) {
      throw new PlanPanelError(sourcePath, "invalid-plan", "Wave file must be a JSON object.");
    }
    if (
      typeof waveRaw.wave_id !== "string" ||
      waveRaw.wave_id.trim().length === 0 ||
      typeof waveRaw.title !== "string" ||
      !Array.isArray(waveRaw.tasks)
    ) {
      throw new PlanPanelError(sourcePath, "invalid-plan", "Wave requires wave_id, title, and tasks array.");
    }

    const waveId = waveRaw.wave_id;
    const waveTitle = waveRaw.title;
    if (!waveSpecIds.has(waveId)) {
      waveSpecs.push({ waveId, title: waveTitle, dependsOn: [] });
      waveSpecIds.add(waveId);
    }

    for (const taskRaw of waveRaw.tasks) {
      if (!isRecord(taskRaw)) {
        throw new PlanPanelError(sourcePath, "invalid-plan", `Wave '${waveId}' contains non-object task.`);
      }
      if (
        typeof taskRaw.code !== "string" ||
        taskRaw.code.trim().length === 0 ||
        typeof taskRaw.urn !== "string" ||
        typeof taskRaw.title !== "string" ||
        taskRaw.title.trim().length === 0 ||
        !isRecord(taskRaw.lifecycle) ||
        !isLifecycleStatus(taskRaw.lifecycle.status)
      ) {
        throw new PlanPanelError(
          sourcePath,
          "invalid-plan",
          `Wave '${waveId}' contains malformed task metadata.`,
        );
      }

      const dependsOn =
        isRecord(taskRaw.graph) && Array.isArray(taskRaw.graph.depends_on)
          ? taskRaw.graph.depends_on.filter((d): d is string => typeof d === "string")
          : [];

      const ownerFiles =
        isRecord(taskRaw.governance) && Array.isArray(taskRaw.governance.owner_files)
          ? taskRaw.governance.owner_files.filter((f): f is string => typeof f === "string")
          : [];

      const verifyCommands: string[] = [];
      if (isRecord(taskRaw.verification) && Array.isArray(taskRaw.verification.commands)) {
        for (const cmdItem of taskRaw.verification.commands) {
          if (typeof cmdItem === "string") {
            verifyCommands.push(cmdItem);
          } else if (isRecord(cmdItem) && typeof cmdItem.cmd === "string") {
            verifyCommands.push(cmdItem.cmd);
          }
        }
      }

      const acceptanceCriteria =
        isRecord(taskRaw.verification) && Array.isArray(taskRaw.verification.acceptance_criteria)
          ? taskRaw.verification.acceptance_criteria.filter((c): c is string => typeof c === "string")
          : [];

      const proof = proofByCode.get(taskRaw.code) ?? proofByUrn.get(taskRaw.urn);

      rawTasks.push({
        code: taskRaw.code,
        urn: taskRaw.urn,
        title: taskRaw.title,
        waveId,
        waveTitle,
        status: taskRaw.lifecycle.status,
        dependsOn,
        ownerFiles,
        ...(typeof taskRaw.lifecycle.model_tier === "string"
          ? { modelTier: taskRaw.lifecycle.model_tier }
          : {}),
        ...(typeof taskRaw.lifecycle.risk_tier === "string"
          ? { riskTier: taskRaw.lifecycle.risk_tier }
          : {}),
        attempts: typeof taskRaw.lifecycle.attempts === "number" ? taskRaw.lifecycle.attempts : 0,
        verifyCommands,
        acceptanceCriteria,
        hasProof: proof !== undefined,
        commitSha: proof ? proof.commitSha : null,
      });
    }
  }

  return finalizeModel({
    planId,
    title: manifest.title,
    format: "plan-taskos/v1",
    sourcePath,
    waveSpecs,
    rawTasks,
    warnings,
  });
}

async function readJsonFileStrict(filePath: string): Promise<unknown> {
  let text: string;
  try {
    text = await readFile(filePath, "utf8");
  } catch (caught) {
    if (isRecord(caught) && caught.code === "ENOENT") {
      throw new PlanPanelError(filePath, "not-found", `Required plan file not found: '${filePath}'.`);
    }
    throw caught;
  }

  try {
    return JSON.parse(text);
  } catch {
    throw new PlanPanelError(filePath, "invalid-plan", `Invalid JSON in plan file: '${filePath}'.`);
  }
}

export async function loadPlanPanel(repoRoot: string, planId: string): Promise<PlanPanelModel> {
  const validId = validatePlanId(planId);
  const planRoot = join(repoRoot, ".plan");
  const planDir = join(planRoot, validId);
  const manifestPath = join(planDir, "manifest.json");

  let hasManifest = false;
  try {
    const s = await stat(manifestPath);
    hasManifest = s.isFile();
  } catch {
    hasManifest = false;
  }

  if (hasManifest) {
    const manifest = await readJsonFileStrict(manifestPath);
    if (!isRecord(manifest) || !Array.isArray(manifest.waves)) {
      throw new PlanPanelError(manifestPath, "invalid-plan", "Manifest must be an object with a waves array.");
    }

    const wavePayloads: unknown[] = [];
    for (const waveEntry of manifest.waves) {
      if (!isRecord(waveEntry) || typeof waveEntry.wave_file !== "string" || waveEntry.wave_file.trim().length === 0) {
        throw new PlanPanelError(manifestPath, "invalid-plan", "Manifest wave entry missing wave_file.");
      }
      const waveFilePath = resolveInside(planDir, waveEntry.wave_file);
      wavePayloads.push(await readJsonFileStrict(waveFilePath));
    }

    const proofs: unknown[] = [];
    const evidenceDir = join(planDir, "evidence");
    try {
      const evidenceEntries = await readdir(evidenceDir, { withFileTypes: true });
      for (const entry of evidenceEntries) {
        if (!entry.isFile() || !entry.name.endsWith(".proof.json")) continue;
        const proofPath = join(evidenceDir, entry.name);
        try {
          proofs.push(await readJsonFileStrict(proofPath));
        } catch {
          proofs.push(null);
        }
      }
    } catch {
      // Evidence directory is optional
    }

    return buildPlanPanelFromV2(manifest, wavePayloads, proofs, manifestPath);
  }

  const legacyPath = join(planRoot, `${validId}.md`);
  let markdown: string;
  try {
    markdown = await readFile(legacyPath, "utf8");
  } catch (caught) {
    if (isRecord(caught) && caught.code === "ENOENT") {
      throw new PlanPanelError(legacyPath, "not-found", `Plan '${validId}' not found under '${planRoot}'.`);
    }
    throw caught;
  }

  return parseLegacyPlanMarkdown(markdown, validId, legacyPath);
}

const SKIPPED_PLAN_DIRS = new Set([".brain", "memory", "node_modules"]);

export async function discoverPlanPanels(repoRoot: string): Promise<PlanPanelModel[]> {
  const planRoot = join(repoRoot, ".plan");
  let entries;
  try {
    entries = await readdir(planRoot, { withFileTypes: true });
  } catch {
    return [];
  }

  const candidateIds = new Set<string>();
  for (const entry of entries) {
    if (entry.name.startsWith(".")) continue;
    if (entry.isDirectory()) {
      if (SKIPPED_PLAN_DIRS.has(entry.name)) continue;
      candidateIds.add(entry.name);
    } else if (entry.isFile() && entry.name.endsWith(".md")) {
      const base = entry.name.slice(0, -".md".length);
      if (base.length > 0) candidateIds.add(base);
    }
  }

  const sortedIds = Array.from(candidateIds).sort((a, b) => a.localeCompare(b));
  const panels: PlanPanelModel[] = [];
  for (const planId of sortedIds) {
    try {
      panels.push(await loadPlanPanel(repoRoot, planId));
    } catch (caught) {
      if (caught instanceof PlanPanelError && caught.reason === "not-found") {
        continue;
      }
      throw caught;
    }
  }
  return panels;
}

export function filterPlanTasks(model: PlanPanelModel, filter: PlanTaskFilter = {}): PlanPanelTask[] {
  const needle = filter.query?.trim().toLowerCase();
  return model.tasks.filter((task) => {
    if (filter.waveId !== undefined && task.waveId !== filter.waveId) return false;
    if (filter.dagState !== undefined && task.dagState !== filter.dagState) return false;
    if (needle && needle.length > 0) {
      const hay = `${task.code} ${task.title} ${task.waveId} ${task.waveTitle}`.toLowerCase();
      if (!hay.includes(needle)) return false;
    }
    return true;
  });
}

export function getReadyFrontier(model: PlanPanelModel, maxParallel?: number): PlanPanelTask[] {
  const criticalSet = new Set(model.criticalPathIds);
  const candidates = model.tasks
    .filter((t) => t.dagState === "ready")
    .sort((a, b) => {
      const aCrit = criticalSet.has(a.code) ? 0 : 1;
      const bCrit = criticalSet.has(b.code) ? 0 : 1;
      if (aCrit !== bCrit) return aCrit - bCrit;
      return a.code.localeCompare(b.code);
    });

  const limit = maxParallel === undefined ? Number.POSITIVE_INFINITY : Math.max(0, Math.floor(maxParallel));
  const selected: PlanPanelTask[] = [];
  const claimedOwnerFiles = new Set<string>();

  for (const candidate of candidates) {
    if (selected.length >= limit) break;
    const overlaps = candidate.ownerFiles.some((file) => claimedOwnerFiles.has(file));
    if (overlaps) continue;
    for (const file of candidate.ownerFiles) {
      claimedOwnerFiles.add(file);
    }
    selected.push(candidate);
  }

  return selected;
}

export function renderPlanPanelText(model: PlanPanelModel): string {
  const lines: string[] = [];
  lines.push(`${model.title} (${model.planId}) [${model.format}]`);
  lines.push(
    `Progress: ${model.percent.toFixed(1)}% (${model.done} done, ${model.active} active, ${model.ready} ready, ${model.blocked} blocked, ${model.skipped} skipped / ${model.total} total)`,
  );

  if (model.waves.length > 0) {
    lines.push("Waves:");
    for (const wave of model.waves) {
      lines.push(
        `  - ${wave.waveId} (${wave.title}): ${wave.percent.toFixed(1)}% [${wave.done + wave.skipped}/${wave.total}] (ready=${wave.ready}, active=${wave.active}, blocked=${wave.blocked})`,
      );
    }
  }

  lines.push(
    `Ready Frontier: ${model.nextReadyTaskIds.length > 0 ? model.nextReadyTaskIds.join(", ") : "none"}`,
  );

  if (model.criticalPathIds.length > 0) {
    lines.push(`Critical Path: ${model.criticalPathIds.join(" -> ")}`);
  }

  if (model.cycles.length > 0) {
    lines.push(`Cycles: ${model.cycles.map((c) => c.join(" -> ")).join(" | ")}`);
  }

  if (model.warnings.length > 0) {
    lines.push(`Warnings: ${model.warnings.join("; ")}`);
  }

  return lines.join("\n");
}
