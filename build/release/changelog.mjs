#!/usr/bin/env node
// Changelog fragments. A PR with a change a user would notice adds `changes/<name>.md`, holding
// `### Added`-style sections of `- ` items, in CHANGELOG.md's own words and format. The release PR
// runs `assemble`, which writes them into CHANGELOG.md as the new release and deletes them, so
// PRs never conflict over CHANGELOG.md. The rules match what the site's sync-changelog.mjs
// accepts, so a fragment that passes `check` can't break the site's changelog page.
//
//   node build/release/changelog.mjs check
//   node build/release/changelog.mjs assemble --version 2.7.0 [--date 2026-12-01] [--summary "One paragraph."]
import { readdirSync, readFileSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
export const SECTIONS = ['Added', 'Changed', 'Deprecated', 'Removed', 'Fixed', 'Security', 'Known limits'];
const NAME = /^[a-z0-9][a-z0-9-]*\.md$/;

/** A fragment's sections as { type: [lines] }, and what's wrong with it. */
export function parseFragment(text, name) {
  const sections = {};
  const problems = [];
  if (!NAME.test(name)) problems.push(`${name}: name it in lower case, like fix-terrain-labels.md`);
  let type = null;
  text.replace(/\r\n?/g, '\n').split('\n').forEach((raw, i) => {
    const line = raw.trimEnd();
    const at = `${name}:${i + 1}`;
    if (!line.trim()) return;
    if (line.startsWith('### ')) {
      type = line.slice(4).trim();
      if (!SECTIONS.includes(type)) problems.push(`${at}: unknown section "${type}" (use ${SECTIONS.join(', ')})`);
      sections[type] ??= [];
    } else if (line.startsWith('#')) problems.push(`${at}: only "### Section" headings go in a fragment`);
    else if (!type) problems.push(`${at}: start with a "### Section" heading`);
    // Only "- " items: the app's What's New dialog reads only those as list items.
    else if (/^- \S/.test(line) || (/^\s/.test(raw) && sections[type].length)) sections[type].push(line);
    else problems.push(`${at}: expected a "- " list item`);
  });
  if (!Object.values(sections).some((lines) => lines.length)) problems.push(`${name}: no items`);
  return { sections, problems };
}

/** The new release's block for CHANGELOG.md, with the fragments' sections in Keep a Changelog order. */
export function assemble(fragments, { version, date, summary }) {
  const out = [`## [${version}] - ${date}`, ''];
  if (summary) out.push(summary.trim(), '');
  for (const type of SECTIONS) {
    const lines = fragments.flatMap((f) => f.sections[type] ?? []);
    if (lines.length) out.push(`### ${type}`, ...lines, '');
  }
  return out.join('\n');
}

/** CHANGELOG.md with the block above its newest release. */
export function insertRelease(changelog, block, version) {
  const text = changelog.replace(/\r\n?/g, '\n');
  if (text.split('\n').some((line) => line.startsWith(`## [${version}]`))) throw new Error(`CHANGELOG.md already has ${version}`);
  const at = text.search(/^## \[/m);
  return at < 0 ? `${text.trimEnd()}\n\n${block}` : `${text.slice(0, at)}${block}\n${text.slice(at)}`;
}

function readFragments(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((name) => name.endsWith('.md') && name !== 'README.md')
    .sort()
    .map((name) => ({ name, ...parseFragment(readFileSync(join(dir, name), 'utf8'), name) }));
}

function main() {
  const { values, positionals } = parseArgs({ allowPositionals: true, options: { version: { type: 'string' }, date: { type: 'string' }, summary: { type: 'string' }, root: { type: 'string' } } });
  const root = values.root ?? ROOT;
  const dir = join(root, 'changes');
  const fragments = readFragments(dir);
  const problems = fragments.flatMap((f) => f.problems);
  for (const p of problems) console.error(p);
  if (problems.length) return 1;
  if (positionals[0] === 'check') {
    console.log(`${fragments.length} changelog fragments, all well formed.`);
    return 0;
  }
  if (positionals[0] !== 'assemble' || !values.version) {
    console.error('usage: node build/release/changelog.mjs check | assemble --version <v> [--date YYYY-MM-DD] [--summary "..."]');
    return 2;
  }
  if (!fragments.length) {
    console.error('No fragments in changes/: nothing to assemble.');
    return 1;
  }
  const date = values.date ?? new Date().toISOString().slice(0, 10);
  // The site's parser rejects the whole changelog if a heading doesn't look like this.
  if (!/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(values.version)) {
    console.error(`--version ${values.version}: write it as 2.7.0 or 2.7.0-beta.1, with no leading v`);
    return 2;
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    console.error(`--date ${date}: write it as YYYY-MM-DD`);
    return 2;
  }
  const file = join(root, 'CHANGELOG.md');
  writeFileSync(file, insertRelease(readFileSync(file, 'utf8'), assemble(fragments, { version: values.version, date, summary: values.summary }), values.version));
  for (const f of fragments) rmSync(join(dir, f.name));
  console.log(`CHANGELOG.md: ${values.version} from ${fragments.length} fragments, which are deleted. Read it through before committing.`);
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    process.exitCode = main();
  } catch (err) {
    console.error(err.message);
    process.exitCode = 1;
  }
}
