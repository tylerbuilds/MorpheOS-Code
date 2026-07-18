#!/usr/bin/env bash
set -euo pipefail
shopt -s lastpipe 2>/dev/null || true
umask 022

PROJECT="deepseek-harness"
MARKER="deepseek-harness-local-installer:v1"
QUIET=0
NO_BUILD=0
FORCE=0
PRINT_CONFIG=0
VERIFY=0
UNINSTALL=0
DRY_RUN=0
HOME_DIR="${HOME:-}"
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LOCK_DIR="${TMPDIR:-/tmp}/${PROJECT}.install.lock"
LOCK_HELD=0
RUNTIME_STAGING=""
COLOUR=1

if [ -n "${NO_COLOR:-}" ] || [ ! -t 1 ] || [ ! -t 2 ]; then
  COLOUR=0
fi

if [ -z "$HOME_DIR" ]; then
  printf 'ERR HOME is not set; set HOME before using the local installer\n' >&2
  exit 2
fi

INSTALL_DIR="${HOME_DIR}/bin"
CONFIG_BASE="${XDG_CONFIG_HOME:-${HOME_DIR}/.config}"
CONFIG_DIR="${CONFIG_BASE}/${PROJECT}"
CONFIG_PATH="${CONFIG_DIR}/mcp-server.json"
CODEX_CONFIG_PATH="${CONFIG_DIR}/codex-mcp-server.toml"
STATE_DIR="${REPO_ROOT}/.state"
ARTIFACT_DIR="${REPO_ROOT}/artifacts"
PROFILE="core"
CLI_LAUNCHER=""
MCP_LAUNCHER=""
APP_DIR=""
APP_MARKER_PATH=""
CLI_ENTRYPOINT=""

info() {
  [ "$QUIET" -eq 1 ] || {
    if [ "$COLOUR" -eq 1 ]; then
      printf '\033[0;34m->\033[0m %s\n' "$*"
    else
      printf '%s\n' "-> $*"
    fi
  }
}

ok() {
  [ "$QUIET" -eq 1 ] || {
    if [ "$COLOUR" -eq 1 ]; then
      printf '\033[0;32mOK\033[0m %s\n' "$*"
    else
      printf '%s\n' "OK $*"
    fi
  }
}

warn() {
  if [ "$COLOUR" -eq 1 ]; then
    printf '\033[1;33mWARN\033[0m %s\n' "$*" >&2
  else
    printf '%s\n' "WARN $*" >&2
  fi
}

err() {
  if [ "$COLOUR" -eq 1 ]; then
    printf '\033[0;31mERR\033[0m %s\n' "$*" >&2
  else
    printf '%s\n' "ERR $*" >&2
  fi
}

usage() {
  cat <<USAGE
deepseek-harness local installer

Usage:
  bash scripts/install-local.sh [options]

Options:
  --install-dir PATH   Install launchers here (default: ${HOME_DIR}/bin)
  --config-dir PATH    Write managed MCP snippets here (default: ${CONFIG_DIR})
  --state-dir PATH     Use this local state directory (default: ${STATE_DIR})
  --artifact-dir PATH  Use this local artefact directory (default: ${ARTIFACT_DIR})
  --profile PROFILE    MCP profile: full, core, or corpus (default: core)
  --no-build           Skip npm install/build
  --force              Reinstall launchers and replace existing snippets
  --print-config       Print generated MCP JSON after install
  --verify             Run the installed CLI doctor and MCP smoke check
  --uninstall          Remove only files marked by this installer
  --dry-run            Show the planned changes without writing anything
  --quiet              Reduce normal output; errors remain visible
  -h, --help           Show this help

Installs:
  deepseek-harness      CLI launcher
  deepseek-harness-mcp  MCP stdio launcher

No secrets are written or used by verification. Provide DEEPSEEK_API_KEY only
in the client environment when explicitly running approved live DeepSeek calls.
USAGE
}

cleanup() {
  if [ -n "$RUNTIME_STAGING" ] && [ -d "$RUNTIME_STAGING" ]; then
    rm -rf "$RUNTIME_STAGING"
  fi
  if [ "$LOCK_HELD" -eq 1 ]; then
    rmdir "$LOCK_DIR" 2>/dev/null || true
  fi
}
trap cleanup EXIT

