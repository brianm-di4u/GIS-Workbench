// GLSL ES 3.00 programs for the one shared WebGL2 context (REQ-IMG-01/02).
// Image tiles are native integer (R8UI/R16UI/R16I) or R32F textures read with texelFetch;
// the resampling kernel runs in the shader; the per-band 65 536-entry LUT (S7+S8) and the
// pseudo-colour palette (S9) follow. KIND selects the sampler type at compile time.
// Spatial filters (S6) run on the texel grid of the drawn pyramid level before resampling:
// linear kernels up to 5×5 (USM, sharpen, smooth, MTF slot), median 3×3, dilate/erode and
// Sobel edge magnitude. The tile gutter (4 texels) covers the filter footprint.

export const IMAGE_VS = `#version 300 es
in vec2 a_unit;
uniform vec4 u_rect;      // image-space rectangle drawn by this quad (x, y, w, h), full resolution
uniform mat3 u_view;      // image → pane pixel
uniform vec2 u_pane;      // pane size in device pixels
out vec2 v_img;
void main() {
  vec2 img = u_rect.xy + a_unit * u_rect.zw;
  vec3 s = u_view * vec3(img, 1.0);
  v_img = img;
  gl_Position = vec4(2.0 * s.x / u_pane.x - 1.0, 1.0 - 2.0 * s.y / u_pane.y, 0.0, 1.0);
}`;

/**
 * Fragment shader for one sampler kind. `filtered` builds the S6 variant: filtered texels
 * under nearest or bilinear resampling only. Keeping the filter loops out of the bicubic and
 * Lanczos loops keeps the unrolled shader small (ANGLE/D3D compile time). `filtered` names the
 * filter family the variant holds ('lin', 'med', 'morph', 'sobel', 'sar'; true = all): with every
 * family inlined into the 4 bilinear taps of 3 bands, D3D's compiler took about two minutes on the
 * first Sharpness or filter change (TE 2.0.4 cross, GUI-027); one family compiles in well under a second.
 */
