// REQ-L10N-10 REQ-L10N-11 S-56 (SDP-2.3 §4.8, phase L6 exit: "PDF/DOCX/PPTX in ja and uk pass"):
// in a Japanese and a Ukrainian UI, the layered PDF shows its labels with Noto fonts from the
// fonts-noto pack (Type0, ToUnicode: the text is selectable), or Helvetica with '?' and one toast
// when the pack is not loaded; DOCX and PPTX carry the UI language; canvas text has the locale's
// font stack. pdftotext, when installed, reads the PDF back.
import { test, expect } from '@playwright/test';
import { readFileSync, readdirSync, existsSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { unzipSync, strFromU8 } from 'fflate';
import { openApp, openFiles, SAMPLES, DIST_DIR } from './helpers.js';

test.describe.configure({ timeout: 300000 });

const VEGAS = join(SAMPLES, 'msi-spacenet2-wv3', 'SN2_buildings_train_AOI_2_Vegas_PS-RGB_img10.tif');
const PACK = existsSync(join(DIST_DIR, 'packs')) ? readdirSync(join(DIST_DIR, 'packs')).find((f) => /^fonts-noto-.*\.gwpack$/.test(f)) : null;
const pdftotext = (() => {
  const r = spawnSync('pdftotext', ['-v'], { encoding: 'utf8' });
  return !r.error && /pdftotext/i.test(`${r.stdout}${r.stderr}`);
})();

/** The locale's pack file when the build ships it as a pack (under the coverage gate), else null. */
const localePack = (tag) => (existsSync(join(DIST_DIR, 'packs')) ? readdirSync(join(DIST_DIR, 'packs')).find((f) => f.startsWith(`locale-${tag}-`) && f.endsWith('.gwpack')) : null) ?? null;

async function ready(page, locale, labels) {
  await page.addInitScript(() => delete window.showSaveFilePicker); // saves become downloads
  const { frame, logs } = await openApp(page, 'file', { prefs: { welcomeDone: true, network: 'online', locale } });
  // A wave 1 locale under the coverage gate is a pack in this build: open it, then restart.
  if ((await frame.evaluate(() => window.gisworkbench.i18n.locale)) !== locale && localePack(locale)) {
    await frame.evaluate(async ([b, name]) => window.gisworkbench.packs.open(new File([new Uint8Array(b)], name)), [[...readFileSync(join(DIST_DIR, 'packs', localePack(locale)))], localePack(locale)]);
    await page.reload();
    await frame.waitForFunction(() => document.body?.dataset.ready === '1', null, { timeout: 45_000 });
  }
  test.skip((await frame.evaluate(() => window.gisworkbench.i18n.locale)) !== locale, `no ${locale} catalogue in this build`);
  await openFiles(frame, [VEGAS]);
  await frame.waitForFunction(() => [...window.gisworkbench.layers.values()].some((l) => l.stats && l.lutTex), null, { timeout: 60000 });
  await frame.evaluate((labels) => {
    const app = window.gisworkbench;
    const l = [...app.layers.values()][0];
    labels.forEach((text, i) => {
      const c = l.groundAt(200 + i * 60, 200 + i * 40);
      app.api.createGraphic({ shape: 'marker', coordinates: [[c.lon, c.lat]], text });
    });
  }, labels);
  return { frame, logs };
}

const save = async (page, frame, cmd) => {
  const got = new Promise((res) => page.once('download', async (d) => res({ name: d.suggestedFilename(), bytes: readFileSync(await d.path()) })));
  await frame.evaluate((c) => window.gisworkbench.commands.run(c), cmd);
  return got;
};

const readText = (bytes) => {
  const dir = mkdtempSync(join(tmpdir(), 'gw-l10n-'));
  try {
    writeFileSync(join(dir, 'a.pdf'), bytes);
    return spawnSync('pdftotext', ['-enc', 'UTF-8', join(dir, 'a.pdf'), '-'], { encoding: 'utf8' }).stdout.replace(/\s+/g, ' ');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
};

/** DOCX (report) and PPTX (one slide titled `title`) from the running app, as base64. */
const officeFiles = (frame, title) =>
  frame.evaluate(async (title) => {
    const app = window.gisworkbench;
    const enc = (u8) => btoa(Array.from(u8, (b) => String.fromCharCode(b)).join(''));
    const c = document.createElement('canvas');
    c.width = 64;
    c.height = 48;
    c.getContext('2d').fillRect(0, 0, 64, 48);
    const pptx = await app.writePptx([{ image: c, wIn: 10, hIn: 7.5, title }]);
    return { docx: enc(app.reportDocx({ title, bluf: title })), pptx: enc(pptx), lang: document.documentElement.lang, css: getComputedStyle(document.body).fontFamily };
  }, title);
const unb64 = (s) => Uint8Array.from(Buffer.from(s, 'base64'));

test('REQ-L10N-11 S-56 Japanese: layered PDF with "?" and one notice without the fonts pack, real text with it; DOCX and PPTX in ja-JP', async ({ page }) => {
  test.skip(!PACK, 'no fonts-noto pack in this build');
  const labels = ['東京タワー', '滑走路 09/27'];
  const { frame, logs } = await ready(page, 'ja', labels);
  // Without the pack: Helvetica, '?' for what it cannot show, and the notice once.
  const toasts = () => frame.evaluate(() => window.gisworkbench.toastLog.map((x) => x.message));
  const before = (await toasts()).length;
  const a = await save(page, frame, 'hub.pdf');
  const at = a.bytes.toString('latin1');
  expect(at).toContain('/BaseFont /Helvetica');
  expect(at).toContain('(?????) Tj');
  await save(page, frame, 'hub.pdf');
  const notices = (await toasts()).slice(before).filter((m) => /fonts-noto|Noto/.test(m));
  expect(notices).toHaveLength(1);
  // With the pack: Type0 fonts (Noto Sans CJK JP for the labels), text readable back.
  expect((await openFiles(frame, [join(DIST_DIR, 'packs', PACK)])).flatMap((r) => r.errors)).toEqual([]);
  const b = await save(page, frame, 'hub.pdf');
  const bt = b.bytes.toString('latin1');
  expect(bt).toMatch(/\/BaseFont \/[A-Z]{6}\+NotoSansJP-Regular/);
  expect(bt).toContain('/Subtype /CIDFontType0');
  expect(bt).toContain('/Encoding /Identity-H');
  expect(bt).toContain('/ToUnicode');
  expect(bt).not.toContain('/Helvetica');
  if (pdftotext) for (const l of labels) expect(readText(b.bytes)).toContain(l);
  // DOCX and PPTX: the UI language.
  const o = await officeFiles(frame, '東京の報告');
  const docx = unzipSync(unb64(o.docx));
  const styles = strFromU8(docx['word/styles.xml']);
  expect(styles).toContain('<w:lang w:val="ja-JP" w:eastAsia="ja-JP"/>');
  expect(styles).toContain('w:eastAsia="Yu Gothic"');
  expect(strFromU8(docx['docProps/core.xml'])).toContain('<dc:language>ja-JP</dc:language>');
  const slide = strFromU8(unzipSync(unb64(o.pptx))['ppt/slides/slide1.xml']);
  expect(slide).toContain('lang="ja-JP"');
  expect(slide).toContain('東京の報告');
  // UI and canvas fonts: the Latin stack, then Japanese fonts first among the CJK fallbacks.
  expect(o.lang).toBe('ja');
  expect(o.css).toMatch(/Arial, "Yu Gothic UI"/);
  expect(logs).toEqual([]);
});

test('REQ-L10N-11 S-56 Ukrainian: layered PDF in Noto Sans (TrueType CID font) with the pack; DOCX and PPTX in uk-UA', async ({ page }) => {
  test.skip(!PACK, 'no fonts-noto pack in this build');
  const labels = ['Київ — столиця', 'Аеродром 7'];
  const { frame, logs } = await ready(page, 'uk', labels);
  expect((await openFiles(frame, [join(DIST_DIR, 'packs', PACK)])).flatMap((r) => r.errors)).toEqual([]);
  const b = await save(page, frame, 'hub.pdf');
  const bt = b.bytes.toString('latin1');
  expect(bt).toMatch(/\/BaseFont \/[A-Z]{6}\+NotoSans-Regular/);
  expect(bt).toContain('/Subtype /CIDFontType2');
  expect(bt).not.toContain('NotoSansJP');
  if (pdftotext) for (const l of labels) expect(readText(b.bytes)).toContain(l);
  const o = await officeFiles(frame, 'Звіт');
  const styles = strFromU8(unzipSync(unb64(o.docx))['word/styles.xml']);
  expect(styles).toContain('<w:lang w:val="uk-UA"/>');
  expect(strFromU8(unzipSync(unb64(o.pptx))['ppt/slides/slide1.xml'])).toContain('lang="uk-UA"');
  // Latin and Cyrillic UI: the CSS stack is the English one.
  expect(o.css).not.toMatch(/Yu Gothic/);
  expect(logs).toEqual([]);
});
