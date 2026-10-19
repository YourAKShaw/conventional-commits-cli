# AI providers

`ccli smart commit` talks to four providers through small `fetch`-based adapters in [`src/providers/`](../src/providers/). This page records the request shapes, model defaults, error handling and the sources they were checked against, so the data can be re-verified before each release.

> **Verification status.** Request shapes and error codes were checked against vendor documentation on 2026-10-17; the model registry on 2026-10-19 ([`registry.ts`](../src/providers/registry.ts), `REGISTRY_VERIFIED_ON`). Contract tests use mocked HTTP responses built from that documentation; live calls to each vendor were **not** run in this repository's CI. Vendors change models, effort levels and error codes often, so treat everything below as a snapshot and re-check it when you update the registry.

## Overview

| | OpenAI | Anthropic | xAI | Google Gemini |
| :--- | :--- | :--- | :--- | :--- |
| Key variable(s) | `OPENAI_API_KEY` | `ANTHROPIC_API_KEY` | `XAI_API_KEY` | `GEMINI_API_KEY`, then `GOOGLE_API_KEY` |
| Endpoint | `POST https://api.openai.com/v1/responses` | `POST https://api.anthropic.com/v1/messages` | `POST https://api.x.ai/v1/responses` | `POST https://generativelanguage.googleapis.com/v1beta/interactions` |
| Auth header | `Authorization: Bearer …` | `x-api-key`, `anthropic-version: 2023-06-01` | `Authorization: Bearer …` | `x-goog-api-key` |
| Structured output | `text.format` = `json_schema`, `strict: true` | `output_config.format` = `json_schema` | Same as OpenAI | `response_format` with `mime_type: application/json` and `schema` |
| Effort | `reasoning.effort` | `output_config.effort` | `reasoning.effort` | `generation_config.thinking_level` |
| Output limit | `max_output_tokens` | `max_tokens` | `max_output_tokens` | `generation_config.max_output_tokens` |
| Storage hint | `store: false` | none in the API (retention is an account arrangement) | `store: false` | `store: false` |
| Default model | `gpt-5.6-luna` | `claude-haiku-5-5` | `grok-4.7` | `gemini-3.5-flash-lite` |
| Default effort | `low` | `low` | `low` | `minimal` |

No SDKs are used (see [ADR 0002](adr/0002-fetch-adapters-instead-of-sdks.md)). No sampling parameters (`temperature`, penalties, `stop`) are sent, because several reasoning models reject them; variety on regeneration comes from your hint and the previous header.

## Models and effort

Run `ccli models` (or `ccli models <provider> --json`) for the current registry. Snapshot as of 2026-10-19:

| Provider | Model | Effort levels | Vendor default | Note |
| :--- | :--- | :--- | :--- | :--- |
| OpenAI | `gpt-5.6-luna` | none, low, medium, high, xhigh, max | medium | Lowest cost and latency in the GPT-5.6 family |
| OpenAI | `gpt-5.6-terra` | not verified | | Lower-cost GPT-5.6 tier |
| OpenAI | `gpt-6-astra` | not verified | | Does not accept `none` |
| Anthropic | `claude-haiku-5-5` | low, medium, high, xhigh, max | medium | Fastest Claude model |
| Anthropic | `claude-sonnet-5-5` | low, medium, high, xhigh, max | high | |
| Anthropic | `claude-opus-5-5` | low, medium, high, xhigh, max | medium | |
| Anthropic | `claude-fable-5-1` | low, medium, high, xhigh, max | high | |
| xAI | `grok-4.7` | low, medium, high, xhigh | high | Reasoning cannot be disabled |
| xAI | `grok-4.6` | low, medium, high, xhigh | high | |
| xAI | `grok-4.5` | low, medium, high | high | |
| Gemini | `gemini-3.5-flash-lite` | minimal, low, medium, high | minimal | Fastest, most cost-effective 3.5 model |
| Gemini | `gemini-3.8-flash` | low, medium, high | medium | |
| Gemini | `gemini-3.6-flash` | minimal, low, medium, high | medium | |
| Gemini | `gemini-4-argon` | low, medium, high | medium | |

How effort is resolved ([`effort.ts`](../src/providers/effort.ts)):

- `auto` omits the parameter, so the vendor default applies.
- A value the model supports is sent as-is.
- An unsupported value is lowered to the nearest supported level below it (or the lowest level), with a warning. Example: `minimal` on `claude-haiku-5-5` becomes `low`.
- For models not in the registry, the value is passed through unvalidated. If the vendor rejects it, the router reports a configuration error and falls back.

**Why `low`/`minimal` by default?** A commit message is a few hundred tokens of structured output. Higher effort adds latency and reasoning-token cost with little benefit for most diffs. Raise it per provider if your diffs need deeper reading.

`ccli` embeds no prices, rate limits or quotas. Check your provider console for those.

## Routing and fallback

The router ([`src/ai/router.ts`](../src/ai/router.ts)) walks your `providers.order`, filtered by the repository's `providers.allow` (if any), by `enabled`, by whether a key exists, and by whether you approved sending diffs to that provider.

