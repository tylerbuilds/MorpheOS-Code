import { useMemo, useReducer, useRef, useState } from "react";
import { Box, Text, render, useApp, useInput, useWindowSize } from "ink";
import path from "node:path";
import { HarnessError } from "../errors.js";
import { defaultArtifactRoot } from "../paths.js";
import { agentTurn } from "./loop.js";
import { formatCorpusJob, loadCorpusJobs, type CorpusJob } from "./jobs.js";
import { listSessions, updateSessionSummary, type AgentSession } from "./session.js";
import { createToolRegistry, setCheckpointManager, type ToolApprovalRequest, type ToolRegistry } from "./tools.js";
import { CheckpointManager } from "./checkpoint.js";
import { createSessionApprovalGate, formatApprovalRequest, type ApprovalChoice } from "./cli.js";
import { composerSegments, initialTuiState, shouldExitOnCtrlD, transcriptLines, tuiReducer } from "./tui-state.js";
import { bold, dim, grey, gold } from "./theme.js";
import { createPermissionGate, formatRule, type PermissionRule } from "./permissions.js";
import { McpRegistry, type McpServerConfig, type McpToolDefinition } from "./mcp-client.js";
import { MemoryManager } from "./memory.js";
import { BackgroundManager, type BgJob } from "./background.js";
import { pairedTurn, type PairingConfig } from "./pairing.js";
import { reviewToolCall, DEFAULT_ADVERSARY_CONFIG, type AdversaryConfig } from "./adversary.js";

const MOTD = [
  `⚡ ${bold("MorpheOS Code")} — ${dim("Captain Zeus at the helm")}`,
  "",
  `${grey("Type /help for orders. /exit to leave the bridge.")}`,
  `${grey("Powered by DeepSeek V4 · British English · Ship metaphors encouraged")}`,
];

function zeusError(raw: string): string {
  if (raw.includes("401") || raw.includes("unauthorized")) return "The DeepSeek harbour master refused our credentials, Captain. Check your API key.";
  if (raw.includes("402")) return "Insufficient credits — the coffer's run dry. Top up at platform.deepseek.com.";
  if (raw.includes("429")) return "Rate limit hit — we're knocking too loudly at the harbour gate. Give it a moment.";
  if (raw.includes("timeout") || raw.includes("timed out")) return "DeepSeek hasn't answered our hail, Captain. The line may be down.";
  if (raw.includes("aborted")) return "Course aborted, Captain.";
  if (raw.includes("DEEPSEEK_API_KEY")) return "No API key in the chart room, Captain. Set DEEPSEEK_API_KEY in your environment.";
  return raw;
}

type SlashCommand = { readonly kind: "exit" } | { readonly kind: "clear" } | { readonly kind: "message"; readonly message: string } | { readonly kind: "jobs"; readonly jobs: readonly CorpusJob[] } | { readonly kind: "thinking" } | { readonly kind: "model" } | { readonly kind: "settings" } | { readonly kind: "mcp-list" } | { readonly kind: "mcp-add"; readonly config: McpServerConfig } | { readonly kind: "mcp-remove"; readonly name: string } | { readonly kind: "permit"; readonly command: "add" | "remove" | "list"; readonly rule?: PermissionRule; readonly pattern?: string } | { readonly kind: "memory-show" } | { readonly kind: "memory-save"; readonly entry: string } | { readonly kind: "memory-topic"; readonly name: string } | { readonly kind: "memory-topics" } | { readonly kind: "bg-list" } | { readonly kind: "bg-cancel"; readonly id: string } | { readonly kind: "pair"; readonly action: "on" | "off" | "status" } | { readonly kind: "adversary"; readonly action: "on" | "off" | "add" | "status"; readonly policy?: string } | { readonly kind: "undo"; readonly filePath?: string } | { readonly kind: "rewind"; readonly checkpointId: string } | { readonly kind: "checkpoints" };

export async function runTui(session: AgentSession, apiKey: string): Promise<void> {
  const instance = render(<ChatTui session={session} apiKey={apiKey} />, { alternateScreen: true, exitOnCtrlC: false, patchConsole: false });
  await instance.waitUntilExit();
}

