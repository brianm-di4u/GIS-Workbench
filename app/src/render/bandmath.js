// Band Math (REQ-MSI-04, `Research/10` §5): a small expression language over bands, compiled
// to a GLSL fragment for display and to a closure tree for statistics and export (no eval and
// no new Function, so it runs under the strict CSP). Division by zero, a negative square root
// or a log of a non-positive value gives no-data.
//
//   expr   := cond ;  cond := or ['?' expr ':' expr] ;  or := and {('||'|'or') and}
//   and    := cmp {('&&'|'and') cmp} ;  cmp := add [('<'|'<='|'>'|'>='|'=='|'!=') add]
//   add    := mul {('+'|'-') mul} ;  mul := unary {('*'|'/') unary} ;  unary := ['-'|'!'] pow
//   pow    := primary ['^' unary] ;  primary := number | band | name '(' args ')' | '(' expr ')'
//   band   := b1 … bN | coastal | blue | green | yellow | red | rededge | nir | nir2 | swir1 | swir2 | tir
//   names  := abs sqrt log log10 exp min max pow clamp

export const MAX_BANDS = 8;

/** Nominal centre wavelengths (µm) of the band names, and their acceptance windows. */
export const BAND_NAMES = {
  coastal: [0.443, 0.4, 0.455],
  blue: [0.48, 0.44, 0.52],
  green: [0.555, 0.52, 0.6],
  yellow: [0.605, 0.585, 0.625],
  red: [0.655, 0.62, 0.69],
  rededge: [0.725, 0.69, 0.76],
  nir: [0.84, 0.76, 0.9],
  nir2: [0.94, 0.86, 1.05],
  swir1: [1.61, 1.5, 1.75],
  swir2: [2.2, 2.05, 2.35],
  tir: [10.9, 8, 13],
};

/** Index presets: name → [label, expression, variant note]. */
export const INDICES = {
  ndvi: ['NDVI', '(nir - red) / (nir + red)', ''],
  ndwi: ['NDWI (McFeeters, water)', '(green - nir) / (green + nir)', 'McFeeters 1996: open water'],
  ndwi_gao: ['NDWI (Gao, leaf water) / NDMI', '(nir - swir1) / (nir + swir1)', 'Gao 1996: vegetation liquid water'],
  mndwi: ['MNDWI', '(green - swir1) / (green + swir1)', 'Xu 2006'],
  ndbi: ['NDBI', '(swir1 - nir) / (swir1 + nir)', 'Zha et al. 2003'],
  savi: ['SAVI (L = 0.5)', '1.5 * (nir - red) / (nir + red + 0.5)', 'Huete 1988'],
  nbr: ['NBR', '(nir - swir2) / (nir + swir2)', ''],
};

const FUNCS = { abs: 1, sqrt: 1, log: 1, log10: 1, exp: 1, min: 2, max: 2, pow: 2, clamp: 3 };

function tokenize(s) {
  const out = [];
  let i = 0;
  while (i < s.length) {
    const c = s[i];
    if (/\s/.test(c)) {
      i++;
      continue;
    }
    const two = s.slice(i, i + 2);
    if (['<=', '>=', '==', '!=', '&&', '||'].includes(two)) {
      out.push({ t: 'op', v: two });
      i += 2;
      continue;
    }
    if ('+-*/^()?:,<>!'.includes(c)) {
      out.push({ t: 'op', v: c });
      i++;
      continue;
    }
    const num = /^(\d+\.?\d*|\.\d+)(e[+-]?\d+)?/i.exec(s.slice(i));
    if (num) {
      out.push({ t: 'num', v: Number(num[0]) });
      i += num[0].length;
      continue;
    }
    const id = /^[a-z_][a-z0-9_]*/i.exec(s.slice(i));
    if (id) {
      out.push({ t: 'id', v: id[0].toLowerCase() });
      i += id[0].length;
      continue;
    }
    throw new Error(`Band Math: unexpected '${c}' at ${i + 1}`);
  }
  if (out.length > 400) throw new Error('Band Math: the expression is too long');
  return out;
}

/** Resolve a band name to a 0-based band index from the band wavelengths (µm). */
export function bandByName(name, bands) {
  const w = BAND_NAMES[name];
  if (!w || !bands?.length) return -1;
  let best = -1;
  let bd = Infinity;
  bands.forEach((b, i) => {
    if (!Number.isFinite(b.cw) || b.cw < w[1] || b.cw > w[2]) return;
    const d = Math.abs(b.cw - w[0]);
    if (d < bd) {
      bd = d;
      best = i;
    }
  });
  return best;
}

/**
 * Parse an expression. `bands`: band metadata [{cw}] (for names), `nb`: band count.
 * Returns {ast, bands: [source band indices referenced, in order], text}.
 */
