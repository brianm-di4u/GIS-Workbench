### Fixed
- **Find Address** reads the short form "Rua Principal, 12", and a 4-digit house number after the street's comma. When the street has no such number, the number is read as a postcode, so the answer is the street rather than the nearest house to a number that was never one, as in "Hauptstraße, 1010, Wien".
