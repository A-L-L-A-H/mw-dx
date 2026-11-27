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
  validatePlanId
} from "../src/plan-taskos-panel";

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
});
