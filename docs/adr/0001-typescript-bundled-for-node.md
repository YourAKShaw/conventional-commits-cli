# ADR-0001: TypeScript bundled into one npm package for Node.js 22.12+, plus Bun binaries

Status: accepted
Date: 2026-10-19
Owner / decision authority: maintainer (@YourAKShaw)
Scope / related issue: language, runtime, packaging and distribution of `ccli`

## Context and constraints

The tool must be installable with `npm`/`npx` and work on Windows, macOS and Linux. The richest ecosystem for this problem (commitlint, secretlint, gitmoji data, prompt libraries) is JavaScript. A CLI that runs on every commit must start quickly and must not break when a transitive dependency publishes a bad release.

| Driver | Known / estimated / unknown | Constraint or evidence |
|---|---|---|
| Correctness/security invariants | Known | No shell for child processes; no required native modules; minimal install-time supply chain |
| Workload and service levels | Estimated | Interactive use; startup should feel instant. Plan falsifier: 300 ms cold start |
| Team, budget and deadline | Known | One maintainer; low operational overhead |
| Compatibility and recovery | Known | `commander` 15 and commitlint 21 require Node.js ≥ 22.12, so that is the floor (`engines`) |

Non-goals: supporting Node.js versions below 22.12; a GUI or editor extension.

## Options and trade-offs

| Option | Correctness/security | Complexity/operations | Cost/time | Compatibility/reversibility |
|---|---|---|---|---|
| TypeScript, dependencies installed at runtime | Large install-time dependency tree; each install resolves fresh versions | Simple build | Low | Easy |
| **TypeScript bundled with esbuild, dependencies as devDependencies** | Versions fixed at build time; one optional native module | Build script and license notices to maintain | Low | Easy to unbundle later |
| Go or Rust single binary | Strong portability; no Node needed | Reimplement commitlint and secretlint or shell out; npm distribution needs per-platform packages | High | Hard to reverse |
| Bun-compiled binaries only | No Node needed | No `npx` story; large files; unsigned binaries warn on macOS/Windows | Medium | Medium |

## Decision and rationale

Write the CLI in strict TypeScript and bundle it with esbuild into `dist/cli.js` plus code-split chunks. All JavaScript dependencies are bundled (listed as `devDependencies`), so `npm install` fetches the package and, optionally, the prebuilt `@napi-rs/keyring` binary for the user's platform. Command modules load lazily so `--help` and `--version` avoid zod, commitlint and secretlint. Standalone executables are built with `bun build --compile` as a secondary channel for machines without Node.

## Consequences and risk ownership

Benefits: one artifact for all platforms; reproducible dependency versions; startup measured at 80–100 ms for `--version` on Linux x64 (indicative, development machine).
Costs / limitations: dependency updates require a release; bundled licenses must be shipped (generated `dist/THIRD_PARTY_NOTICES.md`); Bun binaries do not embed the keychain module and are not code-signed.
Residual risks / owners: a bundled dependency vulnerability ships until the next release (maintainer; Dependabot + `npm audit signatures` in CI).

## Transition and recovery

Unbundling is a `package.json` change (move packages to `dependencies`, drop them from the bundle). Binaries can be dropped from the release workflow without affecting npm users.

## Validation and acceptance

| Claim / acceptance criterion | Method or exact command | Evidence / state | Limitation / owner |
|---|---|---|---|
| Package installs and runs from a tarball | `npm pack` → `npm install -g --prefix <tmp>` → `ccli --version`, `doctor`, `commit --print` | Executed on Linux x64; CI `package` job runs it on Ubuntu, macOS, Windows | Windows/macOS evidence comes from CI runs |
| Startup within budget | `node dist/cli.js --version` timed 5× | 80–100 ms on Linux x64 | Other machines vary |
| Binaries run on each target | Release `verify-binaries` job | linux-x64 executed locally; others cross-compiled and checked with `file`; native runs happen in CI | Not code-signed |

## Revisit when

A required dependency drops Node 22, startup exceeds 300 ms, or users ask for signed native installers (Homebrew, winget) that a different toolchain would serve better.
