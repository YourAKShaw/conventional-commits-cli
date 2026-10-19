# Changelog

All notable changes to this project are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses [Semantic Versioning](https://semver.org/spec/v2.0.0.html). While the version is `0.x`, minor releases may contain breaking changes; they are listed under **Changed** with migration notes.

## [Unreleased]

## [0.1.0] - 2026-10-19

First public release.

### Added

- `ccli commit`: guided Conventional Commit prompts (type, scope, gitmoji, description, body, breaking change, issue references), pre-filled from flags, with types and scopes from the repository's commitlint config and recent history.
- `ccli smart commit`: commit messages generated from staged changes by OpenAI (Responses API), Anthropic (Messages API), xAI (Responses API) or Google Gemini (Interactions API), with structured JSON output, per-provider model and reasoning-effort settings, and a review loop (commit, edit, change type or scope, regenerate with a hint, switch provider, cancel).
- Provider router with ordered fallback: immediate fallback on exhausted credits or quota (remembered for 30 minutes), one bounded retry for short rate limits, overload, network errors and timeouts, a doubled output budget after truncation, and an overall time budget.
- Secret gate on the exact payload: default deny globs for secret-bearing files, `.ccliignore`, secretlint's recommended rules, built-in key patterns and an entropy check, with withhold / redact / send / stop choices; generated messages are re-scanned.
- One-time, per-provider consent before diffs are first sent; `--show-payload` to inspect the payload without network access.
- Validation against Conventional Commits 1.0.0 (blocking) and commitlint rules (confirm to override), with up to two automatic repair rounds for AI output.
- Global configuration with JSON schema, restrict-only repository configuration (`.ccli.json`), and `ccli config init/show/get/set/unset/path`.
- API keys from environment variables, the OS keychain (via the optional `@napi-rs/keyring`), or an opt-in plaintext file store; `ccli auth set/remove/list/test`.
- `ccli doctor`, `ccli models`, and an optional `prepare-commit-msg` hook (`ccli hook install/uninstall/status`).
- Gitmoji support (after the colon by default; prefix position and `:code:` style optional).
- Saved message and `--retry` after a failed `git commit`; staging done by ccli is undone on cancel; Ctrl-C exits with code 130.
- npm package for Windows, macOS and Linux (Node.js 22.12+), standalone binaries for eight platform targets, CI on all three operating systems, and trusted publishing with provenance.

[Unreleased]: https://github.com/YourAKShaw/conventional-commits-cli/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/YourAKShaw/conventional-commits-cli/releases/tag/v0.1.0
