# Threat model

Keep this at the design level. On a public repo, anyone can read it. Exploitable detail goes in a draft security advisory or in `docs/private/`, which is gitignored.

## What we're protecting

- The user's imagery and derived products. They stay on the user's device.
- The user's trust that the file makes no request unless they allow it.
- The integrity of releases and of the site that serves them.
- Credentials the agents use to build the project.

## Data classification

| Data | Sensitivity | Where it lives | Retention |
|---|---|---|---|
| Opened imagery and products | High, the user's own | Browser memory and files the user saves | Session only |
| Recovery journal, whiteboard sessions | Medium | Browser storage; can be turned off; journal can be encrypted | Until cleared |
| API keys and tokens typed by the user | High | Memory only | Session only |
| Sidecar pairing tokens | High | The sidecar and the paired origin; revocable | Until revoked |
| Release files and their hashes | Public | GitHub Releases, the site | Permanent |
| Agent token | High | The admin's machine, outside the repo | Until rotated |

There is no telemetry. The project collects no user data.

## Who might attack, and how

- **A hostile file.** A crafted image, point cloud, or archive aimed at the parsers.
- **A hostile page or local process.** It tries to reach the sidecar or abuse an allowed origin.
- **A malicious dependency.** A crate, npm package, or build tool that changes the build.
- **Prompt injection against the agents.** Issue text, web pages, or file contents that try to give the agents orders.
- **Tampering with a release.** A replaced file, or a site serving a different build than the release.

## Trust boundaries

- **File parsing.** All input files are untrusted. Parsers are memory-safe Rust with bounds and size limits, fuzzed, and run in workers.
- **The page.** A strict CSP with hashed scripts. WASM loads only from inlined, hash-checked bytes. The build fails on `eval`, `new Function`, or string timers outside a short allow-list.
- **The network.** Off by default. The user adds origins to an allow-list, and a request log shows what was sent.
- **The sidecar.** Optional. It listens on loopback only. Each origin pairs with a code and gets a revocable token. It checks Host and Origin, runs tools from fixed profiles with no shell, confines paths, caps resources, and makes no outbound connection.
- **Supply chain.** Licences and advisories are checked on every change and nightly (`cargo deny`, npm audit, cargo audit). Secrets are scanned (gitleaks). Release hashes are published.
- **The agents.** Text from outside is data, not instructions. See `.pipeline/AUTONOMY.md` and `docs/POLICY.md`. The agent token is restricted and cannot change protection or workflows.

## Mitigations and accepted risks

| Risk | Mitigation or decision | Decision record |
|---|---|---|
| Hostile file | Memory-safe parsers, limits, workers, fuzzing | none |
| Script injection | CSP, hashes, no-eval gate | none |
| Unwanted network use | Off by default, origin allow-list, request log | [0002](decisions/0002-no-hosted-or-installed.md) |
| Local abuse of the sidecar | Loopback, pairing, Host and Origin checks | none |
| Malicious dependency | Audits, licence checks, locked dependencies | none |
| Prompt injection | Restricted token, admin gate, review | none |
| Tampered release | Published hashes, no replaced files | [0005](decisions/0005-dist-not-tracked.md) |
| The sidecar is a larger surface than the file | Accepted. It is optional and gets its own review | none |
