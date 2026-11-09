# 0009: How Annex 14 Amendment 18's gaps are read

- **Date:** 2026-11-09
- **Class:** design
- **Issue:** #97
- **Status:** accepted

## Context

#60 adds ICAO Annex 14 Volume I Amendment 18's Chapter 4 obstacle free and obstacle evaluation surfaces, applicable from 21 November 2030, as a third obstruction regime. In 17 places the amendment gives no number or can be read two ways. Those readings decide what the app reports as an obstacle under the new edition, so they are a product call.

## Decision

Option B: the 17 readings stand, with item 4 changed. Each reading is named by its flag. Items 1 to 15 are flags in `crates/gw-aviation/src/a18.rs`, and items 16 and 17 are in `app/src/analysis/obstruction.js`.

1. `A_STRIP`: the transitional surface's lower edge is at the Chapter 3 strip half-width, and the strip itself is not an obstacle free surface.
2. `A_INNER_EDGE`: the inner transitional's lower edge is at half the inner approach width.
3. `A_INNER_START`: on non-instrument and non-precision runways, the inner transitional runs along the whole inner approach, and its vertical section is measured from its lower edge.
4. `A_TRANS_SLOPE`, **changed**. The transitional slope is the current edition's value for the runway's code number: 1:7 (14.3 %) for codes 3 and 4, and 1:5 (20 %) for codes 1 and 2. This replaces §4.2.2.5's 20 % upper limit. It was the only reading that erred toward reporting fewer obstacles: a steeper transitional rises faster, so fewer objects penetrate it.
5. `A_OES_CHOICE`: the evaluation surfaces follow the runway type, not the operations.
6. `A_STRAIGHT_IN`: Table 4-11 has a shorter side of 7,410 m in total, longer sides reaching 5,350 m beyond the thresholds, and an upper section at 60 m.
7. `A_ONE_ADG`: one aeroplane design group per runway, without the lower horizontal surfaces of smaller groups.
8. `A_MASS_5700`: exactly 5,700 kg uses Table 4-14.
9. `A_LIGHT_LARGE`: 5,700 kg or less on an ADG IIC to V runway uses Table 4-15.
10. `A_TODA`: Table 4-15 starts at the end of the take-off distance available.
11. `A_TAKEOFF_ELEV`: the take-off climb starts at the runway end's elevation, and the departure surface starts 5 m above it.
12. `A_DEP_SLOPE`: Table 4-13's single 2.5 % slope applies to both sections.
13. `A_WIDTH`: when the runway width is unknown, Tables 4-1 and 4-2 are used as printed.
14. `A_CODE_F`: the code letter F notes apply to ADG V.
15. `A_AS_PRINTED`: slopes and lengths are used as printed, with no reductions.
16. `A18_ADG_SPEED`: at 307 km/h and above, the speed counts in the IIC band, and the group is the higher of that and the wingspan's.
17. `A18_FROM`: the default edition switches on 21 November 2030, reading the "October" in one footnote as a typo.

## Consequences

- Items 1 to 16 are labelled assumptions in each result, kept record and export that uses them. Item 17 only sets the dialog's default edition, and a run's edition is always named.
- Amendment 18 results at code 3 and 4 runways show more transitional penetrations than the 20 % reading would.
- Not covered by this ruling: precision approach runways of codes 1 and 2, which the current edition's Table 4-1 gives 14.3 %. The code uses 14.3 % for them until #125 is decided, and that decision amends or supersedes item 4.
- A later ICAO clarification (Doc 9137 Part 6, or a corrigendum) that settles a gap supersedes the matching reading.
