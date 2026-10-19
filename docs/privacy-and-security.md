# Privacy and security

This page describes what `ccli` sends, to whom, what it protects, and where those protections stop. It is written for users deciding whether to enable smart mode and for reviewers auditing the code. To report a vulnerability, follow the [security policy](../.github/SECURITY.md).

## Invariants

These hold for every release. A change that weakens one needs an ADR and a major-version note.

1. **Nothing is committed without approval.** Interactive commands commit only after you choose *Commit* (or save the editor in hook mode). Without a terminal, `ccli` refuses to commit and offers `--print` instead.
2. **Nothing is sent before consent.** Diffs go only to providers you approved once per provider (`smart.acknowledgedProviders`). Manual mode makes no network requests at all.
3. **Secret-bearing files never have their content sent.** Only their path and line counts.
4. **Flagged content is never sent silently.** Sending content the gate flagged requires typing `send`; without a terminal it is withheld.
5. **A repository cannot redirect your data.** `.ccli.json` can only tighten rules.
6. **Keys never appear in output, logs or payloads.** `--verbose` prints diagnostics without keys or diff content.

## What smart mode sends

| Item | Sent | Notes |
| :--- | :--- | :--- |
| Staged diff hunks | Yes, within `smart.maxInputTokens` (default 12,000 estimated tokens) | When the diff is larger, small files are kept whole and large ones share the rest; manifests, schemas, migrations, API specs, Dockerfiles, CI workflows and entry points get a double share |
| Changed file list | Yes | Status, path, added/removed line counts, and why content was omitted |
| Content of denied files | **No** | Path and counts only |
| Lockfiles and generated files | **No** | Summarized as "lockfile" or "generated" (including `linguist-generated` in `.gitattributes`) |
| Binary files | **No** | Listed as binary |
| Recent commit subjects | Yes, up to `smart.historyCount` (default 15) | Scanned like the diff; helps match your style |
| Branch name | Yes | Scanned; issue keys in it may become `Refs:` footers |
| Your `--hint` | Yes | |
| Unstaged or untracked changes | **No** | Only staged changes are described and committed |
| Author name, email, remotes | **No** | |
| Telemetry or analytics | **None** | `ccli` contacts only the provider endpoints you configured |

Run `ccli smart commit --show-payload` to print the exact system prompt and user message after the secret gate, with no network access.

Where the API supports it, requests set `store: false` (OpenAI, xAI, Gemini). Anthropic's Messages API has no such parameter; data retention is governed by your account terms. Each provider's own policies apply to what you send.

## The secret gate

The gate runs on the **exact payload** after budgeting and before any network call ([`src/guard/`](../src/guard/), [`src/commands/smart.ts`](../src/commands/smart.ts)).

### Layer 1: path deny list

Content is withheld for files matching any of these (case-insensitive, any directory):

`.env`, `.env.*`, `*.env`, `*.pem`, `*.key`, `*.p8`, `*.p12`, `*.pfx`, `*.jks`, `*.keystore`, `*.asc`, `*.gpg`, `id_rsa*`, `id_dsa*`, `id_ecdsa*`, `id_ed25519*`, `*.kdbx`, `credentials`, `credentials.*`, `*credentials*.json`, `service-account*.json`, `client_secret*.json`, `.npmrc`, `.yarnrc.yml`, `.pypirc`, `.netrc`, `_netrc`, `.git-credentials`, `.dockercfg`, `.docker/config.json`, `*.tfstate`, `*.tfstate.*`, `*.tfvars`, `kubeconfig*`, `.kube/config`, `secrets.yml`, `secrets.yaml`, `secrets.json`, `*.secret`, `*.secrets`, `.htpasswd`.

Exceptions (content allowed): `.env.example`, `.env.sample`, `.env.template`, `.env.dist`, `*.pub` (see [`denylist.ts`](../src/guard/denylist.ts) for the authoritative list).

Add your own globs in a `.ccliignore` file at the repository root (one glob per line, `#` comments), `secrets.extraDenyGlobs` in your global config, or the repository's `.ccli.json`. When you commit a denied file, `ccli` also warns you, because such files rarely belong in Git.

### Layer 2: content scanning

Every text item in the payload (diff hunks, recent subjects, branch name) is scanned by:

- **secretlint** with `@secretlint/secretlint-rule-preset-recommend` (cloud keys, private keys, tokens for common services, basic-auth URLs). Inline `secretlint-disable` comments are **not** honoured, so a diff cannot switch the scanner off for itself.
- **Built-in patterns** for private key blocks, AWS access key IDs, OpenAI, Anthropic, xAI, Google, GitHub, GitLab, Slack, Stripe and npm tokens, JWTs, and credentials in URLs.
- **Your patterns** from `secrets.extraPatterns` (regular expressions).
- **An entropy check** for high-randomness strings: at least 16 characters with Shannon entropy ≥ 3.5 next to words like `secret`, `token`, `password` or `api_key`, or at least 32 characters with entropy ≥ 4.5 anywhere. Obvious placeholders are ignored: runs of `x`, `*` or `0`, values starting with `your_`, and values containing `example`, `sample`, `placeholder`, `changeme`, `dummy`, `redacted` or `test`.

