// #190: an IndexedDB transaction that aborts with no request error must still settle, or the
// caller's db.close() in `finally` never runs.
import { describe, it, expect } from 'vitest';
import { txDone } from '../../app/src/storage/idb.js';

/** A transaction stand-in: the handlers txDone sets, and an error the browser may leave null. */
const fakeTx = () => ({ error: null, oncomplete: null, onerror: null, onabort: null });

describe('txDone', () => {
  it('resolves with the value once the transaction commits', async () => {
    const t = fakeTx();
    const req = { result: undefined };
    const p = txDone(t, () => req.result);
    req.result = 42; // a request's result is only read after the commit
    t.oncomplete();
    await expect(p).resolves.toBe(42);
  });

  it('rejects with the request error', async () => {
    const t = fakeTx();
    const p = txDone(t, () => 1);
    t.error = new DOMException('quota', 'QuotaExceededError');
    t.onerror();
    await expect(p).rejects.toThrow('quota');
  });

  it("rejects with the failed request's error before the browser sets t.error (#209)", async () => {
    const t = fakeTx();
    const p = txDone(t, () => 1);
    const req = { error: new DOMException('key already exists', 'ConstraintError') };
    t.onerror({ target: req }); // the request's error event bubbles here while t.error is still null
    await expect(p).rejects.toThrow('key already exists');
  });

  it("keeps the transaction's cause over a pending request's AbortError", async () => {
    const t = fakeTx();
    const p = txDone(t, () => 1);
    t.error = new DOMException('disk full', 'QuotaExceededError'); // set before the AbortErrors fire
    t.onerror({ target: { error: new DOMException('aborted', 'AbortError') } });
    await expect(p).rejects.toThrow('disk full');
  });

  it('rejects when the transaction aborts with no error on it', async () => {
    const t = fakeTx();
    const p = txDone(t, () => 1);
    t.onabort();
    await expect(p).rejects.toThrow('aborted');
  });
});