export const filterFamily = (mode) => (mode === 11 ? 'rlee' : mode === 10 ? 'frost' : mode >= 6 ? 'sarstat' : mode === 5 ? 'sobel' : mode === 3 || mode === 4 ? 'morph' : mode === 2 ? 'med' : 'lin');
/** `mono`: a filtered variant for one display band (SAR, DEM), without the three-band path. */
export function imageFS(kind, filtered = false, mono = false) {
  const samp = kind === 'u' ? 'usampler2D' : kind === 'i' ? 'isampler2D' : 'sampler2D';
  const has = (fam) => filtered === true || filtered === fam;
  const sar = has('sarstat') || has('frost') || has('rlee');
  mono = mono && !!filtered;
  return `#version 300 es
precision highp float;
precision highp int;
precision highp ${samp};
uniform ${samp} u_b0;
uniform ${samp} u_b1;
uniform ${samp} u_b2;
uniform highp sampler2D u_lut;   // 256 × 768 R8: band k uses rows 256k … 256k+255
uniform highp sampler2D u_pal;   // 256 × 1 RGBA8
uniform int u_nb;                // 1 or 3 display bands
uniform int u_kernel;            // 0 nearest, 1 bilinear, 2 bicubic, 3 Lanczos-3
uniform ivec2 u_size;            // tile texture size (with gutter)
uniform vec2 u_origin;           // level coordinates of texel (0, 0)
uniform float u_scale;           // 2^level
uniform vec3 u_lutScale;
uniform vec3 u_lutOffset;
uniform vec3 u_nodata;
uniform int u_hasNodata;
uniform int u_usePal;
uniform float u_opacity;
uniform float u_saturation;      // −1 … +2 around 1
uniform int u_filt;              // 0 none, 1 linear kernel, 2 median 3×3, 3 dilate, 4 erode, 5 Sobel,
                                 // SAR speckle on intensity A² (REQ-SAR-07): 6 mean, 7 Lee, 8 Kuan,
                                 // 9 Gamma-MAP, 10 Frost, 11 Refined Lee (7×7)
uniform float u_sarL;            // looks L (C_u² = 1/L)
uniform float u_sarK;            // Frost damping K
uniform int u_fr;                // filter radius (1 → 3×3, 2 → 5×5)
uniform float u_fk[25];          // linear kernel, row-major 5×5, centre at index 12
uniform int u_dem;               // 0 off, 1 hillshade, 2 slope, 3 aspect, 4 colour relief (REQ-DEM-10)
uniform vec2 u_cell;             // DEM cell size (m) at full resolution, x and y
uniform vec3 u_sun;              // sun azimuth (rad, from grid north), elevation (rad), z-factor
uniform float u_gridRot;         // grid-north angle of the raster's up axis (rad)
uniform float u_contour;         // contour interval (m), 0 off (REQ-DEM-11)
uniform int u_hasClip;           // transparency threshold (REQ-IMG-09)
uniform vec2 u_clip;             // DN below x or above y → transparent (band 0 / brightest band)
in vec2 v_img;
out vec4 o;
${filtered ? `uniform int u_clahe;              // CLAHE on (REQ-IMG-08 Should)
uniform highp sampler2D u_claheTex; // 256 × (grid² · bands) R8: one map per cell and band
uniform int u_claheGrid;            // cells per side
uniform vec2 u_imgSize;             // full-resolution image size
// Bilinear blend of the four nearest cell maps at the pixel (contrast-limited AHE).
float clahe(int band, float g) {
  int n = u_claheGrid;
  vec2 c = v_img / u_imgSize * float(n) - 0.5;
  ivec2 c0 = ivec2(floor(c));
  vec2 f = c - floor(c);
  ivec2 a = clamp(c0, ivec2(0), ivec2(n - 1));
  ivec2 b = clamp(c0 + 1, ivec2(0), ivec2(n - 1));
  int i = int(clamp(g * 255.0 + 0.5, 0.0, 255.0));
  int base = band * n * n;
  float v00 = texelFetch(u_claheTex, ivec2(i, base + a.y * n + a.x), 0).r;
  float v10 = texelFetch(u_claheTex, ivec2(i, base + a.y * n + b.x), 0).r;
  float v01 = texelFetch(u_claheTex, ivec2(i, base + b.y * n + a.x), 0).r;
  float v11 = texelFetch(u_claheTex, ivec2(i, base + b.y * n + b.x), 0).r;
  return mix(mix(v00, v10, f.x), mix(v01, v11, f.x), f.y);
}
` : ''}
float F(${samp} t, ivec2 p) {
  p = clamp(p, ivec2(0), u_size - 1);
  return float(texelFetch(t, p, 0).r);
}

bool isNd(float v, float nd) {
  return ${kind === 'f' ? 'isnan(v) || isinf(v) || ' : ''}(u_hasNodata == 1 && v == nd);
}

${filtered ? `// SAR speckle filters (S6, REQ-SAR-07) on intensity; the texel is amplitude, so the result
// is returned as √intensity. Windows up to 9 × 9 fit inside the 4-texel gutter.
${sar ? `float I2(${samp} t, ivec2 p, float c) {
  float a = F(t, p);
  return isNd(a, u_nodata.x) ? c * c : a * a;
}
float sarFilter(${samp} t, ivec2 p, float c) {
  float cu2 = 1.0 / max(u_sarL, 0.1);
  float z = c * c;
${has('rlee') ? `  if (u_filt == 11) {
    // Refined Lee: 3 × 3 block means on a stride-2 grid pick the edge direction and half window.
    float bm[9];
    for (int by = 0; by < 3; by++)
      for (int bx = 0; bx < 3; bx++) {
        float s = 0.0;
        for (int dy = -1; dy <= 1; dy++)
          for (int dx = -1; dx <= 1; dx++) s += I2(t, p + ivec2(2 * (bx - 1) + dx, 2 * (by - 1) + dy), c);
        bm[by * 3 + bx] = s / 9.0;
      }
    float gh = abs((bm[0] + bm[1] + bm[2]) - (bm[6] + bm[7] + bm[8]));
    float gv = abs((bm[0] + bm[3] + bm[6]) - (bm[2] + bm[5] + bm[8]));
    float gd = abs((bm[1] + bm[0] + bm[3]) - (bm[5] + bm[8] + bm[7]));
    float ga = abs((bm[1] + bm[2] + bm[5]) - (bm[3] + bm[6] + bm[7]));
    int k = 0;
    float g = gh;
    if (gv > g) { g = gv; k = 1; }
    if (gd > g) { g = gd; k = 2; }
    if (ga > g) { g = ga; k = 3; }
    float cm = bm[4];
    float h0, h1;
    if (k == 0) { h0 = (bm[0] + bm[1] + bm[2]) / 3.0; h1 = (bm[6] + bm[7] + bm[8]) / 3.0; }
    else if (k == 1) { h0 = (bm[0] + bm[3] + bm[6]) / 3.0; h1 = (bm[2] + bm[5] + bm[8]) / 3.0; }
    else if (k == 2) { h0 = (bm[1] + bm[0] + bm[3]) / 3.0; h1 = (bm[5] + bm[8] + bm[7]) / 3.0; }
    else { h0 = (bm[1] + bm[2] + bm[5]) / 3.0; h1 = (bm[3] + bm[6] + bm[7]) / 3.0; }
    int d = 2 * k + (abs(h0 - cm) <= abs(h1 - cm) ? 0 : 1);
    float s1 = 0.0, s2 = 0.0, n = 0.0;
    for (int dy = -3; dy <= 3; dy++)
      for (int dx = -3; dx <= 3; dx++) {
        bool in_ = d == 0 ? dy <= 0 : d == 1 ? dy >= 0 : d == 2 ? dx <= 0 : d == 3 ? dx >= 0 : d == 4 ? dx + dy <= 0 : d == 5 ? dx + dy >= 0 : d == 6 ? dx - dy <= 0 : dx - dy >= 0;
        if (!in_) continue;
        float v = I2(t, p + ivec2(dx, dy), c);
        s1 += v;
        s2 += v * v;
        n += 1.0;
      }
    float m = s1 / n;
    float vy = max(s2 / n - m * m, 0.0);
    float vx = max((vy - m * m * cu2) / (1.0 + cu2), 0.0);
    float b = vy > 0.0 ? vx / vy : 0.0;
    return sqrt(max(m + b * (z - m), 0.0));
  }
` : ''}${has('sarstat') || has('frost') ? `  float s1 = 0.0, s2 = 0.0, n = 0.0;
  for (int y = -4; y <= 4; y++)
    for (int x = -4; x <= 4; x++) {
      if (abs(x) > u_fr || abs(y) > u_fr) continue;
      float v = I2(t, p + ivec2(x, y), c);
      s1 += v;
      s2 += v * v;
      n += 1.0;
    }
  float m = s1 / n;
  float ci2 = m > 0.0 ? max(s2 / n - m * m, 0.0) / (m * m) : 0.0;
  float est = m;
${has('sarstat') ? `  if (u_filt == 7) est = m + (ci2 > 0.0 ? max(0.0, 1.0 - cu2 / ci2) : 0.0) * (z - m);
  else if (u_filt == 8) est = m + (ci2 > 0.0 ? clamp((1.0 - cu2 / ci2) / (1.0 + cu2), 0.0, 1.0) : 0.0) * (z - m);
  else if (u_filt == 9) {
    float cu = sqrt(cu2), ci = sqrt(ci2);
    if (ci <= cu) est = m;
    else if (ci >= 1.41421356 * cu) est = z;
    else {
      float L = 1.0 / cu2;
      float al = (1.0 + cu2) / (ci2 - cu2);
      float b = al - L - 1.0;
      est = (b * m + sqrt(max(m * m * b * b + 4.0 * al * L * m * z, 0.0))) / (2.0 * al);
    }
  }
` : ''}${has('frost') ? `  if (u_filt == 10) {
    float kk = max(u_sarK, 0.0) * ci2;
    float s = 0.0, sw = 0.0;
    for (int y = -4; y <= 4; y++)
      for (int x = -4; x <= 4; x++) {
        if (abs(x) > u_fr || abs(y) > u_fr) continue;
        float w = exp(-kk * length(vec2(float(x), float(y))));
        s += w * I2(t, p + ivec2(x, y), c);
        sw += w;
      }
    est = s / sw;
  }
` : ''}  return sqrt(max(est, 0.0));
` : `  return c;
`}}
` : ''}
// Filtered texel (S6). Nodata texels inside the footprint take the centre value.
float T(${samp} t, ivec2 p) {
  if (u_filt == 0) return F(t, p);
  float c = F(t, p);
${sar ? `  if (u_filt >= 6) return isNd(c, u_nodata.x) ? c : sarFilter(t, p, c);
` : ''}${has('lin') ? `  if (u_filt == 1) {
    float s = 0.0;
    for (int y = -2; y <= 2; y++)
      for (int x = -2; x <= 2; x++) {
        float w = u_fk[(y + 2) * 5 + x + 2];
        if (w != 0.0) {
          float v = F(t, p + ivec2(x, y));
          s += w * (isNd(v, u_nodata.x) ? c : v);
        }
      }
    return s;
  }
` : ''}${has('med') ? `  if (u_filt == 2) {
    float v[9];
    int k = 0;
    for (int y = -1; y <= 1; y++)
      for (int x = -1; x <= 1; x++) v[k++] = F(t, p + ivec2(x, y));
    // Partial selection: the 5th smallest of 9.
    for (int i = 0; i < 5; i++)
      for (int j = i + 1; j < 9; j++)
        if (v[j] < v[i]) { float tmp = v[i]; v[i] = v[j]; v[j] = tmp; }
    return v[4];
  }
` : ''}${has('morph') ? `  if (u_filt == 3 || u_filt == 4) {
    float m = c;
    for (int y = -2; y <= 2; y++)
      for (int x = -2; x <= 2; x++) {
        if (abs(x) > u_fr || abs(y) > u_fr) continue;
        float v = F(t, p + ivec2(x, y));
        m = u_filt == 3 ? max(m, v) : min(m, v);
      }
    return m;
  }
` : ''}${has('sobel') ? `  float a = F(t, p + ivec2(-1, -1)), b = F(t, p + ivec2(0, -1)), d = F(t, p + ivec2(1, -1));
  float e = F(t, p + ivec2(-1, 0)), g = F(t, p + ivec2(1, 0));
  float hh = F(t, p + ivec2(-1, 1)), i2 = F(t, p + ivec2(0, 1)), j = F(t, p + ivec2(1, 1));
  float gx = (d + 2.0 * g + j) - (a + 2.0 * e + hh);
  float gy = (hh + 2.0 * i2 + j) - (a + 2.0 * b + d);
  return length(vec2(gx, gy)) * 0.25;
` : `  return c;
`}}

` : ""}
${filtered ? `
// DEM display (REQ-DEM-10): Horn gradients on the drawn level, in metres.
vec2 demGrad(${samp} t, ivec2 p) {
  float a = F(t, p + ivec2(-1, -1)), b = F(t, p + ivec2(0, -1)), c = F(t, p + ivec2(1, -1));
  float d = F(t, p + ivec2(-1, 0)), f = F(t, p + ivec2(1, 0));
  float g = F(t, p + ivec2(-1, 1)), hh = F(t, p + ivec2(0, 1)), i = F(t, p + ivec2(1, 1));
  vec2 cell = u_cell * u_scale;
  float dzdx = ((c + 2.0 * f + i) - (a + 2.0 * d + g)) / (8.0 * cell.x);
  float dzdy = ((g + 2.0 * hh + i) - (a + 2.0 * b + c)) / (8.0 * cell.y);
  return vec2(dzdx, dzdy) * u_sun.z;
}
float demShade(vec2 gr) {
  float slope = atan(length(gr));
  // Aspect from grid north (y down in the raster), clockwise.
  float aspect = atan(-gr.x, gr.y) + u_gridRot;
  float zen = 1.5707963 - u_sun.y;
  return clamp(cos(zen) * cos(slope) + sin(zen) * sin(slope) * cos(u_sun.x - aspect), 0.0, 1.0);
}
vec3 hsv2rgb(vec3 c) {
  vec3 p = abs(fract(c.xxx + vec3(0.0, 2.0 / 3.0, 1.0 / 3.0)) * 6.0 - 3.0);
  return c.z * mix(vec3(1.0), clamp(p - 1.0, 0.0, 1.0), c.y);
}
vec3 demColour(${samp} t, ivec2 p, vec3 base) {
  vec2 gr = demGrad(t, p);
  if (u_dem == 1) return vec3(demShade(gr));
  if (u_dem == 2) {
    float sd = degrees(atan(length(gr)));
    float k = clamp(sd / 45.0, 0.0, 1.0);
    return k < 0.5 ? mix(vec3(0.1, 0.6, 0.1), vec3(1.0, 0.9, 0.1), k * 2.0) : mix(vec3(1.0, 0.9, 0.1), vec3(0.85, 0.1, 0.05), k * 2.0 - 1.0);
  }
  if (u_dem == 3) {
    float sd = degrees(atan(length(gr)));
    float asp = mod(atan(-gr.x, gr.y) + u_gridRot + 6.2831853, 6.2831853) / 6.2831853;
    return sd < 1.0 ? vec3(0.75) : hsv2rgb(vec3(asp, 0.75, 0.95));
  }
  return base * (0.35 + 0.65 * demShade(gr));
}
` : ''}
float keys(float x) {           // Keys cubic, a = −0.5
  x = abs(x);
  if (x <= 1.0) return (1.5 * x - 2.5) * x * x + 1.0;
  if (x < 2.0) return ((-0.5 * x + 2.5) * x - 4.0) * x + 2.0;
  return 0.0;
}

float sinc(float x) {
  if (abs(x) < 1e-5) return 1.0;
  float px = 3.14159265358979 * x;
  return sin(px) / px;
}

float lanczos(float x) { return abs(x) < 3.0 ? sinc(x) * sinc(x / 3.0) : 0.0; }

${filtered ? `float sampleK(${samp} t, vec2 q) {
  if (u_kernel == 0) return T(t, ivec2(floor(q)));
  vec2 p = q - 0.5;
  vec2 i0 = floor(p);
  vec2 f = p - i0;
  ivec2 ii = ivec2(i0);
  float a = T(t, ii), b = T(t, ii + ivec2(1, 0)), c = T(t, ii + ivec2(0, 1)), d = T(t, ii + ivec2(1, 1));
  return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
}

` : `float sampleK(${samp} t, vec2 q) {
  if (u_kernel == 0) return F(t, ivec2(floor(q)));
  vec2 p = q - 0.5;
  vec2 i0 = floor(p);
  vec2 f = p - i0;
  ivec2 ii = ivec2(i0);
  if (u_kernel == 1) {
    float a = F(t, ii), b = F(t, ii + ivec2(1, 0)), c = F(t, ii + ivec2(0, 1)), d = F(t, ii + ivec2(1, 1));
    return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
  }
  float s = 0.0;
  float ws = 0.0;
  if (u_kernel == 2) {
    for (int y = -1; y <= 2; y++) {
      float wy = keys(float(y) - f.y);
      for (int x = -1; x <= 2; x++) {
        float w = keys(float(x) - f.x) * wy;
        s += w * F(t, ii + ivec2(x, y));
        ws += w;
      }
    }
  } else {
    for (int y = -2; y <= 3; y++) {
      float wy = lanczos(float(y) - f.y);
      for (int x = -2; x <= 3; x++) {
        float w = lanczos(float(x) - f.x) * wy;
        s += w * F(t, ii + ivec2(x, y));
        ws += w;
      }
    }
  }
  return s / ws;
}

`}
float lut(int band, float dn, float sc, float off) {
  int i = int(clamp(floor(dn * sc + off + 0.5), 0.0, 65535.0));
  return texelFetch(u_lut, ivec2(i & 255, band * 256 + (i >> 8)), 0).r;
}

void main() {
  vec2 q = v_img / u_scale - u_origin;
  // Void mask from the nearest sample (no-data never blends into the kernel's centre).
  ivec2 c = ivec2(floor(q));
  float n0 = F(u_b0, c);
  if (isNd(n0, u_nodata.x)) discard;
  float v0 = sampleK(u_b0, q);
  vec3 rgb;
  if (u_hasClip == 1 && u_nb == 1 && (v0 < u_clip.x || v0 > u_clip.y)) discard;
  if (u_nb == 1) {
    float g = lut(0, v0, u_lutScale.x, u_lutOffset.x);
    ${filtered ? 'if (u_clahe == 1) g = clahe(0, g);' : ''}
    rgb = u_usePal == 1 ? texelFetch(u_pal, ivec2(int(g * 255.0 + 0.5), 0), 0).rgb : vec3(g);
    ${filtered ? `if (u_dem > 0) {
      // Bilinear blend of the DEM colour at the four nearest texels.
      vec2 pp = q - 0.5;
      ivec2 i0 = ivec2(floor(pp));
      vec2 fr = pp - floor(pp);
      vec3 c00 = demColour(u_b0, i0, rgb), c10 = demColour(u_b0, i0 + ivec2(1, 0), rgb);
      vec3 c01 = demColour(u_b0, i0 + ivec2(0, 1), rgb), c11 = demColour(u_b0, i0 + ivec2(1, 1), rgb);
      rgb = mix(mix(c00, c10, fr.x), mix(c01, c11, fr.x), fr.y);
    }
    if (u_contour > 0.0) {
      ivec2 cc = ivec2(floor(q));
      float z0 = floor(F(u_b0, cc) / u_contour);
      if (floor(F(u_b0, cc + ivec2(1, 0)) / u_contour) != z0 || floor(F(u_b0, cc + ivec2(0, 1)) / u_contour) != z0) rgb = mix(rgb, vec3(0.45, 0.22, 0.05), 0.85);
    }` : ''}
  }${mono ? '' : ` else {
    float v1 = sampleK(u_b1, q);
    float v2 = sampleK(u_b2, q);
    if (u_hasClip == 1 && (max(v0, max(v1, v2)) < u_clip.x || min(v0, min(v1, v2)) > u_clip.y)) discard;
    rgb = vec3(lut(0, v0, u_lutScale.x, u_lutOffset.x), lut(1, v1, u_lutScale.y, u_lutOffset.y), lut(2, v2, u_lutScale.z, u_lutOffset.z));
    ${filtered ? 'if (u_clahe == 1) rgb = vec3(clahe(0, rgb.r), clahe(1, rgb.g), clahe(2, rgb.b));' : ''}
    float L = dot(rgb, vec3(0.2126, 0.7152, 0.0722));
    rgb = clamp(vec3(L) + (1.0 + u_saturation) * (rgb - vec3(L)), 0.0, 1.0);
  }`}
  o = vec4(rgb * u_opacity, u_opacity);
}`;
}

