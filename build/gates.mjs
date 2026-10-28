// Build gates (SDP §6.3 step 4, §8.2; PT-04). Pure functions so tests can feed them
// deliberately bad inputs. Each returns a list of error strings (empty = pass).

export const LIMITS = {
  totalFail: 12 * 1024 * 1024,
  totalWarn: 9 * 1024 * 1024,
  totalTarget: 8 * 1024 * 1024,
  eagerFail: 6 * 1024 * 1024,
  eagerTarget: 4.5 * 1024 * 1024,
};

/** REQ-ARC-03: size gates. */
export function sizeGate({ total, eager }) {
  const errors = [];
  const warnings = [];
  if (total > LIMITS.totalFail) errors.push(`REQ-ARC-03: built file is ${total} B, over the 12 MB fail limit`);
  else if (total > LIMITS.totalWarn) warnings.push(`REQ-ARC-03: built file is ${total} B, over the 9 MB warning level`);
  if (eager > LIMITS.eagerFail) errors.push(`REQ-ARC-03: eager part is ${eager} B, over the 6 MB fail limit`);
  return { errors, warnings };
}

// Patterns that generate code from strings. String timers: setTimeout/setInterval whose
// first argument is a string literal or template.
const DYNAMIC = [
  { re: /\beval\s*\(/g, what: 'eval(' },
  { re: /\bnew\s+Function\s*\(/g, what: 'new Function(' },
  { re: /(?<![\w$.]|\bnew\s+)Function\s*\(\s*["'`]/g, what: 'Function("…")' },
  { re: /\bset(?:Timeout|Interval)\s*\(\s*["'`]/g, what: 'string timer' },
];

/**
 * REQ-ARC-04 / REQ-RUST-02: no dynamic code. `sources` = [{name, text}]; `allow` = list of
 * {name, what, count, reason} entries for audited, unreachable occurrences in third-party code.
 */
export function evalGate(sources, allow = []) {
  const errors = [];
  for (const { name, text } of sources) {
    for (const { re, what } of DYNAMIC) {
      re.lastIndex = 0;
      const hits = [...text.matchAll(re)];
      if (!hits.length) continue;
      const a = allow.find((x) => x.name === name && x.what === what);
      if (a && hits.length <= a.count) continue;
      const at = hits.slice(0, 3).map((m) => JSON.stringify(text.slice(Math.max(0, m.index - 40), m.index + 40))).join(' | ');
      errors.push(`REQ-ARC-04: ${name} contains ${hits.length}× ${what} ${a ? `(allow-list permits ${a.count})` : ''}: ${at}`);
    }
  }
  return errors;
}

const DENIED = /\b(A?GPL|LGPL|SSPL|CC-BY-NC|EUPL)\b/i;

/** REQ-SEC-08: no copyleft code in the bundle. `packages` = [{name, version, license}]. */
export function licenceGate(packages) {
  const errors = [];
  for (const p of packages) {
    const lic = String(p.license ?? 'UNKNOWN');
    if (lic === 'UNKNOWN') errors.push(`REQ-SEC-08: ${p.name}@${p.version} has no licence field`);
    else if (DENIED.test(lic) && !/\bOR\b/i.test(lic)) errors.push(`REQ-SEC-08: ${p.name}@${p.version} is ${lic}, which is not allowed in the bundle`);
    else if (DENIED.test(lic) && /\bOR\b/i.test(lic) && !/(MIT|Apache|BSD|ISC)/i.test(lic)) errors.push(`REQ-SEC-08: ${p.name}@${p.version} is ${lic}`);
  }
  return errors;
}

/**
 * REQ-LAI-08: every pack that carries a model declares SPDX licences for its code and weights,
 * all of them permissive, and its licence text names no non-commercial, research-only or GPL
 * terms. `models` = [{pack, spdx: [..], licence}].
 */
export const MODEL_LICENCES = new Set(['MIT', 'Apache-2.0', 'BSD-2-Clause', 'BSD-3-Clause', 'ISC']);
export function modelLicenceGate(models) {
  const errors = [];
  for (const m of models) {
    if (!m.spdx?.length) errors.push(`REQ-LAI-08: model pack ${m.pack} declares no licence`);
    for (const l of m.spdx ?? []) if (!MODEL_LICENCES.has(l)) errors.push(`REQ-LAI-08: model pack ${m.pack} is ${l}, which is not a permissive licence`);
    const bad = /\bnon-commercial\b|\bCC[- ]BY[- ]NC\b|\bA?GPL\b|\bresearch[- ]only\b|Research Licen[cs]e/i.exec(m.licence ?? '');
    if (bad) errors.push(`REQ-LAI-08: model pack ${m.pack} licence text mentions "${bad[0]}"`);
  }
  return errors;
}

/**
 * REQ-ARC-02: every block in the HTML is listed in the manifest with the same hash, and
 * every manifest entry has a block. `blocks` = [{name, sha256}] as written.
 */
export function manifestGate(manifest, blocks) {
  const errors = [];
  const seen = new Set();
  for (const b of blocks) {
    const m = manifest.blocks[b.name];
    if (!m) errors.push(`REQ-ARC-02: block "${b.name}" is not in the build manifest`);
    else if (m.sha256 !== b.sha256) errors.push(`REQ-ARC-02: block "${b.name}" hash differs from the manifest`);
    seen.add(b.name);
  }
  for (const name of Object.keys(manifest.blocks)) if (!seen.has(name)) errors.push(`REQ-ARC-02: manifest entry "${name}" has no block`);
  return errors;
}

/** REQ-SEC-01: the CSP must keep its strict shape. */
export function cspGate(csp) {
  const errors = [];
  if (!/default-src 'none'/.test(csp)) errors.push("REQ-SEC-01: CSP lacks default-src 'none'");
  if (/'unsafe-eval'/.test(csp)) errors.push("REQ-SEC-01: CSP contains 'unsafe-eval'");
  if (!/'wasm-unsafe-eval'/.test(csp)) errors.push("REQ-SEC-01: CSP lacks 'wasm-unsafe-eval'");
  if (!/worker-src blob:/.test(csp)) errors.push('REQ-SEC-01: CSP lacks worker-src blob:');
  if (/script-src[^;]*'unsafe-inline'/.test(csp)) errors.push("REQ-SEC-01: script-src contains 'unsafe-inline'");
  if (/connect-src[^;]*(\*|https?:(?:\s|;|$))/.test(csp)) errors.push('REQ-SEC-01: connect-src contains a wildcard');
  return errors;
}

export const WASM_ALLOWED_IMPORTS = new Set(['env.gw_log']);
export const WASM_TOTAL_BUDGET = 1.2 * 1024 * 1024;

/**
 * REQ-RUST-01/02/08: each bundle imports nothing outside the allow-list and keeps its gzip
 * budget (+10 %); all bundles together stay within 1.2 MB. `bundles` = [{name, imports, gzip, budget}].
 */
export function wasmGate(bundles) {
  const errors = [];
  let total = 0;
  for (const b of bundles) {
    const bad = b.imports.filter((i) => !WASM_ALLOWED_IMPORTS.has(i));
    if (bad.length) errors.push(`REQ-RUST-01/02: bundle ${b.name} imports ${bad.join(', ')}`);
    if (b.gzip > b.budget * 1.1) errors.push(`REQ-RUST-08: bundle ${b.name} is ${b.gzip} B gzip, budget ${b.budget} B (+10%)`);
    total += b.gzip;
  }
  if (total > WASM_TOTAL_BUDGET) errors.push(`REQ-RUST-08: all Rust WASM is ${total} B gzip, budget ${WASM_TOTAL_BUDGET} B`);
  return errors;
}

const CRATE_OK = /^(MIT|Apache-2\.0|Apache-2\.0 WITH LLVM-exception|BSD-2-Clause|BSD-3-Clause|ISC|Zlib|Unicode-3\.0|Unicode-DFS-2016|0BSD|CC0-1\.0)$/;

/**
 * REQ-RUST-09: every linked crate has a permissive licence (an SPDX expression where each
 * OR-alternative set contains an allowed licence, and every AND-part is allowed).
 */
export function crateLicenceGate(packages) {
  const errors = [];
  for (const p of packages) {
    const expr = String(p.license ?? '').replace(/[()]/g, ' ').trim();
    if (!expr || expr === 'unknown') {
      errors.push(`REQ-RUST-09: crate ${p.name}@${p.version} has no licence`);
      continue;
    }
    const ok = expr.split(/\s+OR\s+|\//).some((alt) => alt.split(/\s+AND\s+/).every((x) => CRATE_OK.test(x.trim())));
    if (!ok) errors.push(`REQ-RUST-09: crate ${p.name}@${p.version} is ${p.license}`);
  }
  return errors;
}

/**
 * REQ-RUST-11: reference paths stay deterministic across browsers. Every function body of a WASM
 * module is decoded instruction by instruction; relaxed-SIMD opcodes (0xFD 0x100…0x113, whose
 * results may differ between engines), atomics and anything the decoder does not know fail the
 * gate, as does a `target_features` section that names relaxed SIMD. Fixed-width SIMD128 and
 * scalar IEEE floats are deterministic and pass. Returns error strings.
 */
export function determinismGate(modules) {
  const errors = [];
  for (const { name, bytes } of modules) {
    try {
      const r = scanWasm(bytes);
      if (r.relaxed) errors.push(`REQ-RUST-11: ${name} uses ${r.relaxed} relaxed-SIMD instruction(s)`);
      if (r.atomics) errors.push(`REQ-RUST-11: ${name} uses ${r.atomics} atomic instruction(s)`);
      if (r.features.includes('relaxed-simd')) errors.push(`REQ-RUST-11: ${name} was built with the relaxed-simd target feature`);
    } catch (e) {
      errors.push(`REQ-RUST-11: ${name}: ${e.message}`);
    }
  }
  return errors;
}

/** Decode a module's code section: {functions, instructions, relaxed, atomics, simd, features}. */
export function scanWasm(bytes) {
  const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  if (b[0] !== 0 || b[1] !== 0x61 || b[2] !== 0x73 || b[3] !== 0x6d) throw new Error('not a WASM module');
  let p = 8;
  const u = () => {
    let r = 0;
    let s = 0;
    let c;
    do {
      c = b[p++];
      r += (c & 0x7f) * 2 ** s;
      s += 7;
    } while (c & 0x80);
    return r;
  };
  const skipLeb = () => {
    while (b[p++] & 0x80);
  };
  const memarg = () => {
    const align = u();
    if (align & 0x40) u(); // multi-memory index
    u();
  };
  const out = { functions: 0, instructions: 0, relaxed: 0, atomics: 0, simd: 0, features: [] };
  const NUM = (op) => (op >= 0x45 && op <= 0xc4) || op === 0x00 || op === 0x01 || op === 0x05 || op === 0x0b || op === 0x0f || op === 0x1a || op === 0x1b || op === 0xd1;
  while (p < b.length) {
    const id = b[p++];
    const size = u();
    const end = p + size;
    if (id === 0) {
      const nl = u();
      const nm = new TextDecoder().decode(b.subarray(p, p + nl));
      p += nl;
      if (nm === 'target_features') {
        const n = u();
        for (let i = 0; i < n; i++) {
          const prefix = String.fromCharCode(b[p++]);
          const l = u();
          const f = new TextDecoder().decode(b.subarray(p, p + l));
          p += l;
          if (prefix !== '-') out.features.push(f);
        }
      }
    } else if (id === 10) {
      const count = u();
      for (let f = 0; f < count; f++) {
        const bodySize = u();
        const bodyEnd = p + bodySize;
        const nloc = u();
        for (let i = 0; i < nloc; i++) {
          u();
          p++;
        }
        while (p < bodyEnd) {
          const op = b[p++];
          out.instructions++;
          if (NUM(op)) continue;
          if (op >= 0x02 && op <= 0x04) {
            const t = b[p];
            if (t === 0x40 || (t >= 0x6f && t <= 0x7f)) p++;
            else skipLeb();
          } else if (op === 0x0c || op === 0x0d || op === 0x10 || op === 0x12 || (op >= 0x20 && op <= 0x26) || op === 0xd2 || op === 0x3f || op === 0x40) u();
          else if (op === 0x0e) {
            const n = u();
            for (let i = 0; i <= n; i++) u();
          } else if (op === 0x11 || op === 0x13) {
            u();
            u();
          } else if (op === 0x1c) {
            const n = u();
            p += n;
          } else if (op >= 0x28 && op <= 0x3e) memarg();
          else if (op === 0x41 || op === 0x42) skipLeb();
          else if (op === 0x43) p += 4;
          else if (op === 0x44) p += 8;
          else if (op === 0xd0) p++;
          else if (op === 0xfc) {
            const s = u();
            if (s <= 7) continue;
            if (s === 8) {
              u();
              u();
            } else if (s === 9 || s === 11 || s === 13 || (s >= 15 && s <= 17)) u();
            else if (s === 10 || s === 12 || s === 14) {
              u();
              u();
            } else throw new Error(`unknown 0xFC opcode ${s} in function ${f}`);
          } else if (op === 0xfd) {
            const s = u();
            out.simd++;
            if (s >= 0x100 && s <= 0x113) out.relaxed++;
            else if (s <= 11 || s === 92 || s === 93) memarg();
            else if (s === 12 || s === 13) p += 16;
            else if (s >= 21 && s <= 34) p++;
            else if (s >= 84 && s <= 91) {
              memarg();
              p++;
            } else if (s > 0xff) throw new Error(`unknown SIMD opcode ${s} in function ${f}`);
          } else if (op === 0xfe) {
            const s = u();
            out.atomics++;
            if (s === 3) p++;
            else memarg();
          } else throw new Error(`unknown opcode 0x${op.toString(16)} in function ${f}`);
        }
        if (p !== bodyEnd) throw new Error(`function ${f} did not decode to its size`);
        out.functions++;
      }
    }
    p = end;
  }
  return out;
}
