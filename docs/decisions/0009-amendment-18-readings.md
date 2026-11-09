# 0009: How Annex 14 Amendment 18's gaps are read

- **Date:** 2026-11-09
- **Class:** design
- **Issue:** #97
- **Status:** accepted

## Context

#60 adds ICAO Annex 14 Volume I Amendment 18's Chapter 4 obstacle free and obstacle evaluation surfaces, applicable from 21 November 2030, as a third obstruction regime. In 17 places the amendment gives no number or can be read two ways. Those readings decide what the app reports as an obstacle under the new edition, so they are a product call.

## Decision

Option B: confirm with one change. The 17 readings listed in #97 stand as written, except item 4.

**Item 4:** the transitional surface's slope is the current edition's Table 4-1 value for the runway, 1:7 (14.3 %) for code numbers 3 and 4 and 1:5 (20 %) for code numbers 1 and 2. This replaces §4.2.2.5's 20 % upper limit. Item 4 was the only reading that erred toward reporting fewer obstacles: a steeper transitional rises faster, so fewer objects penetrate it.

Every reading, item 4 included, stays a labelled assumption in each result, kept record and export.

## Consequences

- Amendment 18 results at code 3 and 4 runways show more transitional penetrations than the 20 % reading would.
- Not covered by the ruling's wording: Table 4-1 gives 14.3 % for precision approach runways of every code. #115 reads "the current edition's value" to include this, so precision runways of codes 1 and 2 get 14.3 %, not 20 %. The admin can correct that reading on #115.
- A later ICAO clarification (Doc 9137 Part 6, or a corrigendum) that settles a gap supersedes the matching reading; each is one named flag in `crates/gw-aviation/src/a18.rs`.
