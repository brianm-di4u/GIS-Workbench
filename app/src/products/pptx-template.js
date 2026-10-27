// PowerPoint templates (REQ-PRD-09): read a .pptx/.potx and keep what product slides need — slide
// size, theme colours and fonts, the master background (colour or picture) and the master's
// pictures (logos) with their positions. PPTX export then defines a slide master from it.

import { unzipSync, strFromU8 } from 'fflate';

const EMU_IN = 914400;
const local = (el) => el.localName;
const kids = (el, name) => [...(el?.children ?? [])].filter((c) => local(c) === name);
const kid = (el, name) => kids(el, name)[0] ?? null;
const desc = (el, name) => (el ? [...el.getElementsByTagName('*')].filter((c) => local(c) === name) : []);

function xmlOf(files, path) {
  const b = files[path];
  return b ? new DOMParser().parseFromString(strFromU8(b), 'application/xml') : null;
}

function relsOf(files, partPath) {
  const dir = partPath.slice(0, partPath.lastIndexOf('/'));
  const base = partPath.slice(partPath.lastIndexOf('/') + 1);
  const r = xmlOf(files, `${dir}/_rels/${base}.rels`);
  const out = {};
  for (const x of desc(r?.documentElement, 'Relationship')) {
    let t = x.getAttribute('Target');
    if (!t.startsWith('/')) {
      const parts = `${dir}/${t}`.split('/');
      const st = [];
      for (const p of parts) p === '..' ? st.pop() : p !== '.' && st.push(p);
      t = st.join('/');
    } else t = t.slice(1);
    out[x.getAttribute('Id')] = t;
  }
  return out;
}

const mime = (p) => (/\.png$/i.test(p) ? 'image/png' : /\.jpe?g$/i.test(p) ? 'image/jpeg' : /\.gif$/i.test(p) ? 'image/gif' : /\.svg$/i.test(p) ? 'image/svg+xml' : 'application/octet-stream');
function dataUrl(bytes, type) {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return `data:${type};base64,${btoa(s)}`;
}

/** A colour element (a:srgbClr / a:sysClr / a:schemeClr) → 'RRGGBB'. */
function colourOf(el, scheme = {}) {
  if (!el) return null;
  const c = kid(el, 'srgbClr') ?? (local(el) === 'srgbClr' ? el : null);
  if (c) return c.getAttribute('val').toUpperCase();
  const sys = kid(el, 'sysClr') ?? (local(el) === 'sysClr' ? el : null);
  if (sys) return (sys.getAttribute('lastClr') ?? '000000').toUpperCase();
  const sc = kid(el, 'schemeClr') ?? (local(el) === 'schemeClr' ? el : null);
  if (sc) {
    const v = sc.getAttribute('val');
    return scheme[{ bg1: 'lt1', tx1: 'dk1', bg2: 'lt2', tx2: 'dk2' }[v] ?? v] ?? null;
  }
  return null;
}

