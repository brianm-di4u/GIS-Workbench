# 0019: An imported catalogue names the column of a property its types define differently

- **Date:** 2026-11-13
- **Class:** design
- **Issue:** #243
- **Status:** accepted

## Context

gw-catalog/1, the catalogue format kept in projects and the browser's catalogue store, has one attribute table for the whole catalogue: each type lists attribute names, and every type that names one shares its definition. ISO 19110 and INSPIRE define properties per type, and two types often give a property of the same name a different definition, cardinality or value list (`status` required on Road, optional on Bridge). The import (#241) gave the second definition a type-qualified key (`status_Bridge`), which became the layer's column, so layers were saved and exported with column names the source schema does not have. How field names are stored in user layers is a data model other converters will copy.

## Decision

Option C: an attribute may carry an optional `field`, the column its layers write.

- Each type's definition stays its own attribute (`status`, `status_Bridge`), so validation, the form and requirements stay exact per type.
- The qualified attribute names its column, `field: 'status'`, and a layer of that type writes `status`.
- A type may not write the same column twice.
- A build from before `field` ignores it and writes the qualified name, as it did.

## Consequences

- Layers of imported catalogues carry the source schema's column names; nothing per type is merged away.
- gw-catalog/1 gains one optional attribute key. Older builds still load such a catalogue, with the qualified column names.
- A later converter that meets per-type definitions uses `field` in the same way. Merging definitions on import (option A) and per-type overrides on a type (option B) are not used.
