// CLIP byte-level BPE tokenizer (REQ-LAI-03, REQ-LAI-06): the tokenizer of OWLv2 and CLIP text
// queries, from the vocab.json and merges.txt in the AI packs. Follows the reference
// CLIPTokenizer: lower case, collapse whitespace, split on the CLIP pattern, map bytes to
// printable characters, merge pairs by rank with "</w>" marking the end of a word, then wrap in
// <|startoftext|> … <|endoftext|>.

const PAT = /<\|startoftext\|>|<\|endoftext\|>|'s|'t|'re|'ve|'m|'ll|'d|[\p{L}]+|[\p{N}]|[^\s\p{L}\p{N}]+/giu;

/** GPT-2 byte → printable character table. */
function byteTable() {
  const bs = [];
  for (let b = 33; b <= 126; b++) bs.push(b);
  for (let b = 161; b <= 172; b++) bs.push(b);
  for (let b = 174; b <= 255; b++) bs.push(b);
  const cs = bs.slice();
  let n = 0;
  for (let b = 0; b < 256; b++) {
    if (!bs.includes(b)) {
      bs.push(b);
      cs.push(256 + n++);
    }
  }
  const t = new Array(256);
  bs.forEach((b, i) => (t[b] = String.fromCharCode(cs[i])));
  return t;
}

export class ClipTokenizer {
  /** vocab: {token: id}; merges: the text of merges.txt. */
  constructor(vocab, merges) {
    this.vocab = vocab;
    this.ranks = new Map();
    merges
      .split(/\r?\n/)
      .filter((l) => l && !l.startsWith('#version'))
      .forEach((l, i) => this.ranks.set(l, i));
    this.bytes = byteTable();
    this.cache = new Map();
    this.bos = vocab['<|startoftext|>'] ?? 49406;
    this.eos = vocab['<|endoftext|>'] ?? 49407;
  }

  bpe(word) {
    const hit = this.cache.get(word);
    if (hit) return hit;
    let parts = [...word];
    parts[parts.length - 1] += '</w>';
    while (parts.length > 1) {
      let best = -1;
      let rank = Infinity;
      for (let i = 0; i < parts.length - 1; i++) {
        const r = this.ranks.get(`${parts[i]} ${parts[i + 1]}`);
        if (r !== undefined && r < rank) [rank, best] = [r, i];
      }
      if (best < 0) break;
      const a = parts[best];
      const b = parts[best + 1];
      const next = [];
      for (let i = 0; i < parts.length; i++) {
        if (i < parts.length - 1 && parts[i] === a && parts[i + 1] === b) {
          next.push(a + b);
          i++;
        } else next.push(parts[i]);
      }
      parts = next;
    }
    this.cache.set(word, parts);
    return parts;
  }

  /** Token ids of one text, with start and end tokens. */
  encode(text) {
    const clean = String(text ?? '').normalize('NFC').replace(/\s+/g, ' ').trim().toLowerCase();
    const ids = [this.bos];
    const enc = new TextEncoder();
    for (const m of clean.matchAll(PAT)) {
      const w = [...enc.encode(m[0])].map((b) => this.bytes[b]).join('');
      for (const t of this.bpe(w)) {
        const id = this.vocab[t];
        if (id !== undefined) ids.push(id);
      }
    }
    ids.push(this.eos);
    return ids;
  }

  /** A batch padded (or cut) to `length`: {ids: BigInt64Array, mask: BigInt64Array, n, length}. */
  batch(texts, length, pad = 0) {
    const n = texts.length;
    const ids = new BigInt64Array(n * length).fill(BigInt(pad));
    const mask = new BigInt64Array(n * length);
    texts.forEach((t, i) => {
      let e = this.encode(t);
      if (e.length > length) e = [...e.slice(0, length - 1), this.eos];
      e.forEach((v, j) => {
        ids[i * length + j] = BigInt(v);
        mask[i * length + j] = 1n;
      });
    });
    return { ids, mask, n, length };
  }
}