function ChatTui({ session, apiKey }: { readonly session: AgentSession; readonly apiKey: string }) {
  const { exit } = useApp();
  const { columns, rows } = useWindowSize();
  const [state, dispatch] = useReducer(tuiReducer, undefined, initialTuiState);
  const [draft, setDraft] = useState("");
  const [cursor, setCursor] = useState(0);
  const [history, setHistory] = useState<readonly string[]>([]);
  const [historyIndex, setHistoryIndex] = useState<number | null>(null);
  const [jobs, setJobs] = useState<readonly CorpusJob[]>(() => loadCorpusJobs(defaultArtifactRoot()));
  const [approval, setApproval] = useState<ToolApprovalRequest | null>(null);
  const [model, setModel] = useState(session.model);
  const [showSettings, setShowSettings] = useState(false);
  const [settingsIdx, setSettingsIdx] = useState(0);
  const bgManager = useRef(new BackgroundManager());
  const checkpointManager = useRef(new CheckpointManager(session.cwd));
  const [checkpointCount, setCheckpointCount] = useState(0);
  const [bgJobs, setBgJobs] = useState<readonly BgJob[]>([]);
  const [pairing, setPairing] = useState<PairingConfig>({ enabled: false, architect: "deepseek-v4-pro", editor: "deepseek-v4-flash" });
  const [adversary, setAdversary] = useState<AdversaryConfig>(DEFAULT_ADVERSARY_CONFIG);
  const approvalResolver = useRef<((choice: ApprovalChoice) => void) | null>(null);
  const turnController = useRef<AbortController | null>(null);
  const exitAfterTurn = useRef(false);
  const registry = useMemo(() => {
    const next = createToolRegistry();
    const approvalGate = createSessionApprovalGate((request) => new Promise((resolve) => {
      approvalResolver.current = resolve;
      setApproval(request);
    }));
    next.setTier2Gate(createPermissionGate(state.rules, approvalGate, "ask"));
    return next;
  }, [state.rules]);

  const mcpRegistry = useMemo(() => new McpRegistry(), []);

  const resolveApproval = (choice: ApprovalChoice): void => {
    const resolve = approvalResolver.current;
    approvalResolver.current = null;
    setApproval(null);
    resolve?.(choice);
  };

  const submit = (raw: string): void => {
    const input = raw.trim();
    if (!input || state.status === "running") return;
    setDraft("");
    setCursor(0);
    setHistory((current) => [...current, input].slice(-100));
    setHistoryIndex(null);
    if (input.startsWith("/")) {
      const command = slashCommand(input, session, state.showThinking);
      switch (command.kind) {
        case "exit": exit(); break;
        case "clear": dispatch({ type: "clear" }); break;
        case "message": dispatch({ type: "message", message: command.message }); break;
        case "jobs":
          setJobs(command.jobs);
          dispatch({ type: "message", message: command.jobs.map(formatCorpusJob).join("\n") || "No corpus jobs found." });
          break;
        case "thinking":
          dispatch({ type: "toggleThinking" });
          dispatch({ type: "message", message: state.showThinking ? "Thinking hidden." : "Thinking visible." });
          break;
        case "model": {
          const arg = input.split(/\s+/, 2)[1]?.toLowerCase();
          if (arg === "pro") { setModel("deepseek-v4-pro"); session.model = "deepseek-v4-pro"; dispatch({ type: "message", message: "Engines: Pro. Full power to the reactors." }); }
          else if (arg === "flash") { setModel("deepseek-v4-flash"); session.model = "deepseek-v4-flash"; dispatch({ type: "message", message: "Engines: Flash. Efficient and swift." }); }
          else dispatch({ type: "message", message: "Usage: /model flash | /model pro" });
          break;
        }
        case "settings": setShowSettings(true); break;
        case "mcp-list": {
          const servers = mcpRegistry.getServerNames();
          if (servers.length === 0) {
            dispatch({ type: "message", message: "No MCP servers connected. Use /mcp add <name> <command> to connect one." });
          } else {
            const lines: string[] = ["Connected MCP servers:"];
            for (const name of servers) {
              const client = mcpRegistry.getClient(name);
              const toolCount = client?.getTools().length ?? 0;
              lines.push(`  ${name} — ${toolCount} tool(s)`);
            }
            dispatch({ type: "message", message: lines.join("\n") });
          }
          break;
        }
        case "mcp-add": {
          const config = command.config;
          dispatch({ type: "message", message: `Connecting to MCP server "${config.name}"...` });
          connectMcpServer(mcpRegistry, registry, config).then(
            (tools) => dispatch({ type: "message", message: `MCP server "${config.name}" connected with ${tools.length} tool(s).` }),
            (err) => dispatch({ type: "error", message: `Failed to connect MCP server "${config.name}": ${err instanceof Error ? err.message : String(err)}` }),
          );
          break;
        }
        case "mcp-remove": {
          const name = command.name;
          if (!mcpRegistry.getClient(name)) {
            dispatch({ type: "message", message: `No MCP server named "${name}" is connected.` });
          } else {
            // Unregister all tools for this server
            const prefix = mcpToolPrefix(name);
            registry.unregisterByPrefix(prefix);
            mcpRegistry.removeServer(name).then(
              () => dispatch({ type: "message", message: `MCP server "${name}" disconnected.` }),
              (err) => dispatch({ type: "error", message: `Error disconnecting "${name}": ${err instanceof Error ? err.message : String(err)}` }),
            );
          }
          break;
        }
        case "memory-show": {
          const mem = new MemoryManager(session.cwd);
          const ctx = mem.loadContext();
          if (ctx) {
            const lines = ctx.split("\n").slice(0, 10);
            dispatch({ type: "message", message: `⚓ Project Memory (first 10 entries):\n${lines.join("\n")}` });
          } else {
            dispatch({ type: "message", message: "No project memory yet, Captain. Use /memory save <entry> to record a learning." });
          }
          break;
        }
        case "memory-save": {
          const mem = new MemoryManager(session.cwd);
          mem.saveEntry(command.entry).then(
            () => dispatch({ type: "message", message: `Memory saved: "${command.entry}"` }),
            (err) => dispatch({ type: "error", message: `Failed to save memory: ${err instanceof Error ? err.message : String(err)}` }),
          );
          break;
        }
        case "memory-topic": {
          const mem = new MemoryManager(session.cwd);
          const topicContent = mem.loadTopic(command.name);
          if (topicContent) {
            dispatch({ type: "message", message: `📋 Topic "${command.name}":\n${topicContent.slice(0, 2000)}` });
          } else {
            dispatch({ type: "message", message: `No topic named "${command.name}" found. Use /memory topics to list available topics.` });
          }
          break;
        }
        case "memory-topics": {
          const mem = new MemoryManager(session.cwd);
          const topics = mem.listTopics();
          if (topics.length > 0) {
            dispatch({ type: "message", message: `📚 Available topics:\n${topics.map(t => `  - ${t}`).join("\n")}` });
          } else {
            dispatch({ type: "message", message: "No topics saved yet. Use /memory topic <name> — the agent will create topic files as it learns." });
          }
          break;
        }
        case "permit": {
          if (command.command === "list") {
            const lines = state.rules.length > 0
              ? state.rules.map(formatRule)
              : ["No session permission rules set."];
            dispatch({ type: "message", message: lines.join("\n") });
          } else if (command.command === "add" && command.rule) {
            dispatch({ type: "addRule", rule: command.rule });
            dispatch({ type: "message", message: `Permission rule added: ${formatRule(command.rule)}` });
          } else if (command.command === "remove" && command.pattern) {
            dispatch({ type: "removeRule", pattern: command.pattern });
            dispatch({ type: "message", message: `Permission rule removed: ${command.pattern}` });
          }
          break;
        }
        case "bg-list": {
          const all = bgManager.current.listJobs();
          if (all.length === 0) {
            dispatch({ type: "message", message: "No background jobs, Captain." });
          } else {
            const lines = all.map(j => `${j.id} [${j.status}] ${j.name} — ${j.summary}`);
            dispatch({ type: "message", message: `Background jobs (${all.length}):\n${lines.join("\n")}` });
          }
          setBgJobs(all);
          dispatch({ type: "bgUpdate", jobs: all });
          break;
        }
        case "bg-cancel": {
          const cancelled = bgManager.current.cancelJob(command.id);
          const all = bgManager.current.listJobs();
          setBgJobs(all);
          dispatch({ type: "bgUpdate", jobs: all });
          dispatch({ type: "message", message: cancelled ? `Job ${command.id} cancelled.` : `Job ${command.id} not found or already finished.` });
          break;
        }
        case "pair": {
          if (command.action === "on") {
            setPairing({ ...pairing, enabled: true });
            dispatch({ type: "message", message: `Architect/Editor pairing engaged. ${pairing.architect} plans, ${pairing.editor} executes.` });
          } else if (command.action === "off") {
            setPairing({ ...pairing, enabled: false });
            dispatch({ type: "message", message: "Pairing disengaged. Back to single-model mode." });
          } else {
            dispatch({ type: "message", message: pairing.enabled
              ? `Pairing: ON — ${pairing.architect} (architect) → ${pairing.editor} (editor)`
              : "Pairing: OFF — single-model mode" });
          }
          break;
        }
        case "adversary": {
          if (command.action === "on" && command.policy) {
            const next: AdversaryConfig = { enabled: true, policies: [command.policy], model: adversary.model };
            setAdversary(next);
            dispatch({ type: "setAdversary", active: true, policyCount: 1 });
            dispatch({ type: "message", message: `Adversary engaged. Policy: "${command.policy}"` });
          } else if (command.action === "add" && command.policy) {
            const next: AdversaryConfig = { ...adversary, policies: [...adversary.policies, command.policy] };
            setAdversary(next);
            dispatch({ type: "setAdversary", active: true, policyCount: next.policies.length });
            dispatch({ type: "message", message: `Policy added (${next.policies.length} total): "${command.policy}"` });
          } else if (command.action === "off") {
            setAdversary({ ...adversary, enabled: false });
            dispatch({ type: "setAdversary", active: false, policyCount: adversary.policies.length });
            dispatch({ type: "message", message: "Adversary disengaged. Standing down." });
          } else if (command.action === "status") {
            if (adversary.enabled && adversary.policies.length > 0) {
              const policyLines = adversary.policies.map((p, i) => `  ${i + 1}. ${p}`).join("\n");
              dispatch({ type: "message", message: `Adversary: ACTIVE (${adversary.policies.length} policies)\n${policyLines}` });
            } else {
              dispatch({ type: "message", message: "Adversary: OFF" });
            }
          }
          break;
        }
        case "undo": {
          const undone = checkpointManager.current.undo(command.filePath);
          if (undone) {
            dispatch({ type: "message", message: `Undid: ${undone.toolCall} → ${path.basename(undone.filePath)} (checkpoint ${undone.id})` });
          } else {
            dispatch({ type: "message", message: command.filePath
              ? `No checkpoints found for: ${command.filePath}`
              : "No checkpoints to undo, Captain." });
          }
          setCheckpointCount(checkpointManager.current.count());
          break;
        }
        case "rewind": {
          const restored = checkpointManager.current.restore(command.checkpointId);
          const ck = checkpointManager.current.findCheckpoint(command.checkpointId);
          if (restored && ck) {
            dispatch({ type: "message", message: `Rewound ${path.basename(ck.filePath)} to checkpoint ${ck.id} (${ck.toolCall} @ ${ck.timestamp})` });
          } else {
            dispatch({ type: "message", message: `Checkpoint not found: ${command.checkpointId}` });
          }
          break;
        }
        case "checkpoints": {
          const list = checkpointManager.current.list(20);
          if (list.length === 0) {
            dispatch({ type: "message", message: "No checkpoints yet, Captain. Mutate some files and check back." });
          } else {
            const lines = list.map((c) => `${c.id}  ${c.toolCall}  ${path.basename(c.filePath)}  ${c.timestamp}`);
            dispatch({ type: "message", message: `Checkpoints (${list.length}):\n${lines.join("\n")}` });
          }
          break;
        }
        default: assertNever(command);
      }
      return;
    }
    dispatch({ type: "submit", input });
    if (!apiKey) {
      dispatch({ type: "error", message: "DEEPSEEK_API_KEY is not set." });
      return;
    }
    const controller = new AbortController();
    turnController.current = controller;
    setCheckpointManager(checkpointManager.current);

    // Build adversary beforeToolExecute callback
    const currentAdversary = adversary;
    const beforeToolExecute = currentAdversary.enabled && currentAdversary.policies.length > 0
      ? async (toolName: string, params: Record<string, unknown>) => {
          const verdict = await reviewToolCall(currentAdversary, toolName, params);
          return { allowed: verdict.allowed, reason: verdict.reasoning };
        }
      : undefined;

    if (pairing.enabled) {
      void pairedTurn(session, apiKey, input, pairing, {
        onText: (text) => dispatch({ type: "event", event: { type: "text_delta", delta: text } }),
        onPhase: (_phase, text) => dispatch({ type: "message", message: text }),
      })
        .then((result) => {
          dispatch({ type: "event", event: { type: "turn_complete", text: result.result, reasoningContent: "", toolCalls: 0, toolRounds: 0, tokens: result.totalTokens } });
          if (session.record.message_count <= 5) updateSessionSummary(session, `${input.slice(0, 80)}${input.length > 80 ? "..." : ""}`);
          setJobs(loadCorpusJobs(defaultArtifactRoot()));
          setCheckpointCount(checkpointManager.current.count());
        })
        .catch((error: unknown) => dispatch({ type: "error", message: zeusError(controller.signal.aborted ? "aborted" : error instanceof Error ? error.message : String(error)) }))
        .finally(() => { turnController.current = null; if (exitAfterTurn.current) exit(); });
    } else {
      void agentTurn(session, apiKey, input, (event) => dispatch({ type: "event", event }), registry, {
        signal: controller.signal,
        baseUrl: process.env.DEEPSEEK_API_BASE_URL,
        beforeToolExecute,
      })
        .then(() => {
          if (session.record.message_count <= 5) updateSessionSummary(session, `${input.slice(0, 80)}${input.length > 80 ? "..." : ""}`);
          setJobs(loadCorpusJobs(defaultArtifactRoot()));
          setCheckpointCount(checkpointManager.current.count());
        })
        .catch((error: unknown) => dispatch({ type: "error", message: zeusError(controller.signal.aborted ? "aborted" : error instanceof Error ? error.message : String(error)) }))
        .finally(() => { turnController.current = null; if (exitAfterTurn.current) exit(); });
    }
  };

  useInput((input, key) => {
    // Settings panel navigation
    if (showSettings) {
      if (key.escape) { setShowSettings(false); return; }
      if (key.upArrow) { setSettingsIdx((i) => Math.max(0, i - 1)); return; }
      if (key.downArrow) { setSettingsIdx((i) => Math.min(3, i + 1)); return; }
      if (key.leftArrow || key.rightArrow || key.return) {
        switch (settingsIdx) {
          case 0: { // Model toggle
            const next = model === "deepseek-v4-pro" ? "deepseek-v4-flash" : "deepseek-v4-pro";
            setModel(next); session.model = next; break;
          }
          case 1: setPairing((p) => ({ ...p, enabled: !p.enabled })); break;
          case 2: dispatch({ type: "toggleThinking" }); break;
          case 3: break; // Session info row — no action
        }
        return;
      }
      return;
    }
    if (key.ctrl && input === "c") {
      if (turnController.current) {
        resolveApproval("decline");
        turnController.current.abort();
      } else {
        exit();
      }
      return;
    }
    if (key.ctrl && input === "d") {
      if (!shouldExitOnCtrlD(draft)) return;
      resolveApproval("decline");
      if (turnController.current) {
        exitAfterTurn.current = true;
        turnController.current.abort();
      } else {
        exit();
      }
      return;
    }
    if (approval) {
      if (input === "y") resolveApproval("once");
      if (input === "s") resolveApproval("session");
      if (input === "n") resolveApproval("decline");
      return;
    }
    if (key.return) return submit(draft);
    if (key.leftArrow) return setCursor((value) => Math.max(0, value - 1));
    if (key.rightArrow) return setCursor((value) => Math.min(draft.length, value + 1));
    if (key.home) return setCursor(0);
    if (key.end) return setCursor(draft.length);
    if (key.backspace && cursor > 0) {
      setDraft(`${draft.slice(0, cursor - 1)}${draft.slice(cursor)}`);
      setCursor(cursor - 1);
      return;
    }
    if (key.delete && cursor < draft.length) {
      setDraft(`${draft.slice(0, cursor)}${draft.slice(cursor + 1)}`);
      return;
    }
    if (key.upArrow && history.length > 0) {
      const next = historyIndex === null ? history.length - 1 : Math.max(0, historyIndex - 1);
      const value = history[next] ?? "";
      setHistoryIndex(next); setDraft(value); setCursor(value.length); return;
    }
    if (key.downArrow && historyIndex !== null) {
      const next = historyIndex + 1;
      const value = next < history.length ? history[next] ?? "" : "";
      setHistoryIndex(next < history.length ? next : null); setDraft(value); setCursor(value.length); return;
    }
    if (input && !key.ctrl && !key.meta) {
      setDraft(`${draft.slice(0, cursor)}${input}${draft.slice(cursor)}`);
      setCursor(cursor + input.length);
    }
  });

  const transcriptRows = Math.max(3, rows - (approval ? 15 : 9));
  const lines = transcriptLines(state, transcriptRows);
  const segments = composerSegments(draft, cursor);
  const showPanel = columns >= 76;
  return <Box width={columns} height={rows} flexDirection="column">
    <Box borderStyle="single" borderColor="yellow" paddingX={1} justifyContent="space-between">
      <Text bold color="yellow">⚡ MorpheOS Code</Text><Text dimColor>{state.status === "running" ? "under way" : "standing by"} · {pairing.enabled ? `${pairing.architect} → ${pairing.editor}` : model === "deepseek-v4-pro" ? "Pro" : "Flash"}</Text>
    </Box>
    <Box flexGrow={1} overflow="hidden">
      <Box flexDirection="column" flexGrow={1} borderStyle="single" paddingX={1} overflow="hidden">
        {lines.length === 0 ? MOTD.map((line, i) => <Text key={`motd-${i}`} dimColor={i > 0}>{line}</Text>) : lines.map((line, index) => <Text key={`${index}-${line}`} wrap="truncate-end">{line}</Text>)}
      </Box>
      {showPanel ? <Box width={32} flexDirection="column" borderStyle="single" paddingX={1}>
        <Text bold color="yellow">Captain's Log</Text>
        <Text dimColor wrap="truncate-end">{session.id}</Text>
        <Text>{pairing.enabled ? `${pairing.architect} → ${pairing.editor}` : model === "deepseek-v4-pro" ? "Pro" : "Flash"} engines</Text>
        {adversary.enabled ? <Text color="yellow">🛡 Adversary: ON ({adversary.policies.length})</Text> : null}
        <Text>£{session.record.total_cost_usd.toFixed(6)}</Text>
        <Text>{session.record.total_tokens} tokens</Text>
        <Text bold color="yellow">Cargo Bay</Text>
        {jobs.length === 0 ? <Text dimColor>empty</Text> : jobs.map((job) => <Text key={job.jobId} wrap="truncate-end">{formatCorpusJob(job)}</Text>)}
        <Text bold color="yellow">Background Ops</Text>
        <Text dimColor>Bg: {bgManager.current.runningCount()} running, {bgManager.current.completedCount()} done</Text>
        <Text bold color="yellow">Checkpoints</Text>
        <Text dimColor>CP: {checkpointCount}</Text>
      </Box> : null}
    </Box>
    {showSettings ? <SettingsPanel
      model={model}
      thinking={state.showThinking}
      pairingEnabled={pairing.enabled}
      cost={session.record.total_cost_usd}
      tokens={session.record.total_tokens}
      sessionId={session.id}
      selected={settingsIdx}
    /> : null}
    {approval ? <Box flexDirection="column" borderStyle="double" borderColor="yellow" paddingX={1}>
      <Text bold color="yellow">Captain's authorisation required</Text><Text>{formatApprovalRequest(approval)}</Text><Text dimColor>[y] once  [s] session  [n] decline</Text>
    </Box> : null}
    <Box borderStyle="single" borderColor={state.status === "running" ? "yellow" : "green"} paddingX={1} justifyContent="space-between">
      <Text>❯ {segments.before}<Text inverse>{segments.cursor}</Text>{segments.after}</Text>
      <Text dimColor>Ctrl+C exit · /help</Text>
    </Box>
  </Box>;
}

