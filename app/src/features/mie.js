// MIE4NITF frame sequences (REQ-FMT-14): the image segments of a NITF that carry MTIMSA time
// stamps are frames; this orders them by time and steps or plays them in a panel (one visible at
// a time) at the nominal frame rate, with the frame time in the panel label.

export const name = 'mie';

export function install(app) {
  const C = app.commands;
  const S = app.store;
  let timer = null;

  /** Frames of a panel: its layers with MIE4NITF timing, in time order. */
  function sequence(p = app.activePane()) {
    return (p?.layers?.() ?? []).filter((l) => l.info?.mie).sort((a, b) => a.info.mie.timeMs - b.info.mie.timeMs || a.info.mie.segment - b.info.mie.segment);
  }

  function show(k, p = app.activePane()) {
    const seq = sequence(p);
    if (!seq.length) throw new Error('this panel has no MIE4NITF frames');
    const i = ((k % seq.length) + seq.length) % seq.length;
    S.transact('MIE4NITF frame', (tx) => {
      for (const l of seq) tx.set(l.id, 'visible', l === seq[i]);
      tx.set(p.id, 'activeLayer', seq[i].id);
    }, { kind: 'load' });
    p.mie = { index: i, count: seq.length, time: seq[i].info.mie.time };
    p.status.textContent = `MIE4NITF frame ${i + 1}/${seq.length} · ${seq[i].info.mie.time.replace('T', ' ').replace('Z', ' UTC')}`;
    p.invalidate();
    return { index: i, layer: seq[i].id, time: seq[i].info.mie.time };
  }

  function play(p = app.activePane(), { rate = null } = {}) {
    stop();
    const seq = sequence(p);
    if (!seq.length) throw new Error('this panel has no MIE4NITF frames');
    const fps = rate ?? seq[0].info.mie.frameRate ?? 2;
    let k = p.mie?.index ?? 0;
    show(k, p);
    timer = setInterval(() => show(++k, p), 1000 / Math.max(0.1, Math.min(60, fps)));
    app.emit('state');
    return fps;
  }

  function stop() {
    if (timer) clearInterval(timer);
    timer = null;
    app.emit('state');
  }

  C.implement('mie.play', { enabled: () => sequence().length > 1, checked: () => !!timer, run: () => (timer ? stop() : play()) });
  C.implement('mie.next', { enabled: () => sequence().length > 1, run: () => show((app.activePane().mie?.index ?? -1) + 1) });
  C.implement('mie.prev', { enabled: () => sequence().length > 1, run: () => show((app.activePane().mie?.index ?? 1) - 1) });
  app.mie = { sequence, show, play, stop, playing: () => !!timer };
}
