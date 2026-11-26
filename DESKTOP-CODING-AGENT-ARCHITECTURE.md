# MoonWitness Desktop Coding Agent Architecture Plan

**Target:** `mw-dx` — Local-first desktop coding agent built on the MoonWitness sovereign fleet  
**Stack:** Tauri v2 (Rust) + React/TypeScript (WebView) + Bun (local sidecar)  
**Philosophy:** Offline-first, capability-granted, worktree-isolated, human-in-the-loop

---

## 1. High-Level Architecture

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                         TAURI v2 DESKTOP APPLICATION                        │
├─────────────────────────────────────────────────────────────────────────────┤
│  ┌─────────────────────┐  ┌─────────────────────────────────────────────┐  │
│  │    WEBVIEW (React)  │  │           RUST BACKEND (Tauri)              │  │
│  │                     │  │                                              │  │
│  │  • Agent Chat UI    │  │  • Window management                        │  │
│  │  • Code Editor      │◄─┼──►│  • File system access (scoped)          │  │
│  │  • Terminal         │  │  • Process spawning (worktree commands)     │  │
│  │  • Diff Viewer      │  │  • Native menus, tray, notifications        │  │
│  │  • Observatory      │  │  • Auto-updater                             │  │
│  │  • Settings         │  │  • IPC bridge (invoke/listen)               │  │
│  └──────────┬──────────┘  └─────────────────────┬───────────────────────┘  │
│             │                                    │                          │
│             │         TAURI IPC (invoke/event)  │                          │
│             ▼                                    ▼                          │
│  ┌─────────────────────────────────────────────────────────────────────┐   │
│  │                    LOCAL SIDECAR (Bun/Node.js)                      │   │
│  │  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐               │   │
│  │  │  AI Runtime  │  │  Worktree    │  │   Sync       │               │   │
│  │  │  (agents,    │  │  Sandbox     │  │  Engine      │               │   │
│  │  │   tools,     │  │  (git ops,   │  │  (PCW sync,  │               │   │
│  │  │   providers) │  │   diff, test)│  │   lease mgmt)│               │   │
│  │  └──────────────┘  └──────────────┘  └──────────────┘               │   │
│  │  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐               │   │
│  │  │  Local ORM   │  │   MCP Host   │  │  Risk Gate   │               │   │
│  │  │  (SQLite)    │  │  (stdio/HTTP)│  │  (R0-R4)     │               │   │
│  │  └──────────────┘  └──────────────┘  └──────────────┘               │   │
│  └─────────────────────────────────────────────────────────────────────┘   │
│                                    │                                       │
│                    LOCAL LOOPBACK / UNIX SOCKET                           │
│                                    ▼                                       │
│  ┌─────────────────────────────────────────────────────────────────────┐   │
│  │                      WORKTREE SANDBOXES                             │   │
│  │  .mw-worktrees/feature-xyz/  .mw-worktrees/bugfix-abc/  ...        │   │
│  │  Each: isolated git worktree, allowlisted commands, redaction       │   │
│  └─────────────────────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────────────────────┘
                                    │
                    ┌───────────────┴───────────────┐
                    ▼                               ▼
         ┌─────────────────────┐          ┌─────────────────────┐
         │   LOCAL AI (Ollama, │          │   CLOUD AI (when    │
         │   LM Studio,        │          │   online & granted) │
         │   llama.cpp)        │          │   OpenAI, Anthropic,│
         │   DataClassification│          │   FreeLLMAPI)       │
         │   = local_only      │          │   Classification =  │
         │                     │          │   cloud_eligible    │
         └─────────────────────┘          └─────────────────────┘
