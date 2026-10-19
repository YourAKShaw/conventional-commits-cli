# Architecture decision records

Consequential decisions, the alternatives considered, and when to revisit them. Each record follows the [Principal Engineer OS ADR template](https://github.com/YourAKShaw/principal-engineer-os/blob/main/assets/adr-template.md). Supersede a decision with a new ADR rather than rewriting history.

| ADR | Decision | Status |
| :--- | :--- | :--- |
| [0001](0001-typescript-bundled-for-node.md) | TypeScript bundled into one npm package for Node.js 22.12+, plus Bun binaries | Accepted |
| [0002](0002-fetch-adapters-instead-of-sdks.md) | Provider adapters on `fetch` instead of vendor SDKs | Accepted |
| [0003](0003-gitmoji-after-the-colon.md) | Gitmoji after the colon by default | Accepted |
| [0004](0004-restrict-only-repository-config.md) | Repository configuration can only restrict, never redirect | Accepted |
| [0005](0005-secret-gate-and-consent.md) | Layered secret gate on the exact payload, with consent before first send | Accepted |
