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
      if (pathname === "/v1/worktree/lease") return json({ leaseId: "l1", path: "/wt", expiresAt: "2030-01-01T00:00:00Z" });
      if (pathname === "/v1/exec") return json({ exitCode: 0, stdout: "hi", stderr: "" });
      if (pathname === "/v1/tools") return json({ tools: [{ name: "t1", description: "d" }] });
      if (pathname === "/v1/tools/call") {
        const body = (await req.json()) as { name: string };
        return json({ result: { echoed: body.name } });
      }
      if (pathname === "/v1/chat/completions") {
        return json({ id: "c1", choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }] });
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
  test("execInSandbox", async () => {
    expect((await bridge.execInSandbox({ command: "echo" })).stdout).toBe("hi");
  });
  test("listMcpTools", async () => {
    expect((await bridge.listMcpTools())[0]?.name).toBe("t1");
  });
  test("callMcpTool", async () => {
    expect(await bridge.callMcpTool("t1", {})).toEqual({ echoed: "t1" });
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
  });
});