```

---

## 2. Core Subsystems (from mw-xv)

| Subsystem | Role | Key Types | Desktop Integration |
|-----------|------|-----------|---------------------|
| **ai-runtime** | Provider abstraction, agent harness, capability gateway, classification router | `AiProvider`, `AgentHarness`, `CapabilityGrant`, `DataClassification`, `ProviderRequest/Response` | Core of sidecar; routes to local/cloud models based on classification; enforces risk tiers |
| **ai-mcp** | Stateless MCP server adapter (stdio + HTTP) | `AiMcpAuthContext`, `AI_MCP_TOOLS`, `createAiMcpServer` | Hosts local MCP servers; exposes tools to agent via capability gateway |
| **orm-ai** | AI Corporation domain: agents, grants, runs, proof-carrying work, obligations | `Agent`, `CapabilityGrant`, `WorkContract`, `AgentRun`, `ExecutionFingerprint`, `AgentRunEffect` | Installed as local addon stack in sidecar SQLite; HTTP sync endpoints for desktop↔cloud |
| **orm-base** | Core user/company/partner models, audit, sequences | `User`, `Company`, `ModelAccess`, `ConfigParameter`, `Attachment` | Local identity & permissions in sidecar |
| **orm-knowledge** | Notes, knowledge bases, semantic search | `KnowledgeEntry`, `KnowledgeSpace`, `EmbeddingVector` | Local RAG for agent context |
| **orm-project** | Projects, tasks, work contracts, criteria | `Project`, `Task`, `WorkContract`, `AcceptanceCriterion` | Task→work contract→agent run pipeline |
| **orm-storage** | Local file attachments, artifact manifests | `LocalFileAttachmentStorage`, `ArtifactManifest` | Stores diffs, patches, evidence bundles |
| **orm-workflow** | Job definitions, cron, workflow execution | `WorkflowDefinition`, `JobRun`, `CronSchedule` | Background sync, evolution jobs |
| **local-sidecar** | Sidecar lifecycle, addon installation, sync client/engine | `DESKTOP_ADDONS`, `LocalSidecarState`, `SyncClient`, `SyncEngine` | Runs as Bun process; manages SQLite, HTTP sync to cloud |
| **worktree-sandbox** | Git worktree leases, allowlisted commands, redaction, diff scope | `WorktreeSandbox`, `GitWorktreeLease`, `BoundedPtyCommand`, `DesktopRiskGate` | Creates isolated worktrees per agent run; enforces path/cmd allowlists |
| **risk-gate** | Risk tier evaluation (R0-R4), human approval tokens, capability grants | `DesktopRiskGate`, `RiskTier`, `HumanApprovalToken`, `DesktopCapabilityGrant` | Every tool call evaluated; R0=auto, R1+=human approval |
| **local-ai-discovery** | Auto-discovers Ollama, LM Studio, OpenAI-compatible endpoints | `discoverLocalAiProviders`, `LocalAiProviderKind`, `LocalAiDiscoveredModel` | Zero-config local model detection |
| **sync-engine** | Offline-first PCW envelope queue, retry, conflict resolution | `PcwSyncEnvelope`, `PcwArtifactDigest`, `SyncEngine` | Queues work locally; syncs when online |
| **agent-runner** | Durable, fenced agent runs with checkpoints, replay | `AgentRunStateStore`, `FencingTokenChecker`, `AgentRunCheckpoint` | Resumable agent runs; survives crashes |
| **bridge** | Tauri↔WebView↔Sidecar IPC protocol | `DesktopCapabilityBridge`, `DesktopBridgeSnapshot`, `protocolVersion` | Versioned contract; progressive enhancement for web fallback |
| **mcp-host** | Manages local MCP server lifecycle (stdio, loopback HTTP) | `LocalMcpServerConfig`, `McpServerRegistry` | Registers/manages MCP servers per project |

---

## 3. Data Flow: Code Task Execution

```
USER (WebView)
    │
    ▼
1. Chat/Command → DesktopCapabilityBridge.invoke("dispatchTaskAgentRun", input)
    │
    ▼
2. Tauri IPC → Rust backend → validates auth, spawns sidecar call
    │
    ▼
