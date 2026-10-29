// Themes (REQ-UI-12, REQ-SHL-13) and Follow system (GUI3, DN-60). The `theme` preference is one
// of the five palettes or 'system'; 'system' (and no preference at all) follows the OS light or
// dark setting with the layout's own pair: Material light/dark in the Modern layout, grey/dark in
// Classic. This is the one place that writes data-theme, so charts can redraw on 'theme'.

export const PALETTES = ['grey', 'dark', 'print', 'm3-light', 'm3-dark'];
const mq = typeof matchMedia === 'function' ? matchMedia('(prefers-color-scheme: dark)') : null;

/** The palette a preference shows in a layout. */
export function resolveTheme(pref, layout, osDark = !!mq?.matches) {
  if (PALETTES.includes(pref)) return pref;
  if (layout === 'modern') return osDark ? 'm3-dark' : 'm3-light';
  return osDark ? 'dark' : 'grey';
}

export const themePref = (app) => app.prefs.get('theme') ?? 'system';

/** Show the preferred palette (data-theme) and the preference itself (data-theme-pref). */
export function applyTheme(app) {
  const html = document.documentElement;
  const pref = themePref(app);
  const t = resolveTheme(pref, html.dataset.layout || app.layoutMode());
  html.dataset.themePref = pref;
  if (html.dataset.theme === t) return;
  html.dataset.theme = t;
  app.emit('theme', t);
}

/** Set the preference ('system' or a palette) and show it. */
export function setTheme(app, pref) {
  app.prefs.set('theme', pref);
  applyTheme(app);
  app.emit('state');
}

/** While the preference is 'system', follow the OS as it changes. */
export function watchSystemTheme(app) {
  mq?.addEventListener?.('change', () => {
    if (themePref(app) !== 'system') return;
    applyTheme(app);
    app.emit('state');
  });
}
