# Configuration

`ccli` works with no configuration: manual mode uses your repository's commitlint rules, and smart mode needs only an API key in an environment variable. This page documents every file, setting and environment variable.

## Files and precedence

| Source | Location | Who controls it | Can set |
| :--- | :--- | :--- | :--- |
| Command-line flags | `ccli smart commit -P anthropic --effort medium` | You, per run | Provider, model, effort, gitmoji, hint |
| Environment variables | See [below](#environment-variables) | You | Keys, directories, behaviour switches |
| **Global config** | `config.json` in the config directory | You | Everything |
| **Repository config** | `.ccli.json` at the repository root | The repository | Formatting and restrictions only |
| `.ccliignore` | Repository root | The repository | Extra deny globs |
| commitlint config | `.commitlintrc`, `.commitlintrc.json`, `package.json#commitlint` | The repository | Types, scopes, rules |

Flags override the global config. The repository config merges `format` settings over yours (so a project's scopes or gitmoji choice wins) and can only **narrow** everything else: deny globs are added, `smart.maxInputTokens` takes the lower value, `smart.enabled: false` disables smart mode, `providers.allow` filters your order.

`ccli config path` prints the locations in use. `ccli config show` prints the effective, merged configuration.

### Config directory

| Platform | Default |
| :--- | :--- |
| Windows | `%APPDATA%\conventional-commits-cli` |
| macOS | `~/Library/Application Support/conventional-commits-cli` |
| Linux and others | `$XDG_CONFIG_HOME/conventional-commits-cli`, else `~/.config/conventional-commits-cli` |

Override with `CCLI_CONFIG_DIR`. The same directory holds `credentials.json` if you opt into the file store.

The cache directory (provider "out of credits" markers, safe to delete) is `%LOCALAPPDATA%\conventional-commits-cli\Cache`, `~/Library/Caches/conventional-commits-cli` or `$XDG_CACHE_HOME/conventional-commits-cli` (`~/.cache/…`). Override with `CCLI_CACHE_DIR`.

## Editing settings

```sh
ccli config init                                  # guided setup
ccli config get providers.order
ccli config set providers.order anthropic,openai  # comma lists for list settings
ccli config set smart.maxInputTokens 20000        # numbers and booleans are parsed as JSON
ccli config set format.scopes '["api","web"]'     # or pass JSON directly
ccli config unset providers.openai.model          # back to the default
```

Every write is validated against the schema and saved atomically. You can also edit `config.json` by hand; editors that understand JSON Schema get completion from the `$schema` URL that `ccli` writes. The schemas are in [`schema/`](../schema/) and are generated from the source with `npm run schema`.

## Global settings reference

### `providers`

| Key | Type | Default | Description |
| :--- | :--- | :--- | :--- |
| `providers.order` | list of `openai`, `anthropic`, `xai`, `gemini` | `["openai", "anthropic", "xai", "gemini"]` | Primary first, then fallbacks. Providers without a key are skipped |
| `providers.<id>.model` | string | see [providers](providers.md#overview) | Any model ID your account can use |
| `providers.<id>.effort` | lowercase string | `low` (Gemini `minimal`) | `auto` omits the parameter; unsupported values are lowered with a warning |
| `providers.<id>.maxOutputTokens` | 256–128,000 | 4096 | Output limit, including reasoning tokens where the vendor counts them. Doubled once (max 32,768) after truncation |
| `providers.<id>.timeoutMs` | 1,000–600,000 | 45,000 | Per-request timeout |
| `providers.<id>.baseUrl` | http(s) URL | vendor endpoint | Gateway or proxy. Global config only |
| `providers.<id>.enabled` | boolean | `true` | Skip a provider without removing its key |
| `providers.<id>.structuredOutput` | boolean | `true` | Set `false` for gateways that reject JSON-schema output |

### `smart`

| Key | Type | Default | Description |
| :--- | :--- | :--- | :--- |
| `smart.enabled` | boolean | `true` | Turn smart mode off entirely |
| `smart.maxInputTokens` | 2,000–400,000 | 12,000 | Estimated token budget for the whole prompt; larger diffs are trimmed |
| `smart.maxRegenerations` | 0–20 | 5 | Regenerations allowed per run |
| `smart.requestBudgetMs` | 5,000–900,000 | 90,000 | Time limit for one generation across all retries and fallbacks |
| `smart.language` | string | `English` | Language for the description and body |
| `smart.historyCount` | 0–50 | 15 | Recent commit subjects sent as style examples (0 sends none) |
| `smart.largeChangeFiles` | integer | 100 | Above this many files, suggest splitting the commit |
| `smart.largeChangeLines` | integer | 2000 | Above this many changed lines, suggest splitting the commit |
| `smart.acknowledgedProviders` | list | `[]` | Providers you approved for receiving diffs. Written by the first-use prompt |

### `format`

| Key | Type | Default | Description |
| :--- | :--- | :--- | :--- |
| `format.gitmoji.enabled` | boolean | `true` | Add a gitmoji to the header |
| `format.gitmoji.style` | `unicode` or `code` | `unicode` | `✨` or `:sparkles:` |
| `format.gitmoji.position` | `after-colon` or `prefix` | `after-colon` | `feat: ✨ add x` or `✨ feat: add x`. `ccli` validates both, but a `prefix` header is not valid Conventional Commits syntax for other tools: a commitlint `commit-msg` hook and changelog generators will usually reject or skip it |
| `format.headerMaxLength` | 20–200 | 72 | Maximum header length (applied as commitlint `header-max-length`) |
| `format.bodyWrap` | 40–200 | 72 | Wrap body paragraphs at this width. List items get a hanging indent; code blocks, indented lines and long URLs are left alone |
| `format.types` | `"commitlint"` or list | `"commitlint"` | Use commitlint's `type-enum`, or a list like `["feat", "fix", {"type": "perf", "description": "Performance"}]` |
| `format.scopes` | list of strings | `[]` | Suggested scopes, in addition to those from commitlint's `scope-enum` and recent history |

### `secrets`

| Key | Type | Default | Description |
| :--- | :--- | :--- | :--- |
| `secrets.extraDenyGlobs` | list of globs | `[]` | Files whose content is never sent, added to the [defaults](privacy-and-security.md#layer-1-path-deny-list) |
| `secrets.extraPatterns` | list of regular expressions | `[]` | Extra secret patterns, e.g. `"ACME-[0-9A-F]{32}"` |
| `secrets.onDetect` | `ask`, `exclude`, `redact`, `abort` | `ask` | What to do when the gate finds something. Global config only |

### `commitlint`

| Key | Type | Default | Description |
| :--- | :--- | :--- | :--- |
| `commitlint.loadJsConfig` | boolean | `false` | Execute JavaScript, TypeScript or YAML commitlint configs through the repository's own `@commitlint/load`. This runs repository code. Global config only |

### Example

```json
{
  "$schema": "https://raw.githubusercontent.com/YourAKShaw/conventional-commits-cli/main/schema/config.schema.json",
  "version": 1,
  "providers": {
    "order": ["anthropic", "gemini", "openai"],
    "anthropic": { "model": "claude-haiku-5-5", "effort": "low" },
    "gemini": { "model": "gemini-3.5-flash-lite", "effort": "minimal" },
    "openai": { "model": "gpt-5.6-luna", "effort": "low", "timeoutMs": 30000 },
    "xai": { "enabled": false }
  },
  "smart": { "language": "English", "maxInputTokens": 16000, "historyCount": 10 },
  "format": {
    "gitmoji": { "enabled": true, "style": "unicode", "position": "after-colon" },
    "headerMaxLength": 72
  },
  "secrets": { "extraDenyGlobs": ["**/fixtures/private/**"], "onDetect": "ask" }
}
```

## Repository config: `.ccli.json`

Commit this file to share conventions. Allowed keys:

| Key | Effect |
| :--- | :--- |
| `format.*` | Same keys as the global `format` section; repository values win |
| `secrets.extraDenyGlobs`, `secrets.extraPatterns` | Added to the user's lists |
| `smart.enabled` | `false` disables smart mode in this repository |
| `smart.maxInputTokens` | The lower of this and the user's value applies |
| `providers.allow` | Only these providers may receive this repository's diffs |

```json
{
  "$schema": "https://raw.githubusercontent.com/YourAKShaw/conventional-commits-cli/main/schema/repo-config.schema.json",
  "version": 1,
  "format": {
    "scopes": ["api", "web", "infra", "docs"],
    "gitmoji": { "enabled": false }
  },
  "providers": { "allow": ["anthropic", "openai"] },
  "secrets": { "extraDenyGlobs": ["data/customers/**"] },
  "smart": { "maxInputTokens": 8000 }
}
```

Setting a provider's model, endpoint or order, acknowledgements, `secrets.onDetect` or `commitlint` here is an error, by design: see [why](privacy-and-security.md#repository-configuration-is-untrusted).

## `.ccliignore`

Gitignore-style globs, one per line; `#` starts a comment. Patterns without a `/` match at any depth, a leading `/` anchors to the repository root, and a trailing `/` means everything under that directory. Matching is case-insensitive.

```gitignore
# Never send these to an AI provider
config/production.yml
/scripts/deploy/
*.sqlite
```

Matching files are still committed normally; only their content is withheld from smart mode.

## commitlint integration

Manual and smart mode use the same rules as your commit-msg hook would:

1. Rules start from `@commitlint/config-conventional` (bundled).
2. `format.headerMaxLength` and a custom `format.types` list apply on top.
3. A declarative repository config is merged next: `.commitlintrc`, `.commitlintrc.json`, or the `commitlint` key in `package.json`. Its `rules` apply; `extends` other than the conventional preset are reported but not loaded.
4. JavaScript, TypeScript and YAML configs (`commitlint.config.*`, `.commitlintrc.{js,cjs,mjs,ts,cts,mts,yml,yaml}`) are only loaded with `commitlint.loadJsConfig: true`, through the repository's installed `@commitlint/load`. Otherwise `ccli` notes that it used the conventional defaults; your actual hook still enforces the full config at commit time.

Commit types and their descriptions come from `type-enum` (with the conventional descriptions). If commitlint's `scope-enum` lists scopes, only those are offered; otherwise suggestions come from `format.scopes` and scopes used in recent history (up to 30).

Spec violations (for example a missing description or a malformed `BREAKING CHANGE` footer) block the commit. commitlint style issues (for example `subject-case`) show as warnings, and committing anyway requires confirmation.

## Environment variables

| Variable | Effect |
| :--- | :--- |
| `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `XAI_API_KEY`, `GEMINI_API_KEY` (or `GOOGLE_API_KEY`) | Provider keys; take precedence over stored keys |
| `CCLI_CONFIG_DIR` | Config directory (also moves the cache to `<dir>/cache` unless `CCLI_CACHE_DIR` is set) |
| `CCLI_CACHE_DIR` | Cache directory |
| `CCLI_DISABLE_KEYCHAIN=1` | Never touch the OS keychain |
| `CCLI_NON_INTERACTIVE=1` | Behave as if there is no terminal (no prompts, never commits) |
| `CCLI_DEBUG=1` | Same as `--verbose`: diagnostics on stderr, never keys or diff content |
| `NO_COLOR` | Disable colours (also `--no-color`) |
| `GIT_EDITOR`, `core.editor`, `VISUAL`, `EDITOR` | Editor for the *Edit* action, resolved by `git var GIT_EDITOR` |
