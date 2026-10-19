## What changed and why?

<!-- Describe the problem and the resulting behaviour. Link related issues; use "Closes #123" only when this PR resolves the issue. -->

## Verification

<!-- List commands actually run and their results (for example `npm run check`, `python3 scripts/tty-smoke.py`, a manual run on Windows). Explain what was not run and why. -->

## Risks or compatibility

<!-- Effects on privacy (what is sent to providers), the approval flow, configuration files, supported platforms or Node.js versions. Write "None identified" when appropriate. -->

## Checklist

- [ ] The change is focused, and the PR title follows Conventional Commits (for example `fix(guard): detect …`).
- [ ] I ran `npm run check` and recorded the result above.
- [ ] Tests cover the new behaviour, including the failure path where it matters.
- [ ] User-visible changes are documented (README or `docs/`) and listed under **Unreleased** in `CHANGELOG.md`.
- [ ] Provider facts (models, parameters, error codes) cite vendor documentation in `docs/providers.md`.
- [ ] No real secrets, private code or personal data appear in code, tests, fixtures or this description; verification claims reflect checks actually performed.
