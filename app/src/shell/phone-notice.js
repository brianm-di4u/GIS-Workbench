// Full is desktop only (OD-2.23): on a phone-size viewport, or a touch screen with no mouse or pen,
// GIS Workbench (Full) says once that GIS Workbench Lite is the edition for phones and tablets. The
// user can always continue in Full; "Don't show this again" keeps the choice on this device.

import { h } from './dom.js';
import { modal } from './dialogs.js';
import { t } from '../i18n/index.js';

/** Phone-size (under 600 CSS px wide) or a coarse pointer without a fine one. */
export function phoneLike(win = globalThis) {
  const mm = (q) => !!win.matchMedia?.(q)?.matches;
  return mm('(max-width: 599px)') || (mm('(pointer: coarse)') && !mm('(any-pointer: fine)'));
}

let shownThisSession = false;

/** Show the notice if this device looks like a phone or tablet and the user has not turned it off. Resolves when it closes (or at once). */
export async function phoneNotice(app, { force = false } = {}) {
  if (!force && (!phoneLike() || shownThisSession || app.prefs.get('phoneNotice') === 'off')) return false;
  shownThisSession = true;
  const keep = h('input', { type: 'checkbox', 'data-id': 'phone-notice:off' });
  const body = h(
    'div',
    { class: 'phone-notice' },
    h('p', {}, t('This is GIS Workbench (Full), the desktop edition: its Ribbon, docks and panels need a mouse or a pen and a large screen.')),
    h('p', {}, t('On a phone or a tablet, use GIS Workbench Lite (gis-workbench-lite.html, beside this file). It opens the same imagery and has a touch interface for viewing, measuring, coordinates, observations with photos and sharing.')),
    h('p', {}, h('a', { href: 'gis-workbench-lite.html', 'data-id': 'phone-notice:lite' }, t('Open GIS Workbench Lite'))),
    h('label', { class: 'fld fld-inline' }, keep, h('span', {}, t("Don't show this again on this device"))),
  );
  await modal({ title: t('GIS Workbench Lite is made for this device'), body, buttons: [{ label: t('Continue in Full'), value: 'continue', primary: true }], id: 'phone-notice', width: Math.max(260, Math.min(420, (globalThis.innerWidth || 420) - 24)) });
  if (keep.checked) app.prefs.set('phoneNotice', 'off');
  return true;
}
