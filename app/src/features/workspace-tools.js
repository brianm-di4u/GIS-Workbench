// Workspace tools (R1 Shoulds): Customize Quick Access Toolbar and Recent Projects (REQ-UI-04),
// Save Options with the recovery journal off or encrypted by a session passphrase (REQ-SEC-06),
// the Image List (REQ-UI-19) and delimited point files through a column-mapping dialog
// (REQ-UI-25, REQ-FMT-13).

import { h, clear } from '../shell/dom.js';
import { modal, field, section } from '../shell/dialogs.js';
import { pickFiles } from '../storage/files.js';
import { QAT, MAIN_TABS } from '../shell/ribbon-data.js';
import { acqTime } from '../products/tokens.js';
import { fromParts } from '../vector/geom.js';
import { inferFields } from '../vector/io.js';
import { removeLayer } from './panels.js';
import { openImageFile } from '../formats/open.js';
import { t, tr, N_, msgOf } from '../i18n/index.js';
import { int, dateTime, collator } from '../i18n/format.js';

const OK_RESET_CANCEL = () => [{ label: t('OK'), value: 'ok', primary: true }, { label: t('Reset'), value: 'reset' }, { label: t('Cancel'), value: 'cancel' }];

export const name = 'workspace-tools';

/** Split delimited text: auto-detected delimiter (tab, comma, semicolon, pipe, spaces), quotes. */
export function parseDelimited(text, delim = null) {
  const lines = String(text).replace(/^﻿/, '').split(/\r?\n/).filter((l) => l.trim() && !/^\s*#/.test(l));
  if (!lines.length) return { delim: ',', rows: [] };
  const cands = ['\t', ',', ';', '|'];
  // Fields per line for a candidate delimiter, ignoring delimiters inside quoted fields.
  const fieldsOf = (l, c) => {
    let n = 1;
    let q = false;
    for (let i = 0; i < l.length; i++) {
      if (l[i] === '"' && (q || i === 0 || l[i - 1] === c)) q = !q;
      else if (!q && l[i] === c) n++;
    }
    return n;
  };
  const d = delim ?? cands.map((c) => [c, lines.slice(0, 20).map((l) => fieldsOf(l, c))]).filter(([, n]) => n.every((x) => x === n[0] && x > 1)).sort((a, b) => b[1][0] - a[1][0])[0]?.[0] ?? ' ';
  const split = (l) => {
    if (d === ' ') return l.trim().split(/\s+/);
    const out = [];
    let cur = '';
    let q = false;
    for (let i = 0; i < l.length; i++) {
      const ch = l[i];
      if (q) {
        if (ch === '"' && l[i + 1] === '"') {
          cur += '"';
          i++;
        } else if (ch === '"') q = false;
        else cur += ch;
      } else if (ch === '"' && cur.trim() === '') q = true; // quotes open a field only at its start
      else if (ch === d) {
        out.push(cur.trim());
        cur = '';
      } else cur += ch;
    }
    out.push(cur.trim());
    return out;
  };
  return { delim: d, rows: lines.map(split) };
}

/** Guess the latitude, longitude, single-coordinate, name and height columns from a header. */
export function guessColumns(header, sample) {
  const find = (re) => header.findIndex((c) => re.test(c));
  let lat = find(/^(lat|latitude|y|northing_dd)$/i);
  let lon = find(/^(lon|long|lng|longitude|x)$/i);
  const coord = find(/^(mgrs|usng|coord|coordinate|location|position|utm)$/i);
  const nm = find(/^(name|label|id|title|site)$/i);
  const hgt = find(/^(h|hae|height|elev|elevation|alt|altitude|z)$/i);
  if ((lat < 0 || lon < 0) && sample) {
    // Two numeric columns in range: the first in ±90 and another in ±180.
    const nums = sample.map((v, i) => [i, Number(v)]).filter(([, v]) => Number.isFinite(v));
    lat = lat >= 0 ? lat : nums.find(([, v]) => Math.abs(v) <= 90)?.[0] ?? -1;
    lon = lon >= 0 ? lon : nums.find(([i, v]) => i !== lat && Math.abs(v) <= 180)?.[0] ?? -1;
  }
  return { lat, lon, coord, name: nm, height: hgt };
}

export function install(app) {
  const C = app.commands;

  // ---- Quick Access Toolbar ----
  const rerenderQat = () => {
    for (const mp of app.desktop.multiports) mp.renderQat();
  };
  C.implement('qat.customize', {
    run: async () => {
      const cur = (app.prefs.get('qat') ?? QAT).filter((x) => x !== 'qat.customize');
      const cmp = collator().compare;
      const all = [...app.commands.map.values()].filter((c) => c.implemented && c.id !== 'qat.customize').sort((a, b) => cmp(tr(a.label), tr(b.label)));
      const filter = h('input', { class: 'inp', type: 'search', placeholder: t('Filter commands'), 'aria-label': t('Filter commands') });
      const list = h('div', { class: 'grid-wrap', style: { maxHeight: '45vh', overflow: 'auto' }, tabindex: '0', role: 'region', 'aria-label': t('Commands') });
      const chosen = new Set(cur.filter((x) => x !== '-'));
      const render = () => {
        clear(list);
        const q = filter.value.trim().toLowerCase();
        for (const c of all.filter((x) => !q || tr(x.label).toLowerCase().includes(q))) {
          const cb = h('input', { type: 'checkbox', checked: chosen.has(c.id), 'aria-label': tr(c.label), 'data-id': `qatpick:${c.id}` });
          cb.addEventListener('change', () => (cb.checked ? chosen.add(c.id) : chosen.delete(c.id)));
          list.appendChild(h('label', { class: 'fld fld-inline' }, cb, h('span', {}, tr(c.label))));
        }
      };
      filter.addEventListener('input', render);
      render();
      const r = await modal({ title: t('Customize Quick Access Toolbar'), body: h('div', {}, filter, list), buttons: OK_RESET_CANCEL(), width: 520, id: 'qat-customize' });
      if (r === 'reset') app.prefs.set('qat', null);
      else if (r === 'ok') {
        // Keep the user's order for commands already there; new ones go at the end.
        const kept = cur.filter((x) => x === '-' || chosen.has(x));
        const added = [...chosen].filter((x) => !kept.includes(x));
        app.prefs.set('qat', [...kept, ...added].filter((x, i, a) => !(x === '-' && (i === 0 || a[i - 1] === '-'))));
      }
      rerenderQat();
    },
  });
  // ---- Customize the Ribbon (REQ-UI-24): hide or show groups, and a tab of your own commands ----
  const setRibbonCustom = (c) => {
    app.prefs.set('ribbonCustom', c);
    app.emit('ribbon');
  };
  app.setRibbonCustom = setRibbonCustom;
  C.implement('ribbon.customize', {
    run: async () => {
      const cur = app.prefs.get('ribbonCustom') ?? {};
      const hidden = new Set(cur.hidden ?? []);
      const groups = h('div', { class: 'grid-wrap', style: { maxHeight: '30vh', overflow: 'auto' }, tabindex: '0', role: 'region', 'aria-label': t('Ribbon groups') });
      for (const tab of MAIN_TABS)
        for (const g of tab.groups) {
          const key = `${tab.id}:${g.label}`; // the preference keeps the English group label
          const path = `${tr(tab.label)} ▸ ${tr(g.label)}`;
          const cb = h('input', { type: 'checkbox', checked: !hidden.has(key), 'aria-label': path, 'data-id': `rgrp:${key}` });
          cb.addEventListener('change', () => (cb.checked ? hidden.delete(key) : hidden.add(key)));
          groups.appendChild(h('label', { class: 'fld fld-inline' }, cb, h('span', {}, path)));
        }
      const label = h('input', { class: 'inp', value: cur.tab?.label ?? t('My Commands'), spellcheck: 'true', 'aria-label': t('Custom tab name'), 'data-id': 'rcustom-label' });
      const chosen = [...(cur.tab?.items ?? [])];
      const cmp = collator().compare;
      const all = [...app.commands.map.values()].filter((c) => c.implemented && !c.id.startsWith('qat.')).sort((a, b) => cmp(tr(a.label), tr(b.label)));
      const pick = h('select', { class: 'inp', 'aria-label': t('Command to add'), 'data-id': 'rcustom-pick' }, all.map((c) => h('option', { value: c.id }, tr(c.label))));
      const list = h('ol', { class: 'relink-list', 'data-id': 'rcustom-list' });
      const render = () => {
        clear(list);
        chosen.forEach((id, i) => {
          const del = h('button', { class: 'btn', 'aria-label': t('Remove {command}', { command: tr(C.get(id)?.label) ?? id }) }, '✕');
          del.addEventListener('click', () => {
            chosen.splice(i, 1);
            render();
          });
          list.appendChild(h('li', {}, tr(C.get(id)?.label) ?? id, ' ', del));
        });
      };
      const add = h('button', { class: 'btn', 'data-id': 'rcustom-add' }, t('Add'));
      add.addEventListener('click', () => {
        if (!chosen.includes(pick.value)) chosen.push(pick.value);
        render();
      });
      render();
      const r = await modal({ title: t('Customize the Ribbon'), body: h('div', {}, section(t('Groups shown'), groups), section(t('Custom tab'), field(t('Name'), label), h('div', { class: 'btn-row' }, pick, add), list)), buttons: OK_RESET_CANCEL(), width: 560, id: 'ribbon-customize' });
      if (r === 'reset') setRibbonCustom(null);
      else if (r === 'ok') setRibbonCustom({ hidden: [...hidden], tab: chosen.length ? { label: label.value.trim() || t('My Commands'), items: chosen } : null });
    },
  });
  app.setQat = (ids) => {
    app.prefs.set('qat', ids);
    rerenderQat();
  };

  // ---- Recent Projects ----
  const recent = async () => (await app.journal?.get('kv', 'recent')) ?? [];
  app.noteRecent = async (nm, handle) => {
    if (!app.journal?.available) return;
    const list = (await recent()).filter((r) => r.name !== nm);
    list.unshift({ name: nm, at: new Date().toISOString(), handle: handle ?? null });
    await app.journal.put('kv', 'recent', list.slice(0, 10));
  };
  app.recentProjects = recent;
  app.openRecent = (r) => openRecent(r);
  /** Reopen a recent project through its stored file handle, else ask for the file again. */
  async function openRecent(r) {
    try {
      if (r.handle) {
        const ok = (await r.handle.queryPermission?.({ mode: 'read' })) === 'granted' || (await r.handle.requestPermission?.({ mode: 'read' })) === 'granted';
        if (ok) {
          const f = await r.handle.getFile();
          f.__handle = r.handle;
          return app.openProjectFile(f);
        }
      }
      app.toast(t('This browser keeps no file handle for {project}; pick it again', { project: r.name }), { kind: 'info' });
      return C.run('file.openproject');
    } catch (e) {
      app.toast(t('{project}: {msg}', { project: r.name, msg: msgOf(e) }), { kind: 'error' });
    }
  }
  C.implement('file.recent', {
    run: async () => {
      const list = await recent();
      let pick = null;
      const body = list.length
        ? h(
            'ul',
            { class: 'recent-list' },
            ...list.map((r) => {
              const b = h('button', { class: 'btn', 'data-id': `recent:${r.name}` }, r.name);
              b.addEventListener('click', () => {
                pick = r;
                document.querySelector('[data-id="dialog:recent"] .dlg-x')?.click();
              });
              return h('li', {}, b, h('span', { class: 'hint' }, ` ${r.handle ? dateTime(r.at, { utc: false, seconds: false }) : t('{when} · pick again', { when: dateTime(r.at, { utc: false, seconds: false }) })}`));
            }),
          )
        : h('p', { class: 'muted' }, t('No recent projects yet. Projects appear here after you open or save them.'));
      await modal({ title: t('Recent Projects'), body, buttons: [{ label: t('Close'), value: 'close', primary: true }], id: 'recent' });
      if (pick) await openRecent(pick);
    },
  });

  // ---- Save Options: recovery journal ----
  C.implement('file.saveoptions', {
    run: async () => {
      const j = app.journal;
      const on = h('input', { type: 'checkbox', checked: j.enabled, 'aria-label': t('Keep a recovery journal') });
      const enc = h('input', { type: 'checkbox', checked: !!j.key, 'aria-label': t('Encrypt the journal') });
      const pass = h('input', { class: 'inp', type: 'password', autocomplete: 'new-password', 'aria-label': t('Session passphrase') });
      const pass2 = h('input', { class: 'inp', type: 'password', autocomplete: 'new-password', 'aria-label': t('Repeat the passphrase') });
      const note = h('p', { class: 'hint', 'aria-live': 'polite' });
      const body = h(
        'div',
        {},
        section(t('Recovery journal'), h('label', { class: 'fld fld-inline' }, on, h('span', {}, t('Keep a recovery journal of edits in this browser (never pixels)'))), h('p', { class: 'hint' }, j.available ? t('Browser storage is available.') : t('Browser storage is unavailable here: there is no journal to keep.'))),
        section(t('Encryption'), h('label', { class: 'fld fld-inline' }, enc, h('span', {}, t('Encrypt it with a passphrase for this session (AES-GCM, PBKDF2)'))), field(t('Passphrase'), pass), field(t('Repeat'), pass2), h('p', { class: 'hint' }, t('The passphrase stays in memory only. Recovery after a crash asks for it; a lost passphrase means the journal cannot be read.'))),
        note,
      );
      const r = await modal({ title: t('Save Options'), body, buttons: [{ label: t('OK'), value: 'ok', primary: true }, { label: t('Cancel'), value: 'cancel' }], id: 'save-options' });
      if (r !== 'ok') return;
      j.setEnabled(on.checked);
      if (enc.checked && on.checked) {
        if (!pass.value || pass.value !== pass2.value) return app.toast(t('The passphrases are empty or do not match; the journal is not encrypted'), { kind: 'warn' });
        await j.setPassphrase(pass.value);
        app.toast(t('The recovery journal is encrypted for this session'), { kind: 'info' });
      } else await j.setPassphrase(null);
    },
  });
  app.setJournalPassphrase = (p) => app.journal.setPassphrase(p);

  // ---- Image List ----
  app.on('ready', (mp) => mp.docks.register({ id: 'imagelist', title: t('Image List'), icon: 'list', home: 'bottom', create: (a, m, el) => imageList(el) }));
  C.implement('tools.imagelist', { run: () => app.panels.toggle('imagelist', 'bottom') });

  const imageRows = () =>
    [...app.layers.values()].map((l) => {
      const sh = l.info.subheader ?? {};
      return {
        id: l.id,
        name: l.rec?.name ?? '',
        format: l.info.format ?? l.info.meta?.format ?? '',
        size: `${l.width} × ${l.height} × ${l.bands}`,
        type: l.sampleType,
        iid: (sh.IID2 || sh.IID1 || l.info.iid || '').trim(),
        sensor: (sh.ISORCE ?? '').trim(),
        acquired: acqTime(l.info.datetime) || '',
        model: l.modelName,
        kind: l.kind,
        footprint: l.rec?.footprint !== false,
      };
    });
  app.imageRows = imageRows;

  function imageList(el) {
    const wrap = h('div', { class: 'grid-wrap' });
    el.append(wrap);
    let key = 'acquired';
    let dir = 1;
    const cols = [
      ['name', N_('Name')],
      ['iid', N_('Image ID')],
      ['acquired', N_('Acquired (UTC)')],
      ['sensor', N_('Sensor')],
      ['format', N_('Format')],
      ['size', N_('Size')],
      ['type', N_('Type')],
      ['model', N_('Model')],
    ];
    const render = () => {
      clear(wrap);
      const rows = imageRows().sort((a, b) => (a[key] === b[key] ? 0 : a[key] < b[key] ? -1 : 1) * dir);
      if (!rows.length) return wrap.appendChild(h('p', { class: 'muted pad' }, t('No images loaded.')));
      const tbl = h('table', { class: 'grid-table', role: 'grid', 'aria-label': t('Image List') });
      tbl.appendChild(
        h(
          'thead',
          {},
          h(
            'tr',
            {},
            h('th', { scope: 'col' }, t('Footprint')),
            ...cols.map(([k, l]) => {
              const b = h('button', { class: 'th-sort', 'aria-label': t('Sort by {column}', { column: tr(l) }) }, `${tr(l)}${key === k ? (dir > 0 ? ' ▲' : ' ▼') : ''}`);
              b.addEventListener('click', () => {
                dir = key === k ? -dir : 1;
                key = k;
                render();
              });
              return h('th', { scope: 'col', 'aria-sort': key === k ? (dir > 0 ? 'ascending' : 'descending') : 'none' }, b);
            }),
          ),
        ),
      );
      const tb = h('tbody');
      for (const r of rows) {
        const cb = h('input', { type: 'checkbox', checked: r.footprint, 'aria-label': t('Show the footprint of {image}', { image: r.name }) });
        cb.addEventListener('change', () => {
          app.store.transact(t('Footprint'), (tx) => tx.set(r.id, 'footprint', cb.checked));
          app.renderer.invalidate();
        });
        const row = h('tr', { 'data-id': `image:${r.id}` }, h('td', {}, cb), ...cols.map(([k]) => h('td', {}, r[k] || '–')));
        row.addEventListener('dblclick', () => {
          app.selectedLayerId = r.id;
          app.desktop.workspace?.map?.zoomToFootprints?.();
          app.renderer.invalidate();
        });
        tb.appendChild(row);
      }
      tbl.appendChild(tb);
      wrap.appendChild(tbl);
    };
    app.on('layers', render);
    app.on('state', render);
    render();
    return { onShow: render };
  }

  // ---- Segments (REQ-IMG-20) ----
  /** Reopen the active layer's file with its image segments merged (or separate again). */
  app.setSegmentsMerged = async (merge, p = app.activePane()) => {
    const l = app.activeLayer();
    const ref = l && app.store.get(l.rec.file);
    const f = ref && app.files.get(ref.id)?.file;
    if (!f) throw new Error('the active layer has no open file');
    for (const rec of app.store.all('layer').filter((x) => x.file === ref.id)) removeLayer(app, p, rec.id);
    await openImageFile(app, f, { pane: p, merge, sidecars: app.files.get(ref.id)?.sidecars ?? [] });
    const mine = p.layers().filter((x) => app.store.get(x.rec?.file)?.name === f.name);
    return { layers: mine.length, merged: !!mine[0]?.info.mosaic, note: mine[0]?.info.mergeNote };
  };
  C.implement('img.segments', {
    enabled: () => app.activeLayer()?.info?.kind === 'nitf' || app.activeLayer()?.info?.format?.startsWith?.('NITF'),
    run: async () => {
      const l = app.activeLayer();
      const ref = app.store.get(l.rec.file);
      const layers = [...app.layers.values()].filter((x) => x.rec?.file === ref.id);
      const rows = l.info.mosaic ?? layers.map((x) => ({ imageIndex: x.info.subheader?.index ?? x.rec.imageIndex, width: x.width, height: x.height, idlvl: x.info.subheader?.IDLVL, ialvl: x.info.subheader?.IALVL, iloc: x.info.subheader?.ILOC }));
      const body = h(
        'div',
        {},
        h('table', { class: 'grid-table small', 'aria-label': t('Image segments') }, h('thead', {}, h('tr', {}, [t('Segment'), t('Size'), 'IDLVL', 'IALVL', t('ILOC / position')].map((x) => h('th', { scope: 'col' }, x)))), h('tbody', {}, ...rows.map((r) => h('tr', {}, h('td', {}, String((r.imageIndex ?? 0) + 1)), h('td', {}, `${int(r.width)} × ${int(r.height)}`), h('td', {}, String(r.idlvl ?? '–')), h('td', {}, String(r.ialvl ?? '–')), h('td', {}, r.x !== undefined ? `${r.x}, ${r.y}` : (r.iloc ?? []).join(', ')))))),
        h('p', { class: 'hint' }, l.info.mosaic ? t('Shown as one merged image.') : l.info.mergeable ? t('These segments can be merged into one image.') : t('Not mergeable: {reason}.', { reason: l.info.mergeNote ?? t('one segment') })),
      );
      const close = { label: t('Close'), value: 'close' };
      const btns = l.info.mosaic ? [{ label: t('Show Separately'), value: 'separate', primary: true }, close] : l.info.mergeable ? [{ label: t('Merge'), value: 'merge', primary: true }, close] : [{ ...close, primary: true }];
      const r = await modal({ title: t('Segments — {file}', { file: ref.name }), body, buttons: btns, width: 560, id: 'segments' });
      if (r === 'merge' || r === 'separate') {
        try {
          await app.setSegmentsMerged(r === 'merge');
        } catch (e) {
          app.toast(msgOf(e), { kind: 'error' });
        }
      }
    },
  });

  // ---- Point files ----
  /**
   * Build point features from delimited text with a column map {lat, lon} or {coord}, name,
   * height (m HAE; the terrain height when missing). Returns {layer, errors}.
   */
  app.pointsFromText = (text, map, { name: nm = t('Points'), delim = null, header = true } = {}) => {
    const { rows } = parseDelimited(text, delim);
    const head = header ? rows[0] : rows[0].map((_, i) => `col${i + 1}`);
    const body = header ? rows.slice(1) : rows;
    const errors = [];
    const features = [];
    body.forEach((r, i) => {
      let lat;
      let lon;
      try {
        if (map.coord >= 0 && map.coord !== undefined && map.coord !== null) {
          const p = app.core.parse(r[map.coord]);
          lat = p.lat;
          lon = p.lon;
        } else {
          lat = Number(String(r[map.lat]).replace(',', '.'));
          lon = Number(String(r[map.lon]).replace(',', '.'));
          if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
            const p = app.core.parse(`${r[map.lat]} ${r[map.lon]}`); // DMS in two columns
            lat = p.lat;
            lon = p.lon;
          }
        }
        if (!(Math.abs(lat) <= 90 && Math.abs(lon) <= 180)) throw new Error('outside ±90/±180');
      } catch (e) {
        errors.push(t('row {n}: {msg}', { n: i + (header ? 2 : 1), msg: msgOf(e) }));
        return;
      }
      const hv = map.height >= 0 ? Number(r[map.height]) : NaN;
      const hh = Number.isFinite(hv) ? hv : app.terrain?.sample?.(lat, lon)?.hae ?? 0;
      const attrs = {};
      head.forEach((c, k) => {
        if ([map.lat, map.lon, map.coord, map.height, map.name].includes(k)) return;
        const v = r[k];
        attrs[c] = v === undefined || v === '' ? null : /^-?\d+(\.\d+)?$/.test(v) ? Number(v) : v;
      });
      features.push({ geom: fromParts('Point', [[[lon, lat, hh]]]), attrs, name: map.name >= 0 ? r[map.name] : null, description: null });
    });
    return { layer: { name: nm, fields: inferFields(features), features, assets: {} }, errors, header: head };
  };

  C.implement('tools.loadpoints', {
    run: async () => {
      const [f] = await pickFiles(app, { multiple: false, accept: ['.csv', '.txt', '.tsv', '.dat'], description: t('Point file') });
      if (!f) return;
      const text = await f.text();
      const { rows, delim } = parseDelimited(text);
      if (!rows.length) return app.toast(t('{file} has no rows', { file: f.name }), { kind: 'warn' });
      const headerCb = h('input', { type: 'checkbox', checked: rows[0].some((c) => !Number.isFinite(Number(c))), 'aria-label': t('First row is a header') });
      const g = guessColumns(rows[0], rows[1] ?? rows[0]);
      const colSel = (label, v) => {
        const s = h('select', { class: 'inp', 'aria-label': label }, h('option', { value: '-1' }, t('(none)')), ...rows[0].map((c, i) => h('option', { value: String(i) }, headerCb.checked ? c : t('column {n}', { n: i + 1 }))));
        s.value = String(v);
        return s;
      };
      const lat = colSel(t('Latitude column'), g.lat);
      const lon = colSel(t('Longitude column'), g.lon);
      const coord = colSel(t('Single coordinate column (MGRS, UTM, DMS …)'), g.coord);
      const nmc = colSel(t('Name column'), g.name);
      const hc = colSel(t('Height column (m HAE)'), g.height);
      const preview = h('pre', { class: 'mono small' }, rows.slice(0, 6).map((r) => r.join(' | ')).join('\n'));
      const body = h('div', {}, h('p', { class: 'hint' }, t('{n, plural, one {# row} other {# rows}}, delimiter {delim}', { n: rows.length, delim: JSON.stringify(delim) })), preview, h('label', { class: 'fld fld-inline' }, headerCb, h('span', {}, t('First row is a header'))), field(t('Latitude'), lat), field(t('Longitude'), lon), field(t('Or one coordinate column'), coord), field(t('Name'), nmc), field(t('Height'), hc), h('p', { class: 'hint' }, t('Latitude/longitude may be decimal or DMS; a single column may be in any format the tool reads (MGRS, UTM, DMS …). Heights default to the terrain.')));
      if ((await modal({ title: t('Load Point File'), body, buttons: [{ label: t('Load'), value: 'load', primary: true }, { label: t('Cancel'), value: 'cancel' }], width: 640, id: 'load-points' })) !== 'load') return;
      const map = { lat: +lat.value, lon: +lon.value, coord: +coord.value >= 0 ? +coord.value : null, name: +nmc.value, height: +hc.value };
      const r = app.pointsFromText(text, map, { name: f.name.replace(/\.\w+$/, ''), delim, header: headerCb.checked });
      if (!r.layer.features.length) return app.toast(t('No points read: {msg}', { msg: r.errors.slice(0, 3).join('; ') }), { kind: 'error' });
      app.addVectorLayer(r.layer, { format: 'CSV points', file: f.name, report: { format: 'CSV', direction: 'import', features_in: r.layer.features.length + r.errors.length, features_out: r.layer.features.length, warnings: r.errors, by_geometry: { Point: r.layer.features.length }, fields_renamed: [], text_truncated: {}, dropped: {}, crs: 'WGS 84', vertical: 'HAE', encoding: 'UTF-8' } });
      app.toast(r.errors.length ? t('{n, plural, one {# point} other {# points}} from {file}; {skipped, plural, one {# row} other {# rows}} skipped', { n: r.layer.features.length, file: f.name, skipped: r.errors.length }) : t('{n, plural, one {# point} other {# points}} from {file}', { n: r.layer.features.length, file: f.name }), { kind: r.errors.length ? 'warn' : 'info' });
    },
  });
}
