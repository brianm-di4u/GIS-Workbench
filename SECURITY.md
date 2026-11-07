# Security

Please report a vulnerability through GitHub's **Report a vulnerability** button on the Security tab, not in a public issue. We'll answer there.

In scope: the app files, the optional sidecar, the release files with their checksums, and the site that serves them. The sidecar should only ever listen on loopback, so anything that makes it reachable from another machine is a vulnerability.

Fixes go in the latest release. GIS Workbench has no update channel, so a fix reaches users when they download a new version.

The design-level picture is in [docs/THREAT-MODEL.md](docs/THREAT-MODEL.md).
