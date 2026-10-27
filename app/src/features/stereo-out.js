// Stereo outputs (REQ-STR-06): a two-window dual output (the stereo panel shows the left eye; a
// second window, for a second projector or a mirror rig, shows the right eye, refreshed with
// every frame of the panel), and WebXR per-eye stereo (each eye's view of the headset draws that
// eye's image) where the browser offers an immersive-vr session.

export const name = 'stereoOut';

export function install(app) {
  const C = app.commands;
  const pane = () => app.activePane();
  let dualState = null;
  let xrState = null;

  function closeDual() {
    if (!dualState) return;
    const { st, prevMode, win } = dualState;
    st.afterDraw = null;
    if (st.mode === 'dual') st.mode = prevMode;
    dualState = null;
    try {
      if (!win.closed) win.close();
    } catch {}
    st.pane?.invalidate();
    app.emit('state');
  }

  /** Open the right-eye window and switch the stereo panel to the left eye. */
  function dual(p = pane()) {
    const st = p?.stereo;
    if (!st) throw new Error('open a stereo panel first (Stereo ▸ Stereo Panel)');
    if (dualState) return dualState;
    const r = p.el.getBoundingClientRect();
    const win = window.open('', 'gw-right-eye', `popup,width=${Math.round(r.width)},height=${Math.round(r.height)}`);
    if (!win) throw new Error('the browser blocked the second window; allow pop-ups for this file');
    const d = win.document;
    d.title = 'GIS Workbench — right eye';
    d.body.style.cssText = 'margin:0;background:#000;overflow:hidden';
    const canvas = d.createElement('canvas');
    canvas.style.cssText = 'width:100vw;height:100vh;display:block;image-rendering:pixelated';
    canvas.dataset.id = 'right-eye';
    d.body.appendChild(canvas);
    const g = canvas.getContext('2d');
    let frames = 0;
    let pending = false;
    dualState = { st, prevMode: st.mode === 'dual' ? 'dubois' : st.mode, win, canvas, frames: () => frames };
    st.mode = 'dual';
    st.afterDraw = (rr) => {
      if (win.closed) return queueMicrotask(closeDual);
      if (pending) return;
      const px = rr.readTarget(1);
      if (!px) return;
      pending = true;
      // The target is bottom-up and premultiplied: flip rows into the window's canvas.
      const img = new ImageData(px.w, px.h);
      const row = px.w * 4;
      for (let y = 0; y < px.h; y++) img.data.set(px.data.subarray((px.h - 1 - y) * row, (px.h - y) * row), y * row);
      for (let i = 3; i < img.data.length; i += 4) img.data[i] = 255;
      if (canvas.width !== px.w || canvas.height !== px.h) [canvas.width, canvas.height] = [px.w, px.h];
      g.putImageData(img, 0, 0);
      frames++;
      pending = false;
    };
    win.addEventListener('beforeunload', () => closeDual());
    p.invalidate();
    app.emit('state');
    return dualState;
  }

  // ---- WebXR ----
  async function xrSupported() {
    try {
      return !!(await navigator.xr?.isSessionSupported?.('immersive-vr'));
    } catch {
      return false;
    }
  }

  async function startXr(p = pane()) {
    const st = p?.stereo;
    if (!st) throw new Error('open a stereo panel first (Stereo ▸ Stereo Panel)');
    if (!(await xrSupported())) throw new Error('WebXR immersive stereo is not available here (no headset, or the browser does not offer immersive-vr); the dual-window output works without one');
    const r = app.renderer;
    const gl = r.gl;
    await gl.makeXRCompatible?.();
    const session = await navigator.xr.requestSession('immersive-vr');
    const layer = new XRWebGLLayer(session, gl);
    session.updateRenderState({ baseLayer: layer });
    const space = await session.requestReferenceSpace('local');
    xrState = { session, frames: 0 };
    const onFrame = (t, frame) => {
      if (!xrState) return;
      session.requestAnimationFrame(onFrame);
      const pose = frame.getViewerPose(space);
      const tl = r.targets?.[0]?.tex;
      const tr = r.targets?.[1]?.tex;
      if (!pose || !tl || !tr) return;
      gl.bindFramebuffer(gl.FRAMEBUFFER, layer.framebuffer);
      gl.clearColor(0, 0, 0, 1);
      gl.clear(gl.COLOR_BUFFER_BIT);
      for (const view of pose.views) {
        const vp = layer.getViewport(view);
        gl.viewport(vp.x, vp.y, vp.width, vp.height);
        gl.scissor(vp.x, vp.y, vp.width, vp.height);
        r.drawStereo(tl, tr, { ...st.displayOpts(), mode: 10, swap: view.eye === 'right' }, { x: vp.x, y: vp.y, w: vp.width, h: vp.height });
      }
      xrState.frames++;
      p.invalidate(); // keep the eye targets current as the analyst roams
    };
    session.requestAnimationFrame(onFrame);
    session.addEventListener('end', () => {
      xrState = null;
      app.emit('state');
    });
    app.emit('state');
    return session;
  }

  async function stopXr() {
    await xrState?.session.end();
    xrState = null;
  }

  C.implement('stereo.mode.dual', { enabled: () => !!pane()?.stereo, checked: () => !!dualState, run: () => (dualState ? closeDual() : dual()) });
  C.implement('stereo.xr', {
    enabled: () => !!pane()?.stereo,
    checked: () => !!xrState,
    run: async () => {
      try {
        if (xrState) await stopXr();
        else await startXr();
      } catch (e) {
        app.toast(e.message, { kind: 'error', ms: 9000 });
      }
    },
  });
  app.stereoOut = { dual, closeDual, dualState: () => dualState, xrSupported, startXr, stopXr, xrState: () => xrState };
}
