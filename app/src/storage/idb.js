// Settle an IndexedDB transaction. A transaction can abort with no request error on it (a commit
// that fails on a full disk, or WebKit refusing a Blob in a private tab), so abort rejects too.
// Without it the promise never settles and the caller's db.close() never runs (#190).

/** Resolve with value() once `t` commits; reject if it errors or aborts. */
export function txDone(t, value) {
  return new Promise((res, rej) => {
    const fail = () => rej(t.error ?? new Error('the browser aborted this storage transaction'));
    t.oncomplete = () => res(value());
    t.onerror = fail;
    t.onabort = fail;
  });
}
