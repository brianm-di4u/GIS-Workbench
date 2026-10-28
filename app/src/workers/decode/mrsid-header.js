// MrSID container header (TE-061): recognise LizardTech/Extensis MrSID files by their "msid"
// magic and read the image size, band count and sample depth from the big-endian header, so the
// refusal names the format and the image instead of "unrecognised data". The wavelet codestream
// itself is proprietary and undocumented; decoding it is owner decision OD-10
// (docs/design/mrsid-spike.md).

export const isMrSid = (h) => h.length >= 4 && h[0] === 0x6d && h[1] === 0x73 && h[2] === 0x69 && h[3] === 0x64;

/** Header fields from the first 41 bytes, or null when they are not plausible. */
export function mrsidHeader(b) {
  if (b.length < 41 || !isMrSid(b)) return null;
  const v = new DataView(b.buffer, b.byteOffset, b.byteLength);
  const version = b[4];
  const width = v.getUint32(26);
  const height = v.getUint32(30);
  const bands = b[36];
  const bits = b[40];
  const ok = width > 0 && height > 0 && width < 2 ** 31 && height < 2 ** 31 && bands >= 1 && bands <= 255 && [8, 16, 32].includes(bits);
  return { version, generation: version === 3 ? 'MG3' : version === 4 ? 'MG4' : version <= 2 ? 'MG2' : `v${version}`, ...(ok ? { width, height, bands, bits } : {}) };
}

/** The refusal shown for a MrSID file. */
export function mrsidRefusal(b) {
  const m = mrsidHeader(b);
  const what = m?.width ? `${m.width.toLocaleString('en-US')} × ${m.height.toLocaleString('en-US')} px, ${m.bands} band${m.bands > 1 ? 's' : ''}, ${m.bits}-bit` : 'header not readable';
  return `MrSID (${m?.generation ?? '?'}; ${what}) is a proprietary wavelet format with no open decoder and cannot be opened in this release. Convert it to a Cloud-Optimized GeoTIFF first, e.g. gdal_translate -of COG with a MrSID-enabled GDAL, or with Extensis GeoExpress`;
}
