// `spectral` bundle wrapper (analysis worker; REQ-MSI-05..14, 16; REQ-EXT-28). Cubes are BIP
// Float32Array; outputs come back as {json, sections: {name: TypedArray}}.

import { Bundle } from './abi.js';

export const METHODS = { md: 0, ml: 1, mahalanobis: 2, sam: 3, sid: 4 };

function unpack(bytes) {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const jl = dv.getUint32(0, true);
  const json = JSON.parse(new TextDecoder().decode(bytes.subarray(4, 4 + jl)));
  let off = 4 + jl;
  const sections = {};
  for (const s of json.sections ?? []) {
    off += (4 - (off % 4)) % 4;
    const n = s.type === 'f32' ? s.len * 4 : s.len;
    const buf = bytes.buffer.slice(bytes.byteOffset + off, bytes.byteOffset + off + n);
    sections[s.name] = s.type === 'f32' ? new Float32Array(buf) : new Uint8Array(buf);
    off += n;
  }
  delete json.sections;
  return { json, sections };
}

const f64 = (a) => (a instanceof Float64Array ? a : Float64Array.from(a ?? []));

export class SpectralBundle extends Bundle {
  constructor(module) {
    super(module, 'spectral');
  }

  /** Put the arrays, call `fn(ptrs…)` with [pointer, length] pairs, free, unpack. */
  run(name, arrays, fn) {
    return this.guard(() => {
      if (arrays[0] !== undefined && ArrayBuffer.isView(arrays[0]) && arrays[0].byteLength === 0 && arrays[0].buffer.byteLength === 0) throw new Error(`spectral ${name}: the input array was detached`);
      const ptrs = arrays.map((a) => {
        if (!a || !a.length) return [0, 0, 0];
        if (a instanceof Float32Array) return [...this.putF32(a), a.length];
        if (a instanceof Uint8Array) return [...this.put(a), a.length];
        const v = f64(a);
        return [...this.putF64(v), v.length];
      });
      try {
        this.check(fn(...ptrs.map(([p, , n]) => [p, n])), name);
        return unpack(this.outBytes());
      } finally {
        for (const [p, n] of ptrs) if (p) this.free(p, n);
      }
    });
  }

  stats(v, w, h, nb) {
    return this.run('stats', [[w, h, nb], v], ([p], [a, n]) => this.x.gw_spec_stats(p, a, n)).json;
  }

  /** sets: [[pixel indices]] per class → {classes: [{n, mean, std}], jm}. */
  train(v, w, h, nb, sets) {
    const prm = [w, h, nb, sets.length, ...sets.map((s) => s.length)];
    return this.run('train', [prm, v, sets.flat()], ([p, pl], [a, n], [i, ni]) => this.x.gw_spec_train(p, pl, a, n, i, ni)).json;
  }

  /** method: 'md'|'ml'|'mahalanobis'|'sam'|'sid'; sets (training pixels) or means (k × nb). */
  classify(v, w, h, nb, method, { sets = null, means = null, threshold = NaN } = {}) {
    const k = sets?.length ?? means.length;
    const prm = [w, h, nb, METHODS[method], threshold, k, ...(sets ? sets.map((s) => s.length) : Array(k).fill(0))];
    const r = this.run('classify', [prm, v, sets ? sets.flat() : [], means ? means.flat() : []], ([p, pl], [a, n], [i, ni], [m, nm]) => this.x.gw_spec_classify(p, pl, a, n, i, ni, m, nm));
    return { labels: r.sections.labels, scores: r.sections.scores };
  }

  kmeans(v, w, h, nb, { k = 6, iters = 20, step = 4, change = 0.01 } = {}) {
    const r = this.run('kmeans', [[w, h, nb, k, iters, step, change], v], ([p, pl], [a, n]) => this.x.gw_spec_cluster(0, p, pl, a, n));
    return { labels: r.sections.labels, centres: r.json.centres };
  }

