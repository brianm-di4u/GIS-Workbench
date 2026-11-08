# 0007: Plans carry no time estimates

- **Date:** 2026-11-07
- **Class:** determination
- **Issue:** #24
- **Status:** accepted

## Context

Plans carried effort sizes (S, M, L, XL), person-weeks, durations and timeboxes. Work has consistently run far faster than those estimates, so they misstated what limits a plan. The admin ruled the same way for the companion repo's plans.

## Decision

Option A. Plans carry no time estimates. A plan, milestone or task is limited only by its scope, its dependencies and its gates, and work runs at full speed.

## Consequences

- `docs/DEV-PLAN.md`, issues and PRs carry no effort sizes, person-weeks, durations, timeboxes or target dates.
- Spikes end when their question is answered, not at a time limit.
- Work is ordered by value, dependencies and gates.
- A release ships when its scope is done and its gates are open.
