# Zeus Dispatch Integration

Zeus Dispatch should treat DeepSeek Harness as a proposal and evidence source,
not as an approval authority.

## Initial Shape

- Dispatch route preview can point to a harness manifest path.
- Harness returns `run_id`, state snapshot path and review packet path.
- Harness can emit a `deepseek-harness.dispatch-proposal.v1` packet.
- Dispatch records the evidence target and forbidden authority list.
- Agent OS or MITL still owns approval and canonical apply.

Generate a proposal:

```bash
node dist/src/cli.js dispatch-proposal examples/basic-run.json
```

## Future Worker Capability

A later Dispatch batch can add a `deepseek-api` worker class once the live
micro-smoke and scale-ramp batches are proven. Until then, Dispatch should not
attempt to execute DeepSeek calls itself.