### Layer 3: your decision

Findings are shown masked (the first four characters, for example `sk-a…**** (51 chars)`) with file and line, and nothing has been sent yet. You choose:

| Choice | Effect |
| :--- | :--- |
| **Withhold** (default, recommended) | The affected files' content is removed; their path and counts remain |
| **Redact** | Only the matches are replaced with `[REDACTED:<rule>]` |
| **Send anyway** | Requires typing `send`; for false positives |
| **Stop** | Exit without sending or committing |

Set `secrets.onDetect` to `exclude`, `redact` or `abort` to skip the question. Without a terminal, or with `--print`/`--show-payload`, `ask` behaves like `exclude`. After withholding or redacting, the payload is rebuilt and scanned again; if it is still not clean after five rounds, `ccli` stops without sending.

### Layer 4: output re-scan

The generated message is scanned before it is shown. Anything that looks like a secret is redacted and you are warned, so a model cannot copy a secret from context into your history.

### Limits

Secret detection is **best-effort**. It can miss secrets in unusual formats, split across lines, or encoded; it can also flag harmless strings. It reduces risk; it does not replace secret scanning on your Git host, pre-commit scanners, or keeping secrets out of the working tree. If something sensitive was sent, rotate it.

## Repository configuration is untrusted

A cloned repository is not trusted to choose where your diffs go. `.ccli.json` can set formatting (`format.*`), add deny globs and patterns, lower `smart.maxInputTokens`, disable smart mode, and restrict providers with `providers.allow`. It is **rejected with an error** if it tries to set any of:

| Key | Why |
| :--- | :--- |
| `providers.order`, `providers.<id>` (model, `baseUrl`, effort, enabled…) | Could route diffs to an attacker-controlled endpoint or an expensive model |
| `smart.acknowledgedProviders` | Consent is yours to give |
| `secrets.onDetect` | Could make the gate send flagged content |
| `commitlint` (`loadJsConfig`) | Would execute repository code |

Similarly, JavaScript, TypeScript and YAML commitlint configs are not executed unless you enable `commitlint.loadJsConfig` in your global config. When enabled, the repository's own `@commitlint/load` runs them, which means running code from that repository.

## Prompt injection

Diffs, file names, commit subjects and branch names are attacker-controllable in a cloned or contributed repository. The prompt marks them as data, but delimiters are not a security boundary. The real controls are structural:

- The model has **no tools** and cannot act; it returns one JSON object.
- The output is **schema-validated**, rendered by `ccli` (not taken verbatim), checked against the spec and commitlint, and re-scanned for secrets.
- **You approve** every commit, so the worst outcome is a misleading message you can reject or edit.

## API keys

Resolution order: environment variable → OS keychain → opt-in file store.

| Store | Where | Notes |
| :--- | :--- | :--- |
| Environment | `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `XAI_API_KEY`, `GEMINI_API_KEY`/`GOOGLE_API_KEY` | Best for CI and containers |
| OS keychain (default for `ccli auth set`) | macOS Keychain, Windows Credential Manager, Linux Secret Service (service `conventional-commits-cli`) | Via the optional `@napi-rs/keyring` package. On Linux it is used only when a D-Bus session exists, and is pinned to Secret Service so keys never land silently in the non-persistent kernel keyring. Calls time out after 5 s. Disable with `CCLI_DISABLE_KEYCHAIN=1` |
| File store (`--insecure-file-store`) | `credentials.json` in the config directory | Plaintext, created with mode `0600` (directory `0700`); `ccli doctor` warns if permissions are too open. Use only where no keychain exists |

`ccli auth set` reads the key from a hidden prompt or `--stdin`, never from a command-line argument (which would land in shell history and process lists). `ccli auth list` shows only where each key comes from.

## Git safety

- Git runs without a shell, with `core.quotepath=off`, `--no-pager` and `GIT_OPTIONAL_LOCKS=0`; file lists are passed with NUL separators and `--pathspec-from-file`, so unusual file names cannot inject arguments.
- The message is written to a temporary file and committed with `git commit --cleanup=whitespace -F <file>`, so lines starting with `#` survive and no editor is spawned unexpectedly.
- Extra arguments after `--` are passed to `git commit`, except options that would replace the message (`-m`, `-F`, `-C`, `--fixup`, `--template`, …) or commit something other than the staged changes (`-a`, `-o`, `-p`, pathspecs…).
- If the staged changes change while you review, you are asked again before committing.
- Your hooks (`pre-commit`, `commit-msg`) run normally. If one rejects the commit, the message is saved to `CCLI_LAST_MESSAGE` in the Git directory; `ccli commit --retry` reuses it.

## Supply chain

- The published package has one optional runtime dependency (`@napi-rs/keyring`, prebuilt per platform). Everything else is bundled at build time, with licenses listed in `dist/THIRD_PARTY_NOTICES.md`.
- Releases are published from GitHub Actions with npm trusted publishing (OIDC, no long-lived token) and provenance; see [releasing](releasing.md).
- Workflow actions are pinned to commit SHAs; Dependabot proposes updates; CodeQL scans the code.