function slashCommand(input: string, session: AgentSession, showThinking: boolean): SlashCommand {
  const command = input.slice(1).split(/\s+/, 1)[0] ?? "";
  switch (command) {
    case "help": return { kind: "message", message: `/help  /clear  /settings  /model flash|pro  /pair on|off|status  /adversary  /cost  /sessions  /jobs  /thinking  /permit  /mcp  /memory  /bg  /undo  /rewind  /checkpoints  /exit
${grey("Captain's bridge commands. All ship-shape and Bristol fashion.")}
${grey("Pair: /pair on — enable architect (Pro plans) / editor (Flash executes)")}
${grey("Adversary: /adversary on <policy>  /adversary add <policy>  /adversary off  /adversary status")}
${grey("MCP: /mcp add <name> <command>  /mcp list  /mcp remove <name>")}
${grey("Permit: /permit  /permit add Tool(pattern) allow|ask|deny  /permit remove Tool(pattern)")}
${grey("Memory: /memory [show]  /memory save <entry>  /memory topic <name>  /memory topics")}
${grey("Background: /bg list  /bg cancel <id>")}
${grey("Checkpoint: /undo [file]  /rewind <id>  /checkpoints — rollback file edits")}` };
    case "clear": return { kind: "clear" };
    case "cost": return { kind: "message", message: `Fuel consumed: £${session.record.total_cost_usd.toFixed(6)} (${session.record.total_tokens} tokens across ${session.record.message_count} messages)` };
    case "sessions": return { kind: "message", message: listSessions(session.store, 10).map((item) => `${item.id === session.id ? "*" : " "} ${item.id} ${item.model} £${item.total_cost_usd.toFixed(4)} ${item.summary || "-"}`).join("\n") || "No previous voyages found." };
    case "jobs": return { kind: "jobs", jobs: loadCorpusJobs(defaultArtifactRoot()) };
    case "model": return { kind: "model" as const };
    case "thinking": return { kind: "thinking" as const };
    case "settings": return { kind: "settings" as const };
    case "exit": case "quit": return { kind: "exit" };
    case "mcp": return parseMcpCommand(input);
    case "permit": return parsePermitCommand(input);
    case "bg": return parseBgCommand(input);
    case "memory": return parseMemoryCommand(input);
    case "pair": return parsePairCommand(input);
    case "adversary": return parseAdversaryCommand(input);
    case "undo": return parseUndoCommand(input);
    case "rewind": return parseRewindCommand(input);
    case "checkpoints": return { kind: "checkpoints" as const };
    default: return { kind: "message", message: `Unknown order: /${command}. Type /help for available commands, Captain.` };
  }
}

