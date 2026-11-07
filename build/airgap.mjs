// What the air-gapped file leaves out (REQ-GAP-08, OD-2.17). On its own because build.mjs runs a build
// when imported, and tests/unit/cors-relay.test.js needs this without one.

/** Blocks the air-gapped file does not hold: the CORS relay never reaches it. */
export const AIRGAP_OMIT = ['js-corsrelay'];

/** `html` without those blocks, and with them listed as `omitted` in its manifest. */
export function airgapStrip(html) {
  const out = AIRGAP_OMIT.reduce((s, name) => s.replace(new RegExp(`<script type="application/octet-stream" id="blk-${name}"[^>]*>[^<]*</script>\\n?`), ''), html).replace(/(<script type="application\/json" id="build-manifest">)([^<]*)(<\/script>)/, (_, a, json, z) => {
    const m = JSON.parse(json);
    for (const n of AIRGAP_OMIT) delete m.blocks[n];
    m.omitted = [...(m.omitted ?? []), ...AIRGAP_OMIT];
    return a + JSON.stringify(m).replace(/</g, '\\u003c') + z;
  });
  for (const n of AIRGAP_OMIT) if (out.includes(`blk-${n}`)) throw new Error(`airgap: block ${n} is still in the file`);
  return out;
}
