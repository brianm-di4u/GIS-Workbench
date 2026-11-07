// The optional sidecar in the app (REQ-SDC-01..10, REQ-HOST-10, REQ-FMT-56; SDP-2.1 §3.2–§3.6).
// Everything here is optional: with no sidecar the app works as before, nothing is requested at
// start-up unless this page paired earlier, and a missing sidecar changes only the commands that
// need it, which say how to install or start it.
//
// Other features convert through one command contract:
//   app.commands.run('sidecar.convert', { files, profile, reason, options?, open? })
// `files`: File objects (the first is the main file, the rest travel with it: .sdw, .aux.xml…)
// or sidecar file ids; `profile`: e.g. 'raster-cog', 'video-h264-klv' (omitted:
// the sidecar probes and picks); `open` (default true): open the result in place by range.

import { SidecarClient, TokenStore, profileForName, sidecarError, DOWNLOAD_URL, API_NEEDED } from './client.js';
import { remoteFile } from '../connectors/remote.js';
import { h, clear } from '../shell/dom.js';
import { modal, field } from '../shell/dialogs.js';
import { pickFiles, saveBlob } from '../storage/files.js';
import { fmtBytes, errorText } from '../core/util.js';
import { t, N_, tr, gwError, msgOf } from '../i18n/index.js';
import { collator } from '../i18n/format.js';
import { loadBlock, once, lazyCommands } from '../features/lazy-host.js';

export const name = 'sidecar';

const RASTER_OUT = /\.(tif|tiff|jp2|ntf|nitf)$/i;
const ACTIVE = new Set(['queued', 'running']);
/** Job states as the sidecar reports them (data), with their display names. */
const STATE_NAME = { queued: N_('queued'), running: N_('running'), succeeded: N_('succeeded'), failed: N_('failed'), cancelled: N_('cancelled') };
const stateName = (s) => (STATE_NAME[s] ? tr(STATE_NAME[s]) : s);
/** An error message in the UI language; errorText() swaps decoder crashes for a plain explanation (core/util.js). */
// errorText() is already in the UI language (its rewrite through t(), else msgOf(e)): no second t().
const errMsg = (e) => errorText(e);
const pctText = (p) => t('{n} %', { n: p });

