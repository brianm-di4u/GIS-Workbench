// Page capture (REQ-WB-04/05/15, S-25): tab capture when the user allows it, else a
// rendered snapshot of the DOM chrome, always composited over the WebGL pane pixels read
// back from the shared canvas, with the marks on top and the classification banner stamped
// at the top and bottom.

import { bannerText, bannerColorVar } from '../security/marking.js';

const SKIP = new Set(['SCRIPT', 'STYLE', 'TEMPLATE', 'NOSCRIPT', 'META', 'LINK', 'HEAD']);

function visible(el, cs) {
  return cs.display !== 'none' && cs.visibility !== 'hidden' && parseFloat(cs.opacity) > 0.01;
}

const svgCache = new Map();
function svgImage(svgEl) {
  const markup = new XMLSerializer().serializeToString(svgEl);
  if (svgCache.has(markup)) return svgCache.get(markup);
  const p = new Promise((resolve) => {
    const color = getComputedStyle(svgEl).color;
    const withColor = markup.replace(/currentColor/g, color);
    const url = URL.createObjectURL(new Blob([withColor], { type: 'image/svg+xml' }));
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => resolve(null);
    img.src = url;
  });
  svgCache.set(markup, p);
  return p;
}

/**
 * Rasterise the document's visible elements into a 2D context (a "rendered snapshot").
 * Draws backgrounds, borders, text, form values, our own SVG icons and 2D canvases. Opaque
 * regions cover the WebGL layer underneath exactly as they do on screen.
 */
export async function renderSnapshot(g, root, { exclude } = {}) {
  clipCache = new WeakMap();
  const queue = [root];
  const icons = [];
  while (queue.length) {
    const el = queue.shift();
    if (!(el instanceof Element) || SKIP.has(el.tagName) || (exclude && exclude(el))) continue;
    const cs = getComputedStyle(el);
    if (!visible(el, cs)) continue;
    const r = el.getBoundingClientRect();
    if (r.width > 0 && r.height > 0 && r.bottom > 0 && r.right > 0 && r.top < innerHeight && r.left < innerWidth) {
      const bg = cs.backgroundColor;
      if (bg && bg !== 'rgba(0, 0, 0, 0)' && bg !== 'transparent') {
        g.fillStyle = bg;
        g.fillRect(r.left, r.top, r.width, r.height);
      }
      if (cs.backgroundImage.startsWith('linear-gradient')) {
        const cols = cs.backgroundImage.match(/rgba?\([^)]+\)/g);
        if (cols?.length >= 2) {
          const gr = g.createLinearGradient(0, r.top, 0, r.bottom);
          gr.addColorStop(0, cols[0]);
          gr.addColorStop(1, cols.at(-1));
          g.fillStyle = gr;
          g.fillRect(r.left, r.top, r.width, r.height);
        }
      }
      for (const [side, w, c] of [
        ['top', cs.borderTopWidth, cs.borderTopColor],
        ['right', cs.borderRightWidth, cs.borderRightColor],
        ['bottom', cs.borderBottomWidth, cs.borderBottomColor],
        ['left', cs.borderLeftWidth, cs.borderLeftColor],
      ]) {
        const bw = parseFloat(w);
        if (!bw || c === 'rgba(0, 0, 0, 0)') continue;
        g.fillStyle = c;
        if (side === 'top') g.fillRect(r.left, r.top, r.width, bw);
        if (side === 'bottom') g.fillRect(r.left, r.bottom - bw, r.width, bw);
        if (side === 'left') g.fillRect(r.left, r.top, bw, r.height);
        if (side === 'right') g.fillRect(r.right - bw, r.top, bw, r.height);
      }
      if (cs.boxShadow && cs.boxShadow.includes('inset') && el.classList.contains('active')) {
        const col = cs.boxShadow.match(/rgba?\([^)]+\)|#[0-9a-f]{3,8}/i)?.[0] ?? '#ff0';
        g.strokeStyle = col;
        g.lineWidth = 2;
        g.strokeRect(r.left + 1, r.top + 1, r.width - 2, r.height - 2);
      }
      if (el.tagName === 'CANVAS' && el.id !== 'gl') {
        try {
          g.drawImage(el, r.left, r.top, r.width, r.height);
        } catch {
          /* tainted canvases are skipped */
        }
      } else if (el.tagName === 'svg' || el instanceof SVGSVGElement) {
        icons.push(svgImage(el).then((img) => img && { img, r }));
        continue;
      } else if (el.tagName === 'INPUT' || el.tagName === 'SELECT' || el.tagName === 'TEXTAREA') {
        const v = el.tagName === 'SELECT' ? el.options[el.selectedIndex]?.text ?? '' : el.type === 'checkbox' ? (el.checked ? '☑' : '☐') : el.type === 'range' ? '' : el.value || el.placeholder || '';
        if (el.type === 'range') {
          g.fillStyle = '#888';
          g.fillRect(r.left, r.top + r.height / 2 - 1, r.width, 2);
        }
        g.fillStyle = cs.color;
        g.font = `${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`;
        g.textBaseline = 'middle';
        g.fillText(v, r.left + 3, r.top + r.height / 2, r.width - 4);
      }
    }
    for (const child of el.childNodes) {
      if (child.nodeType === Node.TEXT_NODE && child.textContent.trim()) drawText(g, child, cs);
      else if (child.nodeType === Node.ELEMENT_NODE) queue.push(child);
    }
  }
  for (const it of await Promise.all(icons)) if (it) g.drawImage(it.img, it.r.left, it.r.top, it.r.width, it.r.height);
}

