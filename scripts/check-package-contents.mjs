#!/usr/bin/env node
import { execFileSync } from "node:child_process";

const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm";
const output = execFileSync(npmCommand, ["pack", "--dry-run", "--json"], {
  encoding: "utf8",
  stdio: ["ignore", "pipe", "pipe"]
});
const packages = JSON.parse(output);
const files = packages[0]?.files?.map((entry) => entry.path).sort() ?? [];
const required = ["LICENSE", "README.md", "dist/src/cli.js", "dist/src/mcp.js", "scripts/install-local.sh"];
const forbidden = /^(?:\.omo\/|\.state\/|artifacts\/|translation-memory\/|ops\/|agentos\.service\.yml$|docs\/(?:proof|security|sprints|storage)\/)/;

const missing = required.filter((path) => !files.includes(path));
const leaked = files.filter((path) => forbidden.test(path));

if (missing.length > 0 || leaked.length > 0) {
  throw new Error(
    JSON.stringify(
      {
        message: "Package content policy failed",
        missing_required_files: missing,
        forbidden_files: leaked
      },
      null,
      2
    )
  );
}

console.log(
  JSON.stringify(
    {
      ok: true,
      package_name: packages[0]?.name,
      package_version: packages[0]?.version,
      file_count: files.length,
      files
    },
    null,
    2
  )
);