/** Textured quads (online map tiles, RGBA) in world coordinates. */
export const TEX_VS = `#version 300 es
in vec2 a_pos;
in vec2 a_uv;
uniform mat3 u_view;
uniform vec2 u_pane;
out vec2 v_uv;
void main() {
  vec3 s = u_view * vec3(a_pos, 1.0);
  v_uv = a_uv;
  gl_Position = vec4(2.0 * s.x / u_pane.x - 1.0, 1.0 - 2.0 * s.y / u_pane.y, 0.0, 1.0);
}`;

export const TEX_FS = `#version 300 es
precision mediump float;
uniform sampler2D u_tex;
uniform float u_opacity;
in vec2 v_uv;
out vec4 o;
void main() { vec4 c = texture(u_tex, v_uv); o = vec4(c.rgb * c.a * u_opacity, c.a * u_opacity); }`;

/** Flat-colour lines and fills (basemap, footprints) in pane pixel space. */
export const FLAT_VS = `#version 300 es
in vec2 a_pos;               // world coordinates (map: lon/lat degrees; image: pixels)
uniform mat3 u_view;
uniform vec2 u_pane;
void main() {
  vec3 s = u_view * vec3(a_pos, 1.0);
  gl_Position = vec4(2.0 * s.x / u_pane.x - 1.0, 1.0 - 2.0 * s.y / u_pane.y, 0.0, 1.0);
}`;