let clipCache = new WeakMap(); // reset per snapshot: rectangles change between captures
/** Intersection of the rectangles of ancestors that clip their overflow. */
function clipRect(el) {
  if (clipCache.has(el)) return clipCache.get(el);
  let r = { l: -Infinity, t: -Infinity, r: Infinity, b: Infinity };
  for (let a = el; a && a !== document.body; a = a.parentElement) {
    const cs = getComputedStyle(a);
    if (cs.overflowX !== 'visible' || cs.overflowY !== 'visible') {
      const b = a.getBoundingClientRect();
      r = { l: Math.max(r.l, b.left), t: Math.max(r.t, b.top), r: Math.min(r.r, b.right), b: Math.min(r.b, b.bottom) };
    }
  }
  clipCache.set(el, r);
  return r;
}

function drawText(g, node, cs) {
  const cr = clipRect(node.parentElement);
  if (cr.r <= cr.l || cr.b <= cr.t) return;
  g.save();
  if (Number.isFinite(cr.l)) {
    g.beginPath();
    g.rect(cr.l, cr.t, cr.r - cr.l, cr.b - cr.t);
    g.clip();
  }
  drawTextInner(g, node, cs);
  g.restore();
}

function drawTextInner(g, node, cs) {
  const range = document.createRange();
  range.selectNodeContents(node);
  const rects = [...range.getClientRects()];
  if (!rects.length) return;
  g.fillStyle = cs.color;
  g.font = `${cs.fontStyle} ${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`;
  g.textBaseline = 'alphabetic';
  if (cs.textShadow && cs.textShadow !== 'none') {
    g.shadowColor = 'rgba(0,0,0,.9)';
    g.shadowBlur = 3;
  }
  const text = node.textContent.replace(/\s+/g, ' ');
  if (rects.length === 1) {
    const r = rects[0];
    g.fillText(text.trim(), r.left, r.bottom - (r.height - parseFloat(cs.fontSize)) / 2 - parseFloat(cs.fontSize) * 0.18, r.width + 2);
  } else {
    // Wrapped text: split words across the line boxes proportionally.
    const words = text.trim().split(' ');
    let wi = 0;
    for (const r of rects) {
      let line = '';
      while (wi < words.length && g.measureText(`${line}${words[wi]} `).width <= r.width + 4) line += `${words[wi++]} `;
      if (!line && wi < words.length) line = words[wi++];
      g.fillText(line.trim(), r.left, r.bottom - parseFloat(cs.fontSize) * 0.25);
    }
  }
  g.shadowBlur = 0;
}

