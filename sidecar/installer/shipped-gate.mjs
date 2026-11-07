// The package gate of the CORS relay (REQ-GAP-08, OD-2.17): a binary that holds the relay or a TLS
// stack does not ship. The relay needs the `cors-relay` Cargo feature, which no release command sets;
// this is the lock on that sentence. `gwb-sidecar/tests/shipped.rs` checks that a relay build does hold
// the marker, so this cannot pass by looking for something that is never there.

import { readFileSync } from 'node:fs';
import { basename } from 'node:path';

/** Bytes that are in a relay build and in no shipped one. */
export const RELAY_MARKERS = ['GWB-CORS-RELAY-COMPILED-IN', 'rustls', 'X-Gwb-Relay'];

/** The problems of a set of binaries, for the packaging gate's list. */
export function relayGate(paths) {
  const out = [];
  for (const p of paths) {
    const b = readFileSync(p);
    for (const m of RELAY_MARKERS) if (b.includes(m)) out.push(`${basename(p)} holds "${m}": the CORS relay is off until the sidecar is signed and reviewed (OD-2.17)`);
  }
  return out;
}
