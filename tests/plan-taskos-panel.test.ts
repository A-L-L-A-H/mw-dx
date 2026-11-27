import { describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildPlanPanelFromV2,
  discoverPlanPanels,
  filterPlanTasks,
  getReadyFrontier,
  loadPlanPanel,
  parseLegacyPlanMarkdown,
  PlanPanelError,
  renderPlanPanelText,
  validatePlanId,
} from "../src/index";

describe("plan-taskos-panel", () => {
  test("validatePlanId validates strict plan IDs and rejects traversal or path separators", () => {
    expect(validatePlanId("core-system-v1")).toBe("core-system-v1");
    expect(validatePlanId("T58_dx_panel")).toBe("T58_dx_panel");

    expect(() => validatePlanId("")).toThrow(PlanPanelError);
    expect(() => validatePlanId("..")).toThrow(PlanPanelError);
    expect(() => validatePlanId("../escape")).toThrow(PlanPanelError);
    expect(() => validatePlanId("sub/dir")).toThrow(PlanPanelError);
    expect(() => validatePlanId("sub\\dir")).toThrow(PlanPanelError);
  });

  test("parseLegacyPlanMarkdown parses markdown checklist into PlanPanelModel", () => {
    const md = `# MoonWitness Core System

### Wave 1: Foundation
- [x] **T01** - Project initialization
- [ ] **T02** - Database configuration

### Wave 2: Services
- [ ] **T03** - Auth gateway
`;
    const model = parseLegacyPlanMarkdown(md, "core-system");
    expect(model.planId).toBe("core-system");
    expect(model.title).toBe("MoonWitness Core System");
    expect(model.format).toBe("legacy-markdown");
    expect(model.total).toBe(3);
    expect(model.done).toBe(1);
    expect(model.ready).toBe(2);
    expect(model.waves.length).toBe(2);
    expect(model.waves[0]?.waveId).toBe("W1");
    expect(model.waves[0]?.done).toBe(1);
    expect(model.waves[1]?.waveId).toBe("W2");
    expect(model.percent).toBeCloseTo(33.3, 1);

    const rendered = renderPlanPanelText(model);
    expect(rendered).toContain("MoonWitness Core System (core-system) [legacy-markdown]");
    expect(rendered).toContain("Progress: 33.3%");
  });

  test("buildPlanPanelFromV2 evaluates DAG status, dependencies, and proofs", () => {
    const manifest = {
      plan_id: "mw-panel-v2",
      title: "Plan TaskOS V2 System",
      waves: [
        { id: "W1", title: "Wave 1 - Engine", depends_on: [] },
        { id: "W2", title: "Wave 2 - Integration", depends_on: ["W1"] }
      ]
    };

    const waves = [
      {
        wave_id: "W1",
        title: "Wave 1 - Engine",
        tasks: [
          {
            code: "T01",
            urn: "urn:mw:work:mw-panel-v2:W1/T01",
            title: "Task One",
            lifecycle: { status: "done", attempts: 1 },
            graph: { depends_on: [] },
            governance: { owner_files: ["src/a.ts"] },
            verification: { commands: ["bun test"], acceptance_criteria: ["Passes"] }
          },
          {
            code: "T02",
            urn: "urn:mw:work:mw-panel-v2:W1/T02",
            title: "Task Two",
            lifecycle: { status: "todo", attempts: 0 },
            graph: { depends_on: ["T01"] },
            governance: { owner_files: ["src/b.ts"] },
            verification: { commands: ["bun test"], acceptance_criteria: ["Passes"] }
          }
        ]
      },
      {
        wave_id: "W2",
        title: "Wave 2 - Integration",
        tasks: [
          {
            code: "T03",
            urn: "urn:mw:work:mw-panel-v2:W2/T03",
            title: "Task Three",
            lifecycle: { status: "todo", attempts: 0 },
            graph: { depends_on: ["T02"] },
            governance: { owner_files: ["src/b.ts", "src/c.ts"] },
            verification: { commands: [], acceptance_criteria: [] }
          }
        ]
      }
    ];

    const proofs = [
      {
        code: "T01",
        task_urn: "urn:mw:work:mw-panel-v2:W1/T01",
        commit_sha: "abcdef1234567890"
      }
    ];

    const model = buildPlanPanelFromV2(manifest, waves, proofs);
    expect(model.planId).toBe("mw-panel-v2");
    expect(model.format).toBe("plan-taskos/v1");
    expect(model.total).toBe(3);
    expect(model.done).toBe(1);
    expect(model.ready).toBe(1);
    expect(model.blocked).toBe(1);

    const t1 = model.tasks.find((t) => t.code === "T01");
    expect(t1?.dagState).toBe("done");
    expect(t1?.hasProof).toBe(true);
    expect(t1?.commitSha).toBe("abcdef1234567890");

    const t2 = model.tasks.find((t) => t.code === "T02");
    expect(t2?.dagState).toBe("ready");

    const t3 = model.tasks.find((t) => t.code === "T03");
    expect(t3?.dagState).toBe("blocked");

    expect(model.nextReadyTaskIds).toEqual(["T02"]);
    expect(model.criticalPathIds).toEqual(["T02", "T03"]);

    const filtered = filterPlanTasks(model, { query: "Task Two" });
    expect(filtered.length).toBe(1);
    expect(filtered[0]?.code).toBe("T02");

    const frontier = getReadyFrontier(model, 2);
    expect(frontier.length).toBe(1);
    expect(frontier[0]?.code).toBe("T02");
  });

  test("loadPlanPanel and discoverPlanPanels read from filesystem and handle errors", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "mw-panel-test-"));
    try {
      const planDir = join(tempDir, ".plan");
      await mkdir(join(planDir, "demo-plan"), { recursive: true });

      const manifest = {
        plan_id: "demo-plan",
        title: "Demo Plan Title",
        waves: [
          {
            id: "W1",
            title: "Wave 1",
            depends_on: [],
            wave_file: "waves/w1.json"
          }
        ]
      };
      await writeFile(join(planDir, "demo-plan", "manifest.json"), JSON.stringify(manifest), "utf8");

      await mkdir(join(planDir, "demo-plan", "waves"), { recursive: true });
      const wave1 = {
        wave_id: "W1",
        title: "Wave 1",
        tasks: [
          {
            code: "T10",
            urn: "urn:mw:work:demo-plan:W1/T10",
            title: "Task 10",
            lifecycle: { status: "done" },
            graph: { depends_on: [] },
            governance: { owner_files: [] },
            verification: {}
          }
        ]
      };
      await writeFile(join(planDir, "demo-plan", "waves", "w1.json"), JSON.stringify(wave1), "utf8");

      const loaded = await loadPlanPanel(tempDir, "demo-plan");
      expect(loaded.planId).toBe("demo-plan");
      expect(loaded.total).toBe(1);
      expect(loaded.done).toBe(1);

      const discovered = await discoverPlanPanels(tempDir);
      expect(discovered.length).toBe(1);
      expect(discovered[0]?.planId).toBe("demo-plan");

      await expect(loadPlanPanel(tempDir, "non-existent")).rejects.toThrow(PlanPanelError);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  test("loadPlanPanel loads evidence proofs, handles active/skipped states, and prefers v2 over legacy markdown", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "mw-panel-v2-pref-"));
    try {
      const planDir = join(tempDir, ".plan");
      const v2Dir = join(planDir, "dual-plan");
      await mkdir(join(v2Dir, "waves"), { recursive: true });
      await mkdir(join(v2Dir, "evidence"), { recursive: true });
      await mkdir(join(planDir, ".brain"), { recursive: true });

      await writeFile(
        join(planDir, "dual-plan.md"),
        "# Legacy Dual Plan\n\n### Wave 1: Legacy\n- [ ] **T99** — Legacy task\n",
        "utf8",
      );
      await writeFile(
        join(planDir, "legacy-only.md"),
        "# Legacy Only\n\n### Wave 1: Solo\n- [x] **T01** — Done legacy\n- [ ] **T02** — Todo legacy\n",
        "utf8",
      );

      const manifest = {
        plan_id: "dual-plan",
        title: "V2 Preferred Plan",
        waves: [{ id: "W0", title: "Wave 0", depends_on: [], wave_file: "waves/W0.json" }],
      };
      await writeFile(join(v2Dir, "manifest.json"), JSON.stringify(manifest), "utf8");

      const w0 = {
        wave_id: "W0",
        title: "Wave 0",
        tasks: [
          {
            code: "T01",
            urn: "urn:mw:work:dual-plan:W0/T01",
            title: "Completed with proof",
            lifecycle: { status: "done" },
            graph: { depends_on: [] },
            governance: { owner_files: ["src/a.ts"] },
            verification: { commands: ["bun test"], acceptance_criteria: ["ok"] },
          },
          {
            code: "T02",
            urn: "urn:mw:work:dual-plan:W0/T02",
            title: "Active work",
            lifecycle: { status: "in_progress" },
            graph: { depends_on: ["T01"] },
            governance: { owner_files: ["src/b.ts"] },
            verification: {},
          },
          {
            code: "T03",
            urn: "urn:mw:work:dual-plan:W0/T03",
            title: "Skipped work",
            lifecycle: { status: "skipped" },
            graph: { depends_on: [] },
            governance: { owner_files: [] },
            verification: {},
          },
        ],
      };
      await writeFile(join(v2Dir, "waves", "W0.json"), JSON.stringify(w0), "utf8");
      await writeFile(
        join(v2Dir, "evidence", "T01.proof.json"),
        JSON.stringify({ code: "T01", task_urn: "urn:mw:work:dual-plan:W0/T01", commit_sha: "deadbeef" }),
        "utf8",
      );

      const loadedDual = await loadPlanPanel(tempDir, "dual-plan");
      expect(loadedDual.format).toBe("plan-taskos/v1");
      expect(loadedDual.done).toBe(1);
      expect(loadedDual.active).toBe(1);
      expect(loadedDual.skipped).toBe(1);
      expect(loadedDual.tasks[0]?.hasProof).toBe(true);
      expect(loadedDual.tasks[0]?.commitSha).toBe("deadbeef");

      const legacyFallback = await loadPlanPanel(tempDir, "legacy-only");
      expect(legacyFallback.format).toBe("legacy-markdown");
      expect(legacyFallback.done).toBe(1);
      expect(legacyFallback.ready).toBe(1);

      const discovered = await discoverPlanPanels(tempDir);
      expect(discovered.map((p) => p.planId)).toEqual(["dual-plan", "legacy-only"]);
      expect(discovered[0]?.format).toBe("plan-taskos/v1");
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  test("handles cyclic dependencies safely and selects disjoint ownerFiles in getReadyFrontier", () => {
    const manifest = {
      plan_id: "cycle-frontier",
      title: "Cycle and Frontier Test",
      waves: [{ id: "W1", title: "Wave 1", depends_on: [] }],
    };
    const waves = [
      {
        wave_id: "W1",
        title: "Wave 1",
        tasks: [
          {
            code: "T01",
            urn: "urn:mw:work:cycle-frontier:W1/T01",
            title: "Ready critical root",
            lifecycle: { status: "todo" },
            graph: { depends_on: [] },
            governance: { owner_files: ["src/shared.ts"] },
            verification: {},
          },
          {
            code: "T02",
            urn: "urn:mw:work:cycle-frontier:W1/T02",
            title: "Ready overlapping file",
            lifecycle: { status: "todo" },
            graph: { depends_on: [] },
            governance: { owner_files: ["src/shared.ts", "src/other.ts"] },
            verification: {},
          },
          {
            code: "T03",
            urn: "urn:mw:work:cycle-frontier:W1/T03",
            title: "Ready disjoint file",
            lifecycle: { status: "todo" },
            graph: { depends_on: [] },
            governance: { owner_files: ["src/independent.ts"] },
            verification: {},
          },
          {
            code: "T04",
            urn: "urn:mw:work:cycle-frontier:W1/T04",
            title: "Downstream on T01",
            lifecycle: { status: "todo" },
            graph: { depends_on: ["T01"] },
            governance: { owner_files: ["src/down.ts"] },
            verification: {},
          },
          {
            code: "T05",
            urn: "urn:mw:work:cycle-frontier:W1/T05",
            title: "Cycle A",
            lifecycle: { status: "todo" },
            graph: { depends_on: ["T06"] },
            governance: { owner_files: [] },
            verification: {},
          },
          {
            code: "T06",
            urn: "urn:mw:work:cycle-frontier:W1/T06",
            title: "Cycle B",
            lifecycle: { status: "todo" },
            graph: { depends_on: ["T05"] },
            governance: { owner_files: [] },
            verification: {},
          },
        ],
      },
    ];

    const model = buildPlanPanelFromV2(manifest, waves);
    expect(model.cycles.length).toBeGreaterThan(0);
    expect(model.tasks.find((t) => t.code === "T05")?.dagState).toBe("blocked");
    expect(model.tasks.find((t) => t.code === "T06")?.dagState).toBe("blocked");
    expect(model.criticalPathIds).toEqual(["T01", "T04"]);

    const frontier = getReadyFrontier(model, 5);
    expect(frontier.map((t) => t.code)).toEqual(["T01", "T03"]);
    expect(renderPlanPanelText(model)).toContain("Cycles:");
  });

  test("error edge cases: missing .plan dir, not-found, invalid-path, and invalid-plan", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "mw-panel-err-"));
    try {
      expect(await discoverPlanPanels(tempDir)).toEqual([]);

      await expect(loadPlanPanel(tempDir, "missing-plan")).rejects.toMatchObject({ reason: "not-found" });
      await expect(loadPlanPanel(tempDir, "../escape")).rejects.toMatchObject({ reason: "invalid-path" });

      const badPlanDir = join(tempDir, ".plan", "broken-json");
      await mkdir(badPlanDir, { recursive: true });
      await writeFile(join(badPlanDir, "manifest.json"), "{not-valid-json", "utf8");

      await expect(loadPlanPanel(tempDir, "broken-json")).rejects.toMatchObject({ reason: "invalid-plan" });
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  test("computeCriticalPath emits no duplicate node IDs on in_progress cyclic tasks", () => {
    const manifest = {
      plan_id: "active-cycle",
      title: "Active Cycle Plan",
      waves: [{ id: "W1", title: "Wave 1", depends_on: [] }],
    };
    const pureCycleWaves = [
      {
        wave_id: "W1",
        title: "Wave 1",
        tasks: [
          {
            code: "A",
            urn: "urn:mw:work:active-cycle:W1/A",
            title: "Active Cycle A",
            lifecycle: { status: "in_progress" },
            graph: { depends_on: ["B"] },
            governance: { owner_files: [] },
            verification: {},
          },
          {
            code: "B",
            urn: "urn:mw:work:active-cycle:W1/B",
            title: "Active Cycle B",
            lifecycle: { status: "in_progress" },
            graph: { depends_on: ["A"] },
            governance: { owner_files: [] },
            verification: {},
          },
        ],
      },
    ];

    const pureModel = buildPlanPanelFromV2(manifest, pureCycleWaves);
    expect(pureModel.cycles.length).toBeGreaterThan(0);
    expect(new Set(pureModel.criticalPathIds).size).toBe(pureModel.criticalPathIds.length);
    expect(pureModel.criticalPathIds).toEqual(["A", "B"]);

    const prefixedCycleWaves = [
      {
        wave_id: "W1",
        title: "Wave 1",
        tasks: [
          ...pureCycleWaves[0]!.tasks.map((task) =>
            task.code === "A" ? { ...task, graph: { depends_on: ["B", "X"] } } : task,
          ),
          {
            code: "X",
            urn: "urn:mw:work:active-cycle:W1/X",
            title: "Upstream into Cycle",
            lifecycle: { status: "in_progress" },
            graph: { depends_on: [] },
            governance: { owner_files: [] },
            verification: {},
          },
        ],
      },
    ];

    const prefixedModel = buildPlanPanelFromV2(manifest, prefixedCycleWaves);
    expect(new Set(prefixedModel.criticalPathIds).size).toBe(prefixedModel.criticalPathIds.length);
    expect(prefixedModel.criticalPathIds).toEqual(["X", "A", "B"]);
  });
});
