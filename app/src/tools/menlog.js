// Mensuration Log rows (REQ-MEN-01, AC-02.2, Research/03 §5.3): the columns and one row as
// display strings, shared by the dock panel, CSV export and reports. Empty values say N/A.

import { fmtNum } from '../shell/dom.js';

export const MENLOG_COLUMNS = [
  ['mid', 'ID'],
  ['object', 'Object'],
  ['type', 'Type'],
  ['value', 'Value'],
  ['units', 'Units'],
  ['method', 'Method'],
  ['ce90', 'CE90 (m)'],
  ['le90', 'LE90 (m)'],
  ['tag', 'Abs/Rel'],
  ['coordinates', 'Coordinates'],
  ['image', 'Source images'],
  ['model', 'Sensor model'],
  ['heightSource', 'Elevation source'],
  ['chain', 'Image chain'],
  ['sigmaText', 'σ inputs'],
  ['analyst', 'Analyst'],
  ['time', 'Time (UTC)'],
];

/** One Mensuration Log row as display strings; empty values say N/A (AC-02.2). */
export function menRow(m) {
  const NA = 'N/A';
  const coords = m.coords?.mgrs
    ? `${m.coords.mgrs} · ${fmtNum(m.coords.lat, 7)}, ${fmtNum(m.coords.lon, 7)} WGS 84 · ${fmtNum(m.coords.hae, 2)} m HAE${m.coords.msl !== null && m.coords.msl !== undefined ? ` · ${fmtNum(m.coords.msl, 2)} m MSL (${m.coords.geoid})` : ''}`
    : m.coords?.from
      ? `${m.coords.from} → ${m.coords.to} (WGS 84)`
      : '';
  const sig = m.sigma
    ? m.sigma.perPoint
      ? m.sigma.perPoint.map((s, i) => `P${i + 1}: model ${fmtNum(s.model, 2)}, pick ${fmtNum(s.pick, 2)}, DEM ${fmtNum(s.demH, 2)}`).join('; ')
      : `model ${fmtNum(m.sigma.model, 2)} m, pick ${fmtNum(m.sigma.pick, 2)} m (${m.sigma.pickPx} px), DEM→horiz ${fmtNum(m.sigma.demH, 2)} m, DEM vert ${fmtNum(m.sigma.demV, 2)} m; ${m.sigma.method ?? ''}`
    : '';
  const v = {
    mid: m.mid,
    object: m.object,
    type: m.mtype ?? m.type,
    value: typeof m.value === 'number' ? m.value.toLocaleString(undefined, { maximumFractionDigits: 3 }) : m.value,
    units: m.units,
    method: m.method,
    ce90: Number.isFinite(m.ce90) ? m.ce90.toFixed(2) : 'error not available',
    le90: Number.isFinite(m.le90) ? m.le90.toFixed(2) : 'error not available',
    tag: m.tag,
    coordinates: coords,
    image: m.image,
    model: m.model,
    heightSource: m.heightSource,
    chain: m.chain,
    sigmaText: sig,
    analyst: m.analyst,
    time: m.time,
  };
  for (const k of Object.keys(v)) if (v[k] === undefined || v[k] === null || v[k] === '') v[k] = NA;
  return v;
}