export const FLAT_FS = `#version 300 es
precision mediump float;
uniform vec4 u_color;
out vec4 o;
void main() { o = vec4(u_color.rgb * u_color.a, u_color.a); }`;

/**
 * Band Math (REQ-MSI-04): one generated program per expression. Up to eight band textures on
 * units 0–7, each scaled by its radiometric gain/offset, the expression evaluated per pixel,
 * then the result through the layer LUT (unit 8) and palette (unit 9). Division by zero, a
 * negative square root or a log of a non-positive value is no-data (transparent).
 */
export function bandMathFS(kind, expr, nb) {
  const samp = kind === 'u' ? 'usampler2D' : kind === 'i' ? 'isampler2D' : 'sampler2D';
  const decl = Array.from({ length: 8 }, (_, i) => `uniform ${samp} u_b${i};`).join('\n');
  const reads = Array.from({ length: nb }, (_, i) => `  bmB[${i}] = sampleB(u_b${i}, q) * u_bmGain[${i}] + u_bmOff[${i}];\n  if (isNd(F(u_b${i}, c), ${i})) discard;`).join('\n');
  return `#version 300 es
precision highp float;
precision highp int;
precision highp ${samp};
${decl}
uniform highp sampler2D u_lut;
uniform highp sampler2D u_pal;
uniform int u_kernel;
uniform ivec2 u_size;
uniform vec2 u_origin;
uniform float u_scale;
uniform float u_lutScale;
uniform float u_lutOffset;
uniform float u_nodataV;
uniform int u_hasNodata;
uniform int u_usePal;
uniform float u_opacity;
uniform float u_bmGain[8];
uniform float u_bmOff[8];
in vec2 v_img;
out vec4 o;
bool bmNd = false;
float bmB[8];
float F(${samp} t, ivec2 p) {
  p = clamp(p, ivec2(0), u_size - 1);
  return float(texelFetch(t, p, 0).r);
}
bool isNd(float v, int k) {
  return ${kind === 'f' ? 'isnan(v) || isinf(v) || ' : ''}(u_hasNodata == 1 && v == u_nodataV);
}
float sampleB(${samp} t, vec2 q) {
  if (u_kernel == 0) return F(t, ivec2(floor(q)));
  vec2 p = q - 0.5;
  vec2 i0 = floor(p);
  vec2 f = p - i0;
  ivec2 ii = ivec2(i0);
  float a = F(t, ii), b = F(t, ii + ivec2(1, 0)), c = F(t, ii + ivec2(0, 1)), d = F(t, ii + ivec2(1, 1));
  return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
}
float bmDiv(float a, float b) {
  if (b == 0.0) { bmNd = true; return 0.0; }
  return a / b;
}
float bmSqrt(float a) {
  if (a < 0.0) { bmNd = true; return 0.0; }
  return sqrt(a);
}
float bmLog(float a) {
  if (a <= 0.0) { bmNd = true; return 0.0; }
  return log(a);
}
void main() {
  vec2 q = v_img / u_scale - u_origin;
  ivec2 c = ivec2(floor(q));
${reads}
  float v = ${expr};
  if (bmNd || isnan(v) || isinf(v)) discard;
  int i = int(clamp(floor(v * u_lutScale + u_lutOffset + 0.5), 0.0, 65535.0));
  float g = texelFetch(u_lut, ivec2(i & 255, i >> 8), 0).r;
  vec3 rgb = u_usePal == 1 ? texelFetch(u_pal, ivec2(int(g * 255.0 + 0.5), 0), 0).rgb : vec3(g);
  o = vec4(rgb * u_opacity, u_opacity);
}`;
}
