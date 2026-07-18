import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { HarnessError } from "./errors.js";

export function repoRoot(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
}

export function defaultStateDir(): string {
  return process.env.DEEPSEEK_HARNESS_STATE_DIR
    ? path.resolve(process.env.DEEPSEEK_HARNESS_STATE_DIR)
    : path.resolve(process.cwd(), ".state");
}

export function defaultArtifactRoot(): string {
  return process.env.DEEPSEEK_HARNESS_ARTIFACT_DIR
    ? path.resolve(process.env.DEEPSEEK_HARNESS_ARTIFACT_DIR)
    : path.resolve(process.cwd(), "artifacts");
}

/** Reject a source that could disclose credentials or protected local state. */
export function assertSafeCorpusSourcePath(candidate: string): string {
  const resolved = path.resolve(candidate);
  assertSafeSourcePath(resolved);
  if (fs.existsSync(resolved)) {
    assertSafeSourcePath(fs.realpathSync(resolved));
  }
  return resolved;
}

/** Resolve an untrusted output argument beneath a trusted artefact root. */
export function resolveArtifactOutputPath(artifactRoot: string, candidate: string): string {
  const root = path.resolve(artifactRoot);
  const output = path.resolve(candidate);
  if (!isWithin(output, root)) {
    throw new HarnessError("artifact_output_path_blocked", "Harness output must remain within the configured artifact root");
  }
  fs.mkdirSync(root, { recursive: true });
  const realRoot = fs.realpathSync(root);
  const realParent = fs.realpathSync(nearestExistingParent(path.dirname(output)));
  if (!isWithin(realParent, realRoot) || (fs.existsSync(output) && !isWithin(fs.realpathSync(output), realRoot))) {
    throw new HarnessError("artifact_output_path_blocked", "Harness output resolves outside the configured artifact root");
  }
  return output;
}

function assertSafeSourcePath(filePath: string): void {
  const normalised = `/${filePath.split(path.sep).filter(Boolean).join("/")}/`;
  const forbidden = ["/.ssh/", "/.gnupg/", "/Library/Keychains/", "/.config/opencode/auth", "/.codex/auth"];
  if (/\/Users\/[^/]+\/Documents\/Obsidian(?:\/|$)/i.test(normalised) || forbidden.some((part) => normalised.includes(part))) {
    throw new HarnessError("corpus_path_forbidden", `Corpus path is forbidden: ${filePath}`);
  }
  const segments = path.resolve(filePath).split(path.sep).filter(Boolean).map((segment) => segment.toLowerCase());
  const sensitiveSegments = new Set([".aws", ".git", ".kube", ".netrc", ".npmrc", ".pypirc", "certs", "certificates", "credential", "credentials", "keychain", "keychains", "passwords", "private-keys", "private_keys", "secret", "secrets", "token", "tokens"]);
  const basename = segments.at(-1) ?? "";
  const sensitiveName = basename === ".env" || basename.startsWith(".env.") || /(?:^|[._-])(?:auth|credential|password|private[-_]?key|secret|token)(?:[._-]|$)/i.test(basename);
  if (segments.some((segment) => sensitiveSegments.has(segment)) || sensitiveName || segments[0] === "etc" || segments[0] === "system") {
    throw new HarnessError("corpus_sensitive_source_path_blocked", `Corpus source path is sensitive and cannot be ingested: ${filePath}`);
  }
}

function nearestExistingParent(candidate: string): string {
  let current = path.resolve(candidate);
  while (!fs.existsSync(current)) {
    const parent = path.dirname(current);
    if (parent === current) return current;
    current = parent;
  }
  return current;
}

function isWithin(candidate: string, root: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}
