# Security Audit Record — v0.1.0 package readiness — 2026-07-18

## Scope

This is a bounded package-readiness review for the local CLI/MCP harness. It is
not a SaaS launch gate, penetration test or independent secret-scanner
attestation. The runtime has no hosted backend, user accounts, payments,
browser surface or customer database. DeepSeek egress exists only behind the
documented approval, privacy, cost and side-effect gates.

The `v0.1.0` package metadata is MIT-licensed and configured for public npm
access with provenance. It is prepared but not published. The Rust workspace is
not published. `npm run pack:check` and `npm run package:smoke` verify the
explicit archive boundary and an installed package without publishing it. The
manual workflow is designed to create one exact tarball, verify its SHA-256,
smoke that same tarball, and attach both files to the matching GitHub Release;
that workflow has not run as part of this audit.

## Checks

Run these checks from a clean checkout or release candidate:

```bash
npm run typecheck
npm test
npm run test:e2e
npm run mcp:smoke
npm run pack:check
npm run package:smoke
cargo test --locked
npm audit --audit-level=high
npm ls --all --depth=2
git ls-files | rg -n '(^artifacts/|^target/|^\.state/|(^|/)\.env|approval-packet|live-scale-ramp-approved|DEEPSEEK_API_KEY|sk-|gho_|api[_-]?key)' || true
```

The main CI matrix is configured to run the installed-package smoke on both
`ubuntu-latest` and `macos-14`; the macOS lane checks that the package retains
the `scripts/ocr-vision.swift` adapter. This audit records configuration and
local proof only; it does not claim that the v0.1.0 release workflow has run.

The audit and package checks report expected source references to
`DEEPSEEK_API_KEY`, bearer construction and approval terminology. Those
references document guarded behaviour; they are not credentials. Runtime
state, artefacts, translation memory, environment files and internal review
evidence are outside the source/package boundary.

## Gate summary

| Gate | Status | Notes |
| --- | --- | --- |
| Auth/session | N/A | Local process; no hosted session surface. |
| Payments | N/A | No payment or account surface. |
| Data privacy | PASS | Sensitive egress is classified and blocked by the live gates. |
| Infrastructure | PASS | No hosted deployment target is part of the harness. |
| Application security | WARN | Live transport remains an explicit, separately approved path; keep the behavioural tests green. |
| Supply chain | WARN | The release uses an explicit npm allowlist, exact-tarball smoke, SHA-256 proof and OIDC provenance; Rust advisory tools were unavailable in this environment. |
| Observability/IR | REVIEWED | `SECURITY.md`, local artefacts and review exports define the available response trail. |
| Compliance/legal | PASS | MIT licence and public package metadata are present; publication remains manual and unclaimed. |
| Abuse/fraud | N/A | No public hosted API or account creation. |
| Business continuity | REVIEWED | Source and changelog are tracked; local runtime state is intentionally excluded. |

## Risk register

| ID | Severity | Status | Finding | Mitigation |
| --- | --- | --- | --- | --- |
| SEC-001 | MEDIUM | Mitigated | Public source and npm distribution require an explicit licence and release boundary. | Root `LICENSE`, npm `license: MIT`, public `publishConfig`, Rust `license = "MIT"`, and the source installer path are aligned. |
| SEC-002 | LOW | Mitigated | A live provider call could expose sensitive prompts or exceed a cost limit if gates were bypassed. | One-use payload-bound receipts, privacy/egress checks, API-key environment loading, atomic run/budget reservations and live flags are required. |
| SEC-003 | LOW | Open | No Rust advisory database tool was available during this review. | Run `cargo audit` or `cargo deny check` in CI/release infrastructure and record the result. |
| SEC-004 | LOW | Mitigated | Generated tests, state and private material must not enter the archive. | The package uses explicit file entries for runtime output, `dist/package.json`, the macOS Vision adapter and public docs; `npm run pack:check` and `npm run package:smoke` reject an incomplete or unexpected boundary. |

## Follow-up

- Keep the listed Node, Rust, package and behavioural checks in CI for future
  release candidates, including the installed-package smoke.
- Configure required reviewers on the GitHub `release` environment before using
  the manual workflow. It must attach the exact tarball and checksum to the
  matching GitHub Release before any optional npm publication; publication has
  not occurred as part of this audit.
- Re-run this record when dependencies, live transport authority or the package
  allowlist changes.
- Treat local live-run measurements as operator artefacts, not maintainer or
  release claims.
