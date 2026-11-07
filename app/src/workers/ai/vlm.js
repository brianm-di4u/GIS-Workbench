// Moondream2 generation (REQ-LAI-04): the SigLIP vision encoder, the token embedding and the Phi
// decoder with its key/value cache, as three ONNX sessions (Xenova/moondream2 export). The prompt
// is "<image>\n\nQuestion: …\n\nAnswer:" after a BOS token; the 729 image features replace the
// <image> token; decoding is greedy until <|endoftext|> or the token limit. Shared by the AI
// worker and the Node checks (tests/tools), so `ort` is passed in.

export const VLM = { size: 378, bos: 50256, eos: 50256, image: -200, layers: 24, heads: 32, headDim: 64, hidden: 2048, vocab: 51200 };

/** The prompt text Moondream2 was trained on. */
export const vlmPrompt = (question) => `<image>\n\nQuestion: ${question}\n\nAnswer:`;

const dtypeOf = (session, name, fallback = 'float32') => {
  const m = session.inputMetadata?.find?.((x) => x.name === name);
  return m?.type ?? fallback;
};
const emptyOf = (type) => (type === 'float16' ? new Uint16Array(0) : new Float32Array(0));

/** f32 → f16 bits (round to nearest even). */
export function f32ToF16(v) {
  const f = new Float32Array(1);
  const u = new Uint32Array(f.buffer);
  f[0] = v;
  const x = u[0];
  const sign = (x >>> 16) & 0x8000;
  let e = ((x >>> 23) & 0xff) - 112;
  let m = x & 0x7fffff;
  if (e <= 0) {
    if (e < -10) return sign;
    m = (m | 0x800000) >> (1 - e);
    return sign | ((m + 0x1000) >> 13);
  }
  if (e >= 31) return sign | 0x7c00;
  const r = sign | (e << 10) | (m >> 13);
  return (m & 0x1000) && ((m & 0x2fff) || (r & 1)) ? r + 1 : r;
}

const toType = (ort, type, f32, dims) => (type === 'float16' ? new ort.Tensor('float16', Uint16Array.from(f32, f32ToF16), dims) : new ort.Tensor('float32', f32, dims));

/**
 * Generate an answer. sessions: {vision, embed, decoder}; pixels: CHW float32 (3 × 378 × 378,
 * normalised); ids: prompt token ids with VLM.image where the image goes (BOS included).
 * opts: {maxTokens, onToken(id, n), gpuKv (keep the cache on the GPU), cancelled()}.
 * Returns {ids, ms: {vision, prefill, decode}, tokens}.
 */
export async function vlmGenerate(ort, sessions, pixels, ids, { maxTokens = 96, onToken, gpuKv = false, cancelled } = {}) {
  const { vision, embed, decoder } = sessions;
  const t0 = performance.now();
  const vi = await vision.run(pixels ? { pixel_values: new ort.Tensor('float32', pixels, [1, 3, VLM.size, VLM.size]) } : {});
  const feats = vi.image_features ?? vi[vision.outputNames[0]];
  const nImg = feats.dims[1];
  const featData = await feats.getData?.() ?? feats.data;
  const t1 = performance.now();

  const at = ids.indexOf(VLM.image);
  const textIds = ids.filter((x) => x !== VLM.image);
  const emb = async (list) => {
    const r = await embed.run({ input_ids: new ort.Tensor('int64', BigInt64Array.from(list, BigInt), [1, list.length]) });
    const e = r.inputs_embeds ?? r[embed.outputNames[0]];
    return Float32Array.from((await e.getData?.()) ?? e.data, Number);
  };
  const te = await emb(textIds);
  const H = VLM.hidden;
  const before = at < 0 ? textIds.length : at;
  const L = textIds.length + (at < 0 ? 0 : nImg);
  const all = new Float32Array(L * H);
  all.set(te.subarray(0, before * H), 0);
  if (at >= 0) {
    all.set(Float32Array.from(featData, Number), before * H);
    all.set(te.subarray(before * H), (before + nImg) * H);
  }

  const embType = dtypeOf(decoder, 'inputs_embeds');
  const kvType = dtypeOf(decoder, 'past_key_values.0.key');
  let past = {};
  for (let i = 0; i < VLM.layers; i++) {
    past[`past_key_values.${i}.key`] = new ort.Tensor(kvType, emptyOf(kvType), [1, VLM.heads, 0, VLM.headDim]);
    past[`past_key_values.${i}.value`] = new ort.Tensor(kvType, emptyOf(kvType), [1, VLM.heads, 0, VLM.headDim]);
  }
  const argmaxLast = async (logits) => {
    const d = (await logits.getData?.()) ?? logits.data;
    const V = logits.dims[2];
    const off = (logits.dims[1] - 1) * V;
    let best = 0;
    let bv = -Infinity;
    const f16 = logits.type === 'float16';
    for (let k = 0; k < V; k++) {
      const v = f16 ? f16ToF32(d[off + k]) : d[off + k];
      if (v > bv) {
        bv = v;
        best = k;
      }
    }
    return best;
  };
  const step = async (embF32, n, pos0) => {
    const feeds = {
      inputs_embeds: toType(ort, embType, embF32, [1, n, H]),
      attention_mask: new ort.Tensor('int64', new BigInt64Array(pos0 + n).fill(1n), [1, pos0 + n]),
      position_ids: new ort.Tensor('int64', BigInt64Array.from({ length: n }, (_, k) => BigInt(pos0 + k)), [1, n]),
      ...past,
    };
    const out = await decoder.run(feeds);
    const next = {};
    for (let i = 0; i < VLM.layers; i++) {
      next[`past_key_values.${i}.key`] = out[`present.${i}.key`];
      next[`past_key_values.${i}.value`] = out[`present.${i}.value`];
    }
    if (gpuKv) for (const v of Object.values(past)) v.dispose?.();
    past = next;
    const tok = await argmaxLast(out.logits);
    out.logits.dispose?.();
    return tok;
  };

  const outIds = [];
  let tok = await step(all, L, 0);
  const t2 = performance.now();
  let pos = L;
  while (tok !== VLM.eos && outIds.length < maxTokens && !cancelled?.()) {
    outIds.push(tok);
    onToken?.(tok, outIds.length);
    const e = await emb([tok]);
    tok = await step(e, 1, pos);
    pos++;
  }
  if (gpuKv) for (const v of Object.values(past)) v.dispose?.();
  const t3 = performance.now();
  return { ids: outIds, tokens: outIds.length, prompt: L, ms: { vision: Math.round(t1 - t0), prefill: Math.round(t2 - t1), decode: Math.round(t3 - t2) } };
}