function assertNever(value: never): never {
  throw new HarnessError("unexpected_tui_variant", `Unexpected TUI variant: ${String(value)}.`);
}

// ── MCP helpers ──

/** Prefix MCP tool names to avoid collisions with built-in tools. */
function mcpToolPrefix(serverName: string): string {
  return `mcp__${serverName}__`;
}

function mcpToolName(serverName: string, toolName: string): string {
  return `${mcpToolPrefix(serverName)}${toolName}`;
}

/** Parse /mcp add|list|remove arguments. */
function parseMcpCommand(input: string): SlashCommand {
  const parts = input.split(/\s+/).slice(1); // skip "/mcp"
  const sub = parts[0]?.toLowerCase() ?? "";

  if (sub === "list" || sub === "ls") {
    return { kind: "mcp-list" };
  }

  if (sub === "remove" || sub === "rm") {
    const name = parts[1];
    if (!name) return { kind: "message", message: "Usage: /mcp remove <name>" };
    return { kind: "mcp-remove", name };
  }

  if (sub === "add") {
    const name = parts[1];
    const command = parts.slice(2).join(" ");
    if (!name || !command) return { kind: "message", message: "Usage: /mcp add <name> <command>" };
    const config: McpServerConfig = {
      name,
      transport: "stdio",
      command,
      args: [],
    };
    return { kind: "mcp-add", config };
  }

  return { kind: "message", message: "Usage: /mcp add <name> <command> | /mcp list | /mcp remove <name>" };
}

