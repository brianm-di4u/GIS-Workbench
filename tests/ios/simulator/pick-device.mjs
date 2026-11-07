// Prints the UDID of the newest iPhone on this host with a Dynamic Island, booting it first.

import { execFileSync } from 'node:child_process';

const sim = (...a) => execFileSync('xcrun', ['simctl', ...a], { encoding: 'utf8' });
const { devices } = JSON.parse(sim('list', 'devices', 'available', '--json'));
const version = (rt) => rt.match(/iOS-(\d+)-(\d+)/)?.slice(1).map(Number) ?? [0, 0];
const rts = Object.keys(devices).filter((k) => /SimRuntime\.iOS/.test(k)).sort((a, b) => version(b)[0] - version(a)[0] || version(b)[1] - version(a)[1]);
for (const rt of rts) {
  const phone = devices[rt].filter((d) => /^iPhone (1[5-9]|[2-9]\d)/.test(d.name) && !/e$|Plus|Air/.test(d.name)).sort((a, b) => a.name.localeCompare(b.name, 'en', { numeric: true })).at(-1);
  if (phone) {
    if (phone.state !== 'Booted') sim('boot', phone.udid);
    console.log(phone.udid);
    process.exit(0);
  }
}
console.error(`no iPhone with a Dynamic Island in: ${rts.join(', ')}`);
process.exit(1);
