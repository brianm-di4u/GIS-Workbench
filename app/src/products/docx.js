// DOCX export (REQ-PRD-09): a WordprocessingML package built from a product's HTML (the report
// and the activity report): headings, paragraphs, lists, tables and figures (PNG/JPEG data URLs),
// with the classification banner as page header and footer. No library: a few XML parts in a ZIP.

import { zipSync, strToU8 } from 'fflate';

const xml = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const EMU = 9525; // per CSS pixel at 96 dpi

/** Pixel size of a PNG or JPEG. */
export function imageSize(b) {
  if (b[0] === 0x89 && b[1] === 0x50) return { w: (b[16] << 24) | (b[17] << 16) | (b[18] << 8) | b[19], h: (b[20] << 24) | (b[21] << 16) | (b[22] << 8) | b[23], ext: 'png' };
  if (b[0] === 0xff && b[1] === 0xd8) {
    let i = 2;
    while (i + 9 < b.length) {
      if (b[i] !== 0xff) {
        i++;
        continue;
      }
      const m = b[i + 1];
      const len = (b[i + 2] << 8) | b[i + 3];
      if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) return { h: (b[i + 5] << 8) | b[i + 6], w: (b[i + 7] << 8) | b[i + 8], ext: 'jpeg' };
      i += 2 + len;
    }
  }
  return null;
}

function dataUrlBytes(u) {
  const m = /^data:([^;,]+)(;base64)?,(.*)$/s.exec(u ?? '');
  if (!m) return null;
  if (m[2]) {
    const s = atob(m[3]);
    const b = new Uint8Array(s.length);
    for (let i = 0; i < s.length; i++) b[i] = s.charCodeAt(i);
    return b;
  }
  return strToU8(decodeURIComponent(m[3]));
}

const run = (text, { bold = false, italic = false, size = null } = {}) => `<w:r><w:rPr>${bold ? '<w:b/>' : ''}${italic ? '<w:i/>' : ''}${size ? `<w:sz w:val="${size}"/>` : ''}</w:rPr><w:t xml:space="preserve">${xml(text)}</w:t></w:r>`;
const para = (runs, { style = null, align = null, shade = null, colour = null } = {}) => `<w:p><w:pPr>${style ? `<w:pStyle w:val="${style}"/>` : ''}${shade ? `<w:shd w:val="clear" w:color="auto" w:fill="${shade}"/>` : ''}${align ? `<w:jc w:val="${align}"/>` : ''}</w:pPr>${colour ? runs.replace(/<w:rPr>/g, `<w:rPr><w:color w:val="${colour}"/>`) : runs}</w:p>`;

/** Inline runs of an element: text with bold/italic from b/strong/i/em. */
function inline(el, st = {}) {
  let out = '';
  for (const n of el.childNodes) {
    if (n.nodeType === 3) {
      if (n.textContent) out += run(n.textContent.replace(/\s+/g, ' '), st);
    } else if (n.nodeType === 1) {
      const t = n.tagName.toLowerCase();
      if (t === 'br') out += '<w:r><w:br/></w:r>';
      else out += inline(n, { ...st, bold: st.bold || t === 'b' || t === 'strong', italic: st.italic || t === 'i' || t === 'em' });
    }
  }
  return out;
}

/**
 * HTML document text → DOCX bytes. opts: {title, creator}. The first `.banner` element's text and
 * colour become the header and footer.
 */
