// `vector` bundle wrapper (analysis worker): feature validation (REQ-EXT-13), and routes and
// service areas on road networks (REQ-GAP-85).

import { Bundle } from './abi.js';

export class VectorBundle extends Bundle {
  constructor(module) {
    super(module, 'vector');
  }

  validate(prm, data) {
    return this.guard(() => {
      const [a, an] = this.putF64(prm);
      const [b, bn] = this.putF64(data);
      try {
        this.check(this.x.gw_validate(a, prm.length, b, data.length), 'validate');
        return this.outJson();
      } finally {
        this.free(a, an);
        this.free(b, bn);
      }
    });
  }

  /**
   * Road network (gw_network): prm [0, from node, to node] → {cost, edges, forward}, or
   * [1, max cost, source nodes…] → {cost: per node, null beyond}. `data` is analysis/network.js graphData().
   */
  network(prm, data) {
    return this.guard(() => {
      const [a, an] = this.putF64(prm);
      const [b, bn] = this.putF64(data);
      try {
        this.check(this.x.gw_network(a, prm.length, b, data.length), 'network');
        return this.outJson();
      } finally {
        this.free(a, an);
        this.free(b, bn);
      }
    });
  }
}
