# 0003: The public repo is the trunk

- **Date:** 2026-11-07
- **Class:** major
- **Issue:** none, recorded at adoption
- **Status:** accepted

## Context

Development ran in a private working repo. The project is adopting a development pipeline that works on a public repo.

## Decision

The admin chose to move development to this public repo. It is the trunk. The old private working repo is a frozen archive. Nothing from it is pushed, merged, or copied here wholesale. A needed old fix is redone on a branch here.

## Consequences

- Issues, PRs, commits, and review output are public.
- Anything private goes in the companion repo ([0004](0004-private-docs-repo.md)).
- Old history stays in the archive and is not carried over.