export function docxFromHtml(html, { title = 'Report', creator = 'GIS Workbench' } = {}) {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  const bannerEl = doc.querySelector('.banner');
  const banner = bannerEl?.textContent?.trim() ?? '';
  const bg = (/background:\s*(#[0-9a-f]{6})/i.exec(doc.querySelector('style')?.textContent ?? '')?.[1] ?? '#007a33').slice(1).toUpperCase();
  const media = [];
  const parts = [];
  const body = [];
  const root = doc.querySelector('main') ?? doc.body;
  const walk = (el) => {
    for (const n of el.children) {
      const t = n.tagName.toLowerCase();
      if (n.classList.contains('banner')) continue;
      if (t === 'h1') body.push(para(inline(n), { style: 'Heading1' }));
      else if (t === 'h2' || t === 'h3') body.push(para(inline(n), { style: t === 'h2' ? 'Heading2' : 'Heading3' }));
      else if (t === 'p' || t === 'div' && !n.children.length) body.push(para(inline(n)));
      else if (t === 'ol' || t === 'ul') [...n.children].forEach((li, i) => body.push(para(run(t === 'ol' ? `${li.getAttribute('value') ?? i + 1}. ` : '• ') + inline(li), { style: 'ListParagraph' })));
      else if (t === 'table') {
        const rows = [...n.querySelectorAll('tr')];
        const cols = Math.max(1, ...rows.map((r) => r.children.length));
        const w = Math.floor(9000 / cols);
        body.push(
          `<w:tbl><w:tblPr><w:tblStyle w:val="TableGrid"/><w:tblW w:w="0" w:type="auto"/></w:tblPr><w:tblGrid>${`<w:gridCol w:w="${w}"/>`.repeat(cols)}</w:tblGrid>${rows
            .map((r) => `<w:tr>${[...r.children].map((c) => `<w:tc><w:tcPr><w:tcW w:w="${w}" w:type="dxa"/>${c.tagName === 'TH' ? '<w:shd w:val="clear" w:color="auto" w:fill="EEEEEE"/>' : ''}</w:tcPr>${para(inline(c, { bold: c.tagName === 'TH', size: 17 }))}</w:tc>`).join('')}</w:tr>`)
            .join('')}</w:tbl>`,
          para(''),
        );
      } else if (t === 'figure' || t === 'img') {
        const img = t === 'img' ? n : n.querySelector('img');
        const bytes = dataUrlBytes(img?.getAttribute('src'));
        const sz = bytes && imageSize(bytes);
        if (sz) {
          const k = media.length + 1;
          media.push({ name: `image${k}.${sz.ext === 'jpeg' ? 'jpeg' : 'png'}`, bytes, ext: sz.ext });
          const maxW = 600;
          const s = Math.min(1, maxW / sz.w);
          const cx = Math.round(sz.w * s * EMU);
          const cy = Math.round(sz.h * s * EMU);
          body.push(`<w:p><w:r><w:drawing><wp:inline><wp:extent cx="${cx}" cy="${cy}"/><wp:docPr id="${k}" name="Figure ${k}"/><a:graphic xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:pic xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:nvPicPr><pic:cNvPr id="${k}" name="${media.at(-1).name}"/><pic:cNvPicPr/></pic:nvPicPr><pic:blipFill><a:blip r:embed="rIdImg${k}"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill><pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="${cx}" cy="${cy}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr></pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r></w:p>`);
        }
        const cap = t === 'figure' ? n.querySelector('figcaption') : null;
        if (cap) body.push(para(inline(cap, { italic: true, size: 18 })));
        else if (t === 'figure' && !sz) body.push(para(inline(n, { italic: true })));
      } else if (n.children.length) walk(n);
      else if (n.textContent.trim()) body.push(para(inline(n)));
    }
  };
  walk(root);
  const NS = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing"';
  const bannerPara = banner ? para(run(banner, { bold: true }), { align: 'center', shade: bg, colour: 'FFFFFF' }) : '<w:p/>';
  const sect = `<w:sectPr>${banner ? '<w:headerReference w:type="default" r:id="rIdHdr"/><w:footerReference w:type="default" r:id="rIdFtr"/>' : ''}<w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1134" w:right="1077" w:bottom="1134" w:left="1077" w:header="567" w:footer="567" w:gutter="0"/></w:sectPr>`;
  parts.push(['word/document.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document ${NS}><w:body>${body.join('')}${sect}</w:body></w:document>`]);
  parts.push(['word/header1.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:hdr ${NS}>${bannerPara}</w:hdr>`]);
  parts.push(['word/footer1.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:ftr ${NS}>${bannerPara}</w:ftr>`]);
  parts.push([
    'word/styles.xml',
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="Arial" w:hAnsi="Arial" w:cs="Arial"/><w:sz w:val="20"/></w:rPr></w:rPrDefault></w:docDefaults><w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/><w:pPr><w:spacing w:after="80"/></w:pPr></w:style><w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/><w:basedOn w:val="Normal"/><w:pPr><w:keepNext/><w:spacing w:before="240" w:after="120"/><w:outlineLvl w:val="0"/></w:pPr><w:rPr><w:b/><w:sz w:val="32"/></w:rPr></w:style><w:style w:type="paragraph" w:styleId="Heading2"><w:name w:val="heading 2"/><w:basedOn w:val="Normal"/><w:pPr><w:keepNext/><w:pBdr><w:bottom w:val="single" w:sz="4" w:space="1" w:color="888888"/></w:pBdr><w:spacing w:before="240" w:after="80"/><w:outlineLvl w:val="1"/></w:pPr><w:rPr><w:b/><w:sz w:val="24"/></w:rPr></w:style><w:style w:type="paragraph" w:styleId="Heading3"><w:name w:val="heading 3"/><w:basedOn w:val="Normal"/><w:pPr><w:outlineLvl w:val="2"/></w:pPr><w:rPr><w:b/></w:rPr></w:style><w:style w:type="paragraph" w:styleId="ListParagraph"><w:name w:val="List Paragraph"/><w:basedOn w:val="Normal"/><w:pPr><w:ind w:left="360"/></w:pPr></w:style><w:style w:type="table" w:styleId="TableGrid"><w:name w:val="Table Grid"/><w:tblPr><w:tblBorders><w:top w:val="single" w:sz="4" w:color="999999"/><w:left w:val="single" w:sz="4" w:color="999999"/><w:bottom w:val="single" w:sz="4" w:color="999999"/><w:right w:val="single" w:sz="4" w:color="999999"/><w:insideH w:val="single" w:sz="4" w:color="999999"/><w:insideV w:val="single" w:sz="4" w:color="999999"/></w:tblBorders></w:tblPr></w:style></w:styles>`,
  ]);
  const rels = [
    '<Relationship Id="rIdStyles" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>',
    '<Relationship Id="rIdHdr" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/header" Target="header1.xml"/>',
    '<Relationship Id="rIdFtr" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/footer" Target="footer1.xml"/>',
    ...media.map((m, i) => `<Relationship Id="rIdImg${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/${m.name}"/>`),
  ];
  parts.push(['word/_rels/document.xml.rels', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${rels.join('')}</Relationships>`]);
  parts.push(['_rels/.rels', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/></Relationships>']);
  parts.push(['docProps/core.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"><dc:title>${xml(banner ? `${banner} — ${title}` : title)}</dc:title><dc:creator>${xml(creator)}</dc:creator><dcterms:created xsi:type="dcterms:W3CDTF">${new Date().toISOString().replace(/\.\d+Z$/, 'Z')}</dcterms:created></cp:coreProperties>`]);
  parts.push([
    '[Content_Types].xml',
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Default Extension="png" ContentType="image/png"/><Default Extension="jpeg" ContentType="image/jpeg"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/><Override PartName="/word/header1.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.header+xml"/><Override PartName="/word/footer1.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.footer+xml"/><Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/></Types>`,
  ]);
  const files = Object.fromEntries(parts.map(([k, v]) => [k, strToU8(v)]));
  for (const m of media) files[`word/media/${m.name}`] = [m.bytes, { level: 0 }];
  return zipSync(files);
}

export const DOCX_TYPE = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