3. Sidecar (Bun) local-sidecar.ts:dispatchTaskAgentRun()
    │   • Creates runId, acquires worktree lease (worktree-sandbox)
    │   • Evaluates risk via risk-gate.ts (R0 auto, R1+ requires approval)
    │   • Builds execution packet (ai-runtime: repo-inspector, overlap-detector)
    │
    ▼
4. If R0 or approved: AgentRunner.execute()
    │   • Loads AiProvider (local Ollama or cloud via classification-router)
    │   • Executes AgentHarness with tool definitions from capability-gateway
    │   • Tools: read/write files, run tests, git diff, search, MCP calls
    │   • Each tool call: capability-gateway checks grant, risk tier, classification
    │
    ▼
5. WorktreeSandbox executes commands in isolated .mw-worktrees/run-xyz/
    │   • git status/diff/commit (local only)
    │   • bun test, tsc, eslint (allowlisted)
    │   • Output redacted (secrets, keys)
    │
    ▼
6. Agent completes → AgentInspectionCompletionEnvelope
    │   • Findings, evidence refs, limitations, provider metadata
    │   • Stored in local ORM (orm-ai: AgentRun, AgentRunEffect, ArtifactManifest)
    │
    ▼
7. SyncEngine queues PcwSyncEnvelope for cloud sync
    │   • Artifacts uploaded (SHA-256 verified server-side)
    │   • Proof gate validated on server
    │   • Fencing token prevents stale replays
    │
    ▼
8. Results streamed back to WebView via DesktopCapabilityBridge events
    │   • Real-time: tool calls, text deltas, diff previews
    │   • Final: summary, diff, test results, evidence links
```

---

## 4. Security Model: Risk Tiers & Capability Grants

### Risk Tiers (R0–R4)

| Tier | Description | Auto? | Human Approval | Examples |
|------|-------------|-------|----------------|----------|
| **R0** | Read-only, local, no side effects | ✅ | No | `repo.read`, `repo.search`, `git.status`, `mcp.read` |
| **R1** | Reversible writes, local only | ❌ | Yes (token) | `worktree.write`, `git.commit_local`, `sidecar.sync_local` |
| **R2** | External effects, test execution | ❌ | Yes (token) | `pty.exec_local`, `worktree.test`, `service.local_start` |
| **R3** | Remote writes, network egress | ❌ | Yes (signed) | `git.push_remote`, `network.egress`, `cloud.provider_call` |
| **R4** | Destructive, privilege escalation | ❌ | Yes (signed + 2FA) | `secret.read`, `system.destructive`, `worktree.escape` |

### Capability Grant Flow

```
Company Admin (cloud)                          Desktop User (local)
       │                                             │
       ▼                                             │
┌──────────────────┐                                 │
│ Create Grant:    │                                 │
│ capability:      │                                 │
│ "worktree.write" │                                 │
│ riskTier: R1     │                                 │
│ classification:  │                                 │
│ local_only       │                                 │
│ allowedPaths:    │                                 │
│ ["src/**",       │                                 │
│  "tests/**"]     │                                 │
└────────┬─────────┘                                 │
         │                                           │
         ▼ (sync via orm-ai HTTP plugin)             │
┌──────────────────────────────────────────────────┐
│ Local SQLite (orm-base + orm-ai addons)          │
│ CapabilityGrant table populated                  │
└──────────────────────────────────────────────────┘
         │                                           │
         ▼                                           │
Agent requests tool → capability-gateway.resolveGrantsForExecution()
         │                                           │
         ▼                                           │
   ┌─────────────┐    No grant / tier exceeded       │
   │ Grant found?├──────────────────────► DENY       │
   └──────┬──────┘                                   │
          │ Yes                                       │
          ▼                                           │
   ┌─────────────┐    riskTier > R0                   │
   │ Risk ≤ R0?  ├──────────────────────► Human      │
   └──────┬──────┘        requires approval          │
          │ No                                        │
          ▼                                           │
   ┌─────────────┐    User clicks "Approve"          │
   │ HumanApprovalToken (signed, single-use, TTL)   │
   └──────┬──────┘                                   │
          │                                           │
          ▼                                           │
   Tool executes in WorktreeSandbox                   │
          │                                           │
          ▼                                           │
   Audit logged (risk-gate, capability-gateway)       │
