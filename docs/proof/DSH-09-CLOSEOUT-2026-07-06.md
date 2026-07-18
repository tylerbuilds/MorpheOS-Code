# DSH-09 Closeout Proof - 2026-07-06

## Verdict

Core DeepSeek Harness sprint is locally complete. Git push handling depends on
the configured remote after the closeout commit.

The harness now supports validated manifests, local SQLite run state, fake,
dry-run and live DeepSeek transports, CLI and MCP control surfaces, Agent OS
state exports, Dispatch proposals, approval packets, review packets and gated
scale-ramp reports.

## Live DeepSeek Proof

Live calls were explicitly approved for this sprint closeout. The API key was
provided only through the process environment and was not printed, committed or
stored in source.

### DSH-07 Micro-Smoke

- run id: `a50ed10f-0059-4e81-9f9f-8daf3f02cd71`
- transport: `deepseek`
- model: `deepseek-v4-flash`
- items: `2`
- result: `2/2` completed
- review packet: `artifacts/a50ed10f-0059-4e81-9f9f-8daf3f02cd71/review-packet.json`
- state snapshot: `artifacts/deepseek-harness-state-after-live-smoke.json`

### DSH-08 Live Scale Ramp

- report: `artifacts/live-scale-ramp-20260706.json`
- runtime source commit: `89c21c2`
- started: `2026-07-06T11:03:34.566Z`
- completed: `2026-07-06T11:03:51.293Z`
- transport: `deepseek`
- model: `deepseek-v4-flash`
- egress: `non_sensitive_bulk`
- result: `120/120` items completed, `0` failed
- recommended next tested concurrency: `20`

| Concurrency | Run id | Items | Elapsed | Throughput |
| --- | --- | --- | --- | --- |
| 5 | `19c29982-d617-4b09-a9f4-bc46753dc46a` | `40/40` | `9388 ms` | `4.26 items/s` |
| 10 | `03154927-0a82-4065-a0a1-43c401681963` | `40/40` | `4813 ms` | `8.31 items/s` |
| 20 | `5702bc22-91b8-4346-8b53-276a2598f879` | `40/40` | `2522 ms` | `15.86 items/s` |

Review packets:

- `artifacts/19c29982-d617-4b09-a9f4-bc46753dc46a/review-packet.json`
- `artifacts/03154927-0a82-4065-a0a1-43c401681963/review-packet.json`
- `artifacts/5702bc22-91b8-4346-8b53-276a2598f879/review-packet.json`

State snapshot:

- `artifacts/deepseek-harness-state-after-live-scale.json`

## Authority Boundary

- no deploy;
- no publish;
- no send;
- no command-centre state write;
- no canonical Agent OS state write;
- no repo apply from harness runtime;
- no raw secret print;
- no credential copy into manifests, docs, artefacts or git.

Git commit/push is maintainer source-control work requested by Tyler. It is not
harness runtime authority.

## Final Proof Commands

Run from `<repository-root>` on 2026-07-06:

```bash
npm run typecheck
npm test
agent-os-repo-proof --repo <repository-root> --level quick --run --json
git diff --check
node dist/src/cli.js state --output artifacts/deepseek-harness-state-final.json --limit 12
```

Results:

- `npm run typecheck`: passed.
- `npm test`: passed, `11/11` tests.
- `agent-os-repo-proof --run`: passed, status `ok`.
- `git diff --check`: passed.
- MCP start smoke: passed, `node dist/src/mcp.js` started and exited on `SIGTERM`.
- final state export: `artifacts/deepseek-harness-state-final.json`.

## Remaining Backlog

- Add a reusable manifest generator if repeated prompt families emerge.
- Add optional cost ledgering once DeepSeek returns reliable per-call billing
  metadata for this route.
- Add a Dispatch worker class only after a separate approval pass.
- Consider larger 50/100/200 live ramp only with a fresh approval and cost cap.