missing_value() {
  err "Missing value for $1"
  usage
  exit 2
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --install-dir|--config-dir|--state-dir|--artifact-dir|--profile)
      [ "$#" -ge 2 ] && [ -n "$2" ] && [[ "$2" != --* ]] || missing_value "$1"
      case "$1" in
        --install-dir) INSTALL_DIR="$2" ;;
        --config-dir) CONFIG_DIR="$2"; CONFIG_PATH="${CONFIG_DIR}/mcp-server.json"; CODEX_CONFIG_PATH="${CONFIG_DIR}/codex-mcp-server.toml" ;;
        --state-dir) STATE_DIR="$2" ;;
        --artifact-dir) ARTIFACT_DIR="$2" ;;
        --profile) PROFILE="$2" ;;
      esac
      shift 2
      ;;
    --no-build) NO_BUILD=1; shift ;;
    --force) FORCE=1; shift ;;
    --print-config) PRINT_CONFIG=1; shift ;;
    --verify) VERIFY=1; shift ;;
    --uninstall) UNINSTALL=1; shift ;;
    --dry-run) DRY_RUN=1; shift ;;
    --quiet) QUIET=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) err "Unknown option: $1"; usage; exit 2 ;;
  esac
done

case "$PROFILE" in
  full|core|corpus) ;;
  *) err "--profile must be one of full, core, corpus (got: $PROFILE)"; exit 2 ;;
esac

