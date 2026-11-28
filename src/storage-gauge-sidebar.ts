export interface StorageDriveMetric {
  drive: string;
  label?: string;
  totalBytes: number;
  freeBytes: number;
  usedPct: number;
  status: "ok" | "warn" | "critical";
}

export interface StorageCleanTarget {
  path: string;
  name: string;
  bytes: number;
  fileCount: number;
  category: string;
  safety: "safe" | "caution" | "protected";
  depth: number;
}

export interface StorageAuditReport {
  drives: StorageDriveMetric[];
  targets: StorageCleanTarget[];
  safeBytes: number;
  cautionBytes: number;
  criticalDrives: number;
  generatedAt: string;
}

export interface DryRunSweepResult {
  paths: string[];
  dryRun: boolean;
  freedBytes: number;
  deletedFiles: number;
  skippedBusy: number;
  errors: string[];
  recordId: string;
}

export interface SidebarStorageGaugeModel {
  primaryDrive: string;
  usedPct: number;
  freeGb: number;
  totalGb: number;
  safeReclaimGb: number;
  cautionReclaimGb: number;
  status: "ok" | "warn" | "critical";
  criticalDrives: number;
  canTriggerSweep: boolean;
  generatedAt: string;
}

export type CliRunner = (args: string[]) => Promise<{ exitCode: number; stdout: string; stderr: string }>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function toGb(bytes: number): number {
  if (!Number.isFinite(bytes) || bytes <= 0) return 0;
  return Math.round((bytes / 1024 ** 3) * 100) / 100;
}

export function parseMwWwAuditOutput(rawJson: string): StorageAuditReport {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawJson);
  } catch {
    throw new Error("mw-ww-cli audit output is not valid JSON");
  }
  if (!isRecord(parsed) || !Array.isArray(parsed.drives) || !Array.isArray(parsed.targets)) {
    throw new Error("mw-ww-cli audit payload missing drives or targets array");
  }

  const drives: StorageDriveMetric[] = parsed.drives.map((entry: unknown) => {
    if (!isRecord(entry) || typeof entry.drive !== "string" || typeof entry.total !== "number" || typeof entry.free !== "number") {
      throw new Error("mw-ww-cli drive entry malformed");
    }
    const status = entry.status === "critical" || entry.status === "warn" ? entry.status : "ok";
    return {
      drive: entry.drive,
      label: typeof entry.label === "string" ? entry.label : undefined,
      totalBytes: entry.total,
      freeBytes: entry.free,
      usedPct: typeof entry.usedPct === "number" ? entry.usedPct : 0,
      status,
    };
  });

  const targets: StorageCleanTarget[] = parsed.targets.map((entry: unknown) => {
    if (!isRecord(entry) || typeof entry.path !== "string" || typeof entry.bytes !== "number") {
      throw new Error("mw-ww-cli target entry malformed");
    }
    const safety = entry.safety === "safe" || entry.safety === "protected" ? entry.safety : "caution";
    return {
      path: entry.path,
      name: typeof entry.name === "string" ? entry.name : entry.path,
      bytes: entry.bytes,
      fileCount: typeof entry.fileCount === "number" ? entry.fileCount : 0,
      category: typeof entry.category === "string" ? entry.category : "General Files",
      safety,
      depth: typeof entry.depth === "number" ? entry.depth : 0,
    };
  });

  return {
    drives,
    targets,
    safeBytes: typeof parsed.safeBytes === "number" ? parsed.safeBytes : 0,
    cautionBytes: typeof parsed.cautionBytes === "number" ? parsed.cautionBytes : 0,
    criticalDrives: typeof parsed.criticalDrives === "number" ? parsed.criticalDrives : 0,
    generatedAt: typeof parsed.generatedAt === "string" ? parsed.generatedAt : new Date().toISOString(),
  };
}

export function parseMwWwDryRunOutput(rawJson: string): DryRunSweepResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawJson);
  } catch {
    throw new Error("mw-ww-cli clean-safe output is not valid JSON");
  }
  if (!isRecord(parsed) || typeof parsed.dryRun !== "boolean" || typeof parsed.freedBytes !== "number") {
    throw new Error("mw-ww-cli clean-safe payload malformed");
  }
  return {
    paths: Array.isArray(parsed.paths) ? parsed.paths.filter((p): p is string => typeof p === "string") : [],
    dryRun: parsed.dryRun,
    freedBytes: parsed.freedBytes,
    deletedFiles: typeof parsed.deletedFiles === "number" ? parsed.deletedFiles : 0,
    skippedBusy: typeof parsed.skippedBusy === "number" ? parsed.skippedBusy : 0,
    errors: Array.isArray(parsed.errors) ? parsed.errors.filter((e): e is string => typeof e === "string") : [],
    recordId: typeof parsed.recordId === "string" ? parsed.recordId : "",
  };
}

export function buildSidebarStorageGaugeModel(report: StorageAuditReport, preferredDrive = "C"): SidebarStorageGaugeModel {
  const primary =
    report.drives.find((d) => d.drive.toUpperCase() === preferredDrive.toUpperCase()) ??
    report.drives[0] ?? {
      drive: preferredDrive,
      totalBytes: 0,
      freeBytes: 0,
      usedPct: 0,
      status: "ok" as const,
    };

  return {
    primaryDrive: primary.drive,
    usedPct: primary.usedPct,
    freeGb: toGb(primary.freeBytes),
    totalGb: toGb(primary.totalBytes),
    safeReclaimGb: toGb(report.safeBytes),
    cautionReclaimGb: toGb(report.cautionBytes),
    status: primary.status,
    criticalDrives: report.criticalDrives,
    canTriggerSweep: report.safeBytes > 0,
    generatedAt: report.generatedAt,
  };
}

export class SidebarStorageGaugeController {
  private readonly runner: CliRunner;
  private readonly preferredDrive: string;

  constructor(options: { runner: CliRunner; preferredDrive?: string }) {
    this.runner = options.runner;
    this.preferredDrive = options.preferredDrive ?? "C";
  }

  async refreshGauge(): Promise<SidebarStorageGaugeModel> {
    const res = await this.runner(["--audit", "--json"]);
    if (res.exitCode !== 0) {
      throw new Error(`mw-ww-cli --audit failed (exit ${res.exitCode}): ${res.stderr.trim()}`);
    }
    const report = parseMwWwAuditOutput(res.stdout);
    return buildSidebarStorageGaugeModel(report, this.preferredDrive);
  }

  async triggerDryRunSweep(customPath?: string): Promise<DryRunSweepResult> {
    const args = ["--clean-safe", "--dry-run", "--json"];
    if (customPath && customPath.trim().length > 0) {
      args.push("--path", customPath.trim());
    }
    const res = await this.runner(args);
    if (res.exitCode !== 0) {
      throw new Error(`mw-ww-cli --clean-safe --dry-run failed (exit ${res.exitCode}): ${res.stderr.trim()}`);
    }
    const parsed = parseMwWwDryRunOutput(res.stdout);
    if (!parsed.dryRun) {
      throw new Error("sidebar dry-run sweep trigger refused non-dry-run execution");
    }
    return parsed;
  }
}