/** Parse /permit [add|remove] arguments. */
function parsePermitCommand(input: string): SlashCommand {
  // /permit — list rules
  const bare = input.trim();
  if (bare === "/permit") {
    return { kind: "permit", command: "list" };
  }

  // /permit add Tool(pattern) action
  const addMatch = bare.match(/^\/permit\s+add\s+([\w-]+\(.+\))\s+(allow|ask|deny)$/);
  if (addMatch) {
    const rule: PermissionRule = {
      pattern: addMatch[1],
      action: addMatch[2] as PermissionRule["action"],
    };
    return { kind: "permit", command: "add", rule };
  }

  // /permit remove Tool(pattern)
  const removeMatch = bare.match(/^\/permit\s+remove\s+([\w-]+\(.+\))$/);
  if (removeMatch) {
    return { kind: "permit", command: "remove", pattern: removeMatch[1] };
  }

  return { kind: "message", message: "Usage: /permit | /permit add Tool(pattern) allow|ask|deny | /permit remove Tool(pattern)" };
}

/** Parse /bg list|cancel arguments. */
function parseBgCommand(input: string): SlashCommand {
  const parts = input.split(/\s+/).slice(1); // skip "/bg"
  const sub = parts[0]?.toLowerCase() ?? "";

  if (sub === "list" || sub === "ls" || sub === "") {
    return { kind: "bg-list" };
  }

  if (sub === "cancel") {
    const id = parts[1];
    if (!id) return { kind: "message", message: "Usage: /bg cancel <id>" };
    return { kind: "bg-cancel", id };
  }

  return { kind: "message", message: "Usage: /bg list | /bg cancel <id>" };
}

