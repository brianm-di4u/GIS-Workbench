// `terrain` bundle wrapper (analysis worker): viewsheds (REQ-DEM-13) and landing zones (REQ-DEM-14).

import { Bundle } from './abi.js';

export class TerrainBundle extends Bundle {
  constructor(module) {
    super(module, 'terrain');
  }

  viewshed(prm, z) {
    return this.guard(() => {
      const [a, an] = this.putF64(prm);
      const [b, bn] = this.putF32(z);
      try {
        this.check(this.x.gw_viewshed(a, prm.length, b, z.length), 'viewshed');
        return this.outBytes();
      } finally {
        this.free(a, an);
        this.free(b, bn);
      }
    });
  }

  hlz(prm, z) {
    return this.guard(() => {
      const [a, an] = this.putF64(prm);
      const [b, bn] = this.putF32(z);
      try {
        this.check(this.x.gw_hlz(a, prm.length, b, z.length), 'hlz');
        const o = this.outBytes();
        const n = z.length;
        return { classes: o.slice(0, n), slope: new Float32Array(o.slice(n, 5 * n).buffer), obstruction: o.slice(5 * n, 6 * n) };
      } finally {
        this.free(a, an);
        this.free(b, bn);
      }
    });
  }

  buildings(prm, dsm, ndsm) {
    return this.guard(() => {
      const [a, an] = this.putF64(prm);
      const [b, bn] = this.putF32(dsm);
      const [c, cn] = this.putF32(ndsm);
      try {
        this.check(this.x.gw_buildings(a, prm.length, b, c, dsm.length), 'buildings');
        return this.outJson();
      } finally {
        this.free(a, an);
        this.free(b, bn);
        this.free(c, cn);
      }
    });
  }

  rtin(z, size, maxError) {
    return this.guard(() => {
      const [a, an] = this.putF32(z);
      try {
        this.check(this.x.gw_rtin(a, z.length, size, maxError), 'rtin');
        const b = this.outBytes();
        const dv = new DataView(b.buffer);
        const nv = dv.getUint32(0, true);
        const nt = dv.getUint32(4, true);
        return { xy: new Uint16Array(b.buffer.slice(8, 8 + 4 * nv)), tris: new Uint32Array(b.buffer.slice(8 + 4 * nv, 8 + 4 * nv + 12 * nt)) };
      } finally {
        this.free(a, an);
      }
    });
  }
}
