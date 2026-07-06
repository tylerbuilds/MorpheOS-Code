import path from "node:path";
import { fileURLToPath } from "node:url";

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