```

---

## 5. Offline-First Design

### Local-Only Stack (No Internet Required)

| Component | Technology | Purpose |
|-----------|------------|---------|
| **Local AI** | Ollama, LM Studio, llama.cpp | Model inference (discovered via local-ai-discovery) |
| **Database** | better-sqlite3 (via orm-base/orm-ai) | Agents, grants, runs, knowledge, artifacts |
| **File Storage** | LocalFileAttachmentStorage (orm-storage) | Diffs, patches, evidence bundles |
| **Git** | worktree-sandbox (libgit2 / git CLI) | Isolated worktrees, local commits |
| **MCP** | ai-mcp (stdio transport) | Local tool servers (filesystem, git, etc.) |
| **Sync Queue** | sync-engine (PcwSyncEnvelope in SQLite) | Persistent offline queue |

### Cloud Sync (When Online)

```
┌─────────────────────────────────────────────────────────────────┐
│                     SYNC ENGINE (sync-engine.ts)                │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│  OUTBOUND (Desktop → Cloud):                                    │
│  1. Poll local outbox (PcwSyncEnvelope, status=pending)        │
│  2. POST /api/ai/desktop/lease (get fencing token)             │
│  3. POST /api/ai/desktop/pull (get latest agents, contracts)   │
│  4. For each envelope:                                          │
│     a. POST /api/ai/desktop/artifacts/upload (SHA-256 verified)│
│     b. POST /api/ai/desktop/pcw-sync (proof gate + commit)     │
│  5. Mark local envelopes synced/conflict/failed                │
│                                                                 │
│  INBOUND (Cloud → Desktop):                                     │
│  1. GET /api/ai/desktop/pull (new grants, updated contracts)   │
│  2. Upsert into local ORM (idempotent by envelope SHA-256)     │
│  3. Trigger capability-gateway policy version bump             │
│                                                                 │
│  CONFLICT RESOLUTION:                                           │
│  • Envelope SHA-256 mismatch → 409, manual resolution          │
│  • Stale fencing token → 409, re-acquire lease                 │
│  • Proof gate failure → 422, evidence insufficient             │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

---

## 6. Extension Points

### 6.1 MCP Servers (Local & Remote)

```typescript
// Configured in DesktopHarnessConfig.mcpServers
{
  serverId: "filesystem",
  name: "Local Filesystem",
  transport: "stdio",
  command: "mcp-server-filesystem",
  args: ["/workspace"],
  requiredCapability: "mcp.filesystem",
  maxRiskTier: "R1",
  allowedDataClassifications: ["local_only"],
  maxCallsPerRun: 50,
  timeoutMs: 30000,
  enabled: true
}
```

### 6.2 Custom Skills (Agent Harness)

```typescript
// Registered via capability-gateway as TypedToolDefinition
{
  name: "refactor-react-component",
  version: 1,
  capability: "skill.refactor.react",
  ownerAddon: "ai-runtime",
  riskTier: "R1",
  dataClassification: "local_only",
  sideEffect: "reversible_write",
  requiresConfirmation: true,
  inputSchema: { /* JSON Schema */ },
  execute: async (args, context) => { /* LLM + AST transform */ }
}
```

### 6.3 Worktree Commands (Allowlisted)

```typescript
// WorktreeSandboxOptions.allowedCommands
[
  'node', 'bun', 'npm', 'git', 'vitest', 'tsc', 'eslint', 'prettier',
  'cargo', 'go', 'python', 'pytest', 'ruff', 'mypy'  // Extensible per project
]
```

