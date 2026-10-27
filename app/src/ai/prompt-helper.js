// Offline Prompt Helper (REQ-AI-13): build a copy-paste prompt with the current context and a
// strict JSON reply schema (graphics, observations, chain), validate a pasted reply, and
// turn it into Proposals. No network: the analyst carries text to any approved AI system.

export const REPLY_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    graphics: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['shape', 'coordinates'],
        properties: {
          shape: { enum: ['point', 'marker', 'text', 'callout', 'line', 'arrow', 'polyline', 'polygon'] },
          coordinates: { type: 'array', items: { type: 'array', items: { type: 'number' }, minItems: 2, maxItems: 2 } },
          text: { type: 'string' },
        },
      },
    },
    observations: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['text'], properties: { text: { type: 'string' }, confidence: { enum: ['low', 'moderate', 'high'] } } } },
    notes: { type: 'string' },
  },
};

export function buildPrompt(app, task, context) {
  return [
    'You are helping an imagery analyst who uses GIS Workbench. Reply with ONE JSON object only, no prose, matching this JSON Schema exactly:',
    JSON.stringify(REPLY_SCHEMA),
    'Rules: coordinates are [longitude, latitude] in WGS 84 degrees. Do not invent measurements, distances or accuracy figures; the analyst measures in the tool. Keep any portion marks you see unchanged.',
    '',
    `Task: ${task}`,
    '',
    'Context from the tool (computed by its engine):',
    JSON.stringify(context, null, 1),
  ].join('\n');
}

/** Validate a pasted reply; returns {ok, value, errors}. */
export function parseReply(text) {
  const errors = [];
  let s = String(text).trim();
  const fence = /```(?:json)?\s*([\s\S]*?)```/.exec(s);
  if (fence) s = fence[1].trim();
  let v;
  try {
    v = JSON.parse(s, (k, val) => (k === '__proto__' ? undefined : val));
  } catch (e) {
    return { ok: false, errors: [`not valid JSON: ${e.message}`] };
  }
  if (!v || typeof v !== 'object' || Array.isArray(v)) return { ok: false, errors: ['the reply must be a JSON object'] };
  for (const k of Object.keys(v)) if (!REPLY_SCHEMA.properties[k]) errors.push(`unexpected field "${k}"`);
  const shapes = REPLY_SCHEMA.properties.graphics.items.properties.shape.enum;
  (v.graphics ?? []).forEach((g, i) => {
    if (!shapes.includes(g?.shape)) errors.push(`graphics[${i}].shape must be one of ${shapes.join(', ')}`);
    if (!Array.isArray(g?.coordinates) || !g.coordinates.length) errors.push(`graphics[${i}].coordinates must be a non-empty array`);
    else
      g.coordinates.forEach((c, j) => {
        if (!Array.isArray(c) || c.length !== 2 || !c.every(Number.isFinite)) errors.push(`graphics[${i}].coordinates[${j}] must be [lon, lat]`);
        else if (Math.abs(c[0]) > 180 || Math.abs(c[1]) > 90) errors.push(`graphics[${i}].coordinates[${j}] is out of range`);
      });
    for (const k of Object.keys(g ?? {})) if (!['shape', 'coordinates', 'text'].includes(k)) errors.push(`graphics[${i}] has unexpected field "${k}"`);
  });
  (v.observations ?? []).forEach((o, i) => {
    if (typeof o?.text !== 'string' || !o.text.trim()) errors.push(`observations[${i}].text is required`);
    if (o?.confidence !== undefined && !['low', 'moderate', 'high'].includes(o.confidence)) errors.push(`observations[${i}].confidence must be low, moderate or high`);
  });
  return { ok: !errors.length, value: v, errors };
}

/** Turn a validated reply into Proposals through the registry (same rules as the assistant). */
export async function proposeReply(app, reg, value) {
  const ctx = { source: 'prompt-helper', connection: 'manual (Prompt Helper)', model: 'unknown (pasted reply)' };
  const out = [];
  for (const g of value.graphics ?? []) out.push(await reg.call('gw_create_graphic', { shape: g.shape, coordinates: g.coordinates, ...(g.text ? { text: g.text } : {}) }, ctx));
  for (const o of value.observations ?? []) out.push(await reg.call('gw_add_observation', { text: o.text, ...(o.confidence ? { confidence: o.confidence } : {}) }, ctx));
  return out;
}
