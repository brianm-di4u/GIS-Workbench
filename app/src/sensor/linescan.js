// Rigorous pushbroom support data from a NITF (REQ-GAP-19): CSEXRA and USE00A from the image
// subheader, CSEPHA and CSSFAA from the image subheader or its TRE_OVERFLOW DES, and the
// CSATTA DES (user-defined subheader text + big-endian quaternions). The core parses and checks
// the fields (crates/gw-sensor/src/linescan.rs); this module only finds and reads the bytes.

const latin1 = new TextDecoder('latin1');

/** Split a TRE area (tag 6, CEL 5, data) into {tag, offset, length} with offsets into `base`. */
export function splitTres(text, base = 0) {
  const out = [];
  let o = 0;
  while (o + 11 <= text.length) {
    const tag = text.slice(o, o + 6).trim();
    const n = Number(text.slice(o + 6, o + 11));
    if (!/^[A-Z0-9_]+$/.test(tag) || !Number.isInteger(n) || n < 0 || o + 11 + n > text.length) break;
    out.push({ tag, offset: base + o + 11, length: n });
    o += 11 + n;
  }
  return out;
}

const readText = async (file, t) => latin1.decode(await file.slice(t.offset, t.offset + t.length).arrayBuffer());

/**
 * TREs a NITF image segment carries in a TRE_OVERFLOW DES (DESOFLW UDID/IXSHD, DESITEM = the
 * image segment's number, 1-based), as {tag, offset, length} in the file.
 */
export async function overflowTres(file, others, imageNumber) {
  const out = [];
  for (const o of others ?? []) {
    if (o.kind !== 'des' || o.DESID !== 'TRE_OVERFLOW' || !o.seg || !/^(UDID|IXSHD)$/.test(String(o.DESOFLW ?? '').trim())) continue;
    if (Number(o.DESITEM) !== imageNumber || o.seg.dataLength > 8 << 20) continue;
    const text = latin1.decode(await file.slice(o.seg.dataOffset, o.seg.dataOffset + o.seg.dataLength).arrayBuffer());
    out.push(...splitTres(text, o.seg.dataOffset));
  }
  return out;
}

/**
 * The support data of one image for core.lineScannerModel, or null when a part is missing
 * (the image then has no rigorous pushbroom; the reason is returned as `missing`).
 */
export async function lineScanSupport(file, ish, others, extra = []) {
  const all = [...(ish?.tres ?? []), ...extra];
  const find = (tag) => all.find((t) => t.tag === tag);
  const need = { csepha: find('CSEPHA'), cssfaa: find('CSSFAA'), csexra: find('CSEXRA') };
  if (!need.csepha) return null; // not a support-data NITF at all
  const att = (others ?? []).filter((o) => o.kind === 'des' && String(o.DESID ?? '').trim() === 'CSATTA DES' && o.seg);
  const missing = [...Object.entries(need).filter(([, v]) => !v).map(([k]) => k.toUpperCase()), ...(att.length ? [] : ['CSATTA'])];
  if (missing.length) return { missing };
  const a = att[0];
  if (a.seg.dataLength > 4 << 20) return { missing: ['CSATTA (over 4 MiB)'] };
  const use = find('USE00A');
  return {
    date: String(ish.IDATIM ?? '').replace(/\D/g, '').slice(0, 8),
    csepha: await readText(file, need.csepha),
    cssfaa: await readText(file, need.cssfaa),
    csexra: await readText(file, need.csexra),
    use00a: use ? await readText(file, use) : null,
    attHeader: String(a.DESSHF ?? ''),
    attData: new Uint8Array(await file.slice(a.seg.dataOffset, a.seg.dataOffset + a.seg.dataLength).arrayBuffer()),
  };
}