/** Parse /pair on|off|status arguments. */
function parsePairCommand(input: string): SlashCommand {
  const parts = input.split(/\s+/).slice(1); // skip "/pair"
  const sub = parts[0]?.toLowerCase() ?? "status";

  if (sub === "on") return { kind: "pair", action: "on" };
  if (sub === "off") return { kind: "pair", action: "off" };
  if (sub === "status") return { kind: "pair", action: "status" };

  return { kind: "message", message: "Usage: /pair on | /pair off | /pair status" };
}

/** Parse /adversary on|off|add|status arguments. */
function parseAdversaryCommand(input: string): SlashCommand {
  const parts = input.split(/\s+/).slice(1); // skip "/adversary"
  const sub = parts[0]?.toLowerCase() ?? "status";

  if (sub === "on") {
    const policy = parts.slice(1).join(" ").trim();
    if (!policy) return { kind: "message", message: "Usage: /adversary on <policy statement>" };
    return { kind: "adversary", action: "on", policy };
  }

  if (sub === "add") {
    const policy = parts.slice(1).join(" ").trim();
    if (!policy) return { kind: "message", message: "Usage: /adversary add <policy statement>" };
    return { kind: "adversary", action: "add", policy };
  }

  if (sub === "off") return { kind: "adversary", action: "off" };
  if (sub === "status") return { kind: "adversary", action: "status" };

  return { kind: "message", message: "Usage: /adversary on <policy> | /adversary add <policy> | /adversary off | /adversary status" };
}

