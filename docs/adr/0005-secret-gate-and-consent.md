# ADR-0005: Layered secret gate on the exact payload, with consent before first send

Status: accepted
Date: 2026-10-19
Owner / decision authority: maintainer (@YourAKShaw)
Scope / related issue: `src/guard/`, `buildSafePayload`, `ensureAcknowledged` and `decideOnFindings` in `src/commands/smart.ts`

## Context and constraints

Requirement: smart mode must not send files or diff content matching secret patterns (such as `.env` files or key material) to any API without explicit user consent. Staged changes routinely include configuration files, test fixtures and accidental credentials.

| Driver | Known / estimated / unknown | Constraint or evidence |
|---|---|---|
| Correctness/security invariants | Known | No flagged content leaves the machine without an explicit, deliberate action |
| Workload | Estimated | Payloads up to `smart.maxInputTokens`; scanning must take well under a second |
| Detection quality | Unknown | No detector is complete; false positives must be cheap to resolve |

## Options and trade-offs

| Option | Protection | Friction |
|---|---|---|
| File-name deny list only | Misses secrets in ordinary files | Low |
| Scan the raw diff | Scans text that may not be sent; misses history and branch | Medium |
| **Scan the exact payload after budgeting (deny list + secretlint + patterns + entropy), then ask** | Covers everything that would be sent, including history and branch | One question when something is found |
| Block on any finding | Strong | Unusable with false positives |

## Decision and rationale

1. Deny-listed files never contribute content.
2. The payload that would actually be sent is scanned by secretlint's recommended preset (inline disable comments ignored), built-in patterns, user patterns and an entropy heuristic.
3. On findings, nothing is sent; the user chooses withhold (default), redact, send (typed confirmation), or stop. Without a terminal, `ask` means withhold. The loop rebuilds and rescans, and fails closed after five rounds.
4. The generated message is rescanned and redacted.
5. Separately, the first request to each provider requires a one-time acknowledgement of what is sent, stored in the user's global config.

## Consequences and risk ownership

Benefits: concrete, inspectable protection (`--show-payload`); consent is explicit and remembered per provider.
Costs / limitations: best-effort detection; entropy heuristics can flag hashes or IDs; scanning adds a bundled secretlint dependency.
Residual risks / owners: novel secret formats (maintainer; users can add `secrets.extraPatterns`; reports welcome with fake examples).

## Validation and acceptance

| Claim / acceptance criterion | Method | Evidence / state |
|---|---|---|
| Denied files and detected secrets are excluded from `--show-payload` | e2e `shows the payload without contacting any provider` | PASS (executed) |
| Detection, masking, inline-disable bypass and false-positive cases | `test/unit/guard.test.ts` | PASS (executed) |
| Withhold and redact keep secrets out of the request; "send" needs the typed word; no terminal means withhold | `test/integration/flows.test.ts` | PASS (executed) |
| No request without acknowledgement | `flows.test.ts`, TTY smoke smart commit | PASS (executed) |

## Revisit when

A false-positive rate makes users routinely choose "send", or a better maintained scanner becomes available.
