#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import packageMetadata from "../package.json" with { type: "json" };

const cargoMetadata = JSON.parse(execFileSync("cargo", ["metadata", "--format-version", "1", "--no-deps"], {
  cwd: process.cwd(),
  encoding: "utf8",
  stdio: ["ignore", "pipe", "pipe"]
}));
const workerPackage = cargoMetadata.packages.find((candidate) => candidate.name === "deepseek-harness-worker");
if (!workerPackage) {
  throw new Error("cargo metadata did not include deepseek-harness-worker");
}

const cliVersion = execFileSync(process.execPath, ["dist/src/cli.js", "--version"], {
  cwd: process.cwd(),
  encoding: "utf8"
}).trim();
const changelog = fs.readFileSync(new URL("../CHANGELOG.md", import.meta.url), "utf8");
const changelogVersion = changelog.match(/^## \[(\d+\.\d+\.\d+)\]/m)?.[1];
const tagVersion = process.env.GITHUB_REF?.startsWith("refs/tags/v")
  ? process.env.GITHUB_REF.slice("refs/tags/v".length)
  : undefined;

const versions = {
  package_json: packageMetadata.version,
  cli: cliVersion,
  rust_worker: workerPackage.version,
  changelog: changelogVersion,
  tag: tagVersion
};
const mismatches = Object.entries(versions)
  .filter((entry) => entry[1] !== undefined && entry[1] !== packageMetadata.version)
  .map(([surface, version]) => ({ surface, version, expected: packageMetadata.version }));

if (mismatches.length > 0) {
  throw new Error(JSON.stringify({ message: "Release version mismatch", versions, mismatches }, null, 2));
}

process.stdout.write(`${JSON.stringify({ ok: true, version: packageMetadata.version, surfaces: versions }, null, 2)}\n`);
