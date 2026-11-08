// The web app's CycloneDX SBOM, from what the build actually bundled: the npm packages and Rust
// crates in dist/build-report.json, and from the HTML's build manifest the packs and the embedded
// third-party blocks (SQLite, usgscsm, the Draco and Basis decoders, geoid and basemap data).
// Pure: it reads nothing, and its timestamp is the build's, so the same build gives the same file.

// Blocks the npm and crate lists already cover: our own data, bundled JS ("see notices") and our
// own Rust WASM, whose third-party crates are in rustCrates.
const COVERED = new Set(['own', 'see notices', 'Apache-2.0']);

// Old Cargo manifests write "A/B" for "A OR B". Everything else the build reports is already SPDX.
const spdx = (licence) => licence.replace(/\s*\/\s*/g, ' OR ');

export function webSbom(report, { packs = {}, blocks = {} } = {}) {
  const lib = (p, type) => ({
    type: 'library',
    name: p.name,
    version: p.version,
    purl: `pkg:${type}/${p.name.replace(/^@/, '%40')}@${p.version}`,
    ...(p.license ? { licenses: [{ expression: spdx(p.license) }] } : {}),
    properties: [{ name: 'gwb:part', value: 'html' }],
  });
  const pack = ([name, p]) => ({
    type: 'data',
    name: `${name}.gwpack`,
    version: p.version,
    description: p.title,
    hashes: [{ alg: 'SHA-256', content: p.sha256 }],
    properties: [{ name: 'gwb:part', value: 'pack' }, { name: 'gwb:file', value: p.file }],
  });
  // A block's licence is free text, so it goes in as a licence name, not an SPDX expression.
  const block = ([id, b]) => ({
    type: b.kind === 'data' ? 'data' : 'library',
    name: id,
    hashes: [{ alg: 'SHA-256', content: b.sha256 }],
    licenses: [{ license: { name: b.licence } }],
    properties: [{ name: 'gwb:part', value: 'html-block' }],
  });
  return {
    bomFormat: 'CycloneDX',
    specVersion: '1.5',
    version: 1,
    metadata: {
      timestamp: report.build.date,
      component: { type: 'application', name: 'gis-workbench', version: report.build.version, properties: [{ name: 'gwb:build', value: report.build.id }] },
    },
    components: [
      ...report.packages.map((p) => lib(p, 'npm')),
      ...report.rustCrates.map((c) => lib(c, 'cargo')),
      ...Object.entries(blocks).filter(([, b]) => b.licence && !COVERED.has(b.licence)).sort(([a], [b]) => (a < b ? -1 : 1)).map(block),
      ...Object.entries(packs).sort(([a], [b]) => (a < b ? -1 : 1)).map(pack),
    ],
  };
}

/** The packs and blocks of the HTML's build manifest, each {} if missing. */
export function manifestParts(html) {
  const m = /<script type="application\/json" id="build-manifest">(.*?)<\/script>/s.exec(html);
  const j = m ? JSON.parse(m[1]) : {};
  return { packs: j.packs ?? {}, blocks: j.blocks ?? {} };
}
