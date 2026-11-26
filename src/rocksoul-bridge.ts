export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };
export type JsonObject = { [key: string]: JsonValue };

export type DaemonName = "gateway" | "core" | "mcp" | "sandbox" | "rid";

export interface BridgeConfig {
  baseUrls: Record<DaemonName, string>;
  timeoutMs: number;
  fetchImpl: typeof fetch;
}

export const DEFAULT_BASE_URLS: Record<DaemonName, string> = {
  gateway: "http://127.0.0.1:4510",
  core: "http://127.0.0.1:4520",
  mcp: "http://127.0.0.1:4530",
  sandbox: "http://127.0.0.1:4540",
  rid: "http://127.0.0.1:4480",
};

export class BridgeError extends Error {
  constructor(
    readonly daemon: DaemonName,
    readonly path: string,
    readonly reason: "unreachable" | "http" | "invalid-response",
    readonly status?: number,
  ) {
    super(`rocksoul ${daemon} ${path} failed: ${reason}${status === undefined ? "" : ` ${status}`}`);
    this.name = "BridgeError";
  }
}

export interface DaemonHealth {
  daemon: DaemonName;
  url: string;
  ok: boolean;
  error?: string;
}
export interface FleetSnapshot {
  healthy: boolean;
  daemons: DaemonHealth[];
}
export interface RiskRequest { action: string; target?: string; context?: JsonObject }
export interface RiskVerdict { allowed: boolean; score: number; reason?: string }
export interface WorktreeLease { leaseId: string; path: string; expiresAt: string }
export interface SandboxExecRequest { command: string; args?: string[]; cwd?: string; timeoutMs?: number }
export interface SandboxExecResult { exitCode: number; stdout: string; stderr: string }
export interface McpTool { name: string; description?: string; inputSchema?: JsonObject }
export interface ChatMessage { role: "system" | "user" | "assistant" | "tool"; content: string }
export interface ChatRequest { model: string; messages: ChatMessage[]; temperature?: number }
export interface ChatCompletion {
  id: string;
  choices: { index: number; message: ChatMessage; finish_reason: string | null }[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export class RocksoulDesktopBridge {
  private readonly config: BridgeConfig;

  constructor(overrides: Partial<BridgeConfig> = {}) {
    this.config = {
      baseUrls: { ...DEFAULT_BASE_URLS, ...overrides.baseUrls },
      timeoutMs: overrides.timeoutMs ?? 5000,
      fetchImpl: overrides.fetchImpl ?? fetch,
    };
  }

  private async request(daemon: DaemonName, path: string, method: "GET" | "POST" | "DELETE", body?: unknown): Promise<Record<string, unknown>> {
    let response: Response;
    try {
      response = await this.config.fetchImpl(`${this.config.baseUrls[daemon]}${path}`, {
        method,
        headers: { "content-type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(this.config.timeoutMs),
      });
    } catch {
      throw new BridgeError(daemon, path, "unreachable");
    }
    if (!response.ok) throw new BridgeError(daemon, path, "http", response.status);
    let parsed: unknown;
    try {
      parsed = await response.json();
    } catch {
      throw new BridgeError(daemon, path, "invalid-response", response.status);
    }
    if (!isRecord(parsed)) throw new BridgeError(daemon, path, "invalid-response", response.status);
    return parsed;
  }

  async getFleetSnapshot(): Promise<FleetSnapshot> {
    const names = Object.keys(this.config.baseUrls) as DaemonName[];
    const daemons = await Promise.all(
      names.map(async (daemon): Promise<DaemonHealth> => {
        const url = this.config.baseUrls[daemon];
        try {
          await this.request(daemon, "/health", "GET");
          return { daemon, url, ok: true };
        } catch (caught) {
          return { daemon, url, ok: false, error: caught instanceof Error ? caught.message : "unknown" };
        }
      }),
    );
    return { healthy: daemons.every((entry) => entry.ok), daemons };
  }

  /** Fail-closed: a verdict must be an explicit boolean `allowed`, else error. */
  async evaluateRisk(input: RiskRequest): Promise<RiskVerdict> {
    const raw = await this.request("rid", "/v1/risk/evaluate", "POST", input);
    if (typeof raw.allowed !== "boolean" || typeof raw.score !== "number") {
      throw new BridgeError("rid", "/v1/risk/evaluate", "invalid-response");
    }
    return { allowed: raw.allowed, score: raw.score, reason: typeof raw.reason === "string" ? raw.reason : undefined };
  }

  async acquireWorktreeLease(repo: string, branch: string): Promise<WorktreeLease> {
    const path = "/leases";
    const raw = await this.request("sandbox", path, "POST", { repo, branch });
    if (typeof raw.leaseId !== "string" || typeof raw.path !== "string" || typeof raw.expiresAt !== "string") {
      throw new BridgeError("sandbox", path, "invalid-response");
    }
    return { leaseId: raw.leaseId, path: raw.path, expiresAt: raw.expiresAt };
  }

  async releaseWorktreeLease(leaseId: string): Promise<void> {
    const path = `/leases/${encodeURIComponent(leaseId)}`;
    await this.request("sandbox", path, "DELETE");
  }

  async execInSandbox(input: SandboxExecRequest): Promise<SandboxExecResult> {
    const path = "/exec";
    const raw = await this.request("sandbox", path, "POST", input);
    if (typeof raw.exitCode !== "number" || typeof raw.stdout !== "string" || typeof raw.stderr !== "string") {
      throw new BridgeError("sandbox", path, "invalid-response");
    }
    return { exitCode: raw.exitCode, stdout: raw.stdout, stderr: raw.stderr };
  }

  async listMcpTools(): Promise<McpTool[]> {
    const path = "/mcp/tools";
    const raw = await this.request("mcp", path, "GET");
    if (!Array.isArray(raw.tools)) throw new BridgeError("mcp", path, "invalid-response");
    return raw.tools.map((entry: unknown): McpTool => {
      if (!isRecord(entry) || typeof entry.name !== "string") throw new BridgeError("mcp", path, "invalid-response");
      return {
        name: entry.name,
        description: typeof entry.description === "string" ? entry.description : undefined,
        inputSchema: isRecord(entry.inputSchema) ? (entry.inputSchema as JsonObject) : undefined,
      };
    });
  }

  async callMcpTool(name: string, args: JsonObject): Promise<JsonValue> {
    const path = "/mcp/rpc";
    const raw = await this.request("mcp", path, "POST", {
      jsonrpc: "2.0",
      id: crypto.randomUUID(),
      method: "tools/call",
      params: { name, arguments: args },
    });
    if (raw.error !== undefined || !("result" in raw)) throw new BridgeError("mcp", path, "invalid-response");
    return raw.result as JsonValue;
  }

  async chatCompletion(input: ChatRequest): Promise<ChatCompletion> {
    const path = "/v1/chat/completions";
    const raw = await this.request("gateway", path, "POST", input);
    if (typeof raw.id !== "string" || !Array.isArray(raw.choices) || raw.choices.length === 0) {
      throw new BridgeError("gateway", path, "invalid-response");
    }
    return raw as unknown as ChatCompletion;
  }
}

