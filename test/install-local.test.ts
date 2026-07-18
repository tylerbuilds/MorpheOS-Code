import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const REPO_ROOT = process.cwd();
const INSTALLER = path.join(REPO_ROOT, "scripts", "install-local.sh");
const MARKER = "deepseek-harness-local-installer:v1";

type Fixture = {
  readonly root: string;
  readonly home: string;
  readonly tmp: string;
  readonly xdgConfigHome: string;
  readonly installDir: string;
  readonly configDir: string;
  readonly stateDir: string;
  readonly artifactDir: string;
  readonly codexConfig: string;
};

type RunResult = {
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
};

function fixture(): Fixture {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "deepseek-harness-installer-"));
  const value: Fixture = {
    root,
    home: path.join(root, "home"),
    tmp: path.join(root, "tmp"),
    xdgConfigHome: path.join(root, "xdg-config"),
    installDir: path.join(root, "bin with space's"),
    configDir: path.join(root, "config"),
    stateDir: path.join(root, "state"),
    artifactDir: path.join(root, "artifacts"),
    codexConfig: path.join(root, "home", ".codex", "config.toml")
  };
  fs.mkdirSync(path.dirname(value.codexConfig), { recursive: true });
  fs.mkdirSync(value.tmp);
  fs.writeFileSync(value.codexConfig, "# operator-owned\n");
  return value;
}

function runAt(
  value: Fixture,
  installer: string,
  args: readonly string[],
  environment: NodeJS.ProcessEnv = {}
): RunResult {
  const result = spawnSync("bash", [installer, ...args], {
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      HOME: value.home,
      TMPDIR: value.tmp,
      XDG_CONFIG_HOME: value.xdgConfigHome,
      ...environment
    },
    encoding: "utf8"
  });
  return {
    status: result.status,
    stdout: result.stdout,
    stderr: result.stderr
  };
}

function run(value: Fixture, args: readonly string[], environment: NodeJS.ProcessEnv = {}): RunResult {
  return runAt(value, INSTALLER, args, environment);
}

function installArgs(value: Fixture, configDir: string): string[] {
  return [
    "--no-build",
    "--install-dir",
    value.installDir,
    "--config-dir",
    configDir,
    "--state-dir",
    value.stateDir,
    "--artifact-dir",
    value.artifactDir,
    "--profile",
    "core"
  ];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function configEnv(configPath: string): Record<string, unknown> {
  const parsed: unknown = JSON.parse(fs.readFileSync(configPath, "utf8"));
  assert.ok(isRecord(parsed));
  const servers = parsed["mcpServers"];
  assert.ok(isRecord(servers));
  const server = servers["deepseek-harness"];
  assert.ok(isRecord(server));
  const env = server["env"];
  assert.ok(isRecord(env));
  return env;
}

function packedFixture(value: Fixture): { readonly root: string; readonly installer: string } {
  const root = path.join(value.root, "packed-package");
  const scripts = path.join(root, "scripts");
  const distSource = path.join(root, "dist", "src");
  fs.mkdirSync(scripts, { recursive: true });
  fs.mkdirSync(distSource, { recursive: true });
  fs.copyFileSync(INSTALLER, path.join(scripts, "install-local.sh"));
  fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({
    name: "deepseek-harness",
    version: "0.1.0-test",
    type: "module",
    dependencies: {}
  }, null, 2));
  fs.writeFileSync(path.join(distSource, "cli.js"), `#!/usr/bin/env node
const args = process.argv.slice(2);
const flag = (name) => {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : "";
};
const quote = JSON.stringify;
if (args[0] !== "mcp-config") {
  console.log(JSON.stringify({ ok: true, packed_runtime: true, args }));
} else if (flag("--format") === "codex-toml") {
  process.stdout.write([
    "[mcp_servers.deepseek-harness]",
    "command = " + quote(flag("--command")),
    "args = []",
    "[mcp_servers.deepseek-harness.env]",
    "DEEPSEEK_HARNESS_STATE_DIR = " + quote(flag("--state-dir")),
    "DEEPSEEK_HARNESS_ARTIFACT_DIR = " + quote(flag("--artifact-dir")),
    "DEEPSEEK_HARNESS_MCP_PROFILE = " + quote(flag("--profile")),
    ""
  ].join("\\n"));
} else {
  process.stdout.write(JSON.stringify({
    mcpServers: {
      "deepseek-harness": {
        command: flag("--command"),
        args: [],
        env: {
          DEEPSEEK_HARNESS_STATE_DIR: flag("--state-dir"),
          DEEPSEEK_HARNESS_ARTIFACT_DIR: flag("--artifact-dir"),
          DEEPSEEK_HARNESS_MCP_PROFILE: flag("--profile")
        }
      }
    }
  }));
}
`);
  fs.writeFileSync(path.join(distSource, "mcp.js"), "#!/usr/bin/env node\nprocess.stdin.resume();\n");
  return { root, installer: path.join(scripts, "install-local.sh") };
}

