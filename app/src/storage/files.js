// File access by capability (REQ-HOST-02/03, REQ-ARC-10): File System Access pickers where
// allowed, else <input type=file>; save in place, else download, else an in-page export
// panel (copy, open in a new tab) with the reason.

import { h } from '../shell/dom.js';
import { modal } from '../shell/dialogs.js';

export async function pickFiles(app, { multiple = true, accept = [], description = 'Files', dir = false } = {}) {
  if (app.runMode.caps.fsaPicker && !dir) {
    try {
      const handles = await window.showOpenFilePicker({ multiple, excludeAcceptAllOption: false, types: accept.length ? [{ description, accept: { 'application/octet-stream': accept } }] : undefined });
      const files = await Promise.all(handles.map((hd) => hd.getFile()));
      return files.map((f, i) => Object.assign(f, { __handle: handles[i] }));
    } catch (e) {
      if (e.name === 'AbortError') return [];
      app.log('warn', `file picker unavailable (${e.message}); using the file input`);
    }
  }
  return new Promise((resolve) => {
    const inp = h('input', { type: 'file', multiple, accept: accept.join(','), style: { position: 'fixed', left: '-9999px' } });
    if (dir) inp.webkitdirectory = true;
    inp.addEventListener('change', () => {
      resolve([...inp.files]);
      inp.remove();
    });
    inp.addEventListener('cancel', () => {
      resolve([]);
      inp.remove();
    });
    document.body.appendChild(inp);
    inp.click();
  });
}

/** Save a Blob: in place to `handle` when given, else a save picker, else a download. */
export async function saveBlob(app, blob, { name, handle = null, types = [], description = 'File', preferPicker = true } = {}) {
  if (handle?.createWritable) {
    try {
      const w = await handle.createWritable();
      await w.write(blob);
      await w.close();
      return { how: 'in-place', handle };
    } catch (e) {
      app.log('warn', `save in place failed: ${e.message}`);
    }
  }
  if (preferPicker && app.runMode.caps.fsaSave) {
    try {
      const hd = await window.showSaveFilePicker({ suggestedName: name, types: types.length ? [{ description, accept: { [blob.type || 'application/octet-stream']: types } }] : undefined });
      const w = await hd.createWritable();
      await w.write(blob);
      await w.close();
      return { how: 'picker', handle: hd };
    } catch (e) {
      if (e.name === 'AbortError') return { how: 'cancelled' };
      app.log('warn', `save picker failed: ${e.message}`);
    }
  }
  return download(app, blob, name);
}

export function download(app, blob, name) {
  const url = URL.createObjectURL(blob);
  if (!app.runMode.caps.downloadsLikely) {
    return exportPanel(app, blob, name, url, 'Downloads look blocked in this embedded frame (the host page did not grant allow-downloads).');
  }
  const a = h('a', { href: url, download: name, style: { display: 'none' } });
  document.body.appendChild(a);
  a.click();
  setTimeout(() => {
    a.remove();
    URL.revokeObjectURL(url);
  }, 60000);
  return { how: 'download', name };
}

/** In-page export panel (REQ-HOST-03, REQ-WB-15): copy text, open in a new tab, or try a link. */
export async function exportPanel(app, blob, name, url = URL.createObjectURL(blob), reason = '') {
  const isText = /^(text|application\/(json|xml|geo\+json))/.test(blob.type);
  const body = h('div', {}, h('p', {}, reason || 'Use one of these ways to keep the file.'), h('p', {}, h('b', {}, name), ` (${blob.size.toLocaleString()} bytes)`));
  const row = h('div', { class: 'btn-row' });
  if (isText) {
    const b = h('button', { class: 'btn' }, 'Copy to clipboard');
    b.addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(await blob.text());
        app.toast('Copied');
      } catch {
        app.toast('The clipboard is blocked here too', { kind: 'warn' });
      }
    });
    row.appendChild(b);
  }
  const open = h('button', { class: 'btn' }, 'Open in a new tab');
  open.addEventListener('click', () => {
    const w = window.open(url, '_blank', 'noopener');
    if (!w) app.toast('Pop-ups are blocked; right-click the link below and choose "Save link as…"', { kind: 'warn' });
  });
  row.appendChild(open);
  body.append(row, h('p', {}, h('a', { href: url, download: name, target: '_blank', rel: 'noopener' }, `Try the download link: ${name}`)));
  modal({ title: 'Export', body, buttons: ['Close'], id: 'export-panel' });
  return { how: 'export-panel', name };
}

export function textBlob(text, type = 'text/plain') {
  return new Blob([text], { type: `${type};charset=utf-8` });
}

/**
 * Stream a large product to disk (REQ-ARC-21): chunks (an async iterable of Uint8Array/Blob) go
 * straight to a file through the save picker's writable stream in Chromium; elsewhere (or without
 * a picker) they are gathered into one Blob and downloaded. Returns {how, bytes}.
 */
export async function saveStream(app, chunks, { name, types = [], description = 'File', type = 'application/octet-stream', preferPicker = true } = {}) {
  let bytes = 0;
  if (preferPicker && app.runMode.caps.fsaSave) {
    let hd = null;
    try {
      hd = await window.showSaveFilePicker({ suggestedName: name, types: types.length ? [{ description, accept: { [type]: types } }] : undefined });
    } catch (e) {
      if (e.name === 'AbortError') return { how: 'cancelled', bytes };
      app.log('warn', `save picker failed: ${e.message}`);
    }
    if (hd) {
      const w = await hd.createWritable();
      try {
        for await (const c of chunks) {
          await w.write(c);
          bytes += c.byteLength ?? c.size ?? 0;
        }
        await w.close();
      } catch (e) {
        await w.abort?.();
        throw e;
      }
      return { how: 'stream', handle: hd, bytes };
    }
  }
  const parts = [];
  for await (const c of chunks) {
    parts.push(c);
    bytes += c.byteLength ?? c.size ?? 0;
  }
  return { ...download(app, new Blob(parts, { type }), name), bytes };
}
