# Getting help

Start with the [README](../README.md) for installation and usage, then the docs for [configuration](../docs/configuration.md), [providers](../docs/providers.md) and [privacy and security](../docs/privacy-and-security.md). See [CONTRIBUTING.md](CONTRIBUTING.md) for making changes.

Before opening an issue, run:

```sh
ccli doctor
```

It checks Node.js, Git, your configuration, commitlint, the OS keychain, provider keys, models and effort settings, and the optional hook, and usually points at the fix. `ccli auth test` makes one tiny request per provider to confirm keys, models and effort values. `--verbose` prints diagnostics to stderr without keys or diff content.

Search [existing issues](https://github.com/YourAKShaw/conventional-commits-cli/issues) first. Use the bug, feature or documentation form when one fits. For a usage question, open a blank issue with what you ran, what you expected, what happened, and the output of `ccli doctor --json`.

Share only sanitized examples. Do not post API keys, private diffs or commit contents you cannot share publicly. Report vulnerabilities privately as described in the [security policy](SECURITY.md).

Provider-side problems (billing, quota, model availability, account access) need to go to that provider; `ccli` reports the provider's status code and error code, and `--verbose` adds the provider's request ID, which support teams usually ask for.
