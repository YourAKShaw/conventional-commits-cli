# Conventional Commits CLI — Implementation Plan

> **Implementation status — 2026-10-19 (v0.1.0).** This is the plan as written on 17 October 2026, kept for reference. The code implements milestones M0–M4. Where the implementation deliberately differs, the table below records what changed and why; the [README](../README.md) and [docs](./) describe the shipped behaviour. Decisions are recorded as [ADRs](adr/).
>
> | Plan | Implemented | Why |
> | :--- | :--- | :--- |
> | `@google/genai` and other vendor SDKs; disable SDK retries | Plain `fetch` adapters for all four APIs ([ADR 0002](adr/0002-fetch-adapters-instead-of-sdks.md)) | One retry policy, small bundle, exact control of request shapes |
> | `execa` and `env-paths` | `node:child_process` (no shell) and an own `config/paths.ts` | Zero required runtime dependencies |
> | Load the repo's commitlint config with `@commitlint/load` | Declarative configs (`.commitlintrc`, `.commitlintrc.json`, `package.json#commitlint`) parsed as data; JS/TS/YAML configs only with `commitlint.loadJsConfig` ([ADR 0004](adr/0004-restrict-only-repository-config.md)) | Loading executable configs runs repository code |
> | Index snapshot with `git write-tree` | SHA-256 of `git diff --cached --raw` | Same detection without writing tree objects |
> | Global caps: 60 s and 4 attempts per generation | `smart.requestBudgetMs` (default 90 s), at most 2 attempts per provider | Slow reasoning models; fallback across four providers needs more than four attempts in the worst case |
> | `secrets.onDetect` default `exclude` | Default `ask`, with *withhold* preselected; `exclude` when there is no terminal | The user sees findings and decides; unattended runs stay safe |
> | Entropy: ≥ 20 characters | ≥ 16 characters near a credential keyword, ≥ 32 characters elsewhere | Fewer false positives on hashes and IDs; keyword context catches short tokens |
> | Keychain timeout 2 s | 5 s, async, skipped without a D-Bus session on Linux | Avoids false "unavailable" on slow first unlocks; never hangs |
> | `auth list` shows last four characters | Shows source and origin, key fully masked | Less key material on screen |
> | In-progress merge/rebase: prefill Git's message | `ccli` refuses and tells you to finish with Git | Git already prepared the right message |
> | Failed repair opens the editor with errors | The last draft is shown with its problems; spec errors block *Commit*, *Edit* opens the editor | Same outcome through the normal review loop |
> | Bun binaries carry the keyring `.node` file | Keychain module not embedded; binaries use environment variables or the opt-in file store | Keeps binaries single-file; documented in [releasing](releasing.md#standalone-binaries) |
> | Gitmoji list fetched at build time | Bundled from the `gitmojis` npm package | Reproducible builds, no network at build time |
> | `--deep` per-file summarization, `smart.untracked` | Not implemented | Cost; the staging prompt covers untracked files |
> | TTY tests with node-pty on all three OSes; `msw` provider fixtures | Python pty smoke test (POSIX) plus scripted-UI integration tests; local mock HTTP server for e2e | No native test dependency; Windows prompt flow is covered by the scripted UI, not a real console |
> | Model evaluation set (60–100 labelled diffs), nightly live smoke | **Not done** | Needs real API keys and a labelled corpus; tracked as follow-up work |
>
> Open questions resolved: package `@yourakshaw/conventional-commits-cli` (the unscoped name is taken), commands `ccli` and `conventional-commits-cli`; gitmoji on by default, after the colon; large changes get a split suggestion, not automatic splitting; repositories can restrict providers but not pin them; no telemetry; MIT license.

*Prepared 17 October 2026. Provider facts were checked against vendor documentation on that date; model names, effort levels and error codes change often, so re-verify them at each release. Sources are listed at the end as [S#].*

---

## 1. Decision summary

| Decision | Recommendation |
|---|---|
| Language / runtime | **TypeScript on Node.js ≥ 22**, CI on Node 22, 24 and 26 |
| Primary distribution | **npm** — one platform-independent JS package is the single release artifact |
| Secondary distribution | **Standalone binaries** built with `bun build --compile`, attached to the same GitHub Release (milestone 4) |
| Commit format authority | Conventional Commits 1.0.0 [S1], enforced by an in-house checker plus `@commitlint/lint` using the repo's own commitlint config when present |
| Gitmoji placement | **After the colon**: `feat(auth): ✨ add OAuth login` — keeps spec rule 1 intact |
| AI providers | Primary: OpenAI, Anthropic, Google Gemini, xAI. Ordered fallback chain triggered by classified quota/credit errors |
| Key storage | Env var → OS keychain (`@napi-rs/keyring`) → plaintext file only with explicit opt-in. Never in config files |
| Safety gates | Secret scan before any network call; mandatory interactive confirmation before `git commit`; no `--yes` flag |

The binary name used below is `ccli` (assumption — check npm and PATH collisions; avoid `cc`, which shadows the C compiler). Smart mode is `ccli smart commit`; users can add `git config --global alias.smart '!ccli smart'` to get `git smart commit`.

---

## 2. Spec rules the tool enforces

All format rules come from the Conventional Commits 1.0.0 specification [S1]. The renderer and validator implement these numbered rules directly:

| Spec rule | What it requires | Where enforced |
|---|---|---|
| 1, 5 | Type prefix, optional scope, optional `!`, then colon + space, then description | Renderer, validator |
| 2, 3, 14 | `feat` for features, `fix` for bug fixes; other types allowed | Type list (from commitlint config or default) |
| 4 | Scope is a noun in parentheses | Validator (`^\([^()\s]+\)$`) |
| 6, 7 | Body starts after one blank line; free-form paragraphs | Renderer |
| 8, 9, 10 | Footers after a blank line; token uses `-` for spaces; `: ` or ` #` separator | Renderer, validator |
| 11, 12, 13 | Breaking change via `!` before the colon and/or uppercase `BREAKING CHANGE:` footer | Renderer, validator |
| 15, 16 | Case-insensitive units except `BREAKING CHANGE`; `BREAKING-CHANGE` is a synonym | Normalizer |

Consequences for the design:

- **Gitmoji cannot lead the header.** Rule 1 puts the type first, while the gitmoji convention puts the emoji first [S3]. `go-gitmoji-cli` already defaults to emoji after the colon [S9b]; `ccli` does the same. `position: "prefix"` is opt-in, with a warning that spec-based tools will miss those commits [S1].
- **Rule 10 can misparse a body.** A last body paragraph like `Note: …` parses as a footer, so the renderer reflows any body paragraph that matches footer grammar.
- The spec FAQ recommends separate commits when a change spans several types [S1]; smart mode suggests a split for large or mixed diffs (§5.3).

---

## 3. Landscape survey

| Tool | Notable features and UX | Gaps `ccli` addresses |
|---|---|---|
| **VS Code Conventional Commits** (vivaxy) [S2] | ~740k installs; palette/SCM-button flow; reads commitlint configs (subset of rules); scopes; gitmoji. `autoCommit` defaults on, and the recommended flow adds, commits and pushes | No AI; editor-bound; partial rule coverage; risky auto-push default |
| **GitHub Copilot commit generation** [S4] | Sparkle button in Source Control; custom instructions via `github.copilot.chat.commitMessageGeneration.instructions` | No spec validation; Copilot-only; no documented pre-send secret gate |
| **Commitizen** (`cz-cli`) [S5] | Adapter-driven prompts; hook integration; retry after a failed pre-commit check | No AI; per-repo adapter setup |
| **cz-git / czg** [S6] | Zero-config CLI; fuzzy search; emoji mode; commitlint awareness; OpenAI generates the subject, optionally several candidates (`-N`) | AI covers the subject only; OpenAI-centric (plus Ollama [S11r]) |
| **OpenCommit** [S7] | OpenAI, Anthropic, Ollama; GitMoji; `conventional-commit` or `@commitlint` prompt modules; hook; GitHub Action | No documented quota-aware fallback chain or pre-send secret scan |
| **aicommits** [S8] | Formats: plain, conventional, conventional+body, gitmoji, subject+body; hook | Single provider in the README reviewed; no validation layer |
| **gitmoji-cli** [S9] | Emoji search; commit hook or `-c` mode; `emojiFormat` code/emoji; scope prompt | Emoji-first headers conflict with spec rule 1 |
| **commitlint** [S10] | Linter with programmatic `lint` and `load` APIs | Not a generator — `ccli` reuses it as a validator |

**Positioning:** `ccli` combines (1) full-message generation (header, body, footers, breaking changes), (2) spec-safe gitmoji, (3) validation against the repo's own commitlint config, (4) multi-provider fallback, (5) a pre-send secret gate with payload preview, and (6) mandatory confirmation with no auto-push.

---

## 4. Architecture and stack

### 4.1 Language evaluation

| Criterion | **Node.js / TypeScript** (chosen) | Go | Rust |
|---|---|---|---|
| Cold start | Slowest of the three; mitigated by single-file bundle. LLM latency dominates smart mode | Fast | Fastest |
| Official SDKs for all four primaries | Yes: `openai`, `@anthropic-ai/sdk`, `@google/genai`; xAI via the `openai` SDK with `baseURL` [S17] | OpenAI, Anthropic and Google Go SDKs appear in vendor docs [S11][S14][S15]; xAI via OpenAI-compatible client | Not verified for all four — assumption: some hand-rolled HTTP |
| Reuse commitlint + secretlint engines | **Direct** [S10][S24] | Reimplement | Reimplement |
| npm distribution | Native | Needs per-platform binary packages | Needs per-platform binary packages |
| Maintainer fit | Matches an existing TypeScript/Node practice | Learning curve | Steepest |

**Decision:** TypeScript on Node. The decisive driver is reuse: the repo's own commitlint rules become the validator, and secretlint supplies maintained secret rules. **Falsifier:** p50 cold start of `ccli --help` above 300 ms on the Windows runner after bundling (first remedy: Node's module compile cache). **Rejected:** Go/Rust (reimplementation cost exceeds the startup gain); Bun as the npm runtime (a second runtime to support).

### 4.2 Node version policy

Node 20 reached end of life on 30 April 2026; Node 22 is in maintenance until 30 April 2027; Node 24 leaves Active LTS on 20 October 2026; Node 26 enters LTS on 28 October 2026 [S23]. Set `engines.node: ">=22"`, test 22/24/26, and raise the floor to 24 after April 2027.

### 4.3 Concrete libraries

| Concern | Library |
|---|---|
| CLI parsing | `commander` |
| Prompts / TUI | `@clack/prompts` (with an injectable IO layer for tests) |
| Process spawning | `execa` (argument arrays, never a shell string) |
| Config validation | `zod` (emit JSON Schema at build for editor autocomplete) |
| Config paths | `env-paths` (XDG, `~/Library/Preferences`, `%APPDATA%`) |
| Keychain | `@napi-rs/keyring` — replaces archived `keytar`; prebuilt N-API binaries for macOS Keychain, Windows Credential Manager, libsecret [S19] |
| Secret scanning | `@secretlint/node` + `@secretlint/secretlint-rule-preset-recommend` + `@secretlint/secretlint-rule-no-dotenv` [S24] |
| Spec validation | `@commitlint/lint`, `@commitlint/load`, `@commitlint/config-conventional` [S10] |
| Globs | `picomatch` |
| Bundling | `esbuild` → one ESM file; keyring stays external |
| Tests | `vitest`, `msw` (HTTP fixtures), `node-pty` (TTY smoke tests; Windows ConPTY support to confirm in M0) |

### 4.4 Module layout

```
src/
  cli/          commands: commit (manual), smart commit, auth, config, doctor, models
  ui/           prompts, editor launch, rendering, non-TTY handling
  git/          inspector, staging, index snapshot, commit executor
  diff/         filter, budgeter, payload builder
  guard/        secret gate (path denylist + secretlint + entropy)
  message/      model (CommitDraft), renderer, gitmoji map, spec checker, commitlint bridge
  ai/           pipeline, prompt builder, repair loop, provider router
  providers/    openai.ts, anthropic.ts, gemini.ts, xai.ts, registry (models.json)
  config/       schema, loader (global + repo), key resolver
```

---

## 5. Module details

### 5.1 Git inspection (`git/`)

- All calls: `git -c core.quotepath=off --no-pager …` via `execa` argument arrays (no shell; safe for spaces and Unicode on Windows).
- State: `rev-parse --show-toplevel --git-dir`; detect unborn/detached HEAD and in-progress merge/rebase (prefill git's merge message instead of generating).
- Status: `status --porcelain=v2 -z --untracked-files=all`.
- Diff: `diff --cached --numstat -z` and `diff --cached --no-color --no-ext-diff --no-textconv -U3`; the last two flags stop repo-configured drivers from running during inspection.
- Style hints: `log -n 15 --format=%s`, passed through the secret gate like everything else.
- **Index snapshot:** record `git write-tree` at generation and compare before committing; if the index changed, warn and offer regenerate or commit-as-is.

**Staging policy:** if anything is staged, the message covers staged changes only; other paths go to the model by name and the user sees a "not included" notice. If nothing is staged, the user picks: tracked (`add -u`), all (`add -A`), or selected files.

### 5.2 Secret gate (`guard/`) — runs before any network call

1. **Path denylist** (content never read into the payload): `.env`, `.env.*`, `*.pem`, `*.key`, `*.p12`, `*.pfx`, `id_rsa*`, `id_ed25519*`, `*.kdbx`, `credentials*.json`, `.npmrc`, `.pypirc`, `*.tfstate*`, `kubeconfig*`, plus user `extraDenyGlobs` and a `.ccliignore` file.
2. **Content scan** of the exact outgoing payload with secretlint's recommended preset and the no-dotenv rule (the same engine `@vscode/vsce` embeds via `createEngine` [S24]).
3. **Entropy heuristic** (assumption — tune on fixtures): flag tokens ≥ 20 chars with high Shannon entropy on added lines.

On any hit nothing is sent. The user sees `file:line`, rule and a masked value, then picks **exclude files (default)**, **redact matches**, **send anyway** (typed confirmation, this run only, never persisted) or **abort**. The generated message is re-scanned in case the model echoes a secret. `--show-payload` prints the exact payload locally.

### 5.3 Diff summarization and token budgeting (`diff/`)

- **Filter:** lockfiles, `dist/`, `build/`, `*.min.*`, `*.map`, binaries and `linguist-generated` files contribute only their numstat line.
- **Estimate:** characters ÷ 4 plus a 20% margin (assumption; it only needs to be conservative). Budget = `min(smart.maxInputTokens, model context)`; default 12,000.
- **Tiered packing:**
  1. Numstat for every file (always sent).
  2. Hunks allocated per file by changed lines, with a per-file floor; cuts at hunk boundaries marked `[truncated N lines]`.
  3. Still over budget: numstat plus highest-signal hunks (public API, schema/migrations, manifests, deleted exports).
  4. Over 100 files or 2,000 changed lines (configurable): suggest a split [S1] and generate from the summary.
- **No map-reduce by default** (cost). `--deep` enables capped per-file summarization calls.

### 5.4 Message model and rendering (`message/`)

A single `CommitDraft` type feeds both modes:

```ts
type CommitDraft = {
  type: string; scope: string | null; gitmoji: string | null;
  description: string; body: string | null;
  breaking: { isBreaking: boolean; description: string | null };
  footers: { token: string; value: string }[];
};
```

The renderer is deterministic: normalize type/scope, map type → gitmoji from a bundled snapshot of the gitmoji list (fetched at build time from the gitmoji API used by gitmoji tooling [S9b]; no runtime network), add `!` and a `BREAKING CHANGE:` footer when breaking, wrap the body at 72 columns (preserving URLs and code), and emit `code` (`:sparkles:`) or `unicode` emoji per config.

### 5.5 UI (`ui/`)

- **Manual mode:** type (searchable) → scope (from config, workspace packages, history) → gitmoji (optional) → description → body → breaking change → footers → live preview → confirm.
- **Smart mode actions:** Commit · Edit (in `git var GIT_EDITOR`, then re-validate) · Regenerate (optional hint) · Change type/scope · Switch provider · Cancel.
- **Non-TTY:** never commits; `--print` writes the message to stdout. In `prepare-commit-msg` hook mode the message lands in the user's editor, and saving it is the approval.
- Honors `NO_COLOR`; keyboard-only.

### 5.6 Commit execution (`git/`)

- Write the approved message to a temp file and run `git commit -F <file>`: hooks run and signing follows user config. `--no-verify` only if the user passes it.
- With `-F` and no editor, git's default cleanup should keep `#`-prefixed lines such as `#123` (assumption; covered by integration tests).
- On hook failure, save the message under `<git-dir>/ccli/`; `ccli commit --retry` reuses it, as Commitizen does [S5].
- **Never pushes.**

---

## 6. AI providers

### 6.1 Primary providers (verified 17 Oct 2026)

| | OpenAI | Anthropic | Google Gemini | xAI |
|---|---|---|---|---|
| Key env var | `OPENAI_API_KEY` [S11] | `ANTHROPIC_API_KEY` (SDK default; verify) | `GEMINI_API_KEY` [S15] | `XAI_API_KEY` [S17] |
| API to use | Responses API (recommended for reasoning models) [S11] | Messages API | Interactions API via `@google/genai` [S15] | OpenAI-compatible Responses API at `https://api.x.ai/v1` [S17] |
| Effort control | `reasoning.effort`: `none`/`minimal`/`low`/`medium`/`high`/`xhigh`/`max`, model-dependent subsets and defaults [S11] | `output_config.effort`: `low`/`medium`/`high`/`xhigh`/`max`; default `high` on most models, `medium` on Opus 5.5 and Haiku 5.5 [S13] | `thinking_level`: `minimal`/`low`/`medium`/`high`, per-model subsets and defaults [S15] | `reasoning.effort`: `low`/`medium`/`high` (default), `xhigh` on grok-4.6+; reasoning cannot be disabled [S17] |
| Structured output | Structured Outputs (param shape: verify) | `output_config.format` [S14]; forced tool use is rejected on Opus/Sonnet 5.5 [S14], so do not rely on tool-forcing | Structured outputs guide exists [S15] (Interactions param: verify) | Structured outputs guide exists [S17] (assumed same shape as OpenAI Responses: verify) |
| No-retention hint | `store: false` (stateless mode) [S11] | — (ZDR is an account arrangement [S13]) | `store` controls stateful mode [S15] — send `false` | `store` governs response storage [S17] — send `false` |
| Suggested default model for commit messages | `gpt-5.6-luna` — lowest cost/latency per docs [S11] | `claude-haiku-5-5` [S13] | `gemini-3.5-flash-lite` (default thinking `minimal`) [S15] | `grok-4.7` (latest documented with effort control [S17]) |

Defaults are suggestions, not pricing claims; the tool embeds no prices or rate limits. The model registry is data, refreshed per release and user-overridable.

**Effort:** users set the provider-native value (`auto` omits it). The registry validates it per model and downgrades unsupported values to the nearest lower level with a warning. Default: `low` (Gemini `minimal`).

**No sampling parameters.** xAI reasoning models reject penalties and `stop` [S17]; regenerate diversity comes from the hint and the previous header.

### 6.2 Secondary providers (listed, not configured in v1)

Ollama (local; supported by OpenCommit [S7]), Azure OpenAI / Microsoft Foundry, Amazon Bedrock, Google Vertex AI, OpenRouter, Mistral, DeepSeek, Groq (popularity beyond the cited tools is an assumption). v1.1 adds a generic `openai-compatible` adapter whose `baseUrl` is settable only in global config.

### 6.3 Error classification and fallback

Router walks `providers.order`. SDK auto-retries are disabled (the Anthropic SDK retries twice by default [S14]) so one policy owns latency and cost.

| Class | Signals (verified unless marked) | Action |
|---|---|---|
| **Quota / credits exhausted** | OpenAI 429 with `credit_balance_exhausted`, `organization_spend_limit_exceeded`, `project_spend_limit_exceeded`, `organization_usage_limit_exceeded` (type may be `insufficient_quota`) [S12]. Anthropic 402 `billing_error`; 400 on a user-set spend limit; 429 tier spend cap with no `retry-after` [S14]. Gemini 402 `payment_required`; 429 `quota_exceeded` (daily) [S16]. xAI: no dedicated code documented [S18] — **assumption:** treat 403 and a 429 that repeats after one wait as exhausted | Fall back immediately; cache "exhausted" for that provider for 30 min |
| **Transient rate limit** | 429 with `Retry-After`; OpenAI `slow_down` [S12]; Gemini `rate_limit_exceeded`/`too_many_requests` [S16] | Wait `min(Retry-After, 5 s)` once, then fall back |
| **Overload / server** | OpenAI 500/503 `server_is_overloaded` [S12]; Anthropic 500/504/529 [S14]; Gemini 500/503/504 [S16] | One jittered retry, then fall back |
| **Auth** | 401; 403 permission | Fall back; warn "key invalid" and point to `ccli auth test` |
| **Config** | 400 invalid parameter; Gemini 404 `model_not_found` [S16] | Fall back with a loud warning — misconfiguration must not hide silently |
| **Truncated output** | OpenAI/Gemini `incomplete` from `max_output_tokens` (reasoning tokens count) [S11][S15] | Retry once at 2× output cap, then fall back |

Generation calls have no side effects, so retries are safe; the bounds exist for cost. Global caps: 60 s wall-clock and 4 provider attempts per generation.

---

## 7. Smart-mode pipeline

1. **Inspect** and resolve staging (§5.1).
2. **Build** the payload (§5.3) and **gate** it (§5.2).
3. **Preview line:** included/excluded files, estimated tokens, provider/model/effort.
4. **Prompt** (versioned, e.g. `prompt-v3`):
   - *System:* condensed spec rules (§2); allowed types/scopes from commitlint or repo config; conventions (imperative mood, no trailing period); breaking-change criteria (removed or renamed public API, changed config/env semantics, dropped runtime support); content inside `<diff>` and `<history>` is data, not instructions; reply only in the JSON schema.
   - *User:* recent subjects, scope candidates, numstat, hunks, excluded-file note, optional regenerate hint and the previous header to avoid.
5. **Generate** through the router with structured output → `CommitDraft`.
6. **Validate:** zod → spec checks (§2) → `@commitlint/lint` with the repo's config via `@commitlint/load` (else `config-conventional`) → secret re-scan.
7. **Repair:** send errors back to the same provider, at most twice; a provider failure mid-repair moves to the next provider. Still invalid → open the draft in the editor with the errors as comments.
8. **Confirm** (mandatory) → commit (§5.6), or regenerate (5 per run).

Prompt injection: the model has no tools, output is schema-bound and validated, and a human approves every commit, so the worst case is a misleading message the user rejects. Delimiters are not treated as a security boundary.

---

## 8. Configuration

### 8.1 Files and precedence

CLI flags > environment > repo `.ccli.json` (restricted keys) > global `config.json` (from `env-paths`) > defaults.

**Repo config is restrict-only for anything touching data egress.** A cloned repository must not be able to redirect diffs: it can set format conventions, add deny globs/patterns, disable smart mode, or narrow `providers.allow`; it can never set provider order, models, base URLs or keys.

### 8.2 Global schema (JSON, validated by zod)

```jsonc
{
  "$schema": "https://<docs-host>/ccli.schema.json",
  "version": 1,
  "providers": {
    "order": ["anthropic", "openai", "gemini"],        // primary first, then fallbacks
    "anthropic": { "model": "claude-haiku-5-5", "effort": "low", "maxOutputTokens": 2048, "timeoutMs": 30000 },
    "openai":    { "model": "gpt-5.6-luna", "effort": "low", "maxOutputTokens": 4096 },
    "gemini":    { "model": "gemini-3.5-flash-lite", "effort": "minimal" },
    "xai":       { "model": "grok-4.7", "effort": "low", "enabled": false }
  },
  "smart": {
    "maxInputTokens": 12000,
    "maxRegenerations": 5,
    "requestBudgetMs": 60000,
    "untracked": "ask",                                 // ask | include | exclude
    "language": "en"
  },
  "format": {
    "gitmoji": { "enabled": true, "style": "unicode", "position": "after-colon" },
    "headerMaxLength": 72,
    "bodyWrap": 72,
    "types": "commitlint",                              // or an explicit list
    "scopes": []
  },
  "secrets": { "extraDenyGlobs": [], "extraPatterns": [], "onDetect": "exclude" }
}
```

### 8.3 Keys

- Resolution: env var → OS keychain (`service: "conventional-commits-cli"`, `account: <provider>`) → 0600 plaintext file **only** with `--insecure-file-store`.
- `ccli auth set <provider>` reads the key from a hidden prompt, never argv (keeps it out of shell history); `auth list` shows source and last four characters; `auth test` makes a minimal call.
- Headless Linux keychains need D-Bus and have been reported to hang in CI containers [S20]: load lazily, time out after 2 s, fall back to env vars.
- `--verbose` logs provider, model, tokens, latency and request IDs — never keys or payloads.

---

## 9. Distribution and the single-release goal

**One tag → one workflow → all artifacts.**

1. **npm (primary):** the bundled ESM file is identical on all three OSes, so one published package *is* the cross-platform release. The one native dependency, `@napi-rs/keyring`, ships prebuilt binaries that npm selects via `os`/`cpu`-gated optional packages (the esbuild/Biome pattern [S26]). Publish with npm trusted publishing over OIDC (npm CLI ≥ 11.5.1; provenance generated automatically) [S25].
2. **Standalone binaries (secondary, M4):** `bun build --compile` cross-targets Linux x64/arm64 (glibc and musl), macOS x64/arm64 and Windows x64/arm64 [S21], attached to the same GitHub Release with SHA-256 checksums. Bun reportedly does not embed `.node` addons [S22], so each archive carries the keyring `.node` beside the executable; if the M4 spike fails, binaries use env-var keys only.
3. **Deferred:** Homebrew, Scoop and winget manifests from the same release.

**Rejected:** npm-only (excludes users without Node); compiled binaries *through* npm optional packages (no gain while the JS package already runs everywhere).

---

## 10. Milestones

Estimates assume one engineer and are planning figures, not commitments.

1. **M0 — Foundations (1 week).** Repo bootstrap, esbuild bundle, vitest, CI matrix (Ubuntu, macOS, Windows × Node 22/24/26). Spikes: keyring on all three OSes including headless Linux; cold-start measurement against the 300 ms falsifier; node-pty on Windows. *Exit:* green matrix; spike results recorded in ADRs.
2. **M1 — Manual mode MVP (2 weeks).** Prompts, `CommitDraft`, renderer, spec checker, commitlint bridge, executor with retry, global/repo config. *Exit:* integration tests produce commits that pass commitlint on all three OSes.
3. **M2 — Smart mode, one provider (2–3 weeks).** Git inspector, staging flow, index snapshot, budgeter, secret gate, prompt v1, structured output, repair loop, Anthropic or OpenAI adapter. *Exit:* evaluation set passes targets (§11).
4. **M3 — Multi-provider (2 weeks).** Remaining three adapters, model registry, effort validation, error classifier, fallback router, keychain storage, `auth`/`doctor`/`models` commands. *Exit:* contract tests cover every error class per provider.
5. **M4 — Distribution (1–2 weeks).** Trusted publishing with provenance, Bun binary spike → release job, `prepare-commit-msg` hook mode, docs. *Exit:* fresh-machine install smoke tests pass on all targets.
6. **M5 — 1.0 hardening (2 weeks).** Security review of the gate and repo-config restrictions, evaluation re-run on all default models, beta feedback, accessibility pass. *Exit:* release checklist signed off.

---

## 11. Testing strategy

| Layer | Scope | Platforms |
|---|---|---|
| Unit | Renderer, spec checker, gitmoji map, budgeter, error classifier, effort downgrade, config precedence and repo restrictions | All CI runners |
| Secret gate | Fixture corpus of fake keys **generated at test time** (committed fake secrets trip push protection), plus near-miss false-positive cases | All |
| Git integration | Temp repos: unborn/detached HEAD, merge in progress, renames, submodules, Unicode/space paths, CRLF with `core.autocrlf=true`, failing hooks, `#`-prefixed lines, index changed before commit | Ubuntu, macOS, Windows |
| Provider contract | `msw` fixtures per provider: success, every error class, `incomplete`, malformed JSON | Ubuntu |
| Live smoke | Nightly, opt-in keys with tight spend limits, one tiny diff per provider | Ubuntu |
| TTY end-to-end | node-pty: manual, smart, edit, regenerate, cancel; assert nothing commits without approval | All three (Windows ConPTY confirmed in M0) |
| Keychain | Set/get/delete; Linux under `dbus-run-session` with a keyring daemon (assumption, proven in M0) | All |
| Model evaluation | 60–100 labeled real diffs; initial targets: 100% spec-valid after repair, type accuracy ≥ 85%, breaking-change recall ≥ 90%. Re-run on any prompt or default-model change | Ubuntu |
| Binaries | `--version` and a manual-mode dry run on native runners for each target | Per target |

---

## 12. Risks and open questions

| Risk | Mitigation |
|---|---|
| **Privacy:** diffs leave the machine | Explicit provider choice, payload preview, `store: false` where supported, restrict-only repo policy (a repo can disable smart mode), local Ollama adapter in v1.1, no telemetry |
| **Secret leakage** (false negatives) | Layered denylist + secretlint + entropy; default exclude; re-scan of output; `.ccliignore`; documented as best-effort, not a guarantee |
| **Cost overrun** | Low effort default, input/output token caps, regenerate cap, attempt and time caps, token usage shown after each run; no embedded prices (they change) — optional user-entered rate for estimates |
| **Model and API churn** | Data-driven registry; `doctor` flags unknown models; each release re-verifies effort values, error codes and defaults (xAI and Gemini docs both list 2026 retirements or breaking changes [S17][S15]) |
| **Misclassified quota errors** (esp. xAI) | Classifier is table-driven and covered by contract tests; unknown 4xx falls back with a warning rather than failing hard |
| **Unsigned binaries flagged by OS security** (assumption) | macOS notarization and Windows code signing before promoting binaries |
| Covered above | Headless keychain (§8.3), Bun native addon (§9), prompt injection (§7) |

**Open questions**

1. Final package and binary name (npm availability not checked).
2. Gitmoji on or off by default.
3. Should smart mode propose a split into multiple commits (with per-group staging) in v1, or only warn?
4. Should a repo be allowed to *pin* a provider (e.g. company-approved only), beyond the current restrict-only allow-list?
5. Licensing and whether to accept an opt-in, payload-free usage metric.

---

## Sources

- **S1** Conventional Commits 1.0.0 — https://www.conventionalcommits.org/en/v1.0.0/
- **S2** VS Code Conventional Commits (vivaxy), Marketplace — https://marketplace.visualstudio.com/items?itemName=vivaxy.vscode-conventional-commits
- **S3** gitmoji-vscode issue #22 (emoji placement) — https://github.com/seatonjiang/gitmoji-vscode/issues/22
- **S4** VS Code blog, custom instructions (commit message generation setting) — https://code.visualstudio.com/blogs/2025/03/26/custom-instructions
- **S5** Commitizen overview — https://www.linuxlinks.com/commitizen-create-well-structured-git-commit-messages/
- **S6** czg on npm — https://npmjs.com/package/czg · cz-git — https://github.com/Zhengqbbb/cz-git
- **S7** OpenCommit summary — https://www.sourcepulse.org/projects/1255206
- **S8** aicommits wiki — https://github.com/Nutlope/aicommits/wiki
- **S9** gitmoji-cli — https://github.com/carloscuesta/gitmoji-cli · **S9b** go-gitmoji-cli — https://pkg.go.dev/github.com/AndreasAugustin/go-gitmoji-cli
- **S10** commitlint — https://github.com/conventional-changelog/commitlint
- **S11** OpenAI, Reasoning models — https://developers.openai.com/api/docs/guides/reasoning · **S11r** AI commit tools comparison (czg/Ollama) — https://www.hongkiat.com/blog/best-ai-tools-for-git-commit-messages/
- **S12** OpenAI, Error codes — https://developers.openai.com/api/docs/guides/error-codes
- **S13** Anthropic, Effort — https://platform.claude.com/docs/en/build-with-claude/effort
- **S14** Anthropic, API errors — https://platform.claude.com/docs/en/api/errors
- **S15** Google, Gemini thinking — https://ai.google.dev/gemini-api/docs/thinking
- **S16** Google, Gemini API errors — https://ai.google.dev/gemini-api/docs/api-errors
- **S17** xAI, Reasoning — https://docs.x.ai/developers/model-capabilities/text/reasoning
- **S18** xAI, Debugging errors — https://docs.x.ai/developers/debugging
- **S19** keytar → `@napi-rs/keyring` migration note — https://github.com/VladoIvankovic/Codeep/issues/6 · library — https://github.com/Brooooooklyn/keyring-node
- **S20** Linux CI keyring/D-Bus hang (third-party code comment) — https://glama.ai/mcp/servers/@jfarcand/pierre_mcp_server/blob/10be78d57724072df323d43ad7151c8d101b7488/sdk/src/secure-storage.ts
- **S21** Bun single-file executables — https://bun.com/docs/bundler/executables
- **S22** Report that `bun build --compile` does not bundle `.node` addons — https://github.com/UsefulSoftwareCo/executor/pull/935/files
- **S23** Node.js release dates — https://endoflife.date/nodejs · https://ecorpit.com/nodejs-development-company/
- **S24** secretlint — https://github.com/secretlint/secretlint · `@secretlint/node` usage in vsce — https://app.unpkg.com/@vscode/vsce@3.7.1/files/out/secretLint.js
- **S25** npm trusted publishers — https://docs.npmjs.com/trusted-publishers · GA announcement — https://github.blog/changelog/2025-07-31-npm-trusted-publishing-with-oidc-is-generally-available/
- **S26** Platform-specific optional packages (esbuild/Biome pattern) — https://github.com/JohnnyMorganz/StyLua/pull/1119
