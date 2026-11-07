# 0002: No hosted or installed features

- **Date:** 2026-11-07
- **Class:** major
- **Issue:** none, recorded at adoption
- **Status:** accepted

## Context

The product can run from a file, from a hosted copy, and with an optional native sidecar. More hosted services or installers would widen the attack surface and break the zero-install promise.

## Decision

The admin chose that no hosted or installed features will be added. New features go only in the standalone HTML file or the optional sidecar. What is already built stays, including the hosted copy of the app.

## Consequences

- New work must run from the file, or from the sidecar's portable form.
- Ideas that need a hosted service are out of scope, and agents raise a decision if one comes up.
- The sidecar's existing optional installer is not a new installed feature.