export function f16ToF32(h) {
  const s = h & 0x8000 ? -1 : 1;
  const e = (h >> 10) & 0x1f;
  const f = h & 0x3ff;
  if (e === 0) return s * 2 ** -14 * (f / 1024);
  if (e === 31) return f ? NaN : s * Infinity;
  return s * 2 ** (e - 15) * (1 + f / 1024);
}

/**
 * D30 for drafts: measurements are never the model's. Lengths, areas, heights, speeds and
 * coordinates written as numbers with units are removed from a draft and listed, so the analyst
 * measures them with the tools. Counts ("3 aircraft") stay, labelled as a draft.
 */
const UNIT = String.raw`(?:km|kilomet(?:er|re)s?|m|met(?:er|re)s?|cm|mm|ft|feet|foot|yd|yards?|mi|miles?|nmi|nautical miles?|m2|m²|sq(?:uare)? ?(?:m|met(?:er|re)s?|km|ft|feet)|km2|km²|hectares?|ha|acres?|knots?|kts?|km\/h|kph|mph|m\/s|°|degrees?)`;
const MEASURE = new RegExp(String.raw`(?:about |approximately |roughly |around |~\s?)?\b\d[\d,.]*(?:\s?(?:x|×|by)\s?\d[\d,.]*)?\s?(?:-|–)?\s?${UNIT}(?![\p{L}])(?:\s(?:long|wide|tall|high|across|in (?:length|width|diameter|height)|apart|away))?`, 'giu');
const COORD = /\b-?\d{1,3}\.\d{3,}\s*°?\s*[NSEW]?,?\s*-?\d{1,3}\.\d{3,}\s*°?\s*[NSEW]?\b|\b\d{1,2}[C-HJ-NP-X]\s?[A-HJ-NP-Z]{2}\s?\d{2,10}\b/g;

export function stripMeasurements(text) {
  const removed = [];
  let out = String(text).replace(COORD, (m) => {
    removed.push(m.trim());
    return '[position: read it with the tool]';
  });
  out = out.replace(MEASURE, (m) => {
    removed.push(m.trim());
    return '[measure with the tool]';
  });
  return { text: out.replace(/\s{2,}/g, ' ').trim(), removed };
}

/** A count from a short answer ("3", "three aircraft", "There are 12 cars.") or null. */
export function parseCount(text) {
  const WORDS = { zero: 0, no: 0, none: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19, twenty: 20 };
  const m = /\b(\d{1,4})\b/.exec(text);
  if (m) return Number(m[1]);
  const w = /\b(zero|no|none|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty)\b/i.exec(text);
  return w ? WORDS[w[1].toLowerCase()] : null;
}
