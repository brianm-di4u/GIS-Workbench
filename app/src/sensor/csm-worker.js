// The usgscsm bridge in the analysis worker (REQ-GAP-24): a block adjustment or RSM fit job with
// CSM records (type 9, gw_sensor::host::RECORD_TYPE) needs the usgscsm module here before the
// photo bundle rebuilds those models from their states.

import { Usgscsm } from './csm-wasm.js';
import { installCsmBridge } from './csm-host.js';

export const CSM_RECORD = 9;
let ready = null;

/** Load usgscsm into this worker once (GW: the worker core). */
export function ensureCsm(GW) {
  return (ready ??= GW.module('usgscsm')
    .then((m) => {
      installCsmBridge(new Usgscsm(m));
    })
    .catch((e) => {
      ready = null;
      throw e;
    }));
}

/**
 * Whether a job has a CSM record: 'adjust' (version 2: [2, nImages, …, then per image [type,
 * length, record…, 8 values]]) or 'fitrsm' ([type, length, record…]).
 */
export function jobNeedsCsm(job, op) {
  if (!job?.length) return false;
  if (op === 'fitrsm') return job[0] === CSM_RECORD;
  if (job[0] !== 2) return false;
  let o = 7;
  for (let i = 0; i < job[1] && o + 1 < job.length; i++) {
    if (job[o] === CSM_RECORD) return true;
    o += 2 + job[o + 1] + 8;
  }
  return false;
}