/** Parse /undo [file_path] */
function parseUndoCommand(input: string): SlashCommand {
  const parts = input.split(/\s+/).slice(1); // skip "/undo"
  const filePath = parts.join(" ").trim();
  return filePath ? { kind: "undo", filePath } : { kind: "undo" };
}

/** Parse /rewind <checkpoint-id> */
function parseRewindCommand(input: string): SlashCommand {
  const parts = input.split(/\s+/).slice(1); // skip "/rewind"
  const checkpointId = parts[0] ?? "";
  if (!checkpointId) return { kind: "message", message: "Usage: /rewind <checkpoint-id>. Use /checkpoints to list them." };
  return { kind: "rewind", checkpointId };
}

/** Parse /memory [show|save|topic|topics] arguments. */
function parseMemoryCommand(input: string): SlashCommand {
  const parts = input.split(/\s+/).slice(1); // skip "/memory"
  const sub = parts[0]?.toLowerCase() ?? "";

  // /memory or /memory show — display current memory
  if (sub === "" || sub === "show") {
    return { kind: "memory-show" };
  }

  // /memory save <entry>
  if (sub === "save") {
    const entry = parts.slice(1).join(" ");
    if (!entry) return { kind: "message", message: "Usage: /memory save <entry text>" };
    return { kind: "memory-save", entry };
  }

  // /memory topics — list available topics
  if (sub === "topics") {
    return { kind: "memory-topics" };
  }

  // /memory topic <name> — load a topic
  if (sub === "topic") {
    const name = parts.slice(1).join(" ");
    if (!name) return { kind: "message", message: "Usage: /memory topic <name>" };
    return { kind: "memory-topic", name };
  }

  return { kind: "message", message: "Usage: /memory [show] | /memory save <entry> | /memory topic <name> | /memory topics" };
}

