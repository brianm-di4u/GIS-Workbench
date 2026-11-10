# Changelog fragments

A PR whose change a user would notice adds one file here, named for the change, like `fix-terrain-labels.md`. Write it the way `CHANGELOG.md` is written: sections from Added, Changed, Deprecated, Removed, Fixed, Security and Known limits, each holding `- ` items in words a user would understand.

```markdown
### Fixed
- **Terrain labels** now name the geoid that really converts the heights. They could name the wrong one.
```

A PR with nothing a user would notice, such as tests, tooling or docs, adds no fragment.

`verify` checks every fragment's format. The release PR runs `node build/release/changelog.mjs assemble --version <v> --summary "<one paragraph>"`, which writes the fragments into `CHANGELOG.md` as the new release and deletes them.