### 6.4 Custom Risk Policies

```typescript
// risk-policy.ts: evaluateRiskTierPolicy()
{
  capability: "worktree.write",
  baseTier: "R1",
  overrides: [
    { condition: "path.startsWith('tests/')", tier: "R0" },
    { condition: "path.includes('.env')", tier: "R4" },
    { condition: "context.companyId === 1 && context.agentRole === 'admin'", tier: "R2" }
  ]
}
```

---

## 7. Tauri v2 Configuration (Desktop App)

### tauri.conf.json (Key Sections)

```json
{
  "productName": "MoonWitness DX",
  "version": "1.0.0-rc.1",
  "identifier": "com.moonwitness.dx",
  "build": {
    "beforeDevCommand": "bun --filter @moonwitness/dx-web dev",
    "devUrl": "http://127.0.0.1:5173",
    "beforeBuildCommand": "bun --filter @moonwitness/dx build && bun --filter @moonwitness/dx build:web",
    "frontendDist": "./dist-web"
  },
  "app": {
    "windows": [{
      "label": "main",
      "title": "MoonWitness DX",
      "width": 1600,
      "height": 1000,
      "minWidth": 1200,
      "minHeight": 800
    }],
    "security": {
      "csp": {
        "connect-src": [
          "'self'",
          "http://127.0.0.1:3000",  // mw-dock
          "http://127.0.0.1:4480",  // mw-rid
          "http://127.0.0.1:11434", // Ollama
          "ws://127.0.0.1:5173",
          "ipc:"
        ]
      }
    }
  },
  "bundle": {
    "targets": "all",
    "createUpdaterArtifacts": true,
    "icon": ["../assets/app-icon-192.png", "../assets/app-icon-512.png"]
  }
}
```

### Rust Commands (src-tauri/src/lib.rs)

```rust
#[tauri::command]
async fn dispatch_task_agent_run(input: DispatchTaskAgentRunInput) -> Result<DispatchTaskAgentRunResult, String> {
    // Validates auth, forwards to sidecar via loopback HTTP or stdio
}

#[tauri::command]
async fn acquire_worktree_lease(opts: AcquireWorktreeOptions) -> Result<GitWorktreeLease, String> {
    // Creates isolated git worktree, returns lease with fencing token
}

#[tauri::command]
async fn execute_worktree_command(req: BoundedPtyCommandRequest) -> Result<BoundedPtyCommandResult, String> {
    // Runs allowlisted command in worktree sandbox with redaction
}

#[tauri::command]
async fn get_desktop_status() -> Result<DesktopBridgeSnapshot, String> {
    // Returns sidecar state, active leases, MCP servers, sync status
}

#[tauri::command]
async fn check_updates() -> Result<DesktopUpdateCheckSummary, String> {
    // Tauri updater plugin
}
```

---

## 8. WebView (React) Architecture

### Page Structure

```
apps/dx-web/
├── src/
│   ├── app/
│   │   ├── layout.tsx           // Root layout with providers
│   │   ├── page.tsx             // Main agent chat interface
│   │   ├── workbench/
│   │   │   ├── page.tsx         // Code editor + terminal + diff
│   │   │   ├── editor/          // Monaco/CodeMirror wrapper
│   │   │   ├── terminal/        // xterm.js + worktree PTY
│   │   │   └── diff/            // Side-by-side diff viewer
│   │   ├── observatory/
│   │   │   ├── page.tsx         // Agent run visualization (cinema-flow)
│   │   │   └── components/      // DAG canvas, telemetry, session inspector
│   │   ├── settings/
│   │   │   ├── page.tsx         // Models, MCP, risk policies, sync
│   │   │   └── components/
│   │   └── providers/
│   │       ├── DesktopBridgeProvider.tsx  // Context for __MW_DESKTOP__
│   │       └── AuthProvider.tsx           // mw-rid OIDC/PKCE
│   ├── components/
│   │   ├── chat/                // Agent conversation UI
│   │   ├── worktree/            // Lease status, file tree, commands
│   │   ├── risk/                // Approval dialogs, tier badges
│   │   └── sync/                // Sync status, conflict resolution
│   ├── lib/
│   │   ├── desktop-bridge.ts    // Typed wrapper for __MW_DESKTOP__
│   │   ├── desktop-mode.ts      // Workspace vs Developer mode
│   │   └── api-client.ts        // mw-dock/mw-rid API client
│   └── hooks/
│       ├── useDesktopBridge.ts
│       ├── useWorktreeLease.ts
│       └── useAgentRun.ts
```

