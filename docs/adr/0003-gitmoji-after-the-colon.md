# ADR-0003: Gitmoji after the colon by default

Status: accepted
Date: 2026-10-19
Owner / decision authority: maintainer (@YourAKShaw)
Scope / related issue: `src/message/render.ts`, `format.gitmoji`

## Context and constraints

Many users like gitmoji, but Conventional Commits 1.0.0 requires the header to start with the type. A leading emoji (`✨ feat: …`) breaks the spec's first rule, commitlint's default parser, and changelog generators. Gitmoji tools disagree on placement.

| Driver | Known / estimated / unknown | Constraint or evidence |
|---|---|---|
| Correctness/security invariants | Known | Every message `ccli` writes must parse as a Conventional Commit by default |
| Compatibility and recovery | Known | Teams already using `prefix` style need an option; teams without emoji need an off switch |

## Options and trade-offs

| Option | Correctness | Complexity | Compatibility/reversibility |
|---|---|---|---|
| No gitmoji | Always valid | None | Disappoints gitmoji users |
| Prefix by default | Breaks spec rule 1 and default tooling | Low | Hard to undo in history |
| **After the colon by default, prefix optional** | Valid (`feat(api): ✨ add login`) | Parser strips a leading gitmoji from the description | Per-user and per-repository setting |

## Decision and rationale

Render the gitmoji at the start of the description, after `type(scope)!: `. Offer `position: "prefix"` and `style: "code"` options and an off switch, settable globally or by the repository's `.ccli.json`. The validator and commitlint bridge strip a leading gitmoji before checking, so both positions validate inside `ccli`.

## Consequences and risk ownership

Benefits: valid by default; visible type cue for people who like emoji.
Costs / limitations: some readers find emoji noisy; `prefix` output remains incompatible with external commitlint hooks and changelog tools (documented).

## Validation and acceptance

| Claim / acceptance criterion | Method | Evidence / state |
|---|---|---|
| After-colon headers pass commitlint conventional rules | `test/unit/commitlint.test.ts`, `test/unit/render.test.ts`, TTY smoke manual commit | PASS (executed) |

## Revisit when

The Conventional Commits specification or commitlint's default parser adopts a standard emoji position.
