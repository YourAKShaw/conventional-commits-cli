# ADR-0002: Provider adapters on `fetch` instead of vendor SDKs

Status: accepted
Date: 2026-10-19
Owner / decision authority: maintainer (@YourAKShaw)
Scope / related issue: `src/providers/`, the implementation plan's suggestion to use `@google/genai` and the Anthropic SDK

## Context and constraints

Smart mode needs one request type per provider: a system prompt, a user message, JSON-schema structured output, reasoning effort, an output limit, and `store: false` where supported. The router must own retries and fallback, because quota errors must fall back immediately while transient errors get exactly one bounded retry.

| Driver | Known / estimated / unknown | Constraint or evidence |
|---|---|---|
| Correctness/security invariants | Known | One retry policy; keys only in headers; no SDK telemetry or environment-variable side effects |
| Workload and service levels | Known | One small request per generation; latency is dominated by the model |
| Team, budget and deadline | Known | Four providers, one maintainer |
| Compatibility and recovery | Known | SDK default retries (for example the Anthropic SDK retries twice by default) would multiply attempts unless disabled everywhere |

Non-goals: streaming, tool use, multi-turn sessions.

## Options and trade-offs

| Option | Correctness/security | Complexity/operations | Cost/time | Compatibility/reversibility |
|---|---|---|---|---|
| Vendor SDKs | Typed requests; SDK retries/timeouts must be disabled per SDK; four dependency trees | Less request code, more configuration | Bundle size grows considerably | SDK upgrades can change behaviour |
| **Plain `fetch` adapters** | Exact control over bodies, headers, timeouts, abort and error parsing | ~100–150 lines per API; we track API changes ourselves | Small | An adapter can be swapped for an SDK later behind the same interface |

## Decision and rationale

Implement each API with `fetch` behind a `ProviderAdapter` interface: the OpenAI Responses API (also used for xAI's compatible endpoint), Anthropic Messages, and Gemini Interactions. A shared `postJson` helper applies timeouts, `AbortSignal` (Ctrl-C), and error classification. The router alone decides retries.

## Consequences and risk ownership

Benefits: one retry/fallback policy; small bundle; adapters are easy to test with recorded shapes.
Costs / limitations: API changes are not absorbed by SDK updates; request shapes must be re-verified per release (`docs/providers.md`).
Residual risks / owners: a silent API change could break one provider; fallback keeps smart mode working while the adapter is fixed (maintainer).

## Transition and recovery

Each adapter is independent; replacing one with an SDK call does not affect the others or the router.

## Validation and acceptance

| Claim / acceptance criterion | Method or exact command | Evidence / state | Limitation / owner |
|---|---|---|---|
| Requests match documented shapes | `test/unit/providers.test.ts`, e2e mock server asserting bodies and headers | PASS (executed) | Built from documentation, not live traffic |
| Errors classify correctly | Unit tests per provider and error class | PASS (executed) | xAI and some Anthropic/Gemini cases are heuristic |
| Live calls succeed | `ccli auth test` with real keys | NOT RUN in this repository (no keys in CI) | Run before each release |

## Revisit when

A provider requires a feature that is impractical without its SDK (for example request signing), or the adapters' maintenance cost exceeds an SDK's configuration cost.
