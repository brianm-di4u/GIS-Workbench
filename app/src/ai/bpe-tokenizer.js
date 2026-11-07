// GPT-2 style byte-level BPE (REQ-LAI-04): the CodeGen / Phi tokenizer of Moondream2, from the
// pack's vocab.json and merges.txt. Text → UTF-8 bytes → the byte-to-unicode alphabet → the
// GPT-2 pre-tokenizer regex → BPE merges by rank; added tokens (the whitespace runs in
// added_tokens.json, and special tokens such as <|endoftext|> and <image>) are split out first,
// longest first. Decoding maps the alphabet back to bytes. No network, no eval.

/** GPT-2's reversible byte → printable unicode character map. */
function bytesToUnicode() {
  const bs = [];
  for (let i = 33; i <= 126; i++) bs.push(i);
  for (let i = 161; i <= 172; i++) bs.push(i);
  for (let i = 174; i <= 255; i++) bs.push(i);
  const cs = bs.slice();
  let n = 0;
  for (let b = 0; b < 256; b++) {
    if (!bs.includes(b)) {
      bs.push(b);
      cs.push(256 + n);
      n++;
    }
  }
  const enc = new Array(256);
  const dec = new Map();
  bs.forEach((b, i) => {
    enc[b] = String.fromCharCode(cs[i]);
    dec.set(String.fromCharCode(cs[i]), b);
  });
  return { enc, dec };
}

const PRE = /'s|'t|'re|'ve|'m|'ll|'d| ?\p{L}+| ?\p{N}+| ?[^\s\p{L}\p{N}]+|\s+(?!\S)|\s+/gu;

export class BpeTokenizer {
  /**
   * vocab: {token: id}; merges: text of merges.txt; added: {content: id} (special and added
   * tokens, matched before BPE).
   */
  constructor(vocab, merges, added = {}) {
    this.vocab = new Map(Object.entries(vocab));
    this.inv = new Map([...this.vocab].map(([k, v]) => [v, k]));
    this.ranks = new Map();
    const lines = merges.split(/\r?\n/);
    let r = 0;
    for (const line of lines) {
      if (!line || line.startsWith('#version')) continue;
      const sp = line.split(' ');
      if (sp.length !== 2) continue;
      this.ranks.set(`${sp[0]} ${sp[1]}`, r++);
    }
    this.added = new Map(Object.entries(added));
    for (const [k, v] of this.added) this.inv.set(v, k);
    this.addedList = [...this.added.keys()].sort((a, b) => b.length - a.length);
    const { enc, dec } = bytesToUnicode();
    this.enc = enc;
    this.dec = dec;
    this.cache = new Map();
  }

  bpe(word) {
    if (this.cache.has(word)) return this.cache.get(word);
    let parts = [...word];
    for (;;) {
      let best = -1;
      let bestRank = Infinity;
      for (let i = 0; i < parts.length - 1; i++) {
        const rk = this.ranks.get(`${parts[i]} ${parts[i + 1]}`);
        if (rk !== undefined && rk < bestRank) {
          bestRank = rk;
          best = i;
        }
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
    if (this.cache.size > 20000) this.cache.clear();
    this.cache.set(word, parts);
    return parts;
  }

  /** Split text into [string | {id}] around added tokens (longest match first). */
  splitAdded(text) {
    const out = [];
    let buf = '';
    let i = 0;
    while (i < text.length) {
      let hit = null;
      for (const a of this.addedList) {
        if (text.startsWith(a, i)) {
          hit = a;
          break;
        }
      }
      if (hit) {
        if (buf) out.push(buf);
        buf = '';
        out.push({ id: this.added.get(hit) });
        i += hit.length;
      } else {
        buf += text[i];
        i++;
      }
    }
    if (buf) out.push(buf);
    return out;
  }

  /** Text → token ids (no BOS; the caller adds it). */
  encode(text) {
    const ids = [];
    const te = new TextEncoder();
    for (const piece of this.splitAdded(String(text))) {
      if (typeof piece === 'object') {
        ids.push(piece.id);
        continue;
      }
      for (const m of piece.matchAll(PRE)) {
        const word = [...te.encode(m[0])].map((b) => this.enc[b]).join('');
        for (const tok of this.bpe(word)) {
          const id = this.vocab.get(tok);
          if (id === undefined) throw new Error(`token ${JSON.stringify(tok)} is not in the vocabulary`);
          ids.push(id);
        }
      }
    }
    return ids;
  }

  /** Token ids → text (special tokens dropped when skipSpecial). */
  decode(ids, { skipSpecial = true, special = new Set() } = {}) {
    const bytes = [];
    let out = '';
    const flush = () => {
      out += new TextDecoder().decode(new Uint8Array(bytes));
      bytes.length = 0;
    };
    for (const id of ids) {
      const tok = this.inv.get(id);
      if (tok === undefined) continue;
      if (special.has(id)) {
        if (!skipSpecial) {
          flush();
          out += tok;
        }
        continue;
      }
      if (this.added.has(tok) && !this.vocab.has(tok)) {
        flush();
        out += tok;
        continue;
      }
      for (const ch of tok) {
        const b = this.dec.get(ch);
        if (b !== undefined) bytes.push(b);
      }
    }
    flush();
    return out;
  }
}
