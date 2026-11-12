// Settle an IndexedDB transaction. A transaction can abort with no request error on it (a commit
// that fails on a full disk, or WebKit refusing a Blob in a private tab), so abort rejects too.
// Without it the promise never settles and the caller's db.close() never runs (#190).
// A failed request's error event reaches the transaction before the browser sets t.error, so then
// the event's target (the request) carries the real error (#209). t.error comes first: when a
// transaction aborts with a cause, its pending requests get AbortErrors that would hide it.

/** Resolve with value() once `t` commits; reject if it errors or aborts. */
export function txDone(t, value) {
  return new Promise((res, rej) => {
    const fail = (ev) =>
      rej(t.error ?? ev?.target?.error ?? new Error('the browser aborted this storage transaction'));
    t.oncomplete = () => res(value());
    t.onerror = fail;
    t.onabort = fail;
  });
}
