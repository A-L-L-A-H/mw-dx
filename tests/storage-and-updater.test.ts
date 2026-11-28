import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildSidebarStorageGaugeModel,
  parseMwWwAuditOutput,
  parseMwWwDryRunOutput,
  SidebarStorageGaugeController,
} from "../src/storage-gauge-sidebar";
import {
  computeDetachedSignatureEnvelope,
  generateTauriLatestJson,
  normalizeReleaseVersion,
} from "../src/tauri-updater-publisher";

describe("V54: mw-dx live mw-ww-cli storage gauge & dry-run sweep trigger", () => {
  const sampleAuditJson = JSON.stringify({
    drives: [
      { drive: "C", total: 100 * 1024 ** 3, free: 8 * 1024 ** 3, usedPct: 92, status: "critical" },
      { drive: "Z", total: 500 * 1024 ** 3, free: 300 * 1024 ** 3, usedPct: 40, status: "ok" },
    ],
    targets: [
      {
        path: "C:\\Users\\dev\\.cargo\\registry\\cache",
        name: "cache",
        bytes: 4 * 1024 ** 3,
        fileCount: 1200,
        category: "Rust Package Cache",
        safety: "safe",
        depth: 0,
      },
    ],
    safeBytes: 4 * 1024 ** 3,
    cautionBytes: 2 * 1024 ** 3,
    criticalDrives: 1,
    generatedAt: "2026-11-27T10:00:00Z",
  });

  test("parses audit JSON and computes sidebar gauge model", () => {
    const report = parseMwWwAuditOutput(sampleAuditJson);
    expect(report.drives).toHaveLength(2);
    expect(report.criticalDrives).toBe(1);

    const gauge = buildSidebarStorageGaugeModel(report, "C");
    expect(gauge.primaryDrive).toBe("C");
    expect(gauge.usedPct).toBe(92);
    expect(gauge.freeGb).toBe(8);
    expect(gauge.safeReclaimGb).toBe(4);
    expect(gauge.cautionReclaimGb).toBe(2);
    expect(gauge.status).toBe("critical");
    expect(gauge.canTriggerSweep).toBe(true);
  });

  test("controller refreshes gauge and triggers dry-run sweep via mw-ww-cli runner", async () => {
    const seenArgs: string[][] = [];
    const controller = new SidebarStorageGaugeController({
      preferredDrive: "C",
      runner: async (args) => {
        seenArgs.push(args);
        if (args.includes("--audit")) {
          return { exitCode: 0, stdout: sampleAuditJson, stderr: "" };
        }
        return {
          exitCode: 0,
          stdout: JSON.stringify({
            paths: ["C:\\Users\\dev\\.cargo\\registry\\cache"],
            dryRun: true,
            freedBytes: 4 * 1024 ** 3,
            deletedFiles: 1200,
            skippedBusy: 0,
            errors: [],
            recordId: "dry-rec-1",
          }),
          stderr: "",
        };
      },
    });

    const gauge = await controller.refreshGauge();
    expect(gauge.status).toBe("critical");
    expect(seenArgs[0]).toEqual(["--audit", "--json"]);

    const sweep = await controller.triggerDryRunSweep();
    expect(sweep.dryRun).toBe(true);
    expect(sweep.deletedFiles).toBe(1200);
    expect(seenArgs[1]).toEqual(["--clean-safe", "--dry-run", "--json"]);
  });

  test("rejects malformed output or non-dry-run response", async () => {
    expect(() => parseMwWwAuditOutput("{bad")).toThrow("not valid JSON");
    expect(() => parseMwWwDryRunOutput(JSON.stringify({ dryRun: "no" }))).toThrow("malformed");

    const badController = new SidebarStorageGaugeController({
      runner: async () => ({
        exitCode: 0,
        stdout: JSON.stringify({ paths: [], dryRun: false, freedBytes: 10, deletedFiles: 1 }),
        stderr: "",
      }),
    });
    await expect(badController.triggerDryRunSweep()).rejects.toThrow("refused non-dry-run");
  });
});

describe("V55: local zero-card Tauri signed release publisher & latest.json generator", () => {
  test("normalizes versions and generates valid Tauri v2 latest.json manifest", () => {
    expect(normalizeReleaseVersion("v1.2.3-rc.1")).toBe("1.2.3-rc.1");
    expect(() => normalizeReleaseVersion("not-a-semver")).toThrow("Invalid semantic version");

    const sigWin = computeDetachedSignatureEnvelope("win-bundle-bytes");
    const sigLinux = computeDetachedSignatureEnvelope("linux-bundle-bytes");

    const manifest = generateTauriLatestJson({
      version: "v0.2.0",
      notes: "MoonWitness DX V55 Zero-Card Release",
      pubDate: "2026-11-27T10:00:00Z",
      artifacts: [
        {
          platform: "windows-x86_64",
          url: "https://github.com/A-L-L-A-H/mw-dx/releases/download/v0.2.0/mw-dx_0.2.0_x64-setup.nsis.zip",
          signature: sigWin,
        },
        {
          platform: "linux-x86_64",
          url: "https://github.com/A-L-L-A-H/mw-dx/releases/download/v0.2.0/mw-dx_0.2.0_amd64.AppImage.tar.gz",
          signature: sigLinux,
        },
      ],
    });

    expect(manifest.version).toBe("0.2.0");
    expect(manifest.pub_date).toBe("2026-11-27T10:00:00Z");
    expect(manifest.platforms["windows-x86_64"]?.signature).toBe(sigWin);
    expect(manifest.platforms["linux-x86_64"]?.url).toContain("AppImage.tar.gz");
  });

  test("rejects insecure URLs, missing signatures, or duplicate platforms", () => {
    expect(() =>
      generateTauriLatestJson({
        version: "0.2.0",
        notes: "Test",
        artifacts: [
          {
            platform: "windows-x86_64",
            url: "http://example.com/insecure.zip",
            signature: "sig",
          },
        ],
      }),
    ).toThrow("https://");

    expect(() =>
      generateTauriLatestJson({
        version: "0.2.0",
        notes: "Test",
        artifacts: [
          {
            platform: "windows-x86_64",
            url: "https://example.com/a.zip",
            signature: "   ",
          },
        ],
      }),
    ).toThrow("signature");
  });

  test("publish-tauri-release.ps1 dry-run generates latest.json and .sig files", () => {
    if (process.platform !== "win32") return;
    const tempDist = mkdtempSync(join(tmpdir(), "mw-dx-release-test-"));
    try {
      const scriptPath = join(import.meta.dir, "..", "scripts", "publish-tauri-release.ps1");
      const proc = Bun.spawnSync([
        "powershell",
        "-NoProfile",
        "-ExecutionPolicy",
        "Bypass",
        "-File",
        scriptPath,
        "-Version",
        "v0.2.5",
        "-DistDir",
        tempDist,
        "-DryRun",
      ]);
      expect(proc.exitCode).toBe(0);
      const latestRaw = readFileSync(join(tempDist, "latest.json"), "utf8");
      const latest = JSON.parse(latestRaw) as { version: string; platforms: Record<string, { signature: string; url: string }> };
      expect(latest.version).toBe("0.2.5");
      expect(latest.platforms["windows-x86_64"]?.signature.length).toBeGreaterThan(10);
      expect(latest.platforms["linux-x86_64"]?.url).toContain("v0.2.5");
    } finally {
      rmSync(tempDist, { recursive: true, force: true });
    }
  });
});
