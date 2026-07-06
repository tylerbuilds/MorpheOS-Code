# DeepSeek Harness Sprint

## Batches

| Batch | Aim | Exit proof |
| --- | --- | --- |
| DSH-00 | Repo scaffold and Agent OS service contract | `agentos.service.yml`, README, build/test scripts |
| DSH-01 | Manifest and safety gates | invalid sensitive/live manifests are rejected |
| DSH-02 | Batch runner core | fake transport handles parallel items with SQLite state |
| DSH-03 | DeepSeek transport | dry-run request shape and live-call gates proven |
| DSH-04 | MCP control surface | Codex can plan, submit, poll and export results by `run_id` |
| DSH-05 | Agent OS integration | read-model writer and contract docs in `my-agent-os` |
| DSH-06 | Zeus Dispatch visibility | proposal/evidence adapter, no execution authority |
| DSH-07 | Live micro-smoke | explicit approval, tiny non-sensitive batch, bounded cost |
| DSH-08 | Scale ramp | measured 5/10/20 concurrency report |
| DSH-09 | Closeout | proof pack, operator guide, next backlog |

## Non-Negotiables

- no live DeepSeek calls without explicit approval packet;
- no secrets in logs, artefacts or MCP responses;
- no canonical state writes;
- no external side effects beyond approved DeepSeek API inference;
- Codex remains final reconciler and proof owner.

## DSH-07 Gate

Before any live DeepSeek call, generate:

```bash
node dist/src/cli.js approval-packet examples/live-micro-smoke-template.json --output artifacts/live-smoke-approval-packet.json
```

The template is deliberately non-executable because `approval_id` is a
placeholder. Replace it only after Tyler approves the exact manifest, then run
with `--allow-live` in a shell that has `DEEPSEEK_API_KEY`.
