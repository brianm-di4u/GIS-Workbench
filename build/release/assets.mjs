// Pure helpers for the release tools in this folder. Nothing here reads or writes files.

/** SHA256SUMS text to a Map of name -> hex hash. Accepts `hash  name` and `hash *name`. */
export function parseSums(text) {
  const sums = new Map();
  for (const line of text.split(/\r?\n/)) {
    const m = /^([0-9a-f]{64}) [ *](.+)$/.exec(line.trim());
    if (m) sums.set(m[2], m[1]);
  }
  return sums;
}

/** [{name, sha256}] to SHA256SUMS text, sorted by name so the file is stable. */
export function formatSums(entries) {
  return [...entries].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0)).map((e) => `${e.sha256}  ${e.name}`).join('\n') + '\n';
}

/** An asset's name with its version numbers replaced, so two releases' assets can be compared. */
export const family = (name) => name.replace(/\d+(?:\.\d+)+/g, '<v>');

/** Families an earlier release had that this one lacks, such as a pack a partial build skipped. */
export function missingFamilies(names, previousNames) {
  const have = new Set(names.map(family));
  return [...new Set(previousNames.map(family))].filter((f) => !have.has(f)).sort();
}

// Both functions below take `want`: SHA256SUMS's entries plus SHA256SUMS itself, name -> hex hash.

/** The local files that still need uploading, smallest first. Only a finished asset with the same digest is skipped. */
export function uploadPlan(local, remote, want) {
  const done = new Map(remote.filter((a) => a.state === 'uploaded').map((a) => [a.name, a.digest]));
  return local.filter((f) => done.get(f.name) !== `sha256:${want.get(f.name)}`).sort((a, b) => a.size - b.size || (a.name < b.name ? -1 : 1));
}

/** Every way the release's assets differ from what was staged. Empty means the release is complete and intact. */
export function digestProblems(want, remote) {
  const problems = [];
  const byName = new Map(remote.map((a) => [a.name, a]));
  for (const [name, hash] of want) {
    const a = byName.get(name);
    if (!a) problems.push(`${name} is not on the release`);
    else if (a.state !== 'uploaded') problems.push(`${name} is not fully uploaded (${a.state})`);
    else if (!a.digest) problems.push(`GitHub reports no digest for ${name}`);
    else if (a.digest !== `sha256:${hash}`) problems.push(`${name} has digest ${a.digest}, but the staged file's is ${hash}`);
  }
  for (const a of remote) if (!want.has(a.name)) problems.push(`${a.name} is on the release but not in SHA256SUMS`);
  return problems;
}
