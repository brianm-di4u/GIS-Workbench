// A large data pack is unpacked and hashed here, not on the main thread (OD-2.27): a pack can be
// nearly 1 GB, and the app must keep drawing and counting while it is checked. Runs in the
// analysis worker. storage/packs.js holds the rules; this only returns the bytes and their hashes.

import { unzipSync } from 'fflate';

async function hex(bytes) {
  const d = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

GW.register('packUnzip', async ({ bytes }, job) => {
  const total = bytes.length || 1;
  let seen = 0;
  // Half for unpacking, reported entry by entry; half for hashing, where Cancel can also act.
  const files = unzipSync(bytes, {
    filter: (f) => {
      seen += f.size;
      job.progress(Math.min(0.5, (seen / total) * 0.5));
      return true;
    },
  });
  const paths = Object.keys(files);
  const all = paths.reduce((s, p) => s + files[p].length, 0) || 1;
  const hashes = {};
  let done = 0;
  for (const p of paths) {
    hashes[p] = await hex(files[p]);
    done += files[p].length;
    job.progress(0.5 + (done / all) * 0.5);
    job.checkCancel();
  }
  return GW.transfer({ files, hashes }, [...new Set(paths.map((p) => files[p].buffer))]);
});
