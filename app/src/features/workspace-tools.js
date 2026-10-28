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
import { portionMark } from '../security/marking.js';
import { removeLayer } from './panels.js';
import { openImageFile } from '../formats/open.js';

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
      const all = [...app.commands.map.values()].filter((c) => c.implemented && c.id !== 'qat.customize').sort((a, b) => a.label.localeCompare(b.label));
      const filter = h('input', { class: 'inp', type: 'search', placeholder: 'Filter commands', 'aria-label': 'Filter commands' });
      const list = h('div', { class: 'grid-wrap', style: { maxHeight: '45vh', overflow: 'auto' }, tabindex: '0', role: 'region', 'aria-label': 'Commands' });
      const chosen = new Set(cur.filter((x) => x !== '-'));
      const render = () => {
        clear(list);
        const q = filter.value.trim().toLowerCase();
        for (const c of all.filter((x) => !q || x.label.toLowerCase().includes(q))) {
          const cb = h('input', { type: 'checkbox', checked: chosen.has(c.id), 'aria-label': c.label, 'data-id': `qatpick:${c.id}` });
          cb.addEventListener('change', () => (cb.checked ? chosen.add(c.id) : chosen.delete(c.id)));
          list.appendChild(h('label', { class: 'fld fld-inline' }, cb, h('span', {}, c.label)));
        }
      };
      filter.addEventListener('input', render);
      render();
      const r = await modal({ title: 'Customize Quick Access Toolbar', body: h('div', {}, filter, list), buttons: ['OK', 'Reset', 'Cancel'], width: 520, id: 'qat-customize' });
      if (r === 'Reset') app.prefs.set('qat', null);
      else if (r === 'OK') {
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
      const groups = h('div', { class: 'grid-wrap', style: { maxHeight: '30vh', overflow: 'auto' }, tabindex: '0', role: 'region', 'aria-label': 'Ribbon groups' });
      for (const t of MAIN_TABS)
        for (const g of t.groups) {
          const key = `${t.id}:${g.label}`;
          const cb = h('input', { type: 'checkbox', checked: !hidden.has(key), 'aria-label': `${t.label} ▸ ${g.label}`, 'data-id': `rgrp:${key}` });
          cb.addEventListener('change', () => (cb.checked ? hidden.delete(key) : hidden.add(key)));
          groups.appendChild(h('label', { class: 'fld fld-inline' }, cb, h('span', {}, `${t.label} ▸ ${g.label}`)));
        }
      const label = h('input', { class: 'inp', value: cur.tab?.label ?? 'My Commands', spellcheck: 'true', 'aria-label': 'Custom tab name', 'data-id': 'rcustom-label' });
      const chosen = [...(cur.tab?.items ?? [])];
      const all = [...app.commands.map.values()].filter((c) => c.implemented && !c.id.startsWith('qat.')).sort((a, b) => a.label.localeCompare(b.label));
      const pick = h('select', { class: 'inp', 'aria-label': 'Command to add', 'data-id': 'rcustom-pick' }, all.map((c) => h('option', { value: c.id }, c.label)));
      const list = h('ol', { class: 'relink-list', 'data-id': 'rcustom-list' });
      const render = () => {
        clear(list);
        chosen.forEach((id, i) => {
          const del = h('button', { class: 'btn', 'aria-label': `Remove ${C.get(id)?.label ?? id}` }, '✕');
          del.addEventListener('click', () => {
            chosen.splice(i, 1);
            render();
          });
          list.appendChild(h('li', {}, C.get(id)?.label ?? id, ' ', del));
        });
      };
      const add = h('button', { class: 'btn', 'data-id': 'rcustom-add' }, 'Add');
      add.addEventListener('click', () => {
        if (!chosen.includes(pick.value)) chosen.push(pick.value);
        render();
      });
      render();
      const r = await modal({ title: 'Customize the Ribbon', body: h('div', {}, section('Groups shown', groups), section('Custom tab', field('Name', label), h('div', { class: 'btn-row' }, pick, add), list)), buttons: ['OK', 'Reset', 'Cancel'], width: 560, id: 'ribbon-customize' });
      if (r === 'Reset') setRibbonCustom(null);
      else if (r === 'OK') setRibbonCustom({ hidden: [...hidden], tab: chosen.length ? { label: label.value.trim() || 'My Commands', items: chosen } : null });
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
      app.toast(`This browser keeps no file handle for ${r.name}; pick it again`, { kind: 'info' });
      return C.run('file.openproject');
    } catch (e) {
      app.toast(`${r.name}: ${e.message}`, { kind: 'error' });
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
              return h('li', {}, b, h('span', { class: 'hint' }, ` ${new Date(r.at).toLocaleString()}${r.handle ? '' : ' · pick again'}`));
            }),
          )
        : h('p', { class: 'muted' }, 'No recent projects yet. Projects appear here after you open or save them.');
      await modal({ title: 'Recent Projects', body, buttons: ['Close'], id: 'recent' });
      if (pick) await openRecent(pick);
    },
  });

  // ---- Save Options: recovery journal ----
  C.implement('file.saveoptions', {
    run: async () => {
      const j = app.journal;
      const on = h('input', { type: 'checkbox', checked: j.enabled, 'aria-label': 'Keep a recovery journal' });
      const enc = h('input', { type: 'checkbox', checked: !!j.key, 'aria-label': 'Encrypt the journal' });
      const pass = h('input', { class: 'inp', type: 'password', autocomplete: 'new-password', 'aria-label': 'Session passphrase' });
      const pass2 = h('input', { class: 'inp', type: 'password', autocomplete: 'new-password', 'aria-label': 'Repeat the passphrase' });
      const note = h('p', { class: 'hint', 'aria-live': 'polite' });
      const body = h(
        'div',
        {},
        section('Recovery journal', h('label', { class: 'fld fld-inline' }, on, h('span', {}, 'Keep a recovery journal of edits in this browser (never pixels)')), h('p', { class: 'hint' }, j.available ? 'Browser storage is available.' : 'Browser storage is unavailable here: there is no journal to keep.')),
        section('Encryption', h('label', { class: 'fld fld-inline' }, enc, h('span', {}, 'Encrypt it with a passphrase for this session (AES-GCM, PBKDF2)')), field('Passphrase', pass), field('Repeat', pass2), h('p', { class: 'hint' }, 'The passphrase stays in memory only. Recovery after a crash asks for it; a lost passphrase means the journal cannot be read.')),
        note,
      );
      const r = await modal({ title: 'Save Options', body, buttons: ['OK', 'Cancel'], id: 'save-options' });
      if (r !== 'OK') return;
      j.setEnabled(on.checked);
      if (enc.checked && on.checked) {
        if (!pass.value || pass.value !== pass2.value) return app.toast('The passphrases are empty or do not match; the journal is not encrypted', { kind: 'warn' });
        await j.setPassphrase(pass.value);
        app.toast('The recovery journal is encrypted for this session');
      } else await j.setPassphrase(null);
    },
  });
  app.setJournalPassphrase = (p) => app.journal.setPassphrase(p);

  // ---- Image List ----
  app.on('ready', (mp) => mp.docks.register({ id: 'imagelist', title: 'Image List', icon: 'list', home: 'bottom', create: (a, m, el) => imageList(el) }));
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
        marking: portionMark(l.info.marking),
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
      ['name', 'Name'],
      ['iid', 'Image ID'],
      ['acquired', 'Acquired (UTC)'],
      ['sensor', 'Sensor'],
      ['format', 'Format'],
      ['size', 'Size'],
      ['type', 'Type'],
      ['model', 'Model'],
      ['marking', 'Marking'],
    ];
    const render = () => {
      clear(wrap);
      const rows = imageRows().sort((a, b) => (a[key] === b[key] ? 0 : a[key] < b[key] ? -1 : 1) * dir);
      if (!rows.length) return wrap.appendChild(h('p', { class: 'muted pad' }, 'No images loaded.'));
      const t = h('table', { class: 'grid-table', role: 'grid', 'aria-label': 'Image List' });
      t.appendChild(
        h(
          'thead',
          {},
          h(
            'tr',
            {},
            h('th', { scope: 'col' }, 'Footprint'),
            ...cols.map(([k, l]) => {
              const b = h('button', { class: 'th-sort', 'aria-label': `Sort by ${l}` }, `${l}${key === k ? (dir > 0 ? ' ▲' : ' ▼') : ''}`);
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
        const cb = h('input', { type: 'checkbox', checked: r.footprint, 'aria-label': `Show the footprint of ${r.name}` });
        cb.addEventListener('change', () => {
          app.store.transact('Footprint', (tx) => tx.set(r.id, 'footprint', cb.checked));
          app.renderer.invalidate();
        });
        const tr = h('tr', { 'data-id': `image:${r.id}` }, h('td', {}, cb), ...cols.map(([k]) => h('td', {}, r[k] || '–')));
        tr.addEventListener('dblclick', () => {
          app.selectedLayerId = r.id;
          app.desktop.workspace?.map?.zoomToFootprints?.();
          app.renderer.invalidate();
        });
        tb.appendChild(tr);
      }
      t.appendChild(tb);
      wrap.appendChild(t);
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
        h('table', { class: 'grid-table small', 'aria-label': 'Image segments' }, h('thead', {}, h('tr', {}, ['Segment', 'Size', 'IDLVL', 'IALVL', 'ILOC / position'].map((x) => h('th', { scope: 'col' }, x)))), h('tbody', {}, ...rows.map((r) => h('tr', {}, h('td', {}, String((r.imageIndex ?? 0) + 1)), h('td', {}, `${r.width} × ${r.height}`), h('td', {}, String(r.idlvl ?? '–')), h('td', {}, String(r.ialvl ?? '–')), h('td', {}, r.x !== undefined ? `${r.x}, ${r.y}` : (r.iloc ?? []).join(', ')))))),
        h('p', { class: 'hint' }, l.info.mosaic ? 'Shown as one merged image.' : l.info.mergeable ? 'These segments can be merged into one image.' : `Not mergeable: ${l.info.mergeNote ?? 'one segment'}.`),
      );
      const btns = l.info.mosaic ? ['Show Separately', 'Close'] : l.info.mergeable ? ['Merge', 'Close'] : ['Close'];
      const r = await modal({ title: `Segments — ${ref.name}`, body, buttons: btns, width: 560, id: 'segments' });
      if (r === 'Merge' || r === 'Show Separately') {
        try {
          await app.setSegmentsMerged(r === 'Merge');
        } catch (e) {
          app.toast(e.message, { kind: 'error' });
        }
      }
    },
  });

  // ---- Point files ----
  /**
   * Build point features from delimited text with a column map {lat, lon} or {coord}, name,
   * height (m HAE; the terrain height when missing). Returns {layer, errors}.
   */
  app.pointsFromText = (text, map, { name: nm = 'Points', delim = null, header = true } = {}) => {
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
        errors.push(`row ${i + (header ? 2 : 1)}: ${e.message}`);
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
      const [f] = await pickFiles(app, { multiple: false, accept: ['.csv', '.txt', '.tsv', '.dat'], description: 'Point file' });
      if (!f) return;
      const text = await f.text();
      const { rows, delim } = parseDelimited(text);
      if (!rows.length) return app.toast(`${f.name} has no rows`, { kind: 'warn' });
      const headerCb = h('input', { type: 'checkbox', checked: rows[0].some((c) => !Number.isFinite(Number(c))), 'aria-label': 'First row is a header' });
      const g = guessColumns(rows[0], rows[1] ?? rows[0]);
      const colSel = (label, v) => {
        const s = h('select', { class: 'inp', 'aria-label': label }, h('option', { value: '-1' }, '(none)'), ...rows[0].map((c, i) => h('option', { value: String(i) }, headerCb.checked ? c : `column ${i + 1}`)));
        s.value = String(v);
        return s;
      };
      const lat = colSel('Latitude column', g.lat);
      const lon = colSel('Longitude column', g.lon);
      const coord = colSel('Single coordinate column (MGRS, UTM, DMS …)', g.coord);
      const nmc = colSel('Name column', g.name);
      const hc = colSel('Height column (m HAE)', g.height);
      const preview = h('pre', { class: 'mono small' }, rows.slice(0, 6).map((r) => r.join(' | ')).join('\n'));
      const body = h('div', {}, h('p', { class: 'hint' }, `${rows.length} rows, delimiter ${JSON.stringify(delim)}`), preview, h('label', { class: 'fld fld-inline' }, headerCb, h('span', {}, 'First row is a header')), field('Latitude', lat), field('Longitude', lon), field('Or one coordinate column', coord), field('Name', nmc), field('Height', hc), h('p', { class: 'hint' }, 'Latitude/longitude may be decimal or DMS; a single column may be in any format the tool reads (MGRS, UTM, DMS …). Heights default to the terrain.'));
      if ((await modal({ title: 'Load Point File', body, buttons: ['Load', 'Cancel'], width: 640, id: 'load-points' })) !== 'Load') return;
      const map = { lat: +lat.value, lon: +lon.value, coord: +coord.value >= 0 ? +coord.value : null, name: +nmc.value, height: +hc.value };
      const r = app.pointsFromText(text, map, { name: f.name.replace(/\.\w+$/, ''), delim, header: headerCb.checked });
      if (!r.layer.features.length) return app.toast(`No points read: ${r.errors.slice(0, 3).join('; ')}`, { kind: 'error' });
      app.addVectorLayer(r.layer, { format: 'CSV points', file: f.name, report: { format: 'CSV', direction: 'import', features_in: r.layer.features.length + r.errors.length, features_out: r.layer.features.length, warnings: r.errors, by_geometry: { Point: r.layer.features.length }, fields_renamed: [], text_truncated: {}, dropped: {}, crs: 'WGS 84', vertical: 'HAE', encoding: 'UTF-8' } });
      app.toast(`${r.layer.features.length} point(s) from ${f.name}${r.errors.length ? `; ${r.errors.length} row(s) skipped` : ''}`);
    },
  });
}
