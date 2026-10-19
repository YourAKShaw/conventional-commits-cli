<div align="center">

# 🤝 Contributing to conventional-commits-cli

**Help make good commit messages effortless, and AI assistance safe by default.**

[![PRs Welcome](https://img.shields.io/badge/PRs-Welcome-2563EB?style=flat-square)](https://github.com/YourAKShaw/conventional-commits-cli/pulls)
[![Node.js 22.12+](https://img.shields.io/badge/Node.js-22.12%2B-334155?style=flat-square)](https://nodejs.org/)
[![Conventional Commits](https://img.shields.io/badge/Conventional%20Commits-1.0.0-2563EB?style=flat-square)](https://www.conventionalcommits.org/en/v1.0.0/)
[![License: MIT](https://img.shields.io/badge/License-MIT-2563EB?style=flat-square)](../LICENSE)

[Project overview](../README.md) · [Architecture](../docs/architecture.md) · [Get help](SUPPORT.md) · [Security policy](SECURITY.md)

</div>

---

## Start with the user's problem

`ccli` helps people write Conventional Commits by hand or with AI, without leaking secrets and without committing anything they did not approve. Contributions should make that faster, clearer, or safer.

Useful contributions include:

- A bug report with a minimal reproduction (a sequence of `git` commands and the `ccli` invocation).
- A secret pattern the gate misses, or a false positive it should not raise, with a **fake** example.
- A provider error the router misclassifies, with the sanitized response body and status.
- Clearer prompts, messages, docs or error hints.
- Tests for an edge case: unusual file names, Windows paths, hooks, large diffs.

Read the [architecture overview](../docs/architecture.md) and the [privacy and security model](../docs/privacy-and-security.md) before changing the secret gate, provider routing, repository config, or anything that decides whether a commit happens.

## 🧭 Choose the right starting point

| Contribution | Where to begin |
| :--- | :--- |
| Small fix or docs correction | Open a pull request with the problem and how you verified the fix. |
| Bug | Search existing issues, then use the [bug report form](https://github.com/YourAKShaw/conventional-commits-cli/issues/new/choose) with `ccli doctor --json` output. |
| New feature, provider, or behaviour change | Open a [feature request](https://github.com/YourAKShaw/conventional-commits-cli/issues/new/choose) first with the use case and trade-offs. |
| Security vulnerability | **Do not open an issue.** Follow the [security policy](SECURITY.md). |
| Usage question | Follow the [support guide](SUPPORT.md). |

Never paste real API keys, private diffs or secrets into issues, PRs or test fixtures. Build fake secrets at runtime as `test/helpers/fake-secrets.ts` does, so the repository never contains strings that trip secret scanners.

## 🛠️ Set up

Requirements: **Node.js 22.12+** (24 recommended), **Git**, and Python 3 for the optional real-terminal smoke test. [Bun](https://bun.sh/) is needed only to build standalone binaries.

```sh
git clone https://github.com/YourAKShaw/conventional-commits-cli.git
cd conventional-commits-cli
npm ci
npm run build
node dist/cli.js --help
```

To try your build in another repository, run `node /path/to/conventional-commits-cli/dist/cli.js commit` there, or `npm link` and use `ccli`.

### Useful scripts

| Command | What it does |
| :--- | :--- |
| `npm run check` | Lint, typecheck, unit + integration tests, build, end-to-end tests (CI additionally checks schemas, dependency signatures, the packed tarball and the TTY smoke test) |
| `npm test` / `npm run test:watch` | Unit and integration tests (Vitest) |
| `npm run test:e2e` | Builds, then runs the CLI as a subprocess against mock provider servers |
| `python3 scripts/tty-smoke.py` | Drives the real prompts in a pseudo-terminal (macOS/Linux; build first) |
| `npm run lint` / `npm run lint:fix` | Biome lint and format check / auto-fix |
| `npm run typecheck` | TypeScript, strict |
| `npm run schema` | Regenerate `schema/*.json` after changing `src/config/schema.ts` |
| `npm run binaries -- --only=bun-linux-x64` | Build standalone executables into `release/` |

Tests never contact real providers and run with an isolated Git and `ccli` configuration (`test/setup.ts`), so they are safe to run on your machine.

## Make a focused change

1. Fork the repository and create a branch.
2. Make the smallest coherent change that solves the problem, with tests.
3. Run `npm run check` (and the TTY smoke test if you touched prompts or signal handling).
4. Update docs and `CHANGELOG.md` (under **Unreleased**) for user-visible changes.
5. Commit with Conventional Commits. Dogfooding is encouraged: `node dist/cli.js commit`.
6. Open a pull request using the template.

### Keep the project coherent

| Principle | What to preserve |
| :--- | :--- |
| **Approval before commit** | No code path may run `git commit` without an explicit user action (or the editor save in hook mode). Non-interactive runs print, never commit. |
| **Consent and least data** | Send providers only what the message needs, only after consent, only after the secret gate. A new payload field needs a reason and a docs update. |
| **Untrusted repositories** | `.ccli.json`, commitlint configs, diffs and branch names come from the repository. They may restrict, never redirect or execute. |
| **No invented provider facts** | Model names, effort levels, parameters and error codes must cite vendor documentation in `docs/providers.md`. Mark inferences as heuristics. |
| **Cross-platform** | Spawn processes without a shell, use `node:path`, test Windows paths and CRLF, keep the package free of required native modules. |
| **Small, fast CLI** | Keep heavy imports out of the entry chunk (commands load lazily). Prefer the standard library over new dependencies; every dependency is bundled and its license shipped. |
| **Honest output** | Error messages say what happened and what to do next. Never print keys or diff content in logs. |

### Commit messages

This project uses [Conventional Commits 1.0.0](https://www.conventionalcommits.org/en/v1.0.0/) with the `@commitlint/config-conventional` types (`feat`, `fix`, `docs`, `refactor`, `perf`, `test`, `build`, `ci`, `chore`, `revert`, `style`). Use a scope when one area is affected (`feat(providers): …`, `fix(guard): …`). Mark breaking changes with `!` and a `BREAKING CHANGE:` footer explaining the migration.

## 🔍 Verify your change

| Change | Minimum evidence |
| :--- | :--- |
| Docs only | Links resolve; commands shown were run or are clearly marked as examples |
| Message rendering, parsing, validation | Unit tests for the new cases |
| Git behaviour | Integration test with a real temporary repository |
| Provider adapter or classifier | Unit tests for request shape, parsing and each error class; e2e mock if the flow changes; vendor doc links |
| Secret gate | Tests for detection **and** a near-miss false positive; fake secrets built at runtime |
| Prompts, keyboard flow, Ctrl-C | `scripts/tty-smoke.py` passes |
| Packaging, build, release workflow | `npm pack` and install the tarball into a temporary prefix; describe what you could not run (for example other operating systems) |

Report what you actually ran. "Not run" with a reason is always better than an unverified claim.

## 📬 Open a reviewable pull request

Use the [pull request template](pull_request_template.md) to explain:

- **Problem and outcome:** what was wrong or missing, and what the change does.
- **Verification:** exact commands and results, and anything not run.
- **Risk:** effects on privacy, the approval flow, configuration compatibility, or platforms.

Keep the diff focused and the discussion respectful. Address the change rather than the contributor, and use concrete examples when you disagree.

By contributing, you agree that your contributions are licensed under the project's [MIT License](../LICENSE).