/** Connect an MCP server and register its tools into the tool registry. */
async function connectMcpServer(
  mcpRegistry: McpRegistry,
  toolRegistry: ToolRegistry,
  config: McpServerConfig,
): Promise<McpToolDefinition[]> {
  const tools = await mcpRegistry.addServer(config);
  for (const tool of tools) {
    const registeredName = mcpToolName(config.name, tool.name);
    toolRegistry.register({
      definition: {
        name: registeredName,
        description: `[MCP:${config.name}] ${tool.description}`,
        parameters: [],
        rawSchema: tool.inputSchema,
      },
      tier: 1, // MCP tools are read/write based on the server — user explicitly added them
      async execute(params: Record<string, unknown>): Promise<{ content: string; summary: string; error?: string }> {
        const client = mcpRegistry.getClient(config.name);
        if (!client) {
          return { content: `MCP server "${config.name}" is no longer connected.`, summary: `MCP disconnected: ${config.name}`, error: "mcp_disconnected" };
        }
        return client.callTool(tool.name, params);
      },
    });
  }
  return tools;
}

function SettingsPanel({ model, thinking, pairingEnabled, cost, tokens, sessionId, selected }: {
  readonly model: string;
  readonly thinking: boolean;
  readonly pairingEnabled: boolean;
  readonly cost: number;
  readonly tokens: number;
  readonly sessionId: string;
  readonly selected: number;
}) {
  const rows: Array<{ label: string; value: string; active: boolean; toggle: boolean }> = [
    { label: "Model", value: model === "deepseek-v4-pro" ? "Pro" : "Flash", active: selected === 0, toggle: true },
    { label: "Pairing", value: pairingEnabled ? "ON" : "OFF", active: selected === 1, toggle: true },
    { label: "Thinking", value: thinking ? "ON" : "OFF", active: selected === 2, toggle: true },
    { label: "Session", value: sessionId.slice(0, 20), active: selected === 3, toggle: false },
  ];

  return (
    <Box flexDirection="column" borderStyle="double" borderColor="yellow" paddingX={2} paddingY={1} marginY={1}>
      <Box marginBottom={1}>
        <Text bold color="yellow">⚙ Bridge Settings</Text>
      </Box>
      {rows.map((row, i) => (
        <Box key={row.label} paddingLeft={1}>
          <Text color={row.active ? "yellow" : undefined} bold={row.active}>
            {row.active ? "▶" : " "} {row.label.padEnd(10)}
          </Text>
          <Text>{row.toggle ? `[ ${row.value} ]` : row.value}</Text>
          {i === 3 ? null : <Text dimColor>  ←→ toggle</Text>}
        </Box>
      ))}
      <Box marginTop={1} paddingLeft={1}>
        <Text dimColor>Cost  £{cost.toFixed(6)} · {tokens} tokens</Text>
      </Box>
      <Box marginTop={1}>
        <Text dimColor>↑↓ navigate  ←→ change  esc close</Text>
      </Box>
    </Box>
  );
}
