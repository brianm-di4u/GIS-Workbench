# 0025: Find Address ranks both readings of a number after the street's comma

- **Date:** 2026-11-15
- **Class:** design
- **Issue:** #305
- **Status:** accepted

## Context

A number in its own segment after the street's comma can be a house number or a postcode: "Avenida Paulista, 1578, São Paulo" is house 1578, and "Laugavegur, 101, Reykjavík" is postcode 101. Under #290's rule, only 1 to 3 digits there are read as a house number. So a 4-digit house number gives only the street, and a 3-digit postcode gives a house. #298 tried a fallback that picked one reading. Over five council rounds, each version of it moved the wrong answer somewhere else, so it was taken out (#301).

## Decision

The admin chose option A (`/decide A` on #305). `search` runs both readings and merges their candidates. A house hit in the place named ranks first: an address point, or a number interpolated in a range. The postcode reading's street, with everything after the street as the place, ranks next. A nearest-house guess ranks below both. The user sees both readings, so neither is silently lost.

## Consequences

- Queries of this form can list one more result: the street, beside the house.
- Tests cover a postcode-named index, a multi-word place, an unknown place, a range and a point.
- Option B, keeping #290's rule, and option C, postcode shapes by country, were not taken.
- To go back, revert the implementing commit. Nothing is stored, so no data changes.