if [ -n "${XDG_CONFIG_HOME:-}" ] && [[ "$XDG_CONFIG_HOME" != /* ]]; then
  err "XDG_CONFIG_HOME must be an absolute path: $XDG_CONFIG_HOME"
  exit 2
fi

if [ "$UNINSTALL" -eq 1 ] && [ "$VERIFY" -eq 1 ]; then
  err "--uninstall cannot be combined with --verify"
  exit 2
fi
if [ "$DRY_RUN" -eq 1 ] && [ "$VERIFY" -eq 1 ]; then
  err "--dry-run cannot be combined with --verify"
  exit 2
fi
if [ "$UNINSTALL" -eq 1 ] && [ "$PRINT_CONFIG" -eq 1 ]; then
  err "--print-config cannot be combined with --uninstall"
  exit 2
fi

check_command() {
  if ! command -v "$1" >/dev/null 2>&1; then
    err "Required command not found: $1"
    exit 1
  fi
}

resolve_path() {
  node -e 'process.stdout.write(require("node:path").resolve(process.argv[1]))' "$1"
}

normalise_paths() {
  INSTALL_DIR="$(resolve_path "$INSTALL_DIR")"
  CONFIG_DIR="$(resolve_path "$CONFIG_DIR")"
  CONFIG_PATH="${CONFIG_DIR}/mcp-server.json"
  CODEX_CONFIG_PATH="${CONFIG_DIR}/codex-mcp-server.toml"
  STATE_DIR="$(resolve_path "$STATE_DIR")"
  ARTIFACT_DIR="$(resolve_path "$ARTIFACT_DIR")"
  CLI_LAUNCHER="${INSTALL_DIR}/deepseek-harness"
  MCP_LAUNCHER="${INSTALL_DIR}/deepseek-harness-mcp"
  APP_DIR="${INSTALL_DIR}/deepseek-harness-app"
  APP_MARKER_PATH="${APP_DIR}/.deepseek-harness-installer"
  CLI_ENTRYPOINT="${REPO_ROOT}/dist/src/cli.js"
}

acquire_lock() {
  if ! mkdir "$LOCK_DIR" 2>/dev/null; then
    err "Another deepseek-harness install appears to be running: $LOCK_DIR"
    exit 1
  fi
  LOCK_HELD=1
}

ensure_dir() {
  local directory="$1"
  local label="$2"
  if [ -e "$directory" ] && [ ! -d "$directory" ]; then
    err "$label is not a directory: $directory"
    exit 1
  fi
  if ! mkdir -p "$directory"; then
    err "Could not create $label: $directory"
    exit 1
  fi
  if [ ! -w "$directory" ]; then
    err "$label is not writable: $directory"
    exit 1
  fi
}

atomic_write() {
  local target="$1"
  local mode="$2"
  local temporary
  if ! temporary="$(mktemp "${target}.tmp.XXXXXX")"; then
    err "Could not create a temporary file for: $target"
    exit 1
  fi
  if ! cat > "$temporary"; then
    rm -f "$temporary"
    err "Could not write temporary file for: $target"
    exit 1
  fi
  if ! chmod "$mode" "$temporary" || ! mv -f "$temporary" "$target"; then
    rm -f "$temporary"
    err "Could not install file: $target"
    exit 1
  fi
}

write_generated() {
  local target="$1"
  local mode="$2"
  local label="$3"
  local generator="$4"
  local temporary
  if ! temporary="$(mktemp "${target}.tmp.XXXXXX")"; then
    err "Could not create a temporary file for: $target"
    exit 1
  fi
  if ! "$generator" > "$temporary"; then
    rm -f "$temporary"
    err "Could not generate $label: $target"
    exit 1
  fi
  if ! chmod "$mode" "$temporary" || ! mv -f "$temporary" "$target"; then
    rm -f "$temporary"
    err "Could not install $label: $target"
    exit 1
  fi
}

path_exists() { [ -e "$1" ] || [ -L "$1" ]; }

managed_launcher() {
  [ -f "$1" ] && [ ! -L "$1" ] && grep -Fqx "# $MARKER" "$1"
}

managed_json_config() {
  [ -f "$1" ] && [ ! -L "$1" ] || return 1
  DEEPSEEK_HARNESS_INSTALLER_MARKER="$MARKER" node -e '
    const fs = require("node:fs");
    try {
      const value = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
      const env = value?.mcpServers?.["deepseek-harness"]?.env;
      process.exit(env?.DEEPSEEK_HARNESS_INSTALLER_MARKER === process.env.DEEPSEEK_HARNESS_INSTALLER_MARKER ? 0 : 1);
    } catch {
      process.exit(1);
    }
  ' "$1" >/dev/null 2>&1
}

managed_toml_config() {
  [ -f "$1" ] && [ ! -L "$1" ] && grep -Fqx "DEEPSEEK_HARNESS_INSTALLER_MARKER = \"$MARKER\"" "$1"
}

managed_runtime() {
  [ -d "$APP_DIR" ] && [ ! -L "$APP_DIR" ] &&
    [ -f "$APP_MARKER_PATH" ] && [ ! -L "$APP_MARKER_PATH" ] &&
    grep -Fqx "$MARKER" "$APP_MARKER_PATH"
}

runtime_complete() {
  managed_runtime &&
    [ -f "$APP_DIR/dist/src/cli.js" ] &&
    [ -f "$APP_DIR/dist/src/mcp.js" ] &&
    [ -f "$APP_DIR/package.json" ]
}

check_target() {
  local target="$1"
  local label="$2"
  if ! path_exists "$target"; then
    return 0
  fi
  if [ -d "$target" ] && [ ! -L "$target" ]; then
    err "Refusing to replace directory at $label path: $target"
    exit 1
  fi
  if [ "$FORCE" -eq 1 ]; then
    return 0
  fi
  case "$label" in
    launcher) managed_launcher "$target" || { err "Refusing to overwrite unmanaged launcher: $target (use --force)"; exit 1; } ;;
    JSON) managed_json_config "$target" || { err "Refusing to overwrite unmanaged JSON MCP config: $target (use --force)"; exit 1; } ;;
    TOML) managed_toml_config "$target" || { err "Refusing to overwrite unmanaged Codex MCP config: $target (use --force)"; exit 1; } ;;
  esac
}

preflight_install() {
  local cli_exists=0
  local mcp_exists=0
  path_exists "$CLI_LAUNCHER" && cli_exists=1
  path_exists "$MCP_LAUNCHER" && mcp_exists=1
  if [ "$cli_exists" -ne "$mcp_exists" ] && [ "$FORCE" -eq 0 ]; then
    err "Refusing to continue with a partial launcher set; both launchers must be present or absent (use --force to repair): $INSTALL_DIR"
    exit 1
  fi
  check_target "$CLI_LAUNCHER" launcher
  check_target "$MCP_LAUNCHER" launcher
  check_target "$CONFIG_PATH" JSON
  check_target "$CODEX_CONFIG_PATH" TOML
  if path_exists "$APP_DIR"; then
    if [ -L "$APP_DIR" ] || [ ! -d "$APP_DIR" ]; then
      err "Refusing to replace non-directory runtime path: $APP_DIR"
      exit 1
    fi
    if ! managed_runtime; then
      err "Refusing to replace unmanaged runtime directory: $APP_DIR"
      exit 1
    fi
    if [ "$FORCE" -eq 0 ] && ! runtime_complete; then
      err "Managed runtime is incomplete; use --force to repair: $APP_DIR"
      exit 1
    fi
  fi
}

shell_quote() {
  printf '%q' "$1"
}

prepare_runtime() {
  if runtime_complete && [ "$FORCE" -eq 0 ]; then
    CLI_ENTRYPOINT="${APP_DIR}/dist/src/cli.js"
    return 0
  fi

  local staging
  if ! staging="$(mktemp -d "${INSTALL_DIR}/.deepseek-harness-app.tmp.XXXXXX")"; then
    err "Could not create a temporary runtime directory under: $INSTALL_DIR"
    exit 1
  fi
  RUNTIME_STAGING="$staging"
  if [ ! -f "$REPO_ROOT/package.json" ]; then
    err "Package metadata is missing: $REPO_ROOT/package.json"
    exit 1
  fi
  if [ ! -f "$REPO_ROOT/dist/src/cli.js" ] || [ ! -f "$REPO_ROOT/dist/src/mcp.js" ]; then
    err "Built runtime is missing: $REPO_ROOT/dist/src/cli.js and $REPO_ROOT/dist/src/mcp.js"
    exit 1
  fi
  mkdir -p "$staging/dist"
  if ! cp -R "$REPO_ROOT/dist/." "$staging/dist/"; then
    err "Could not copy the built runtime into: $staging"
    exit 1
  fi
  if ! cp "$REPO_ROOT/package.json" "$staging/package.json"; then
    err "Could not copy package metadata into: $staging"
    exit 1
  fi

  if [ -d "$REPO_ROOT/node_modules" ]; then
    if ! cp -R "$REPO_ROOT/node_modules" "$staging/node_modules"; then
      err "Could not copy runtime dependencies into: $staging"
      exit 1
    fi
  else
    check_command npm
    info "Installing production dependencies into the managed runtime"
    if ! (cd "$staging" && npm install --omit=dev --no-package-lock --ignore-scripts); then
      err "Could not install production dependencies for the managed runtime"
      exit 1
    fi
  fi
  if ! printf '%s\n' "$MARKER" > "$staging/.deepseek-harness-installer"; then
    err "Could not mark the managed runtime: $staging"
    exit 1
  fi
  if path_exists "$APP_DIR"; then
    rm -rf "$APP_DIR"
  fi
  if ! mv "$staging" "$APP_DIR"; then
    err "Could not install the managed runtime: $APP_DIR"
    exit 1
  fi
  RUNTIME_STAGING=""
  CLI_ENTRYPOINT="${APP_DIR}/dist/src/cli.js"
  ok "Installed self-contained runtime in $APP_DIR"
}

write_launchers() {
  local app="$APP_DIR"
  local state="$STATE_DIR"
  local artifact="$ARTIFACT_DIR"
  local profile="$PROFILE"
  local marker="$MARKER"
  local app_q state_q artifact_q profile_q marker_q
  app_q="$(shell_quote "$app")"
  state_q="$(shell_quote "$state")"
  artifact_q="$(shell_quote "$artifact")"
  profile_q="$(shell_quote "$profile")"
  marker_q="$(shell_quote "$marker")"

  atomic_write "$CLI_LAUNCHER" 0755 <<EOF
#!/usr/bin/env bash
# $MARKER
set -euo pipefail
export DEEPSEEK_HARNESS_STATE_DIR=$state_q
export DEEPSEEK_HARNESS_ARTIFACT_DIR=$artifact_q
export DEEPSEEK_HARNESS_MCP_PROFILE=$profile_q
export DEEPSEEK_HARNESS_INSTALLER_MARKER=$marker_q
cd $app_q
exec node ${app_q}/dist/src/cli.js "\$@"
EOF
  atomic_write "$MCP_LAUNCHER" 0755 <<EOF
#!/usr/bin/env bash
# $MARKER
set -euo pipefail
export DEEPSEEK_HARNESS_STATE_DIR=$state_q
export DEEPSEEK_HARNESS_ARTIFACT_DIR=$artifact_q
export DEEPSEEK_HARNESS_MCP_PROFILE=$profile_q
export DEEPSEEK_HARNESS_INSTALLER_MARKER=$marker_q
cd $app_q
exec node ${app_q}/dist/src/mcp.js
EOF
  ok "Installed launchers in $INSTALL_DIR"
}

generate_json_config() {
  DEEPSEEK_HARNESS_INSTALLER_MARKER="$MARKER" DEEPSEEK_HARNESS_MCP_PROFILE="$PROFILE" \
    node "$CLI_ENTRYPOINT" mcp-config \
      --command "$MCP_LAUNCHER" \
      --state-dir "$STATE_DIR" \
      --artifact-dir "$ARTIFACT_DIR" \
      --profile "$PROFILE" |
    DEEPSEEK_HARNESS_INSTALLER_MARKER="$MARKER" DEEPSEEK_HARNESS_MCP_PROFILE="$PROFILE" \
      node -e '
        const fs = require("node:fs");
        const value = JSON.parse(fs.readFileSync(0, "utf8"));
        const server = value?.mcpServers?.["deepseek-harness"];
        if (!server || typeof server !== "object" || Array.isArray(server) || !server.env || typeof server.env !== "object") {
          throw new Error("MCP config did not contain the expected deepseek-harness server");
        }
        server.env.DEEPSEEK_HARNESS_MCP_PROFILE = process.env.DEEPSEEK_HARNESS_MCP_PROFILE;
        server.env.DEEPSEEK_HARNESS_INSTALLER_MARKER = process.env.DEEPSEEK_HARNESS_INSTALLER_MARKER;
        process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
      '
}

generate_toml_config() {
  DEEPSEEK_HARNESS_INSTALLER_MARKER="$MARKER" DEEPSEEK_HARNESS_MCP_PROFILE="$PROFILE" \
    node "$CLI_ENTRYPOINT" mcp-config \
      --format codex-toml \
      --command "$MCP_LAUNCHER" \
      --state-dir "$STATE_DIR" \
      --artifact-dir "$ARTIFACT_DIR" \
      --profile "$PROFILE" |
    DEEPSEEK_HARNESS_INSTALLER_MARKER="$MARKER" DEEPSEEK_HARNESS_MCP_PROFILE="$PROFILE" \
      node -e '
        const fs = require("node:fs");
        const section = "[mcp_servers.deepseek-harness.env]";
        let value = fs.readFileSync(0, "utf8").trimEnd();
        if (!value.includes(section)) {
          throw new Error("MCP TOML did not contain the expected environment section");
        }
        const upsert = (source, key, line) => {
          const expression = new RegExp(`^${key} = .*$`, "m");
          return expression.test(source) ? source.replace(expression, line) : `${source}\n${line}`;
        };
        value = upsert(value, "DEEPSEEK_HARNESS_MCP_PROFILE", `DEEPSEEK_HARNESS_MCP_PROFILE = ${JSON.stringify(process.env.DEEPSEEK_HARNESS_MCP_PROFILE)}`);
        value = upsert(value, "DEEPSEEK_HARNESS_INSTALLER_MARKER", `DEEPSEEK_HARNESS_INSTALLER_MARKER = ${JSON.stringify(process.env.DEEPSEEK_HARNESS_INSTALLER_MARKER)}`);
        process.stdout.write(`# ${process.env.DEEPSEEK_HARNESS_INSTALLER_MARKER}\n${value}\n`);
      '
}

write_mcp_config() {
  write_generated "$CONFIG_PATH" 0644 "JSON MCP config" generate_json_config
  ok "Wrote MCP config snippet: $CONFIG_PATH"
  write_generated "$CODEX_CONFIG_PATH" 0644 "Codex MCP config" generate_toml_config
  ok "Wrote Codex MCP config snippet: $CODEX_CONFIG_PATH"
}

verification_failure() {
  local label="$1"
  local output="$2"
  local error_output="$3"
  err "$label"
  if [ "$QUIET" -eq 0 ]; then
    [ -s "$error_output" ] && cat "$error_output" >&2 || true
    [ -s "$output" ] && cat "$output" >&2 || true
  fi
}

mcp_smoke() {
  (
    cd "$APP_DIR"
    DEEPSEEK_HARNESS_SMOKE_COMMAND="$MCP_LAUNCHER" DEEPSEEK_HARNESS_SMOKE_PROFILE="$PROFILE" \
      node --input-type=module - <<'NODE'
      import fs from "node:fs";
      import os from "node:os";
      import path from "node:path";
      import { Client } from "@modelcontextprotocol/sdk/client/index.js";
      import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

      const command = process.env.DEEPSEEK_HARNESS_SMOKE_COMMAND;
      const profile = process.env.DEEPSEEK_HARNESS_SMOKE_PROFILE;
      if (!command || !profile) throw new Error("Installer MCP smoke inputs were not configured");
      const root = fs.mkdtempSync(path.join(os.tmpdir(), "deepseek-harness-installer-smoke-"));
      const transport = new StdioClientTransport({
        command,
        args: [],
        cwd: process.cwd(),
        env: {
          ...process.env,
          DEEPSEEK_HARNESS_MCP_PROFILE: profile,
          DEEPSEEK_HARNESS_STATE_DIR: path.join(root, ".state"),
          DEEPSEEK_HARNESS_ARTIFACT_DIR: path.join(root, "artifacts"),
          DEEPSEEK_HARNESS_INPUT_ROOT: root
        }
      });
      const client = new Client({ name: "deepseek-harness-installer-smoke", version: "0.0.1" }, { capabilities: {} });
      try {
        await client.connect(transport);
        const names = (await client.listTools()).tools.map((tool) => tool.name);
        const common = ["deepseek_harness_doctor"];
        const core = [...common, "deepseek_harness_plan", "deepseek_harness_workload_benchmark"];
        const corpus = [...common, "deepseek_harness_corpus_ingest_text", "deepseek_harness_corpus_plan"];
        const required = profile === "corpus" ? corpus : profile === "full" ? [...core, ...corpus] : core;
        const missing = required.filter((name) => !names.includes(name));
        if (missing.length > 0) throw new Error(`Missing MCP smoke tools: ${missing.join(", ")}`);
        const doctor = await client.callTool({ name: "deepseek_harness_doctor", arguments: {} });
        const doctorText = doctor.content?.find((item) => item.type === "text")?.text;
        const doctorPayload = doctorText ? JSON.parse(doctorText) : null;
        if (!doctorPayload?.ok || doctorPayload.deepseek_api_key_present !== false) {
          throw new Error("MCP doctor did not return an ok no-secret payload");
        }
        if (names.includes("deepseek_harness_capabilities")) {
          const response = await client.callTool({ name: "deepseek_harness_capabilities", arguments: {} });
          const text = response.content?.find((item) => item.type === "text")?.text;
          const payload = text ? JSON.parse(text) : null;
          if (payload?.active_mcp_profile !== profile) throw new Error(`MCP profile was not active: ${profile}`);
        }
        console.log(JSON.stringify({ ok: true, profile, tool_count: names.length }));
      } finally {
        await client.close();
        fs.rmSync(root, { recursive: true, force: true });
      }
NODE
  )
}

verify_install() {
  local doctor_output doctor_error smoke_output smoke_error
  doctor_output="$(mktemp "${TMPDIR:-/tmp}/${PROJECT}.doctor.XXXXXX")" || { err "Could not create CLI verification temporary file"; return 1; }
  doctor_error="$(mktemp "${TMPDIR:-/tmp}/${PROJECT}.doctor-error.XXXXXX")" || { rm -f "$doctor_output"; err "Could not create CLI verification error file"; return 1; }
  smoke_output="$(mktemp "${TMPDIR:-/tmp}/${PROJECT}.smoke.XXXXXX")" || { rm -f "$doctor_output" "$doctor_error"; err "Could not create MCP verification temporary file"; return 1; }
  smoke_error="$(mktemp "${TMPDIR:-/tmp}/${PROJECT}.smoke-error.XXXXXX")" || { rm -f "$doctor_output" "$doctor_error" "$smoke_output"; err "Could not create MCP verification error file"; return 1; }

  if ! managed_launcher "$CLI_LAUNCHER" || [ ! -x "$CLI_LAUNCHER" ]; then
    verification_failure "CLI doctor verification failed: managed CLI launcher is missing" "$doctor_output" "$doctor_error"
    rm -f "$doctor_output" "$doctor_error" "$smoke_output" "$smoke_error"
    return 1
  fi
  if ! managed_launcher "$MCP_LAUNCHER" || [ ! -x "$MCP_LAUNCHER" ]; then
    verification_failure "MCP smoke verification failed: managed MCP launcher is missing" "$smoke_output" "$smoke_error"
    rm -f "$doctor_output" "$doctor_error" "$smoke_output" "$smoke_error"
    return 1
  fi
  if ! env -u DEEPSEEK_API_KEY -u DEEPSEEK_HARNESS_APPROVAL_PUBLIC_KEY "$CLI_LAUNCHER" doctor > "$doctor_output" 2> "$doctor_error"; then
    verification_failure "CLI doctor verification failed: installed doctor exited non-zero" "$doctor_output" "$doctor_error"
    rm -f "$doctor_output" "$doctor_error" "$smoke_output" "$smoke_error"
    return 1
  fi
  if ! node -e '
    const fs = require("node:fs");
    const value = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
    process.exit(value.ok === true && value.state_dir === process.argv[2] && value.deepseek_api_key_present === false ? 0 : 1);
  ' "$doctor_output" "$STATE_DIR"; then
    verification_failure "CLI doctor verification failed: unexpected no-secret doctor payload" "$doctor_output" "$doctor_error"
    rm -f "$doctor_output" "$doctor_error" "$smoke_output" "$smoke_error"
    return 1
  fi
  ok "CLI doctor verification passed"

  if ! (unset DEEPSEEK_API_KEY DEEPSEEK_HARNESS_APPROVAL_PUBLIC_KEY; mcp_smoke) > "$smoke_output" 2> "$smoke_error"; then
    verification_failure "MCP smoke verification failed: installed MCP launcher exited non-zero" "$smoke_output" "$smoke_error"
    rm -f "$doctor_output" "$doctor_error" "$smoke_output" "$smoke_error"
    return 1
  fi
  ok "MCP smoke verification passed"
  rm -f "$doctor_output" "$doctor_error" "$smoke_output" "$smoke_error"
}

dry_run_install() {
  preflight_install
  info "Dry run: no files will be changed"
  if [ "$NO_BUILD" -eq 0 ]; then
    if [ -f "$REPO_ROOT/package-lock.json" ]; then
      info "Would run npm ci and npm run build"
    elif [ -f "$REPO_ROOT/dist/src/cli.js" ] && [ -f "$REPO_ROOT/dist/src/mcp.js" ]; then
      info "Would use the built runtime from this package (no package-lock.json required)"
    else
      info "Would run npm install without a package lock and npm run build"
    fi
  else
    info "Would skip the build"
  fi
  info "Would install managed launchers in $INSTALL_DIR"
  info "Would write MCP snippets in $CONFIG_DIR"
  info "Would prepare state directory $STATE_DIR"
  info "Would prepare artefact directory $ARTIFACT_DIR"
  if [ "$PRINT_CONFIG" -eq 1 ]; then
    if [ ! -f "$CLI_ENTRYPOINT" ]; then
      err "--dry-run --print-config requires a built CLI at $REPO_ROOT/dist/src/cli.js"
      return 1
    fi
    generate_json_config
  fi
}

uninstall_runtime() {
  if ! path_exists "$APP_DIR"; then
    return 0
  fi
  if managed_runtime; then
    if [ "$DRY_RUN" -eq 1 ]; then
      info "Would remove managed runtime: $APP_DIR"
    else
      rm -rf "$APP_DIR"
      ok "Removed managed runtime: $APP_DIR"
    fi
  else
    warn "Preserved unmanaged runtime: $APP_DIR"
  fi
}

uninstall_file() {
  local target="$1"
  local label="$2"
  local managed=1
  if ! path_exists "$target"; then
    return 0
  fi
  case "$label" in
    launcher) managed_launcher "$target" || managed=0 ;;
    JSON) managed_json_config "$target" || managed=0 ;;
    TOML) managed_toml_config "$target" || managed=0 ;;
  esac
  if [ "$managed" -eq 1 ]; then
    if [ "$DRY_RUN" -eq 1 ]; then
      info "Would remove managed $label: $target"
    else
      rm -f "$target"
      ok "Removed managed $label: $target"
    fi
  else
    warn "Preserved unmanaged $label: $target"
  fi
}

uninstall() {
  uninstall_runtime
  uninstall_file "$CLI_LAUNCHER" launcher
  uninstall_file "$MCP_LAUNCHER" launcher
  uninstall_file "$CONFIG_PATH" JSON
  uninstall_file "$CODEX_CONFIG_PATH" TOML
  if [ "$DRY_RUN" -eq 0 ]; then
    ok "Uninstall complete; state and artefact directories were preserved"
  fi
}

build_source() {
  if [ "$NO_BUILD" -eq 1 ]; then
    if [ ! -f "$REPO_ROOT/dist/src/cli.js" ] || [ ! -f "$REPO_ROOT/dist/src/mcp.js" ]; then
      err "--no-build requested but dist/src/cli.js and dist/src/mcp.js must exist"
      exit 1
    fi
    return 0
  fi
  if [ -f "$REPO_ROOT/package-lock.json" ]; then
    check_command npm
    info "Installing Node dependencies"
    npm ci
    info "Building TypeScript"
    npm run build
    return 0
  fi
  if [ -f "$REPO_ROOT/dist/src/cli.js" ] && [ -f "$REPO_ROOT/dist/src/mcp.js" ]; then
    info "Using the built runtime from this package; no package-lock.json or npm ci is required"
    return 0
  fi
  check_command npm
  info "Installing Node dependencies without a package lock"
  npm install --no-package-lock
  info "Building TypeScript"
  npm run build
}

main() {
  check_command node
  cd "$REPO_ROOT"
  normalise_paths

  if [ "$UNINSTALL" -eq 1 ]; then
    if [ "$DRY_RUN" -eq 0 ]; then acquire_lock; fi
    uninstall
    return
  fi
  if [ "$DRY_RUN" -eq 1 ]; then
    dry_run_install
    return
  fi

  info "Repository: $REPO_ROOT"
  info "Install dir: $INSTALL_DIR"
  acquire_lock

  build_source
  preflight_install
  ensure_dir "$INSTALL_DIR" "install directory"
  ensure_dir "$CONFIG_DIR" "config directory"
  ensure_dir "$STATE_DIR" "state directory"
  ensure_dir "$ARTIFACT_DIR" "artefact directory"
  prepare_runtime
  write_launchers
  write_mcp_config

  if [ "$VERIFY" -eq 1 ]; then
    verify_install
  fi
  if [ "$PRINT_CONFIG" -eq 1 ]; then
    cat "$CONFIG_PATH"
  fi

  ok "Install complete"
  info "MCP command: $MCP_LAUNCHER"
  info "CLI command: $CLI_LAUNCHER"
  info "Smoke: run $MCP_LAUNCHER with an MCP client"
}

main