function cleanup(value: Fixture): void {
  fs.rmSync(value.root, { recursive: true, force: true });
}

test("installs XDG-aware managed launchers and profile config", () => {
  const value = fixture();
  try {
    const result = run(value, [
      "--no-build",
      "--force",
      "--install-dir",
      value.installDir,
      "--state-dir",
      value.stateDir,
      "--artifact-dir",
      value.artifactDir,
      "--profile",
      "corpus",
      "--print-config"
    ]);
    assert.equal(result.status, 0, result.stderr);
    const configDir = path.join(value.xdgConfigHome, "deepseek-harness");
    const env = configEnv(path.join(configDir, "mcp-server.json"));
    assert.equal(env["DEEPSEEK_HARNESS_STATE_DIR"], value.stateDir);
    assert.equal(env["DEEPSEEK_HARNESS_ARTIFACT_DIR"], value.artifactDir);
    assert.equal(env["DEEPSEEK_HARNESS_MCP_PROFILE"], "corpus");
    assert.equal(env["DEEPSEEK_HARNESS_INSTALLER_MARKER"], MARKER);
    assert.match(fs.readFileSync(path.join(configDir, "codex-mcp-server.toml"), "utf8"), /DEEPSEEK_HARNESS_MCP_PROFILE = "corpus"/);
    const appDir = path.join(value.installDir, "deepseek-harness-app");
    const cliLauncher = fs.readFileSync(path.join(value.installDir, "deepseek-harness"), "utf8");
    const mcpLauncher = fs.readFileSync(path.join(value.installDir, "deepseek-harness-mcp"), "utf8");
    assert.match(cliLauncher, new RegExp(MARKER));
    assert.match(mcpLauncher, new RegExp(MARKER));
    assert.match(cliLauncher, /deepseek-harness-app\/dist\/src\/cli\.js/);
    assert.match(mcpLauncher, /deepseek-harness-app\/dist\/src\/mcp\.js/);
    assert.equal(cliLauncher.includes(REPO_ROOT), false);
    assert.equal(mcpLauncher.includes(REPO_ROOT), false);
    assert.equal(fs.readFileSync(path.join(appDir, ".deepseek-harness-installer"), "utf8"), `${MARKER}\n`);
    assert.equal((fs.statSync(path.join(value.installDir, "deepseek-harness")).mode & 0o111) !== 0, true);
    assert.equal(fs.readFileSync(value.codexConfig, "utf8"), "# operator-owned\n");
    assert.equal(result.stdout.includes("DEEPSEEK_API_KEY"), false);
  } finally {
    cleanup(value);
  }
});

test("verifies installed CLI and MCP without credentials", () => {
  const value = fixture();
  try {
    const installed = run(value, [...installArgs(value, value.configDir), "--force"]);
    assert.equal(installed.status, 0, installed.stderr);
    const verified = run(value, [...installArgs(value, value.configDir), "--verify"]);
    assert.equal(verified.status, 0, verified.stderr);
    assert.match(verified.stdout, /CLI doctor verification passed/);
    assert.match(verified.stdout, /MCP smoke verification passed/);
    assert.equal(verified.stdout.includes("DEEPSEEK_API_KEY"), false);
  } finally {
    cleanup(value);
  }
});