export function parse(text, { bands = null, nb = 0 } = {}) {
  const tk = tokenize(String(text));
  let p = 0;
  const peek = () => tk[p];
  const take = (v) => {
    if (peek()?.v !== v) throw new Error(`Band Math: expected '${v}'${peek() ? ` before '${peek().v}'` : ' at the end'}`);
    p++;
  };
  const used = [];
  const slot = (b) => {
    let k = used.indexOf(b);
    if (k < 0) {
      if (used.length >= MAX_BANDS) throw new Error(`Band Math: at most ${MAX_BANDS} different bands in one expression`);
      used.push(b);
      k = used.length - 1;
    }
    return { k: 'band', slot: k, band: b };
  };
  let depth = 0;
  const expr = () => {
    if (++depth > 64) throw new Error('Band Math: nested too deeply');
    const c = or();
    if (peek()?.v === '?') {
      p++;
      const a = expr();
      take(':');
      const b = expr();
      depth--;
      return { k: 'if', c, a, b };
    }
    depth--;
    return c;
  };
  const bin = (next, ops, alias = {}) => () => {
    let a = next();
    for (;;) {
      const t = peek();
      const v = t?.t === 'op' ? t.v : t?.t === 'id' ? alias[t.v] : undefined;
      if (!v || !ops.includes(v)) return a;
      p++;
      a = { k: 'bin', op: v, a, b: next() };
    }
  };
  const pow = () => {
    const a = primary();
    if (peek()?.v === '^') {
      p++;
      return { k: 'bin', op: '^', a, b: unary() };
    }
    return a;
  };
  const unary = () => {
    const t = peek();
    if (t?.v === '-' || t?.v === '!') {
      p++;
      return { k: 'un', op: t.v, a: pow() };
    }
    return pow();
  };
  const mul = bin(unary, ['*', '/']);
  const add = bin(mul, ['+', '-']);
  const cmp = () => {
    const a = add();
    const t = peek();
    if (t?.t === 'op' && ['<', '<=', '>', '>=', '==', '!='].includes(t.v)) {
      p++;
      return { k: 'bin', op: t.v, a, b: add() };
    }
    return a;
  };
  const and = bin(cmp, ['&&'], { and: '&&' });
  const or = bin(and, ['||'], { or: '||' });
  const primary = () => {
    const t = tk[p++];
    if (!t) throw new Error('Band Math: the expression ends early');
    if (t.t === 'num') return { k: 'num', v: t.v };
    if (t.v === '(') {
      const e = expr();
      take(')');
      return e;
    }
    if (t.t === 'id') {
      if (peek()?.v === '(') {
        if (!(t.v in FUNCS)) throw new Error(`Band Math: unknown function ${t.v}()`);
        p++;
        const args = [];
        if (peek()?.v !== ')') {
          args.push(expr());
          while (peek()?.v === ',') {
            p++;
            args.push(expr());
          }
        }
        take(')');
        if (args.length !== FUNCS[t.v]) throw new Error(`Band Math: ${t.v}() takes ${FUNCS[t.v]} argument(s)`);
        return { k: 'fn', f: t.v, args };
      }
      const m = /^b(\d+)$/.exec(t.v);
      if (m) {
        const b = Number(m[1]) - 1;
        if (b < 0 || (nb && b >= nb)) throw new Error(`Band Math: band ${t.v} does not exist (the image has ${nb} bands)`);
        return slot(b);
      }
      if (t.v in BAND_NAMES) {
        const b = bandByName(t.v, bands);
        if (b < 0) throw new Error(`Band Math: no band of this image matches '${t.v}' (${BAND_NAMES[t.v][1]}–${BAND_NAMES[t.v][2]} µm); use b1…b${nb || 'N'}`);
        return slot(b);
      }
      if (t.v === 'pi') return { k: 'num', v: Math.PI };
      throw new Error(`Band Math: unknown name '${t.v}'`);
    }
    throw new Error(`Band Math: unexpected '${t.v}'`);
  };
  const ast = expr();
  if (p < tk.length) throw new Error(`Band Math: unexpected '${tk[p].v}'`);
  return { ast, bands: used, text: String(text) };
}

const glslNum = (v) => (Number.isInteger(v) ? `${v}.0` : String(v));

