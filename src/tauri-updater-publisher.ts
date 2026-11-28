import { createHash } from "node:crypto";

export type TauriPlatformKey =
  | "windows-x86_64"
  | "linux-x86_64"
  | "darwin-aarch64"
  | "darwin-x86_64";

export interface TauriReleaseArtifactInput {
  platform: TauriPlatformKey;
  url: string;
  signature: string;
  sha256?: string;
}

export interface TauriUpdaterPlatformEntry {
  signature: string;
  url: string;
}

export interface TauriLatestJsonManifest {
  version: string;
  notes: string;
  pub_date: string;
  platforms: Record<string, TauriUpdaterPlatformEntry>;
}

export interface GenerateTauriLatestJsonInput {
  version: string;
  notes: string;
  pubDate?: string;
  artifacts: readonly TauriReleaseArtifactInput[];
}

const SEMVER_PATTERN = /^v?\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

export function normalizeReleaseVersion(rawVersion: string): string {
  const trimmed = rawVersion.trim();
  if (!SEMVER_PATTERN.test(trimmed)) {
    throw new Error(`Invalid semantic version for Tauri updater: '${rawVersion}'`);
  }
  return trimmed.startsWith("v") ? trimmed.slice(1) : trimmed;
}

export function validateArtifactUrl(url: string): string {
  const trimmed = url.trim();
  if (!trimmed.startsWith("https://") && !trimmed.startsWith("http://127.0.0.1")) {
    throw new Error(`Updater artifact URL must use https:// (or local loopback): '${url}'`);
  }
  return trimmed;
}

export function computeDetachedSignatureEnvelope(payloadBytes: Uint8Array | string, keyId = "mw-dx-local-ed25519"): string {
  const digest = createHash("sha256").update(payloadBytes).digest("hex");
  return Buffer.from(`untrusted comment: minisign/tauri local signature (${keyId})\nRW${digest}`, "utf8").toString("base64");
}

export function generateTauriLatestJson(input: GenerateTauriLatestJsonInput): TauriLatestJsonManifest {
  const version = normalizeReleaseVersion(input.version);
  const notes = input.notes.trim();
  if (notes.length === 0) {
    throw new Error("Tauri updater release notes must not be empty");
  }
  if (!Array.isArray(input.artifacts) || input.artifacts.length === 0) {
    throw new Error("Tauri updater manifest requires at least one signed platform artifact");
  }

  const pubDate = input.pubDate ? input.pubDate.trim() : new Date().toISOString();
  if (Number.isNaN(Date.parse(pubDate))) {
    throw new Error(`Invalid pubDate ISO timestamp: '${pubDate}'`);
  }

  const platforms: Record<string, TauriUpdaterPlatformEntry> = {};
  for (const artifact of input.artifacts) {
    const signature = artifact.signature.trim();
    if (signature.length === 0) {
      throw new Error(`Missing Tauri minisign/Ed25519 signature for platform '${artifact.platform}'`);
    }
    if (platforms[artifact.platform]) {
      throw new Error(`Duplicate platform entry in Tauri updater manifest: '${artifact.platform}'`);
    }
    platforms[artifact.platform] = {
      signature,
      url: validateArtifactUrl(artifact.url),
    };
  }

  return {
    version,
    notes,
    pub_date: pubDate,
    platforms,
  };
}
