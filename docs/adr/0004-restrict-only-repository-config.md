# ADR-0004: Repository configuration can only restrict, never redirect

Status: accepted
Date: 2026-10-19
Owner / decision authority: maintainer (@YourAKShaw)
Scope / related issue: `src/config/schema.ts` (`repoConfigSchema`, `REPO_FORBIDDEN_KEYS`), `src/message/commitlint.ts`

## Context and constraints

Teams want to share conventions (scopes, types, gitmoji, extra deny globs) in the repository. But a cloned repository is untrusted input: a config that can set a provider `baseUrl`, model, order or secret handling could exfiltrate every diff a developer makes, or run up their bill. Executable commitlint configs (`commitlint.config.ts`) run arbitrary code when loaded.

| Driver | Known / estimated / unknown | Constraint or evidence |
|---|---|---|
| Correctness/security invariants | Known | Only the user decides where their diffs go, what is sent, and whether repository code runs |
| Compatibility and recovery | Known | Teams still need to enforce restrictions (for example "only our approved provider") |

## Options and trade-offs

| Option | Security | Usefulness |
|---|---|---|
| No repository config | Safe | No shared conventions |
| Full repository config with a trust prompt | Prompt fatigue; one "yes" grants everything | High |
| **Restrict-only repository config** | Cannot redirect data or run code | Formatting, deny globs, lower token cap, disable smart mode, provider allow-list |

## Decision and rationale

`.ccli.json` accepts formatting, additional deny globs and patterns, a lower `smart.maxInputTokens`, `smart.enabled: false`, and `providers.allow`. Setting provider order or settings, acknowledgements, `secrets.onDetect` or `commitlint` is rejected with an explanatory error (not silently ignored, so the team notices). Declarative commitlint configs are parsed as data; JS/TS/YAML configs execute only with the user's global `commitlint.loadJsConfig: true`.

## Consequences and risk ownership

Benefits: cloning a repository cannot change where data goes.
Costs / limitations: a team cannot force a specific provider or model; with executable commitlint configs, `ccli`'s pre-check uses conventional defaults unless the user opts in (the repository's own hook still enforces its rules).

## Validation and acceptance

| Claim / acceptance criterion | Method | Evidence / state |
|---|---|---|
| Forbidden and unknown keys are rejected with a clear error | `test/unit/config.test.ts` ("rejects repository settings that could redirect data…") | PASS (executed) |
| Repository values can only tighten (lower token cap, added deny globs, smart mode off) | `test/unit/config.test.ts` ("lets the repository shape format and tighten egress…") | PASS (executed) |
| Allow-list is enforced; an empty intersection explains the fix | `test/integration/flows.test.ts` | PASS (executed) |
| Executable commitlint configs are not run by default | `test/unit/commitlint.test.ts` | PASS (executed) |

## Revisit when

Users need repository-pinned providers for compliance; consider a signed or user-approved policy file rather than loosening this rule.