export function install(app) {
  const C = app.commands;
  const airgap = () => app.gw?.manifest?.build?.profile === 'airgap' || app.network?.airgap;
  const S = { status: 'idle', hello: null, caps: null, error: '', mode: app.runMode?.mode ?? 'file' };
  const jobs = new Map(); // id → {job, label, log: [], at}
  const client = new SidecarClient({ fetch: app.netlog.fetchFor('sidecar'), store: new TokenStore() });

  // ---------------- switch (REQ-SDC-14: off by default in the air-gapped file) ----------------
  const enabled = () => {
    const p = app.prefs.get('sidecar');
    return airgap() ? p === 'on' : p !== 'off';
  };
  const setEnabled = (on) => {
    app.prefs.set('sidecar', on ? 'on' : 'off');
    if (!on) setStatus('off');
    else setStatus(client.token ? 'idle' : 'idle');
    app.emit('state');
  };

  function setStatus(s, error = '') {
    S.status = s;
    S.error = error;
    app.emit('sidecar', S);
    renderPills();
  }

  const statusText = () => {
    const running = [...jobs.values()].filter((j) => ACTIVE.has(j.job.state)).length;
    if (!enabled()) return [t('Sidecar off'), t('The local sidecar is switched off. Click to change.')];
    switch (S.status) {
      case 'paired':
        if (app.sidecar?.proSync?.on) return [t('Sidecar · ArcGIS Pro sync'), t('Sync with ArcGIS Pro is on. Click for details.')];
        if (app.sidecar?.relay?.on) return [t('Sidecar · Python relay'), t('The Python relay is on: scripts paired with the sidecar can use this page. Click for details.')];
        return [running ? t('Sidecar · {n, plural, one {# job} other {# jobs}}', { n: running }) : t('Sidecar ✓'), t('Sidecar {version} on {base} is paired with this page. Click for details.', { version: S.hello?.version ?? '', base: client.base })];
      case 'unpaired':
        return [t('Sidecar: pair'), t('A sidecar is running on {base}; this page is not paired yet. Click to pair.', { base: client.base })];
      case 'absent':
        return [t('No sidecar'), t('No sidecar answered on 127.0.0.1:47821–47823. Click to see how to install or start it.')];
      case 'outdated':
        return [t('Sidecar: update'), t('The sidecar on {base} speaks API {api}; this app needs {needed}. Update the sidecar.', { base: client.base, api: String(S.hello?.api), needed: String(API_NEEDED) })];
      case 'blocked':
        return [t('Sidecar blocked'), S.error];
      case 'error':
        return [t('Sidecar ⚠'), S.error];
      default:
        return [t('Sidecar'), t('The optional local sidecar converts formats the browser cannot read. Click to look for it.')];
    }
  };

  // ---------------- status bar (REQ-HOST-10) ----------------
  const pills = new Set();
  function renderPills() {
    const [label, tip] = statusText();
    for (const b of pills) {
      b.textContent = label;
      b.title = tip;
      b.dataset.state = enabled() ? S.status : 'off';
      b.classList.toggle('on', S.status === 'paired' && enabled());
    }
  }
  const addPill = (mp) => {
    const row = mp.status?.rows?.[0];
    if (!row) return;
    const b = h('button', { class: 'status-net status-sidecar', type: 'button', 'data-id': `status:sidecar:${mp.id}`, 'aria-label': t('Sidecar state') });
    b.addEventListener('click', () => C.run('sidecar.status'));
    row.insertBefore(b, row.querySelector('.status-jobs'));
    pills.add(b);
    renderPills();
  };
  app.on('ready', (mp) => addPill(mp));
  const origAdd = app.desktop.addMultiport.bind(app.desktop);
  app.desktop.addMultiport = (id) => {
    const mp = origAdd(id);
    if (app._ready) addPill(mp);
    return mp;
  };

  // ---------------- discovery and pairing ----------------
  async function refresh({ quiet = false } = {}) {
    if (!enabled()) return setStatus('off');
    const hello = await client.discover();
    S.hello = hello;
    if (!hello) {
      // S-42: Chrome/Edge block public pages from loopback until the user grants Local Network
      // Access (one prompt); frames need the host page to allow it.
      const embedded = /iframe|srcdoc/.test(S.mode);
      const hosted = location.protocol === 'https:' && !/^(127\.0\.0\.1|localhost|\[::1\])$/.test(location.hostname);
      if (embedded) return setStatus('blocked', t('No sidecar answered. In an embedded page the host must allow loopback (Local Network Access) for this frame.'));
      if (hosted) return setStatus('blocked', t('No sidecar answered. If it is running, allow this site to access apps on your device (the browser asks once: Local Network Access), or open GIS Workbench from the sidecar at http://127.0.0.1:47821/app/.'));
      return setStatus('absent');
    }
    if (hello.api < API_NEEDED) return setStatus('outdated');
    if (!client.paired) return setStatus('unpaired');
    setStatus('paired');
    try {
      S.caps = await client.caps();
      app.emit('sidecar-caps', S.caps);
    } catch (e) {
      if (!quiet) setStatus('error', errMsg(e));
    }
    return S.caps;
  }

  async function pairDialog() {
    const code = h('div', { class: 'sidecar-code', 'aria-live': 'polite', 'data-id': 'sidecar:code' }, '······');
    const msg = h('p', { class: 'hint' }, t('Asking the sidecar…'));
    const ac = new AbortController();
    const base = client.base ?? '127.0.0.1';
    const intro = location.protocol === 'file:' ? t('Pair this page (a local file) with the sidecar on {base}. The sidecar window shows the same six digits: check them and click Allow there.', { base }) : t('Pair this page ({origin}) with the sidecar on {base}. The sidecar window shows the same six digits: check them and click Allow there.', { origin: location.origin, base });
    const body = h('div', {}, h('p', {}, intro), code, msg);
    const dlg = modal({ title: t('Pair with Sidecar'), body, buttons: [{ label: t('Cancel'), value: 'cancel', primary: true }], width: 520, id: 'sidecar-pair' });
    let outcome = null;
    const run = client
      .pair({
        client: `GIS Workbench ${app.gw?.manifest?.build?.version ?? ''} (${app.gw?.manifest?.build?.profile ?? 'standard'})`.trim(),
        signal: ac.signal,
        onCode: (c) => {
          code.textContent = c;
          msg.textContent = t('Waiting for Allow in the sidecar window…');
        },
      })
      .then(
        () => (outcome = 'paired'),
        (e) => (outcome = e),
      )
      .finally(() => document.querySelector('[data-id="dialog:sidecar-pair"]')?.finish?.('done'));
    const r = await dlg;
    if (r !== 'done') ac.abort();
    await run;
    if (outcome === 'paired') {
      app.toast(t('Paired with the sidecar.'), { kind: 'info' });
      await refresh();
      return true;
    }
    if (outcome instanceof Error && outcome.code !== 'cancelled') app.toast(t('Sidecar: {msg}', { msg: msgOf(outcome) }), { kind: 'warn', ms: 8000 });
    return false;
  }

  /** A paired client with caps, or an error that says what to do. */
  async function ready({ interactive = true } = {}) {
    if (!enabled()) throw airgap() ? sidecarError(N_('the Sidecar switch is off in the air-gapped file: turn it on in the Sidecar status (status bar)'), null, { code: 'off' }) : sidecarError(N_('the sidecar is switched off (status bar ▸ Sidecar)'), null, { code: 'off' });
    if (S.status !== 'paired' || !S.caps) await refresh();
    if (S.status === 'absent' || S.status === 'blocked') throw sidecarError(N_('no sidecar is running on this computer. Install GIS Workbench Sidecar ({url}) or start it from the Start menu'), { url: DOWNLOAD_URL }, { code: 'absent' });
    if (S.status === 'outdated') throw sidecarError(N_('the sidecar is too old (API {api}, this app needs {needed}): update it'), { api: String(S.hello?.api), needed: String(API_NEEDED) }, { code: 'outdated' });
    if (S.status === 'unpaired') {
      if (!interactive || !(await pairDialog())) throw sidecarError(N_('this page is not paired with the sidecar'), null, { code: 'unpaired' });
    }
    if (!S.caps) S.caps = await client.caps();
    return S.caps;
  }

  // ---------------- jobs ----------------
  function track(job, label) {
    const rec = { job, label: label ?? job.profile, log: [], at: Date.now() };
    jobs.set(job.id, rec);
    changed();
    const done = (async () => {
      try {
        for await (const ev of client.events(job.id)) {
          if (ev.type === 'progress') rec.job = { ...rec.job, progress: ev.progress };
          else if (ev.type === 'state') rec.job = { ...rec.job, state: ev.state };
          else if (ev.type === 'log') {
            rec.log.push(ev.line);
            if (rec.log.length > 400) rec.log.shift();
          } else if (ev.type === 'done') rec.job = ev.job;
          changed();
        }
      } catch {
        rec.job = await client.job(job.id).catch(() => ({ ...rec.job, state: 'failed', error: t('the sidecar stopped answering') }));
      }
      // The stream can end before the final state is visible (a dropped connection): ask once.
      if (ACTIVE.has(rec.job.state)) rec.job = await client.job(job.id).catch(() => rec.job);
      changed();
      return rec.job;
    })();
    rec.done = done;
    return rec;
  }
  let pend = 0;
  function changed() {
    if (pend) return;
    pend = requestAnimationFrame(() => {
      pend = 0;
      app.emit('sidecar-jobs');
      renderPills();
      renderDock();
    });
  }
  app.sidecarJobs = () => [...jobs.values()].filter((j) => ACTIVE.has(j.job.state)).map((j) => ({ id: j.job.id, op: 'sidecar', label: t('Sidecar: {job}', { job: j.label }), progress: j.job.progress ?? NaN, cancel: () => client.cancel(j.job.id).catch(() => {}) }));

  /** A copy to or from the sidecar, in the activity indicator with Cancel (OD-2.27). */
  async function copying(label, work) {
    let job = null;
    try {
      return await app.activity.track(label, (j) => work((job = j).signal), { cancel: true });
    } catch (e) {
      throw job?.cancelled ? Object.assign(gwError('cancelled', null, 'cancelled'), { cancelled: true }) : e;
    }
  }
  /** File ids this session sent → their names, so a route that passes ids still names its job. */
  const sentNames = new Map();
  async function send(main, rest = []) {
    const up = await copying(t('Sending {file} ({size}) to the sidecar…', { file: main.name, size: fmtBytes(main.size) }), (signal) => client.uploadSet(main, rest, { signal }));
    sentNames.set(up.id, main.name);
    return up;
  }
  const fetchOutput = (out) =>
    copying(t('Reading {file} from the sidecar…', { file: out.name }), async (signal) => {
      const r = await client.request('GET', `/v1/files/${out.id}`, { raw: true, signal });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return r.blob();
    });

  /**
   * MrSID and ECW need the vendor plug-in, which only the Windows sidecar has (P16): say so before
   * a multi-gigabyte upload, not after GDAL fails to recognise the file.
   */
  function vendorCheck(first, reason = '') {
    const vendorId = /\.sid$/i.test(first) || /mrsid/i.test(reason) ? 'vendor-mrsid' : /\.ecw$/i.test(first) || /\bECW\b/.test(reason) ? 'vendor-ecw' : null;
    const sdk = vendorId && S.caps?.vendor?.find((v) => v.id === vendorId);
    if (sdk && !sdk.installed) throw /Windows only/.test(sdk.source ?? '') ? gwError('this sidecar cannot decode {format}: the vendor plug-in exists for Windows only, so convert the file with the Windows sidecar', { format: vendorId === 'vendor-mrsid' ? 'MrSID' : 'ECW' }, 'E_SIDECAR_VENDOR_WINDOWS') : gwError('the {module} is not installed: add it in the sidecar window (Add or remove modules…)', { module: sdk.name.replace(/ \(.*$/, '') }, 'E_SIDECAR_VENDOR_MISSING');
  }

  /** Upload (or take ids), queue the job, follow it; resolves with the finished job. */
  async function convert({ files = [], profile = null, reason = '', options = {}, open = true, outputName, exact = false, label = null } = {}) {
    await ready();
    const list = [...(files ?? [])];
    if (!list.length) throw new Error('nothing to convert');
    vendorCheck(typeof list[0] === 'string' ? list[0] : list[0].name, reason);
    // Linux with Cisco's OpenH264 installed (REQ-GAP-51): H.264 in place of the MPEG-1 fallback.
    if (!exact && profile === 'video-h264-klv' && S.caps.profiles.find((p) => p.id === 'video-h264-openh264')?.available) profile = 'video-h264-openh264';
    let inputs;
    let mainName;
    if (typeof list[0] === 'string') {
      inputs = list;
      mainName = sentNames.get(list[0]) ?? list[0];
    } else {
      const [main, ...rest] = list;
      mainName = main.name;
      inputs = [(await send(main, rest)).id];
    }
    let opts = options ?? {};
    if (!profile) {
      const p = await probe(inputs[0], mainName);
      profile = p.profile;
      opts = { ...(p.options ?? {}), ...opts };
    }
    const prof = S.caps.profiles.find((p) => p.id === profile);
    if (!prof) throw gwError('the sidecar has no {profile} profile', { profile }, 'E_SIDECAR_NO_PROFILE');
    if (!prof.available) throw gwError("the sidecar's {module} module is not installed (needed for {title})", { module: prof.module, title: prof.title }, 'E_SIDECAR_NO_MODULE');
    const job = await client.createJob({ profile, inputs, options: opts, reason: String(reason || '').slice(0, 200) || undefined, output_name: outputName });
    const rec = track(job, `${prof.title}: ${label ?? mainName}`);
    app.toast(t('{title}: {file} queued in the sidecar. Progress is in Sidecar Jobs.', { title: prof.title, file: label ?? mainName }), { kind: 'info', action: { label: t('Show jobs'), run: () => C.run('sidecar.jobs') } });
    const fin = await rec.done;
    if (fin.state !== 'succeeded') throw fin.error ? gwError('{title} {state}: {error}', { title: prof.title, state: stateName(fin.state), error: fin.error }, 'E_SIDECAR_JOB') : gwError('{title} {state}', { title: prof.title, state: stateName(fin.state) }, 'E_SIDECAR_JOB');
    if (open && fin.outputs?.length) await openOutput(fin.outputs[0]).catch((e) => e.cancelled || app.toast(t('Opening {file}: {msg}', { file: fin.outputs[0].name, msg: errMsg(e) }), { kind: 'error', ms: 9000 }));
    return fin;
  }

  /** Universal import (REQ-SDC-09): probe, then the matching profile. */
  async function probe(id, name) {
    const job = await client.createJob({ profile: 'probe', inputs: [id], reason: `identify ${name}`.slice(0, 200) });
    const rec = track(job, t('Identify {file}', { file: name }));
    const fin = await rec.done;
    const m = fin.result?.match;
    if (!m?.profile) {
      const kinds = (fin.result?.matches ?? []).map((x) => (x.available ? t('{format} ({kind})', { format: x.format, kind: x.kind }) : t('{format} ({kind}, module not installed)', { format: x.format, kind: x.kind })));
      throw kinds.length ? gwError('the sidecar recognises {file} as {kinds}, but cannot convert it here', { file: name, kinds: kinds.join(', ') }, 'E_SIDECAR_CANNOT_CONVERT') : gwError("none of the sidecar's tools recognises {file}", { file: name }, 'E_SIDECAR_UNRECOGNISED');
    }
    return m;
  }

  async function openOutput(out) {
    if (RASTER_OUT.test(out.name)) {
      // In place, by range, like an online COG (REQ-SDC-07): no download.
      const f = await remoteFile(app, client.fileUrl(out.id), { name: out.name, size: out.size, purpose: 'sidecar', sign: client.signer() });
      const { openImageFile } = await import('../formats/open.js');
      const r = await openImageFile(app, f, { pane: app.activePane() });
      const lid = r.layers?.[0]?.id;
      app.importLog?.push({ file: out.name, errors: [], warnings: [t('opened in place from the sidecar by range')] });
      app.toast(t('Opened {file} from the sidecar ({size}; read by range).', { file: out.name, size: fmtBytes(out.size) }), lid ? { kind: 'info', action: { label: t('Zoom to layer'), run: () => app.zoomToLayer?.(lid) } } : { kind: 'info' });
      app.desktop?.workspace?.map?.zoomToFootprints?.();
      return r;
    }
    const file = new File([await fetchOutput(out)], out.name);
    return app.openFiles([file], app.activePane());
  }

  async function saveOutput(out) {
    const r = await client.saveFile(out.id);
    if (r?.saved) app.toast(t('Saved {file} in {folder}.', { file: out.name, folder: r.folder }), { kind: 'info' });
  }

  async function downloadOutput(out) {
    const blob = await fetchOutput(out).catch((e) => {
      if (!e.cancelled) throw e;
    });
    if (blob) await saveBlob(app, blob, { name: out.name, types: [`.${out.name.split('.').pop()}`], description: out.name });
  }

  // ---------------- refusals (REQ-FMT-56) ----------------
  // Refusals are recognised by their code (DN-62 L0): 4 is the decode worker's "cannot be opened
  // as imagery". Errors without a code (Rust decoders, older readers) fall back to their English
  // message, which gwError and the core keep English in every locale; the translated text is never
  // read.
  const REFUSAL_CODES = new Set([4, 'E_EPT_TYPE', 'E_PNG_DEPTH', 'E_BPF_VERSION', 'E_ZIP_METHOD', 'E_WKT_TYPE', 'E_WKB_TYPE', 'E_PMTILES_HEADER', 'E_FGB_UNREADABLE', 'E_PARQUET_FOOTER']);
  const NOT_CONVERTIBLE_CODES = new Set(['E_BPF_QUICKLZ', 'E_BPF_TRUNCATED', 'E_LAS_TRUNCATED', 'E_ZIP_TRUNCATED', 'E_ZIP_DAMAGED', 'E_ZOOM_NO_TILES']);
  const REFUSAL = /cannot be opened|not read in this release|is not read|unrecognised data|no open decoder|needs the sidecar|sidecar route|convert it|not supported|cannot be read/i;
  const NOT_CONVERTIBLE = /QuickLZ|damaged|truncated|holds no tiles|compressed signal array/i;
  /**
   * The toast action for a file the app refused: "Convert with Sidecar" when one is paired (or
   * may be), "Install the sidecar" when none runs. `hint` may name the profile.
   */
  function refusalAction(file, err, hint = {}) {
    const msg = errorText(err ?? '', { english: true });
    const code = err?.code;
    const notConvertible = NOT_CONVERTIBLE_CODES.has(code) || NOT_CONVERTIBLE.test(msg);
    const refused = REFUSAL_CODES.has(code) || NOT_CONVERTIBLE_CODES.has(code) || REFUSAL.test(msg);
    if (!file || (!refused && !hint.profile && !err?.sidecar)) return undefined;
    // Refusals the sidecar cannot help with: QuickLZ BPF (its PDAL decodes it wrongly, S-45) and
    // damaged or empty files.
    if (!hint.profile && !err?.sidecar && notConvertible) return undefined;
    const profile = hint.profile ?? err?.sidecar?.profile ?? profileForName(file.name);
    if (!enabled() || S.status === 'absent') return { label: t('Install the sidecar'), run: () => installInfo(file.name) };
    return {
      label: t('Convert with Sidecar'),
      run: () => C.run('sidecar.convert', { files: [file, ...(hint.companions ?? [])], profile, reason: `refused by the app: ${msg.slice(0, 120)}` }),
    };
  }

  async function installInfo(what) {
    const body = h(
      'div',
      {},
      h('p', {}, what ? t('{file} needs a conversion the browser cannot do. GIS Workbench Sidecar is an optional, separately installed helper that runs on this computer only (127.0.0.1) and converts MrSID, ECW, FileGDB, E57, MPEG-2 and every other GDAL, OGR, PDAL or FFmpeg format into ones this app reads.', { file: what }) : t('GIS Workbench Sidecar is an optional, separately installed helper that runs on this computer only (127.0.0.1) and converts MrSID, ECW, FileGDB, E57, MPEG-2 and every other GDAL, OGR, PDAL or FFmpeg format into ones this app reads.')),
      h('p', {}, t('Download it from the release page (Windows: the installer or the portable ZIP; Linux: the .deb package or the AppImage), start it, then click Pair here. MrSID and ECW need the Windows build, the only one with the vendor plug-ins. These preview builds are unsigned.')),
      h('p', { class: 'hint mono' }, DOWNLOAD_URL),
    );
    const r = await modal({ title: t('Install the sidecar'), body, buttons: [{ label: t('Open the release page'), value: 'open', primary: true }, { label: t('Look again'), value: 'look' }, { label: t('Close'), value: 'close' }], width: 560, id: 'sidecar-install' });
    if (r === 'open') window.open(DOWNLOAD_URL, '_blank', 'noopener');
    if (r === 'look') await refresh().then(() => app.toast(statusText()[1], { kind: 'info' }));
  }

  // ---------------- status dialog ----------------
  async function statusDialog() {
    if (enabled() && S.status === 'idle') await refresh().catch(() => {});
    const [label, tip] = statusText();
    const on = h('input', { type: 'checkbox', checked: enabled(), 'data-id': 'sidecar:switch' });
    const hp = S.hello ? { version: S.hello.version, api: String(S.hello.api), channel: S.hello.channel, base: client.base, origin: S.hello.origin } : null;
    const info = hp ? h('p', { class: 'hint' }, S.hello.paired ? t('Sidecar {version} (API {api}, {channel}) on {base}; this page is paired (origin {origin}).', hp) : t('Sidecar {version} (API {api}, {channel}) on {base}; this page is not paired (origin {origin}).', hp)) : null;
    const mods = S.caps ? h('ul', { class: 'hint' }, ...S.caps.modules.map((m) => h('li', {}, m.installed ? (m.size ? t('{module}: installed, {size}', { module: m.title, size: fmtBytes(m.size) }) : t('{module}: installed', { module: m.title })) : t('{module}: not installed', { module: m.title })))) : null;
    const body = h('div', {}, h('p', {}, h('b', {}, label), ' — ', tip), info, mods, field(t('Use the sidecar'), on, airgap() ? t('The air-gapped file makes only loopback calls when this is on; the sidecar itself never connects out.') : t('Loopback calls (127.0.0.1) are allowed while Offline and appear in the Network Log.')));
    const first = S.status === 'unpaired' ? { label: t('Pair'), value: 'pair' } : S.status === 'paired' ? { label: t('Forget Sidecar'), value: 'forget' } : S.status === 'absent' ? { label: t('Install…'), value: 'install' } : { label: t('Look again'), value: 'look' };
    const buttons = [{ ...first, primary: true }, { label: t('Close'), value: 'close' }];
    const r = await modal({ title: t('Sidecar'), body, buttons, width: 560, id: 'sidecar-status' });
    if (on.checked !== enabled()) setEnabled(on.checked);
    if (r === 'pair') await pairDialog();
    if (r === 'forget') await C.run('sidecar.forget');
    if (r === 'install') await installInfo();
    if (r === 'look') await refresh();
  }

  // ---------------- options form from a profile (no hard-coded lists: REQ-SDC-05) ----------------
  function optionsForm(profile, caps) {
    const controls = {};
    const rows = [];
    for (const o of profile.options) {
      let el;
      if (o.type === 'enum') el = h('select', { class: 'inp' }, ...(o.optional ? [h('option', { value: '' }, t('(default)'))] : []), ...o.values.map((v) => h('option', { value: v, selected: v === o.default }, v)));
      else if (o.type === 'bool') el = h('input', { type: 'checkbox', checked: !!o.default });
      else if (o.type === 'int' || o.type === 'float') el = h('input', { type: 'number', class: 'inp', min: o.min ?? '', max: o.max ?? '', step: o.type === 'int' ? '1' : 'any', value: o.default ?? '', placeholder: o.optional ? t('(none)') : '' });
      else if (o.type === 'crs') el = h('input', { type: 'text', class: 'inp', placeholder: o.optional ? t('EPSG:4326 (optional)') : 'EPSG:4326', pattern: 'EPSG:[0-9]{4,6}(\\+[0-9]{4,6})?' });
      else if (o.type === 'float_list') el = h('input', { type: 'text', class: 'inp', placeholder: t('Numbers separated by spaces (optional)') });
      else if (o.type === 'name') el = h('input', { type: 'text', class: 'inp', maxlength: '63' });
      else if (o.type === 'raster_driver' || o.type === 'vector_driver') {
        const cmp = collator().compare;
        const list = (o.type === 'raster_driver' ? caps.raster_drivers : caps.vector_drivers).filter((d) => d.write).sort((a, b) => cmp(a.long_name, b.long_name));
        el = h('select', { class: 'inp' }, ...list.map((d) => h('option', { value: d.name }, `${d.long_name} (${d.name}${d.extensions[0] ? `, .${d.extensions[0]}` : ''})`)));
      } else if (o.type === 'creation_options') el = h('textarea', { class: 'inp mono', rows: '3', placeholder: t('KEY=VALUE, one per line (checked against the format)') });
      else continue;
      el.dataset.opt = o.name;
      controls[o.name] = { o, el };
      rows.push(field(o.title, el));
    }
    const read = () => {
      const out = {};
      for (const { o, el } of Object.values(controls)) {
        if (o.type === 'bool') {
          if (el.checked !== !!o.default) out[o.name] = el.checked;
        } else if (o.type === 'float_list') {
          const items = el.value.trim().split(/[\s,;]+/).filter(Boolean).map(Number);
          if (items.length) out[o.name] = items;
        } else if (o.type === 'int' || o.type === 'float') {
          if (el.value !== '' && Number(el.value) !== o.default) out[o.name] = Number(el.value);
        } else if (o.type === 'creation_options') {
          const items = el.value.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
          if (items.length) out[o.name] = items;
        } else if (el.value) {
          if (el.value !== o.default) out[o.name] = el.value;
        }
      }
      return out;
    };
    return { el: h('div', { class: 'sidecar-opts' }, ...rows), read, controls };
  }

  // ---------------- Convert dialog ----------------
  async function convertDialog({ files = null, ids = null, title = t('Convert with Sidecar') } = {}) {
    const caps = await ready();
    let list = files;
    if (!list && !ids) list = await pickFiles(app, { multiple: true, accept: [], description: t('Files to convert (with their companion files)') });
    if (!list?.length && !ids?.length) return;
    const main = ids ? { name: ids.name ?? t('picked file'), size: ids.size ?? 0 } : list[0];
    const status = h('p', { class: 'hint', 'aria-live': 'polite' }, t('Identifying {file}…', { file: main.name }));
    // Upload once; probe; then offer the profiles of that data kind.
    let inputs = ids?.list;
    if (!inputs) {
      status.textContent = t('Sending {file} ({size}) to the sidecar…', { file: main.name, size: fmtBytes(main.size) });
      inputs = [(await send(list[0], list.slice(1))).id];
    }
    let m = null;
    try {
      m = await probe(inputs[0], main.name);
    } catch (e) {
      status.textContent = errMsg(e);
    }
    const kinds = { raster: 'raster', vector: 'vector', points: 'points', video: 'video' };
    // One file, one result: the profiles with their own commands (two inputs, or a JSON answer) stay out.
    const fits = (p) => (p.id !== 'pdf-cog' || m?.format === 'PDF') && (p.id !== 'raster-sds-cog' || m?.subdatasets > 0);
    const offered = caps.profiles.filter((p) => p.available && p.min_inputs === 1 && p.output_ext !== '' && p.input !== 'model' && p.id !== 'sfm-block' && fits(p) && (!m || p.input === kinds[m.kind] || p.input === 'any'));
    if (!offered.length) return app.toast(t('{file}: {msg}', { file: main.name, msg: status.textContent }), { kind: 'warn', ms: 9000 });
    const preferred = m?.profile === 'video-h264-klv' && offered.some((p) => p.id === 'video-h264-openh264') ? 'video-h264-openh264' : m?.profile;
    const sel = h('select', { class: 'inp', 'data-id': 'sidecar:profile' }, ...offered.map((p) => h('option', { value: p.id, selected: p.id === preferred }, p.title)));
    const optsBox = h('div');
    let form = null;
    const showOpts = () => {
      const p = offered.find((x) => x.id === sel.value);
      form = optionsForm(p, caps);
      clear(optsBox);
      optsBox.append(form.el);
      for (const [k, v] of Object.entries(m?.options ?? {})) if (form.controls[k]) form.controls[k].el.value = v;
      // A container's parts by GDAL's description: its number alone says nothing to a person.
      const list = m?.subdataset_list ?? [];
      const num = form.controls.subdataset?.el;
      if (num && list.length) {
        const pick = h('select', { class: 'inp', 'data-id': 'sidecar:subdataset' }, ...list.map((s) => h('option', { value: s.n }, `${s.n}: ${s.desc}`)));
        pick.addEventListener('change', () => (num.value = pick.value));
        num.closest('label, .field')?.setAttribute('hidden', '');
        optsBox.prepend(field(t('Subdataset'), pick));
      }
    };
    sel.addEventListener('change', showOpts);
    showOpts();
    const openIt = h('input', { type: 'checkbox', checked: true });
    if (m) {
      // A list of facts about the file: each item is one message; the separators are not words.
      const facts = [m.long_name ? `${m.format ?? m.kind} — ${m.long_name}` : `${m.format ?? m.kind}`];
      if (m.size) facts.push(t('{size} px', { size: m.size.join(' × ') }));
      if (m.bands) facts.push(t('{n, plural, one {# band} other {# bands}}', { n: m.bands }));
      if (m.layers) facts.push(t('{n, plural, one {# layer} other {# layers}}', { n: m.layers.length }));
      if (m.points) facts.push(t('{n, plural, one {# point} other {# points}}', { n: m.points }));
      if (m.subdatasets) facts.push(t('{n, plural, one {# subdataset} other {# subdatasets}}', { n: m.subdatasets }));
      if (m.klv_streams) facts.push(t('{n, plural, one {# KLV stream} other {# KLV streams}}', { n: m.klv_streams }));
      status.textContent = `${main.name}: ${facts.join(' · ')}`;
    }
    const body = h('div', {}, status, field(t('Conversion'), sel), optsBox, field(t('Open the result when done'), openIt));
    const r = await modal({ title, body, buttons: [{ label: t('Convert'), value: 'convert', primary: true }, { label: t('Cancel'), value: 'cancel' }], width: 600, id: 'sidecar-convert' });
    if (r !== 'convert') return;
    return convert({ files: inputs, profile: sel.value, options: form.read(), open: openIt.checked, reason: 'Convert with Sidecar', outputName: ids ? undefined : main.name, exact: true });
  }

  async function pickInSidecar() {
    await ready();
    const r = await client.pick('files', t('Choose the file to convert (and its companion files)'));
    if (!r.files.length) return;
    const main = r.files[0];
    return convertDialog({ ids: { list: r.files.map((f) => f.id).slice(0, 1), name: main.name, size: main.size }, title: t('Convert with Sidecar — {file}', { file: main.name }) });
  }

  async function batchDialog() {
    const caps = await ready();
    const r = await client.pick('folder', t('Choose the folder to convert'));
    const folder = r.files[0];
    if (!folder) return;
    // A folder with no files of its own that GDAL reads as one raster: a TileDB array.
    if (!folder.entries.length) return convertDialog({ ids: { list: [folder.id], name: folder.name, size: 0 }, title: t('Convert with Sidecar — {file}', { file: folder.name }) });
    const exts = [...new Set(folder.entries.map((n) => n.split('.').pop().toLowerCase()).filter((e) => e && e.length <= 10))].sort();
    const ext = h('select', { class: 'inp' }, ...exts.map((e) => h('option', { value: e, selected: e === 'sid' }, `.${e} (${folder.entries.filter((n) => n.toLowerCase().endsWith(`.${e}`)).length})`)));
    const how = h('select', { class: 'inp' }, h('option', { value: 'each' }, t('One COG per file')), h('option', { value: 'mosaic' }, t('One mosaic COG of all files (VRT)')));
    const prof = h('select', { class: 'inp' }, ...caps.profiles.filter((p) => p.available && p.min_inputs === 1 && p.output_ext !== '' && p.input !== 'model' && p.id !== 'raster-vrt-cog' && p.id !== 'sfm-block').map((p) => h('option', { value: p.id }, p.title)));
    const body = h('div', {}, h('p', {}, t('{folder}: {n, plural, one {# file} other {# files}}.', { folder: folder.name, n: folder.entries.length })), field(t('Files'), ext), field(t('Result'), how), field(t('Conversion (one per file)'), prof));
    const b = await modal({ title: t('Convert a Folder with Sidecar'), body, buttons: [{ label: t('Convert'), value: 'convert', primary: true }, { label: t('Cancel'), value: 'cancel' }], width: 560, id: 'sidecar-batch' });
    if (b !== 'convert') return;
    if (how.value === 'mosaic') {
      // Each file of the delivery becomes a picked input; the sidecar builds the VRT itself.
      const res = await client.batch({ profile: 'probe', folder: folder.id, extensions: [ext.value] });
      const ids = res.jobs.map((j) => j.inputs[0]);
      res.jobs.forEach((j) => track(j, t('Identify {file}', { file: j.inputs[0] })));
      return convert({ files: ids, profile: 'raster-vrt-cog', reason: `mosaic of ${folder.name}`, outputName: `${folder.name}.tif` });
    }
    const res = await client.batch({ profile: prof.value, folder: folder.id, extensions: [ext.value] });
    for (const j of res.jobs) track(j, `${prof.selectedOptions[0].textContent}: ${folder.name}`);
    app.toast(t('{n, plural, one {# conversion} other {# conversions}} queued in the sidecar.', { n: res.jobs.length }), { kind: 'info', action: { label: t('Show jobs'), run: () => C.run('sidecar.jobs') } });
    C.run('sidecar.jobs');
  }

  // ---------------- Save As with any GDAL/OGR writer (REQ-SDC-10) ----------------
  async function saveAsDialog(args = {}) {
    const caps = await ready();
    const files = args.files ?? (await pickFiles(app, { multiple: true, accept: [], description: t('The file to save in another format (with its companion files)') }));
    if (!files?.length) return;
    const kind = h('select', { class: 'inp' }, h('option', { value: 'export-gdal' }, t('Raster (GDAL writers)')), h('option', { value: 'export-ogr', selected: /\.(geojson|json|shp|gpkg|kml|gml|fgb|csv|parquet|gpx)$/i.test(files[0].name) }, t('Vector (OGR writers)')));
    const box = h('div');
    let form;
    const show = () => {
      form = optionsForm(caps.profiles.find((p) => p.id === kind.value), caps);
      clear(box);
      box.append(form.el);
    };
    kind.addEventListener('change', show);
    show();
    const body = h('div', {}, h('p', {}, t("{file}: choose a format the sidecar can write. Creation options are checked against the format's own list.", { file: files[0].name })), field(t('Kind'), kind), box);
    const r = await modal({ title: t('Save As with GDAL/OGR'), body, buttons: [{ label: t('Save'), value: 'save', primary: true }, { label: t('Cancel'), value: 'cancel' }], width: 640, id: 'sidecar-saveas' });
    if (r !== 'save') return;
    const fin = await convert({ files, profile: kind.value, options: form.read(), open: false, reason: 'Save As' });
    const out = fin.outputs[0];
    const where = await modal({ title: t('Saved by the sidecar'), body: h('p', {}, t('{file} ({size}) is ready.', { file: out.name, size: fmtBytes(out.size) })), buttons: [{ label: t('Save to folder…'), value: 'folder', primary: true }, { label: t('Download'), value: 'download' }, { label: t('Close'), value: 'close' }], id: 'sidecar-saved' });
    if (where === 'folder') await saveOutput(out);
    if (where === 'download') await downloadOutput(out);
    return fin;
  }

  // ---------------- Sidecar Jobs dock (REQ-SDC-06) ----------------
  let dockEl = null;
  function renderDock() {
    if (!dockEl || !dockEl.isConnected) return;
    clear(dockEl);
    const rows = [...jobs.values()].sort((a, b) => b.at - a.at);
    if (!rows.length) {
      dockEl.append(h('p', { class: 'hint pad' }, enabled() ? t('No sidecar jobs yet. Convert with Sidecar (Add-Ins ▸ Sidecar) or use the action on a file the app refused.') : t('The sidecar is switched off.')));
      return;
    }
    const list = h('ul', { class: 'cat-results', 'data-id': 'sidecar:jobs' });
    for (const r of rows) {
      const j = r.job;
      const pct = Number.isFinite(j.progress) ? Math.round(j.progress * 100) : null;
      const btn = (label, fn) => {
        const b = h('button', { class: 'btn btn-small' }, label);
        b.addEventListener('click', () => fn().catch((e) => app.toast(errMsg(e), { kind: 'error', ms: 8000 })));
        return b;
      };
      const actions = h('div', { class: 'btn-row' });
      if (ACTIVE.has(j.state)) actions.append(btn(t('Cancel'), () => client.cancel(j.id)));
      if (j.state === 'failed' || j.state === 'cancelled') actions.append(btn(t('Retry'), async () => track(await client.retry(j.id), r.label)));
      for (const o of (j.outputs ?? []).filter((o) => !o.name.endsWith('.gwb-provenance.json'))) {
        actions.append(btn(t('Open {file}', { file: o.name }), () => openOutput(o)), btn(t('Save to folder…'), () => saveOutput(o)));
      }
      actions.append(
        btn(t('Log'), async () => {
          const text = await client.log(j.id).catch(() => r.log.join('\n'));
          await modal({ title: t('Sidecar log — {job}', { job: r.label }), body: h('pre', { class: 'mono sidecar-log' }, text), buttons: [{ label: t('Close'), value: 'close', primary: true }], width: 760, id: 'sidecar-log' });
        }),
      );
      list.append(
        h(
          'li',
          { class: ['cat-item', `cv-${j.state}`], 'data-job': j.id, 'data-state': j.state },
          h('div', {}, h('strong', {}, r.label), h('div', { class: 'small muted' }, [stateName(j.state), pct !== null && ACTIVE.has(j.state) ? pctText(pct) : '', j.error ?? ''].filter(Boolean).join(' · ')), ACTIVE.has(j.state) ? h('progress', { max: '100', value: pct ?? undefined }) : null),
          actions,
        ),
      );
    }
    dockEl.append(list);
  }
  const regDock = (mp) => mp.docks.register({ id: 'sidecarjobs', title: t('Sidecar Jobs'), icon: 'job', home: 'bottom', create: (a, m, el) => ((dockEl = el), renderDock(), { onShow: renderDock }) });
  app.on('ready', (mp) => regDock(mp));

  // ---------------- commands ----------------
  const guard = (fn) => async (args) => {
    try {
      return await fn(args);
    } catch (e) {
      if (e?.code === 'absent') return installInfo(args?.files?.[0]?.name);
      if (e?.code === 'cancelled') return null; // Cancel in the activity indicator
      // Switched off (the air-gapped file starts so): say how to turn it on, not an error.
      if (e?.code === 'off') return app.toast(airgap() ? t('The Sidecar switch is off in the air-gapped file: turn it on in the Sidecar status (status bar).') : t('The sidecar is switched off (status bar ▸ Sidecar).'), { kind: 'info', ms: 8000 });
      throw e;
    }
  };
  C.implement('sidecar.status', { run: () => statusDialog() });
  C.implement('sidecar.toggle', { run: () => setEnabled(!enabled()), checked: () => enabled() });
  C.implement('sidecar.pair', { run: guard(async () => (await refresh(), S.status === 'paired' ? app.toast(t('This page is already paired.'), { kind: 'info' }) : ready())) });
  C.implement('sidecar.forget', {
    run: async () => {
      await client.forget();
      S.caps = null;
      setStatus(S.hello ? 'unpaired' : 'idle');
      app.toast(t('This page forgot the sidecar; it will ask to pair again.'), { kind: 'info' });
    },
  });
  C.implement('sidecar.convert', { run: guard((args = {}) => convert(args)) });
  C.implement('sidecar.convertdialog', { run: guard((args = {}) => convertDialog(args)) });
  C.implement('sidecar.pick', { run: guard(() => pickInSidecar()) });
  C.implement('sidecar.view', { run: guard(async (args = {}) => (await loadBlock(app, 'js-sidecarview')).viewFile(app, { client, ready, vendorCheck, remoteFile }, args)) });
  C.implement('sidecar.batch', { run: guard(() => batchDialog()) });
  C.implement('sidecar.saveas', { run: guard((args) => saveAsDialog(args)) });
  C.implement('sidecar.jobs', { run: () => app.panels?.toggle('sidecarjobs', 'bottom'), checked: () => !!app.activeMp?.()?.docks.isOpen('sidecarjobs') });

  /** Whether the paired sidecar has the vendor plug-in for 'MrSID' or 'ECW'. */
  const decodes = (format) => S.status === 'paired' && !!S.caps?.vendor?.find((v) => v.id === (format === 'ECW' ? 'vendor-ecw' : 'vendor-mrsid'))?.installed;

  app.sidecar = { client, state: S, enabled, refresh, ready, convert, send, refusalAction, openOutput, jobs, installInfo, changed, optionsForm, guard, decodes };
  // The Python relay (REQ-GAP-02): the command here, its code in the lazy js-relay block.
  const relay = once(async () => (await loadBlock(app, 'js-relay')).install(app));
  lazyCommands(app, ['sidecar.relay'], relay, { 'sidecar.relay': { checked: () => !!app.sidecar.relay?.on } });
  // The native viewer and ArcGIS Pro sync (REQ-GAP-33, 65): js-sidecarnative. The CORS relay
  // (REQ-GAP-08): js-corsrelay, which the sidecar's own report keeps disabled (OD-2.17).
  const native = once(async () => (await loadBlock(app, 'js-sidecarnative')).install(app));
  lazyCommands(app, ['sidecar.stereoviewer', 'sidecar.prosync'], native, { 'sidecar.prosync': { checked: () => !!app.sidecar.proSync?.on } });
  const corsRelay = once(async () => (await loadBlock(app, 'js-corsrelay')).install(app));
  lazyCommands(app, ['sidecar.corsrelay'], corsRelay, { 'sidecar.corsrelay': { enabled: () => !airgap() && !!S.caps?.features?.cors_relay } });

  // ---------------- start-up: only if this page paired before (REQ-SDC-01) ----------------
  if (!enabled()) setStatus('off');
  else
    client.load().then((had) => {
      if (had) refresh({ quiet: true }).catch(() => {});
    });
}
