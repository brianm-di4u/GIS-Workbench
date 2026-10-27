// `vector` bundle wrapper (analysis worker): feature validation (REQ-EXT-13).

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
}