/** GLSL for the expression: reads float b[slot]; division and domain errors set `bmNd`. */
export function toGlsl(ast) {
  const g = (n) => {
    switch (n.k) {
      case 'num':
        return glslNum(n.v);
      case 'band':
        return `bmB[${n.slot}]`;
      case 'un':
        return n.op === '-' ? `(-${g(n.a)})` : `(${g(n.a)} == 0.0 ? 1.0 : 0.0)`;
      case 'if':
        return `(${g(n.c)} != 0.0 ? ${g(n.a)} : ${g(n.b)})`;
      case 'fn': {
        const a = n.args.map(g);
        if (n.f === 'sqrt') return `bmSqrt(${a[0]})`;
        if (n.f === 'log') return `bmLog(${a[0]})`;
        if (n.f === 'log10') return `(bmLog(${a[0]}) * 0.4342944819)`;
        return `${n.f}(${a.join(', ')})`;
      }
      case 'bin': {
        const a = g(n.a);
        const b = g(n.b);
        if (n.op === '/') return `bmDiv(${a}, ${b})`;
        if (n.op === '^') return `pow(${a}, ${b})`;
        if (['<', '<=', '>', '>=', '==', '!='].includes(n.op)) return `((${a} ${n.op} ${b}) ? 1.0 : 0.0)`;
        if (n.op === '&&') return `((${a} != 0.0 && ${b} != 0.0) ? 1.0 : 0.0)`;
        if (n.op === '||') return `((${a} != 0.0 || ${b} != 0.0) ? 1.0 : 0.0)`;
        return `(${a} ${n.op} ${b})`;
      }
      default:
        throw new Error('Band Math: bad node');
    }
  };
  return g(ast);
}

/** A closure tree evaluating the expression on a band-value array (NaN = no-data). */
export function compile(ast) {
  const c = (n) => {
    switch (n.k) {
      case 'num': {
        const v = n.v;
        return () => v;
      }
      case 'band': {
        const s = n.slot;
        return (b) => b[s];
      }
      case 'un': {
        const a = c(n.a);
        return n.op === '-' ? (b) => -a(b) : (b) => (a(b) === 0 ? 1 : 0);
      }
      case 'if': {
        const [k, a, e] = [c(n.c), c(n.a), c(n.b)];
        return (b) => (k(b) !== 0 ? a(b) : e(b));
      }
      case 'fn': {
        const a = n.args.map(c);
        const f = { abs: Math.abs, sqrt: (x) => (x < 0 ? NaN : Math.sqrt(x)), log: (x) => (x <= 0 ? NaN : Math.log(x)), log10: (x) => (x <= 0 ? NaN : Math.log10(x)), exp: Math.exp, min: Math.min, max: Math.max, pow: Math.pow, clamp: (x, lo, hi) => Math.min(hi, Math.max(lo, x)) }[n.f];
        if (a.length === 1) return (b) => f(a[0](b));
        if (a.length === 2) return (b) => f(a[0](b), a[1](b));
        return (b) => f(a[0](b), a[1](b), a[2](b));
      }
      case 'bin': {
        const a = c(n.a);
        const e = c(n.b);
        switch (n.op) {
          case '+':
            return (b) => a(b) + e(b);
          case '-':
            return (b) => a(b) - e(b);
          case '*':
            return (b) => a(b) * e(b);
          case '/':
            return (b) => {
              const d = e(b);
              return d === 0 ? NaN : a(b) / d;
            };
          case '^':
            return (b) => a(b) ** e(b);
          case '<':
            return (b) => (a(b) < e(b) ? 1 : 0);
          case '<=':
            return (b) => (a(b) <= e(b) ? 1 : 0);
          case '>':
            return (b) => (a(b) > e(b) ? 1 : 0);
          case '>=':
            return (b) => (a(b) >= e(b) ? 1 : 0);
          case '==':
            return (b) => (a(b) === e(b) ? 1 : 0);
          case '!=':
            return (b) => (a(b) !== e(b) ? 1 : 0);
          case '&&':
            return (b) => (a(b) !== 0 && e(b) !== 0 ? 1 : 0);
          default:
            return (b) => (a(b) !== 0 || e(b) !== 0 ? 1 : 0);
        }
      }
      default:
        throw new Error('Band Math: bad node');
    }
  };
  return c(ast);
}

/** Evaluate over band planes (one per referenced slot, with gain/offset per slot) → Float32Array. */
export function evaluate(ast, planes, { gain = null, offset = null, nodata = null } = {}) {
  const f = compile(ast);
  const n = planes[0]?.length ?? 0;
  const out = new Float32Array(n);
  const v = new Float64Array(planes.length);
  const isNd = nodata === null || nodata === undefined ? (x) => Number.isNaN(x) : (x) => x === nodata || Number.isNaN(x);
  for (let i = 0; i < n; i++) {
    let bad = false;
    for (let k = 0; k < planes.length; k++) {
      const x = planes[k][i];
      if (isNd(x)) {
        bad = true;
        break;
      }
      v[k] = (gain ? gain[k] : 1) * x + (offset ? offset[k] : 0);
    }
    const r = bad ? NaN : f(v);
    out[i] = Number.isFinite(r) ? r : NaN;
  }
  return out;
}
