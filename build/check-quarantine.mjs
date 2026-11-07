#!/usr/bin/env node
// A quarantined test is skipped in CI, so the list has to stay honest: every entry names the
// issue tracking the fix and a date it expires. An expired entry fails `verify`, which forces
// the choice between fixing the test and renewing it on purpose.
import { existsSync, readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

export const QUARANTINE = 'tests/quarantine.json';

export function problems(entries, today) {
  const found = [];
  for (const entry of entries) {
    const label = entry.test || JSON.stringify(entry);
    if (!entry.test) found.push(`${label}: no test title`);
    if (!Number.isInteger(entry.issue)) found.push(`${label}: no issue number`);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(entry.expires ?? '')) found.push(`${label}: no expiry date (YYYY-MM-DD)`);
    else if (entry.expires < today) found.push(`${label}: expired on ${entry.expires} (issue #${entry.issue})`);
  }
  return found;
}

/** The Playwright title filter for the entries that apply in CI. */
export function grepInvert(entries) {
  const escape = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return entries.length > 0 ? new RegExp(entries.map((entry) => escape(entry.test)).join('|')) : undefined;
}

export function readQuarantine(path = QUARANTINE) {
  return existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : [];
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const entries = readQuarantine();
  const found = problems(entries, new Date().toISOString().slice(0, 10));
  if (found.length > 0) {
    console.error(`Quarantine list needs attention:\n  ${found.join('\n  ')}`);
    process.exitCode = 1;
  } else {
    console.log(`${entries.length} quarantined tests, none expired.`);
  }
}