test("dry-run previews config without creating operator files", () => {
  const value = fixture();
  try {
    const result = run(value, [...installArgs(value, value.configDir), "--dry-run", "--print-config"]);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /DEEPSEEK_HARNESS_MCP_PROFILE/);
    assert.equal(fs.existsSync(value.installDir), false);
    assert.equal(fs.existsSync(value.configDir), false);
    assert.equal(fs.existsSync(value.stateDir), false);
    assert.equal(fs.existsSync(value.artifactDir), false);
    assert.deepEqual(fs.readdirSync(value.tmp), []);
    const invalid = run(value, ["--dry-run", "--profile", "invalid"]);
    assert.equal(invalid.status, 2);
    assert.match(invalid.stderr, /--profile must be one of full, core, corpus/);
  } finally {
    cleanup(value);
  }
});

test("repeat install is idempotent and quiet", () => {
  const value = fixture();
  try {
    const first = run(value, [...installArgs(value, value.configDir), "--force"]);
    assert.equal(first.status, 0, first.stderr);
    const second = run(value, [...installArgs(value, value.configDir), "--quiet"]);
    assert.equal(second.status, 0, second.stderr);
    assert.equal(second.stdout, "");
    assert.equal(second.stderr, "");
  } finally {
    cleanup(value);
  }
});

test("uninstall removes only marked files and preserves operator state", () => {
  const value = fixture();
  try {
    const installed = run(value, [...installArgs(value, value.configDir), "--force"]);
    assert.equal(installed.status, 0, installed.stderr);
    const unrelatedConfig = path.join(value.configDir, "unrelated.json");
    const stateSentinel = path.join(value.stateDir, "keep.txt");
    const artifactSentinel = path.join(value.artifactDir, "keep.txt");
    fs.writeFileSync(unrelatedConfig, "keep");
    fs.writeFileSync(stateSentinel, "keep");
    fs.writeFileSync(artifactSentinel, "keep");
    const removed = run(value, [...installArgs(value, value.configDir), "--uninstall"]);
    assert.equal(removed.status, 0, removed.stderr);
    for (const name of ["deepseek-harness", "deepseek-harness-mcp"]) {
      assert.equal(fs.existsSync(path.join(value.installDir, name)), false);
    }
    assert.equal(fs.existsSync(path.join(value.installDir, "deepseek-harness-app")), false);
    assert.equal(fs.existsSync(path.join(value.configDir, "mcp-server.json")), false);
    assert.equal(fs.existsSync(path.join(value.configDir, "codex-mcp-server.toml")), false);
    assert.equal(fs.readFileSync(unrelatedConfig, "utf8"), "keep");
    assert.equal(fs.readFileSync(stateSentinel, "utf8"), "keep");
    assert.equal(fs.readFileSync(artifactSentinel, "utf8"), "keep");
    assert.equal(fs.readFileSync(value.codexConfig, "utf8"), "# operator-owned\n");
    const repeated = run(value, [...installArgs(value, value.configDir), "--uninstall"]);
    assert.equal(repeated.status, 0, repeated.stderr);
    assert.equal(fs.readFileSync(stateSentinel, "utf8"), "keep");
    assert.equal(fs.readFileSync(artifactSentinel, "utf8"), "keep");
  } finally {
    cleanup(value);
  }
});

test("uninstall leaves unmarked same-name files untouched", () => {
  const value = fixture();
  try {
    fs.mkdirSync(value.installDir);
    fs.mkdirSync(value.configDir);
    fs.writeFileSync(path.join(value.installDir, "deepseek-harness"), "operator launcher\n");
    fs.writeFileSync(path.join(value.installDir, "deepseek-harness-mcp"), "operator mcp\n");
    fs.writeFileSync(path.join(value.configDir, "mcp-server.json"), "{}\n");
    fs.writeFileSync(path.join(value.configDir, "codex-mcp-server.toml"), "# operator\n");
    const result = run(value, [...installArgs(value, value.configDir), "--uninstall"]);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(fs.existsSync(path.join(value.installDir, "deepseek-harness")), true);
    assert.equal(fs.existsSync(path.join(value.installDir, "deepseek-harness-mcp")), true);
    assert.equal(fs.existsSync(path.join(value.configDir, "mcp-server.json")), true);
    assert.equal(fs.existsSync(path.join(value.configDir, "codex-mcp-server.toml")), true);
  } finally {
    cleanup(value);
  }
});

