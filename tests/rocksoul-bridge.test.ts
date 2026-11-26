import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { BridgeError, RocksoulDesktopBridge } from "../src/index";

const json = (payload: unknown, status = 200): Response => Response.json(payload, { status });

let server: ReturnType<typeof Bun.serve>;
let bridge: RocksoulDesktopBridge;

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    async fetch(req) {
      const { pathname } = new URL(req.url);
      if (pathname === "/health") return json({ ok: true });
      if (pathname === "/v1/risk/evaluate") return json({ allowed: false, score: 0.9, reason: "deny" });
      if (pathname === "/leases") return json({ leaseId: "l1", path: "/wt", expiresAt: "2030-01-01T00:00:00Z" });
      if (pathname === "/exec") return json({ exitCode: 0, stdout: "hi", stderr: "" });
      if (pathname === "/mcp/tools") return json({ tools: [{ name: "t1", description: "d" }] });
      if (pathname === "/mcp/rpc") {
        const body = (await req.json()) as { jsonrpc: string; method: string; params: { name: string } };
        if (body.jsonrpc !== "2.0" || body.method !== "tools/call") return json({ error: { code: -32601 } });
        return json({ jsonrpc: "2.0", id: "x", result: { echoed: body.params.name } });
      }
      if (pathname === "/leases/l1" && req.method === "DELETE") return json({ released: true });
      if (pathname === "/v1/chat/completions") {
        return json({ id: "c1", choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }] });
      }
      if (pathname === "/v1/sessions") return json({ sessions: [{ id: "s1", title: "T", mode: "act" }] });
      if (pathname === "/v1/sessions/s1/resume" && req.method === "POST") return json({ id: "s1", title: "T", mode: "act", messageCount: 3 });
      if (pathname === "/leases/l1/undo" && req.method === "POST") return json({ checkpointId: "cp1", label: "turn" });
      if (pathname === "/v1/approvals/c1" && req.method === "POST") {
        const body = (await req.json()) as { decision: string };
        return json({ challengeId: "c1", status: body.decision === "approve" ? "approved" : "denied" });
      }
      return json({}, 404);
    },
  });
  const url = `http://127.0.0.1:${server.port}`;
  bridge = new RocksoulDesktopBridge({ baseUrls: { gateway: url, core: url, mcp: url, sandbox: url, rid: url } });
});
afterAll(() => server.stop(true));

describe("RocksoulDesktopBridge", () => {
  test("fleet snapshot healthy", async () => {
    const snap = await bridge.getFleetSnapshot();
    expect(snap.healthy).toBe(true);
    expect(snap.daemons).toHaveLength(5);
  });
  test("evaluateRisk", async () => {
    expect(await bridge.evaluateRisk({ action: "rm" })).toEqual({ allowed: false, score: 0.9, reason: "deny" });
  });
  test("acquireWorktreeLease", async () => {
    expect((await bridge.acquireWorktreeLease("r", "b")).leaseId).toBe("l1");
  });
  test("releaseWorktreeLease", async () => {
    await bridge.releaseWorktreeLease("l1");
  });
  test("execInSandbox", async () => {
    expect((await bridge.execInSandbox({ command: "echo" })).stdout).toBe("hi");
  });
  test("listMcpTools", async () => {
    expect((await bridge.listMcpTools())[0]?.name).toBe("t1");
  });
  test("callMcpTool", async () => {
    expect(await bridge.callMcpTool("t1", {})).toEqual({ echoed: "t1" });
  });
  test("session, undo and approval", async () => {
    expect((await bridge.listSessions())[0]?.id).toBe("s1");
    expect((await bridge.resumeSession("s1")).messageCount).toBe(3);
    expect((await bridge.undoCheckpoint("l1")).checkpointId).toBe("cp1");
    expect((await bridge.submitApproval("c1", "approve")).status).toBe("approved");
    expect((await bridge.submitApproval("c1", "deny")).status).toBe("denied");
  });
  test("chatCompletion", async () => {
    expect((await bridge.chatCompletion({ model: "m", messages: [] })).id).toBe("c1");
  });
});

describe("fail-closed", () => {
  test("unreachable daemon throws and snapshot unhealthy", async () => {
    const dead = "http://127.0.0.1:1";
    const down = new RocksoulDesktopBridge({ baseUrls: { gateway: dead, core: dead, mcp: dead, sandbox: dead, rid: dead }, timeoutMs: 500 });
    await expect(down.evaluateRisk({ action: "x" })).rejects.toBeInstanceOf(BridgeError);
    expect((await down.getFleetSnapshot()).healthy).toBe(false);
  });
  test("http error throws", async () => {
    const failing = new RocksoulDesktopBridge({ fetchImpl: (async () => json({}, 500)) as unknown as typeof fetch });
    await expect(failing.listMcpTools()).rejects.toMatchObject({ reason: "http", status: 500 });
  });
  test("malformed verdict throws", async () => {
    const malformed = new RocksoulDesktopBridge({ fetchImpl: (async () => json({ ok: true })) as unknown as typeof fetch });
    await expect(malformed.evaluateRisk({ action: "x" })).rejects.toMatchObject({ reason: "invalid-response" });
    await expect(malformed.execInSandbox({ command: "x" })).rejects.toBeInstanceOf(BridgeError);
    await expect(malformed.acquireWorktreeLease("r", "b")).rejects.toBeInstanceOf(BridgeError);
    await expect(malformed.chatCompletion({ model: "m", messages: [] })).rejects.toBeInstanceOf(BridgeError);
    await expect(malformed.callMcpTool("t", {})).rejects.toBeInstanceOf(BridgeError);
    await expect(malformed.listSessions()).rejects.toBeInstanceOf(BridgeError);
    await expect(malformed.resumeSession("s")).rejects.toBeInstanceOf(BridgeError);
    await expect(malformed.undoCheckpoint("l")).rejects.toBeInstanceOf(BridgeError);
    await expect(malformed.submitApproval("c", "deny")).rejects.toBeInstanceOf(BridgeError);
  });
});