/** .pptx bytes → template {name, size {w, h} in, colours, fonts, background, pictures, title}. */
export function readPptxTemplate(bytes, name = 'template') {
  const files = unzipSync(bytes);
  if (!files['ppt/presentation.xml']) throw new Error(`${name}: not a PowerPoint file (no ppt/presentation.xml)`);
  const pres = xmlOf(files, 'ppt/presentation.xml');
  const sz = desc(pres.documentElement, 'sldSz')[0];
  const size = sz ? { w: Number(sz.getAttribute('cx')) / EMU_IN, h: Number(sz.getAttribute('cy')) / EMU_IN } : { w: 13.333, h: 7.5 };
  const presRels = relsOf(files, 'ppt/presentation.xml');
  const masterId = desc(pres.documentElement, 'sldMasterId')[0]?.getAttribute('r:id') ?? desc(pres.documentElement, 'sldMasterId')[0]?.getAttributeNS('http://schemas.openxmlformats.org/officeDocument/2006/relationships', 'id');
  const masterPath = presRels[masterId] ?? 'ppt/slideMasters/slideMaster1.xml';
  const masterRels = relsOf(files, masterPath);
  const themePath = Object.values(masterRels).find((t) => /theme\/theme\d+\.xml$/.test(t)) ?? 'ppt/theme/theme1.xml';
  const theme = xmlOf(files, themePath);
  const colours = {};
  const cs = desc(theme?.documentElement, 'clrScheme')[0];
  for (const c of [...(cs?.children ?? [])]) colours[local(c)] = colourOf(c);
  const font = (k) => desc(theme?.documentElement, k)[0] && kid(desc(theme.documentElement, k)[0], 'latin')?.getAttribute('typeface');
  const fonts = { title: font('majorFont') ?? 'Arial', body: font('minorFont') ?? 'Arial' };
  const master = xmlOf(files, masterPath);
  let cSld = kid(master?.documentElement, 'cSld');
  let partRels = masterRels;
  // Templates put the background and logos on the master, or (as some tools write them) on a
  // slide layout: fall back to the layout with the most pictures or a background.
  const hasArt = (c) => !!kid(c, 'bg') || desc(kid(c, 'spTree'), 'pic').length > 0;
  if (!hasArt(cSld)) {
    let best = null;
    for (const t of Object.values(masterRels).filter((x) => /slideLayouts\/slideLayout\d+\.xml$/.test(x))) {
      const lc = kid(xmlOf(files, t)?.documentElement, 'cSld');
      const score = (kid(lc, 'bg') ? 1 : 0) + desc(kid(lc, 'spTree'), 'pic').length;
      if (score > (best?.score ?? 0)) best = { score, cSld: lc, rels: relsOf(files, t) };
    }
    if (best) [cSld, partRels] = [best.cSld, best.rels];
  }
  const masterArtRels = partRels;
  let background = null;
  const bgPr = desc(kid(cSld, 'bg'), 'bgPr')[0];
  if (bgPr) {
    const blip = desc(bgPr, 'blip')[0];
    const solid = kid(bgPr, 'solidFill');
    if (blip) {
      const t = masterArtRels[blip.getAttribute('r:embed') ?? blip.getAttributeNS('http://schemas.openxmlformats.org/officeDocument/2006/relationships', 'embed')];
      if (t && files[t]) background = { data: dataUrl(files[t], mime(t)) };
    } else if (solid) background = { color: colourOf(solid, colours) };
  }
  const bgRef = desc(kid(cSld, 'bg'), 'bgRef')[0];
  if (!background && bgRef) background = { color: colourOf(bgRef, colours) ?? colours.lt1 ?? 'FFFFFF' };
  const pictures = [];
  for (const pic of desc(kid(cSld, 'spTree'), 'pic')) {
    const blip = desc(pic, 'blip')[0];
    const rid = blip?.getAttribute('r:embed') ?? blip?.getAttributeNS('http://schemas.openxmlformats.org/officeDocument/2006/relationships', 'embed');
    const t = masterArtRels[rid];
    const off = desc(pic, 'off')[0];
    const ext = desc(pic, 'ext').find((e) => e.getAttribute('cx'));
    if (t && files[t] && off && ext) pictures.push({ data: dataUrl(files[t], mime(t)), x: Number(off.getAttribute('x')) / EMU_IN, y: Number(off.getAttribute('y')) / EMU_IN, w: Number(ext.getAttribute('cx')) / EMU_IN, h: Number(ext.getAttribute('cy')) / EMU_IN });
  }
  // The title placeholder's box and text colour, when the master defines them.
  let title = null;
  for (const sp of desc(kid(cSld, 'spTree'), 'sp')) {
    const ph = desc(sp, 'ph')[0];
    if (ph && /title|ctrTitle/.test(ph.getAttribute('type') ?? '')) {
      const off = desc(sp, 'off')[0];
      const ext = desc(sp, 'ext').find((e) => e.getAttribute('cx'));
      if (off && ext) title = { x: Number(off.getAttribute('x')) / EMU_IN, y: Number(off.getAttribute('y')) / EMU_IN, w: Number(ext.getAttribute('cx')) / EMU_IN, h: Number(ext.getAttribute('cy')) / EMU_IN };
    }
  }
  const titleStyle = desc(master?.documentElement, 'titleStyle')[0];
  const tcol = colourOf(desc(titleStyle, 'solidFill')[0], colours);
  return { name, size, colours, fonts, background, pictures, title, titleColour: tcol ?? colours.dk1 ?? '202020' };
}
