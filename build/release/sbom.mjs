// The web app's CycloneDX SBOM, from what the build actually bundled: the npm packages and Rust
// crates in dist/build-report.json, and the packs in the HTML's build manifest. Pure: it reads
// nothing, and its timestamp is the build's, so the same build gives the same file.

// Old Cargo manifests write "A/B" for "A OR B". Everything else the build reports is already SPDX.
const spdx = (licence) => licence.replace(/\s*\/\s*/g, ' OR ');

export function webSbom(report, packs = {}) {
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
      ...Object.entries(packs).sort(([a], [b]) => (a < b ? -1 : 1)).map(pack),
    ],
  };
}

/** The packs section of the HTML's build manifest, or {} if there isn't one. */
export function manifestPacks(html) {
  const m = /<script type="application\/json" id="build-manifest">(.*?)<\/script>/s.exec(html);
  return m ? (JSON.parse(m[1]).packs ?? {}) : {};
}
