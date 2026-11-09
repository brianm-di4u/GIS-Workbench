// Pure helpers for the release tools in this folder. Nothing here reads or writes files.

/** The three HTML files a release publishes. The release workflow rebuilds and attests these. */
export const HTML = ['gis-workbench.html', 'gis-workbench-lite.html', 'gis-workbench-airgap.html'];

/** The asset the release workflow adds to the draft: SHA256SUMS of its own rebuild of HTML. */
export const CI_SUMS = 'CI-SHA256SUMS';

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
  for (const a of remote) if (!want.has(a.name) && a.name !== CI_SUMS) problems.push(`${a.name} is on the release but not in SHA256SUMS`);
  return problems;
}

/** Every way the staged HTML differs from the CI rebuild. `ciText` is CI-SHA256SUMS, or null when the release has none. Empty means they match. */
export function ciProblems(sums, ciText) {
  if (ciText == null) return [`${CI_SUMS} is not on the release, so the HTML can't be checked against the CI rebuild`];
  const ci = parseSums(ciText);
  const problems = [];
  for (const name of HTML) {
    if (!sums.has(name)) problems.push(`${name} is not staged`);
    else if (!ci.has(name)) problems.push(`${name} is not in ${CI_SUMS}`);
    else if (ci.get(name) !== sums.get(name)) problems.push(`${name} doesn't match the CI rebuild: staged ${sums.get(name)}, CI ${ci.get(name)}`);
  }
  return problems;
}
