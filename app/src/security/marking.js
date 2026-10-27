// Classification banners and portion marks (REQ-SEC-04/05, D13). A display aid built from
// NITF FS*/IS* (and later ST 0102) fields; never an accredited marking system. Raw field
// values are shown as they are, not "fixed". The default vocabulary is UNCLASSIFIED only.

export const LEVELS = ['U', 'R', 'C', 'S', 'T'];
export const LEVEL_NAME = { U: 'UNCLASSIFIED', R: 'RESTRICTED', C: 'CONFIDENTIAL', S: 'SECRET', T: 'TOP SECRET' };
export const NOT_ACCREDITED = 'Banners and portion marks are display aids taken from the file. GIS Workbench is not an accredited marking system.';

export function rank(level) {
  const i = LEVELS.indexOf(String(level ?? '').trim().toUpperCase());
  return i < 0 ? -1 : i;
}

/** Marking object from a NITF security group ({class, FSCODE, FSCTLH, FSREL, …}). */
export function fromNitf(sec, prefix) {
  if (!sec) return null;
  const lvl = String(sec.class ?? '').trim().toUpperCase();
  const g = (k) => String(sec[`${prefix}${k}`] ?? '').trim();
  return { level: rank(lvl) >= 0 ? lvl : null, raw: lvl, codewords: g('CODE'), control: g('CTLH'), release: g('REL'), text: g('CLTX'), system: g('CLSY'), source: prefix === 'FS' ? 'file header' : prefix === 'IS' ? 'image subheader' : prefix };
}

/** Banner text: level, then non-blank codeword, handling and release fields, joined by //. */
export function bannerText(m) {
  if (!m || !m.level) return m?.raw ? `UNKNOWN MARKING "${m.raw}"` : '';
  const parts = [LEVEL_NAME[m.level]];
  for (const f of [m.codewords, m.control, m.release ? `REL TO ${m.release}` : '']) if (f) parts.push(f);
  return parts.join('//');
}

/** Portion mark, e.g. "(U)" or "(C//REL TO USA)". */
export function portionMark(m) {
  if (!m?.level) return '(U)';
  const extra = [m.codewords, m.control].filter(Boolean).join('//');
  return `(${m.level}${extra ? `//${extra}` : ''})`;
}

/** Highest of several markings (null entries ignored); default UNCLASSIFIED. */
export function highest(markings, fallback = { level: 'U', raw: 'U', codewords: '', control: '', release: '', source: 'project default' }) {
  let best = null;
  for (const m of markings) {
    if (!m?.level) continue;
    if (!best || rank(m.level) > rank(best.level)) best = { ...m };
    else if (rank(m.level) === rank(best.level)) {
      // Same level: union the caveats (display only).
      const join = (a, b) => [...new Set([a, b].filter(Boolean).join('/').split('/').filter(Boolean))].join('/');
      best.codewords = join(best.codewords, m.codewords);
      best.control = join(best.control, m.control);
    }
  }
  return best ?? fallback;
}

/** "U - Unclassified" style suffix used in window titles. */
export function titleSuffix(m) {
  if (!m?.level) return 'U - Unclassified';
  const n = LEVEL_NAME[m.level];
  return `${m.level} - ${n.charAt(0)}${n.slice(1).toLowerCase()}`;
}

export function bannerColorVar(m) {
  return `--c-banner-${m?.level ?? 'U'}`;
}

/** Inconsistencies the import log should show (segment above file level, unknown values). */
export function checkConsistency(file, segments) {
  const warn = [];
  if (file && file.raw && !file.level) warn.push(`file classification "${file.raw}" is not a known level`);
  for (const s of segments) {
    if (s?.raw && !s.level) warn.push(`segment classification "${s.raw}" is not a known level`);
    if (file?.level && s?.level && rank(s.level) > rank(file.level)) warn.push(`a segment (${s.level}) is marked higher than the file (${file.level})`);
  }
  return warn;
}
