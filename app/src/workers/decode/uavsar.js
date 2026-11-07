// UAVSAR binary products in the decode worker (FC-24, REQ-FMT-53). The `legacy` bundle parses the `.ann`
// annotation and picks the layer a file is from its name and size (`gw_uavsar_product`); the headerless
// samples are then read like an ENVI raw image (REAL*4 as one band; COMPLEX and two-value layers as two
// interleaved REAL*4 bands), by window and with strided coarse levels. Complex layers (SLC, the
// off-diagonal MLC/GRD covariances) become the SAR bands (amplitude, phase, I, Q, power). GRD, HGT, INC
// and slope layers are on the annotation's equiangular latitude/longitude grid (EPSG:4326); SLC and MLC
// stay in radar geometry.

import { enviSource } from './envi.js';
import { sicdSource } from './sicd.js';
import { gwError } from '../../i18n/index.js';
import { wasmError } from '../errors.js';

function run(B, fn, bufs, tail = []) {
  const ps = bufs.map((b) => B.put(b));
  try {
    if (B.x[fn](...ps.flat(), ...tail) !== 0) throw wasmError(B);
    return B.outJson();
  } finally {
    for (const [p, n] of ps) B.free(p, n);
  }
}

/** Annotation bytes → its JSON summary. */
export function uavsarAnn(bytes, B) {
  return run(B, 'gw_uavsar_ann', [bytes]);
}

/** Open `file` described by the annotation `annFile` → {meta, source, complex}. */
export async function openUavsar(file, annFile, B) {
  if (annFile.size > 4 << 20) throw gwError('{file} is larger than 4 MiB: not a UAVSAR annotation', { file: annFile.name });
  const ann = new Uint8Array(await annFile.arrayBuffer());
  const prod = run(B, 'gw_uavsar_product', [ann, new TextEncoder().encode(file.name)], [file.size]);
  const summary = uavsarAnn(ann, B);
  const complex = prod.kind === 'complex';
  const nodata = /^(grd|mlc|slc)/.test(prod.layer) ? 0 : null;
  const hd = { samples: prod.cols, lines: prod.rows, bands: prod.kind === 'real' ? 1 : 2, headerOffset: prod.header, interleave: 'bip', byteOrder: prod.littleEndian ? 0 : 1, dataType: 4, sizeOk: true, ignore: nodata ?? NaN };
  const base = enviSource(file, hd);
  const source = complex ? sicdSource(base, { pixelType: 'RE32F_IM32F' }) : base;
  const pol = /([HV]{2,4})/.exec(prod.key.replace(/^[a-z]+/, ''))?.[1] ?? '';
  const what = { grd_pwr: 'GRD power', grd_mag: 'GRD complex covariance', mlc_pwr: 'MLC power', mlc_mag: 'MLC complex covariance', slc_mag: 'SLC', hgt: 'height', inc: 'incidence angle', slope: 'terrain slope' }[prod.layer] ?? prod.layer;
  const meta = {
    format: `UAVSAR ${summary.mode || ''} ${what}${pol ? ` ${pol}` : ''} (${prod.proj === 'EQA' ? 'ground range, lat/lon grid' : 'slant range, radar geometry'})`.replace(/\s+/g, ' '),
    uavsar: { ...summary, entries: undefined, product: prod, annName: annFile.name },
    geotransform: prod.geotransform,
    epsg: prod.geotransform ? 4326 : null,
    dateTime: summary.start,
    bandsMeta: prod.kind === 'pair' ? [{ name: `${what} 1` }, { name: `${what} 2` }] : null,
  };
  return { meta, source, complex };
}