### Key UI Flows

1. **Agent Chat** → User types → `dispatchTaskAgentRun` → real-time tool stream → diff preview → approve/commit
2. **Workbench** → Opens worktree lease → Monaco editor on worktree files → terminal in worktree → git diff
3. **Observatory** → Live DAG of agent steps → tool calls, tokens, decisions → replay/inspect
4. **Settings** → Local AI models (auto-discovered) → MCP servers → Risk policies → Sync config

---

## 9. Gaps & Implementation Priorities

| Priority | Gap | Effort | Notes |
|----------|-----|--------|-------|
| **P0** | Tauri v2 app scaffold (`mw-dx/apps/desktop`) | 2 weeks | Copy from `mw-xv/apps/desktop`, adapt for dx |
| **P0** | Sidecar Bun entry point (`local-sidecar.ts` main) | 1 week | Install DESKTOP_ADDONS, start HTTP server, register IPC |
| **P0** | WebView chat + workbench UI | 3 weeks | Monaco editor, xterm, diff viewer, real-time streaming |
| **P0** | WorktreeSandbox Tauri commands (Rust↔Bun) | 1 week | `acquire_worktree_lease`, `execute_worktree_command` |
| **P0** | RiskGate integration (approval UI) | 1 week | Native dialog for R1+, signed tokens for R3+ |
| **P1** | Local AI discovery + model picker | 1 week | Use `local-ai-discovery`, Ollama/LM Studio detection |
| **P1** | Sync engine offline queue + conflict UI | 2 weeks | `sync-engine`, conflict resolution dialog |
| **P1** | MCP server registry UI | 1 week | Add/remove/configure local MCP servers |
| **P1** | Observatory (cinema-flow canvas) | 2 weeks | Port from `mw-xv/apps/desktop/desktop-web/observatory` |
| **P2** | Cloud agent effect (cloud sandbox) | 3 weeks | Requires mw-mission, mw-cp, cloud provider creds |
| **P2** | Visual DNA theming (design system) | 1 week | `@moonwitness/ui` + `visual-dna.ts` |
| **P2** | Workspace Orbit (multi-repo) | 2 weeks | `workspace-orbit.ts`, orbit status UI |
| **P3** | Evolution loop / sleep-dream | 2 weeks | Background agent self-improvement |

---

## 10. Repository Structure (mw-dx)