  isodata(v, w, h, nb, o = {}) {
    const prm = [w, h, nb, o.kMin ?? 4, o.kMax ?? 10, o.iters ?? 12, o.change ?? 0.02, o.minPixels ?? 50, o.maxStd ?? Infinity, o.minDist ?? 0, o.maxMerge ?? 2, o.step ?? 4];
    const r = this.run('isodata', [prm, v], ([p, pl], [a, n]) => this.x.gw_spec_cluster(1, p, pl, a, n));
    return { labels: r.sections.labels, centres: r.json.centres };
  }

  /** op: 'majority' | 'sieve' | 'fill'. */
  post(op, labels, w, h, param = 3) {
    const r = this.run('post', [labels], ([l, n]) => this.x.gw_spec_post({ majority: 0, sieve: 1, fill: 2 }[op], w, h, param, l, n));
    return r.sections.labels;
  }

  accuracy(reference, mapped, k, weights = null) {
    return this.run('accuracy', [reference, mapped, weights ?? []], ([r, n], [m], [wt, nw]) => this.x.gw_spec_accuracy(k, r, m, n, wt, nw)).json;
  }

  /** kind: 'rx' | 'rxlocal' | 'target' | 'gmm'. */
  detect(kind, v, w, h, nb, { step = 4, outer = 15, guard = 5, k = 4, iters = 10, target = null } = {}) {
    const code = { rx: 0, rxlocal: 1, target: 2, gmm: 3 }[kind];
    const prm = [w, h, nb, step, kind === 'gmm' ? k : outer, kind === 'gmm' ? iters : guard];
    return this.run('detect', [prm, v, target ?? []], ([p], [a, n], [t, nt]) => this.x.gw_spec_detect(code, p, a, n, t, nt)).sections;
  }

  /** kind: 'pca' | 'mnf' | 'dstretch' | 'ica' | 'unmix'. */
  transform(kind, v, w, h, nb, { k = 3, step = 4, iters = 50, endmembers = null } = {}) {
    const code = { pca: 0, mnf: 1, dstretch: 2, ica: 3, unmix: 4 }[kind];
    const prm = [w, h, nb, kind === 'unmix' ? endmembers.length : k, kind === 'ica' ? iters : step, step];
    const r = this.run('transform', [prm, v, endmembers ? endmembers.flat() : []], ([p], [a, n], [e, ne]) => this.x.gw_spec_transform(code, p, a, n, e, ne));
    return { ...r.json, cube: r.sections.cube };
  }

  /** kind: 'dos' (param = percentile) | 'mean' (aux = pixel indices) | 'destripe' | 'change' (b). */
  correct(kind, v, w, h, nb, { param = 0.0001, idx = null, b = null } = {}) {
    const code = { dos: 0, mean: 1, destripe: 2, change: 3 }[kind];
    const r = this.run('correct', [[w, h, nb, param], v, idx ?? [], b ?? new Float32Array(0)], ([p], [a, n], [x, nx], [bb, nbb]) => this.x.gw_spec_correct(code, p, a, n, x, nx, bb, nbb));
    return { ...r.json, ...r.sections };
  }

  elm(imageMeans, reflectances) {
    const t = imageMeans.length;
    const nb = imageMeans[0].length;
    return this.run('elm', [imageMeans.flat(), reflectances.flat()], ([a], [b]) => this.x.gw_spec_elm(t, nb, a, b)).json;
  }

  bt(radiance, { k1 = NaN, k2 = NaN, lambda = NaN, emissivity = NaN } = {}) {
    return this.run('bt', [[k1, k2, lambda, emissivity], radiance], ([p], [a, n]) => this.x.gw_spec_bt(p, a, n)).sections.kelvin;
  }

  /** wl/values (µm) → sensor bands {centres, fwhm} (µm). */
  resample(wl, values, centres, fwhm) {
    return this.run('resample', [[wl.length, ...wl, ...values], [centres.length, ...centres, ...fwhm]], ([a, na], [b, nb]) => this.x.gw_spec_resample(a, na, b, nb)).json;
  }

  template(img, w, h, t, tw, th) {
    const r = this.run('template', [img, t], ([a], [b]) => this.x.gw_spec_template(w, h, a, tw, th, b));
    return { ...r.json, ncc: r.sections.ncc };
  }
}
