// TAK bridge, Tier 1 (2.0 plan P7; REQ-HUB-04): Cursor-on-Target XML and ATAK data packages that
// ATAK, WinTAK and iTAK import by sideload or Data Sync. A web page cannot send UDP multicast,
// so nothing is pushed live from here (DN-58). Points become CoT events typed from their class
// (2525 function codes); outlines become freehand drawing shapes (u-d-f) with link points.

import { zipSync, strToU8 } from 'fflate';

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[c]);
const iso = (d) => new Date(d).toISOString().replace(/\.\d{3}Z$/, '.000Z');

/** CoT type for an object class (unknown affiliation; ground unless the class says otherwise). */
export function cotType(cls = '') {
  const c = String(cls).toLowerCase();
  if (/\b(aircraft|airplane|plane|jet|helicopter|airliner|fighter|bomber|uav|drone)\b/.test(c)) return 'a-u-G-E-V-A'; // aircraft on the ground (equipment)
  if (/\b(ship|vessel|boat|tanker|barge|ferry|submarine|warship|dredger)\b/.test(c)) return 'a-u-S';
  if (/\b(tank|armou?r|apc|artillery|launcher|missile)\b/.test(c)) return 'a-u-G-E-W';
  if (/\b(car|vehicle|truck|bus|van|trailer|jeep)\b/.test(c)) return 'a-u-G-E-V';
  if (/\b(building|house|hangar|bunker|installation|facility|tower)\b/.test(c)) return 'a-u-G-I';
  return 'a-u-G';
}

/**
 * One CoT event. p: {uid, type, lat, lon, hae, ce, le, time, staleHours, how, callsign, remarks,
 * ring: [[lon, lat], …] for a drawing, colour (ARGB int), attachments: [file names]}.
 */
export function cotEvent(p) {
  const t = p.time ?? Date.now();
  const stale = t + (p.staleHours ?? 24 * 30) * 3600e3;
  const pt = `<point lat="${(+p.lat).toFixed(7)}" lon="${(+p.lon).toFixed(7)}" hae="${Number.isFinite(p.hae) ? (+p.hae).toFixed(1) : '9999999.0'}" ce="${Number.isFinite(p.ce) ? (+p.ce).toFixed(1) : '9999999.0'}" le="${Number.isFinite(p.le) ? (+p.le).toFixed(1) : '9999999.0'}"/>`;
  const links = (p.ring ?? []).map(([lon, lat]) => `<link point="${(+lat).toFixed(7)},${(+lon).toFixed(7)}"/>`).join('');
  const shape = p.ring ? `${links}<strokeColor value="${p.colour ?? -16711681}"/><strokeWeight value="3.0"/><fillColor value="${(p.colour ?? -16711681) & 0x40ffffff}"/><labels_on value="true"/>` : '';
  const att = (p.attachments ?? []).length ? `<attachment_list hashes="[]"/>` : '';
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<event version="2.0" uid="${esc(p.uid)}" type="${esc(p.ring ? 'u-d-f' : p.type ?? 'a-u-G')}" time="${iso(t)}" start="${iso(t)}" stale="${iso(stale)}" how="${esc(p.how ?? 'h-e')}">${pt}<detail><contact callsign="${esc(p.callsign ?? p.uid)}"/>${p.remarks ? `<remarks>${esc(p.remarks)}</remarks>` : ''}${shape}${att}<__group name="Cyan" role="Team Member"/><creator uid="GIS-Workbench" callsign="GIS Workbench" time="${iso(t)}" type="a-f-G-E-S"/></detail></event>`;
}

/** The ATAK data package (mission package v2): {name, events: [{uid, xml}], files: [{path, bytes, uid?}]} → zip bytes. */
export function dataPackage({ name, uid, events = [], files = [] }) {
  const contents = [
    ...events.map((e) => `<Content ignore="false" zipEntry="${esc(`cot/${e.uid}.cot`)}"><Parameter name="uid" value="${esc(e.uid)}"/></Content>`),
    ...files.map((f) => `<Content ignore="false" zipEntry="${esc(f.path)}">${f.uid ? `<Parameter name="uid" value="${esc(f.uid)}"/>` : ''}</Content>`),
  ];
  const manifest = `<MissionPackageManifest version="2"><Configuration><Parameter name="uid" value="${esc(uid)}"/><Parameter name="name" value="${esc(name)}"/><Parameter name="onReceiveDelete" value="false"/></Configuration><Contents>${contents.join('')}</Contents></MissionPackageManifest>`;
  const entries = { 'MANIFEST/manifest.xml': strToU8(manifest) };
  for (const e of events) entries[`cot/${e.uid}.cot`] = strToU8(e.xml);
  for (const f of files) entries[f.path] = [f.bytes, { level: /\.(jpe?g|png|kmz|zip)$/i.test(f.path) ? 0 : 6 }];
  return zipSync(entries);
}
