// Copilot routing (REQ-LAI-09; 2.0 plan P5): plain-language requests that a local tool can do are
// recognised here and run on this device first, with or without a cloud connection. A request
// nothing matches goes to the connected assistant, or, offline, gets the list of what works.
//
//   "detect aircraft and vehicles in view"  → find (OWLv2): ['aircraft', 'vehicles']
//   "where is an unpaved runway"            → search (CLIP): 'unpaved runway'
//   "auto contrast" / "enhance the image"   → contrast
//   "align to the reference" / "co-register" → align (DISK + LightGlue)
//   "segment" / "smart select" / "outline"  → segment (SAM; the analyst clicks the object)
//   "go to 38SMB4484" / a coordinate        → goto

const SPLIT = /\s*(?:,|;|\band\b|\bor\b|\/|&)\s*/i;
const TAIL = /\s+(?:in|on|within|across|over|inside)\s+(?:the\s+)?(?:view|aoi|area|image|scene|screen|panel|frame|picture)\b.*$/i;
const ARTICLES = /^(?:all|any|every|the|a|an|some)\s+/i;

const clean = (s) => s.replace(TAIL, '').replace(/[.?!]+$/, '').trim();

/** text → {intent, …} or null. */
export function parseIntent(text) {
  const t = String(text ?? '').trim();
  if (!t) return null;
  let m = /^(?:please\s+)?(?:detect|find|locate|count|spot|identify|show)\s+(?:me\s+)?(?:all\s+|any\s+|the\s+|every\s+)?(.+)$/i.exec(t);
  if (m && !/^(?:where|places?\s+(?:like|with|that))/i.test(m[1])) {
    const objects = clean(m[1])
      .split(SPLIT)
      .map((s) => s.replace(ARTICLES, '').trim())
      .filter(Boolean);
    if (objects.length) return { intent: 'find', objects: objects.slice(0, 8), count: /^(?:please\s+)?count\b/i.test(t) };
  }
  m = /^(?:search(?:\s+(?:the\s+)?(?:imagery|image|scene))?\s+for|where\s+(?:is|are)|look\s+for|show\s+(?:me\s+)?places?\s+(?:like|with|that\s+(?:look|looks)\s+like))\s+(.+)$/i.exec(t);
  if (m) return { intent: 'search', text: clean(m[1]).replace(ARTICLES, '') };
  if (/^(?:auto[\s-]?contrast|enhance|improve|brighten|fix)\b(?:\s+(?:the\s+)?(?:image|contrast|view|display))?\s*[.!]?$/i.test(t)) return { intent: 'contrast' };
  if (/^(?:auto[\s-]?)?(?:align|co-?register|register)\b/i.test(t)) return { intent: 'align' };
  if (/^(?:segment|smart\s*select|outline|trace|select\s+(?:the\s+)?(?:object|building))\b/i.test(t)) return { intent: 'segment', square: /\b(?:square|building|regulari[sz]e|orthogonal)\b/i.test(t) };
  m = /^(?:go\s*to|fly\s*to|jump\s*to|zoom\s*to|pan\s*to)\s+(.+)$/i.exec(t);
  if (m) return { intent: 'goto', text: m[1].trim() };
  return null;
}

/** What the offline copilot can do (shown when nothing matched and no assistant is connected). */
export const LOCAL_HELP = 'On this device I can: “detect aircraft, vehicles in view” · “search for an unpaved runway” · “auto contrast” · “align to the reference” · “segment the building” · “go to 38SMB4484”. Connect an assistant (Add-Ins ▸ AI Setup) for other questions.';