/** Try tab capture of the current tab (one frame). Returns an ImageBitmap or null. */
export async function tabCaptureFrame(state) {
  if (!navigator.mediaDevices?.getDisplayMedia) return null;
  try {
    if (!state.stream || !state.stream.active) {
      // The browser shows its own share prompt; give up after 30 s so a capture never hangs.
      const ask = navigator.mediaDevices.getDisplayMedia({ video: { displaySurface: 'browser' }, audio: false, preferCurrentTab: true, selfBrowserSurface: 'include' });
      state.stream = await Promise.race([ask, new Promise((_, rej) => setTimeout(() => rej(new Error('no answer to the share prompt')), 30000))]);
      const track = state.stream.getVideoTracks()[0];
      track.addEventListener('ended', () => (state.stream = null));
    }
    const video = document.createElement('video');
    video.muted = true;
    video.srcObject = state.stream;
    await video.play();
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    const bmp = await createImageBitmap(video);
    video.pause();
    video.srcObject = null;
    return bmp;
  } catch {
    state.stream = null;
    return null;
  }
}

/** Stamp the banner (highest marking on screen) at the top and bottom (REQ-WB-05). */
export function stampBanners(g, w, h, text, color, dpr = 1) {
  if (!text) return;
  const bh = 18 * dpr;
  g.font = `bold ${12 * dpr}px Arial, sans-serif`;
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  for (const y of [0, h - bh]) {
    g.fillStyle = color;
    g.fillRect(0, y, w, bh);
    g.fillStyle = '#ffffff';
    g.fillText(text, w / 2, y + bh / 2);
  }
  g.textAlign = 'left';
}

/**
 * Compose a page image. `gl` is the renderer read-back {width, height, data, dpr}; `drawMarks`
 * draws the whiteboard marks into the context in CSS pixels.
 */
export async function composePage({ app, method, state, drawMarks, exclude }) {
  const dpr = window.devicePixelRatio || 1;
  const W = Math.round(innerWidth * dpr);
  const H = Math.round(innerHeight * dpr);
  const c = document.createElement('canvas');
  c.width = W;
  c.height = H;
  const g = c.getContext('2d');
  let used = 'snapshot';
  let bmp = null;
  if (method === 'tab' || method === 'auto') bmp = app.runMode.caps.displayCapture ? await tabCaptureFrame(state) : null;
  if (bmp) {
    g.drawImage(bmp, 0, 0, W, H);
    used = 'tab capture';
  } else {
    // Base: the page background, then the WebGL panes (render-to-capture of the shared canvas).
    g.fillStyle = getComputedStyle(document.body).backgroundColor;
    g.fillRect(0, 0, W, H);
    if (method !== 'marks') {
      const glr = app.renderer.capture();
      const img = new ImageData(glr.data, glr.width, glr.height);
      const tmp = document.createElement('canvas');
      tmp.width = glr.width;
      tmp.height = glr.height;
      tmp.getContext('2d').putImageData(img, 0, 0);
      g.drawImage(tmp, 0, 0, W, H);
      g.save();
      g.scale(dpr, dpr);
      await renderSnapshot(g, document.getElementById('app'), { exclude });
      // Floating windows and dialogs that live outside #app.
      for (const el of document.querySelectorAll('body > .float-win, body > .dlg')) await renderSnapshot(g, el, { exclude });
      g.restore();
      used = 'rendered snapshot';
    } else used = 'marks only';
  }
  g.save();
  g.scale(dpr, dpr);
  drawMarks(g);
  g.restore();
  const m = app.screenMarking();
  const color = getComputedStyle(document.documentElement).getPropertyValue(bannerColorVar(m)).trim() || '#007a33';
  stampBanners(g, W, H, bannerText(m), color, dpr);
  return { dataUrl: c.toDataURL('image/png'), width: W, height: H, method: used, canvas: c };
}