test("packed package installs without a lock and launchers survive source move", () => {
  const value = fixture();
  try {
    const packed = packedFixture(value);
    const result = runAt(value, packed.installer, [
      "--force",
      "--install-dir",
      value.installDir,
      "--config-dir",
      value.configDir,
      "--state-dir",
      value.stateDir,
      "--artifact-dir",
      value.artifactDir,
      "--profile",
      "core"
    ]);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(fs.existsSync(path.join(packed.root, "package-lock.json")), false);
    assert.match(result.stdout, /no package-lock\.json or npm ci is required/);
    const cliLauncher = fs.readFileSync(path.join(value.installDir, "deepseek-harness"), "utf8");
    assert.equal(cliLauncher.includes(packed.root), false);
    assert.match(cliLauncher, /deepseek-harness-app/);
    assert.equal(fs.existsSync(path.join(value.installDir, "deepseek-harness-app", "dist", "src", "cli.js")), true);

    const movedRoot = `${packed.root}-moved`;
    fs.renameSync(packed.root, movedRoot);
    const launched = spawnSync(path.join(value.installDir, "deepseek-harness"), ["--help"], {
      cwd: value.root,
      env: {
        ...process.env,
        HOME: value.home,
        TMPDIR: value.tmp,
        XDG_CONFIG_HOME: value.xdgConfigHome
      },
      encoding: "utf8"
    });
    assert.equal(launched.status, 0, launched.stderr);
    assert.match(launched.stdout, /packed_runtime/);
    assert.equal(launched.stdout.includes(movedRoot), false);
  } finally {
    cleanup(value);
  }
});

test("partial launcher collisions fail without claiming success", () => {
  const value = fixture();
  try {
    fs.mkdirSync(value.installDir, { recursive: true });
    fs.writeFileSync(path.join(value.installDir, "deepseek-harness"), "operator launcher\n");
    const result = run(value, installArgs(value, value.configDir));
    assert.equal(result.status, 1);
    assert.match(result.stderr, /partial launcher set/);
    assert.equal(fs.existsSync(path.join(value.installDir, "deepseek-harness-mcp")), false);
    assert.equal(fs.existsSync(path.join(value.installDir, "deepseek-harness-app")), false);
    assert.equal(fs.existsSync(value.stateDir), false);
    assert.equal(fs.existsSync(value.artifactDir), false);
  } finally {
    cleanup(value);
  }
});

test("help and failed contenders never remove another installer's lock", () => {
  const value = fixture();
  try {
    const lockDir = path.join(value.tmp, "deepseek-harness.install.lock");
    const sentinel = path.join(lockDir, "owner");
    fs.mkdirSync(lockDir, { recursive: true });
    fs.writeFileSync(sentinel, "other installer\n");
    const help = run(value, ["--help"]);
    assert.equal(help.status, 0, help.stderr);
    assert.equal(fs.readFileSync(sentinel, "utf8"), "other installer\n");
    const contender = run(value, installArgs(value, value.configDir));
    assert.equal(contender.status, 1);
    assert.match(contender.stderr, /Another deepseek-harness install appears to be running/);
    assert.equal(fs.readFileSync(sentinel, "utf8"), "other installer\n");
  } finally {
    cleanup(value);
  }
});

test("NO_COLOR and piped output stay free of ANSI control sequences", () => {
  const value = fixture();
  try {
    const preview = run(value, [...installArgs(value, value.configDir), "--dry-run"]);
    assert.equal(preview.status, 0, preview.stderr);
    assert.equal(/\u001b\[/.test(`${preview.stdout}${preview.stderr}`), false);
    const installed = run(value, [...installArgs(value, value.configDir), "--force"], { NO_COLOR: "1" });
    assert.equal(installed.status, 0, installed.stderr);
    assert.equal(/\u001b\[/.test(`${installed.stdout}${installed.stderr}`), false);
  } finally {
    cleanup(value);
  }
});
