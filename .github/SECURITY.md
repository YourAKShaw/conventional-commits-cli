# Security policy

`conventional-commits-cli` handles source code diffs and API keys, so security reports are taken seriously. Thank you for helping keep users safe.

## Supported versions

| Version | Supported |
| :--- | :---: |
| Latest `0.x` release | ✓ |
| Older releases | ✗ — please upgrade |

## Reporting a vulnerability

**Please do not open a public issue, discussion or pull request for a vulnerability.**

Report it privately through GitHub: open the repository's **Security** tab and choose **Report a vulnerability** ([direct link](https://github.com/YourAKShaw/conventional-commits-cli/security/advisories/new)).

Please include:

- The affected version (`ccli --version`) and platform (`ccli doctor --json` output, sanitized).
- What an attacker controls (for example a cloned repository, a file name, a provider response) and what they gain.
- Minimal steps to reproduce, using **fake** secrets only.
- Any suggested fix or mitigation.

What to expect (targets, not guarantees, for a project maintained in spare time):

- Acknowledgement within 5 business days.
- An initial assessment and severity within 14 days.
- A fix or mitigation plan agreed with you, followed by a release and a GitHub Security Advisory crediting you unless you prefer otherwise.

Please give us reasonable time to release a fix before disclosing publicly.

## In scope

Issues that break the guarantees in [docs/privacy-and-security.md](../docs/privacy-and-security.md), for example:

- Content of a denied file, or content the secret gate flagged, being sent to a provider without the documented consent step.
- A repository (`.ccli.json`, commitlint config, file names, diff content, branch names) causing data to be sent to an endpoint the user did not configure, changing provider settings, or executing code without `commitlint.loadJsConfig`.
- A commit being created without user approval.
- API keys appearing in output, logs, payloads, commit messages or files with weak permissions.
- Argument or command injection through file names, editor settings or passthrough arguments.
- Supply-chain issues in the published package or release artifacts.

## Out of scope

- Secrets the detector does not recognize in unusual formats: detection is documented as best-effort. Reports of missed patterns are still welcome as regular issues with **fake** examples.
- Data handling by AI providers once a request is sent with consent; refer to each provider's policies.
- Misleading commit messages from a model (prompt injection) that the user can see and reject before committing, unless they bypass review or validation.
- Vulnerabilities in a user's own Git hooks, editor, or environment.

## Handling a leaked key

If you believe a key was exposed (for example committed or sent by mistake), revoke and rotate it in the provider's console first, then remove it from `ccli` with `ccli auth remove <provider>`.