| Error class | Typical signal | Action |
| :--- | :--- | :--- |
| `quota` | Credits, spend limit or quota exhausted | Fall back immediately; skip the provider for 30 minutes (5 minutes when the classification is heuristic) |
| `rate_limit` | 429 with `Retry-After` ≤ 5 s | Wait and retry once, then fall back. Longer waits fall back immediately |
| `overloaded`, `network`, `timeout` | 5xx, 529, connection errors, timeouts | One retry after 0.5–1.5 s, then fall back |
| `truncated` | Output cut off by the token limit | Retry once with double the output limit (capped at 32,768), then fall back |
| `auth` | 401, 403 | Fall back; suggest `ccli auth test` |
| `config` | 400, 404 (bad model, bad parameter) | Fall back with a warning so misconfiguration is visible |
| `invalid_response` | Unparseable or schema-violating output | Fall back |

Limits: at most two attempts per provider, and the whole generation must finish within `smart.requestBudgetMs` (90 s by default). Each request is also bounded by the provider's `timeoutMs` (45 s by default). If every candidate is currently marked as exhausted, all of them are tried anyway, in case credits were topped up. The exhausted marker lives in `provider-state.json` in the cache directory and can be deleted at any time.

Generation has no side effects, so retries are safe; the bounds exist to cap cost and waiting time. Validation repairs (up to two rounds) go back to the provider that produced the draft; if it fails mid-repair, the router continues with the next provider.

### Error classification by provider

The classifier is table-driven ([`classify.ts`](../src/providers/classify.ts)) and covered by unit and end-to-end tests.

| Provider | Classified as `quota` | Basis |
| :--- | :--- | :--- |
| OpenAI | 429 with code `credit_balance_exhausted`, `organization_spend_limit_exceeded`, `project_spend_limit_exceeded`, `organization_usage_limit_exceeded`, or type/code `insufficient_quota` | Documented error codes |
| Anthropic | 402, or error type `billing_error`; 400 whose message mentions a spend limit or billing | Documented error types |
| Anthropic | 429 **without** `retry-after` | **Heuristic**: the docs describe a usage-tier spend cap that keeps failing until access resumes; ordinary rate limits include `retry-after` |
| Gemini | 402 or `payment_required`; `quota_exceeded`; `failed_precondition` | Documented error codes |
| Gemini | 429 `RESOURCE_EXHAUSTED` whose message mentions quota | **Heuristic** |
| xAI | 402 | Treated as out of credits |
| xAI | 403 or 429 whose message mentions credits, billing, spending limit or quota | **Heuristic**: no dedicated out-of-credits code is documented |

Anything else maps by status: 401/403 → `auth`, 408 → `timeout`, 429 → `rate_limit`, 404 → `config`, 5xx → `overloaded`, other 4xx → `config`.

## Custom endpoints

Each provider accepts a `baseUrl` in your **global** config, for example a corporate gateway or a local mock:

```sh
ccli config set providers.openai.baseUrl https://llm-gateway.example.com/v1
```

A repository's `.ccli.json` cannot set `baseUrl`, models or provider order; see [privacy and security](privacy-and-security.md#repository-configuration-is-untrusted). If a gateway does not support structured output, set `providers.<id>.structuredOutput` to `false`. The prompt's field rules still describe the JSON object, and the response is validated against the same schema (with up to two repair rounds), so expect more repairs than with native structured output.

## Updating the registry (maintainers)

1. Re-read the sources below for each provider: current models, supported effort values and defaults, request parameters, error codes.
2. Update [`registry.ts`](../src/providers/registry.ts) and `REGISTRY_VERIFIED_ON`. Change a default model only when the replacement is documented as available to all API customers.
3. Update the adapter and its unit tests if a request or response shape changed; update [`classify.ts`](../src/providers/classify.ts) and its tests if error codes changed.
4. Run `npm run check`, then `ccli auth test` with real keys and low spend limits for each provider you changed.
5. Update this page and the README provider table, and add a CHANGELOG entry.

## Sources

- OpenAI, Reasoning models (Responses API, `reasoning.effort`, `store`, model guidance) — https://developers.openai.com/api/docs/guides/reasoning
- OpenAI, Error codes — https://developers.openai.com/api/docs/guides/error-codes
- Anthropic, Effort — https://platform.claude.com/docs/en/build-with-claude/effort
- Anthropic, Structured outputs — https://platform.claude.com/docs/en/build-with-claude/structured-outputs
- Anthropic, API errors — https://platform.claude.com/docs/en/api/errors
- xAI, Reasoning — https://docs.x.ai/developers/model-capabilities/text/reasoning
- xAI, Debugging errors — https://docs.x.ai/developers/debugging
- Google, Gemini thinking — https://ai.google.dev/gemini-api/docs/thinking
- Google, Interactions API — https://ai.google.dev/api/interactions-api
- Google, Structured output — https://ai.google.dev/gemini-api/docs/structured-output
- Google, Gemini API errors — https://ai.google.dev/gemini-api/docs/api-errors