```
mw-dx/
├── apps/
│   ├── desktop/                 # Tauri v2 app
│   │   ├── src/                 # Rust backend (commands, IPC)
│   │   ├── src-tauri/           # Tauri config, Cargo.toml
│   │   ├── desktop-web/         # React WebView (Vite + React 19)
│   │   │   ├── src/
│   │   │   │   ├── app/         # Next.js-style pages
│   │   │   │   ├── components/  # Shared UI components
│   │   │   │   ├── lib/         # Bridge, hooks, API client
│   │   │   │   └── hooks/       # React hooks
│   │   │   ├── package.json
│   │   │   ├── tauri.conf.json
│   │   │   └── vite.config.ts
│   │   └── package.json         # @moonwitness/dx-desktop
│   └── dx-web/                  # Optional: standalone web version
├── packages/
│   ├── dx-sidecar/              # Bun sidecar (local-sidecar.ts entry)
│   │   ├── src/
│   │   │   ├── index.ts         # Main entry, HTTP server, IPC
│   │   │   ├── ipc.ts           # Tauri↔Bun communication
│   │   │   ├── lifecycle.ts     # Startup/shutdown, health
│   │   │   └── config.ts        # DesktopHarnessConfig
│   │   └── package.json         # @moonwitness/dx-sidecar
│   ├── dx-bridge/               # Shared bridge types & protocol
│   │   ├── src/
│   │   │   ├── protocol.ts      # DesktopCapabilityBridge, events
│   │   │   ├── types.ts         # All shared TypeScript types
│   │   │   └── version.ts       // Protocol version negotiation
│   │   └── package.json         # @moonwitness/dx-bridge
│   └── dx-config/               # Shared config schemas
│       ├── src/
│       │   ├── harness.ts       # DesktopHarnessConfig schema
│       │   ├── mcp.ts           # LocalMcpServerConfig schema
│       │   └── risk.ts          # Risk policy schema
│       └── package.json
├── package.json                 # Root workspace (Bun)
├── bunfig.toml
├── tsconfig.base.json
├── turbo.json                   # Turborepo config
└── README.md
```

---

## 11. Development Workflow

### Local Development

```bash
# 1. Install deps
bun install

# 2. Start sidecar (Bun)
bun --filter @moonwitness/dx-sidecar dev

# 3. Start WebView (Vite)
bun --filter @moonwitness/dx-desktop build:web  # or dev

# 4. Run Tauri (Rust)
cd apps/desktop && cargo tauri dev

# Or all at once (via Turborepo)
bun run dev
```

### Testing

```bash
# Unit tests (sidecar)
bun --filter @moonwitness/dx-sidecar test

# E2E tests (Playwright + Tauri)
bun --filter @moonwitness/dx-desktop test:web

# Rust tests
cd apps/desktop && cargo test
```

### Release

```bash
# Build all
bun run build

# Tauri bundle (creates .msi, .dmg, .AppImage, .deb)
cd apps/desktop && cargo tauri build

# Auto-updater artifacts generated per tauri.conf.json
```

---

## 12. Integration with MoonWitness Fleet

| Service | Port | Integration |
|---------|------|-------------|
| **mw-rid** | 4480 | OIDC/PKCE auth for cloud sync; desktop app registers as public client |
| **mw-dock** | 3000 | BaaS API for projects, ORM, jobs; sidecar uses `@moonwitness/client` |
| **mw-xv** | 3001 | Board & execution engine; desktop can dispatch tasks to cloud agents |
| **mw-mission** | 4410 | Distributed job queue; cloud agent effects run here |
| **mw-cp** | 4440 | PaaS control plane; cloud sandbox provisioning |
| **mw-design** | 8080 | Visual Design Studio; component preview in observatory |
| **mw-lab** | 4400 | Git server; worktree push/pull via Smart HTTP |
| **mw-corpus** | 4420 | Epistemic corpus; knowledge sync for RAG |
| **mw-nexus** | 4430 | Ontology/correlation; agent context enrichment |

---

## 13. Success Criteria

1. **Cold start < 3s** — Tauri app launches, sidecar ready, WebView loaded
2. **Local agent run (R0) < 500ms overhead** — No network, pure local inference + tools
3. **Worktree isolate < 100ms** — `git worktree add` + lease creation
4. **Offline functional** — Full agent loop works without internet (local models)
5. **Sync conflict < 1%** — Fencing tokens + SHA-256 prevent most conflicts
6. **Memory < 500MB** — Sidecar + WebView + Rust backend combined
7. **Cross-platform** — Windows, macOS, Linux (Tauri targets all)

---

*This architecture leverages the existing MoonWitness subsystems in `mw-xv/packages/*` and `mw-xv/apps/desktop/*` as the foundation. The `mw-dx` repo will be a focused composition of these pieces into a cohesive desktop coding agent experience.*