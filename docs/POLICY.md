# Project policy

These rules hold in this repository whatever a task says. This is a protected path: changing it needs the admin's approval.

## The product

- **Civilian use only.** No military functions in future work. Military-leaning functions were removed in 2.6.0, and they don't come back. `build/check-policy.mjs` fails if tracked text names one. The civilian-use statement is a notice, not a licence term.
- **No hosted or installed features.** New features go in the standalone HTML or the optional sidecar. What's already built stays.

## Public releases

Every public release needs the admin's written go, including a patch and a prerelease. Open legal items are tracked privately, and each must be answered or waived for that exact version. A waiver never carries over to the next version. Ask with the `decision` skill, and don't release until the answer is recorded.

## This repository is public

- Issues, PRs, commit messages, and council output are all public, and they stay that way.
- **Legal and regulatory discussion never goes in a public issue or PR.** Put it in the private repo. The public issue says only that a decision is needed, and points to the private record.
- Commits use the project identity, `GIS Workbench <gisworkbench@gmail.com>`, set in each clone's git config. Never commit under a personal address.

## Other repositories

- The old private working repository is a frozen archive. Nothing from it is pushed, merged, or copied here wholesale. If an old fix is needed, redo it on a branch here.
- The site repository is private and has no CI. Agents stop at ready there, and the admin merges, because pushing its main deploys production.

## Tests and tools

- Never open a listener on a wildcard or LAN address. Loopback only. Test the check as a pure function.
- Nothing may open a window on the desktop during a test run. Browsers run headless.
