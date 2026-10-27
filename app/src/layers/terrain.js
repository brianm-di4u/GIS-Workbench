// Terrain manager (REQ-DEM-01/03 partial, REQ-GEO-03): loaded DEMs are registered in the
// Rust core for height look-ups and ray–DEM intersection. DTED/SRTM heights are MSL (EGM96)
// and are converted to HAE through the embedded geoid before any sensor-model call.

export class Terrain {
  constructor(app) {
    this.app = app;
    this.dems = []; // {layerId, name, coreId, bounds, sigmaV, vertical}
  }

  addFromLayer(layer, res) {
    const g = res.gridInfo;
    const heights = res.heights;
    if (!g || !heights) return;
    const meta = res.meta ?? {};
    // DTED ACC/UHL accuracy is a 90 % linear error; σ = LE90 / 1.6449.
    const le = Number(meta.accAbsVertical || meta.absVerticalAccuracy);
    const sigmaV = Number.isFinite(le) && le > 0 ? le / 1.6449 : meta.format === 'SRTM HGT' ? 16 / 1.6449 : NaN;
    const hae = false; // DTED (MSL/E96) and SRTM are both orthometric on EGM96
    this.app.ensureGeoid?.();
    const coreId = this.app.core.loadDem({ lat0: g.lat0, lon0: g.lon0, dlat: g.dlat, dlon: g.dlon, width: g.width, height: g.height, heights, hae, sigmaV });
    this.dems.push({
      layerId: layer.id,
      vertical: 'egm96',
      name: `${layer.rec.name} (${meta.level || meta.format || 'DEM'}, MSL EGM96)`,
      coreId,
      sigmaV,
      // The source grid (never changed) and whether its posts are the layer's pixels (edits, REQ-DEM-08).
      grid: { lat0: g.lat0, lon0: g.lon0, dlat: g.dlat, dlon: g.dlon, width: g.width, height: g.height, heights },
      aligned: true,
      bounds: { north: g.lat0, south: g.lat0 - g.dlat * (g.height - 1), west: g.lon0, east: g.lon0 + g.dlon * (g.width - 1) },
    });
    this.app.emit('terrain');
  }

  /**
   * Register a DEM from a geographic grid (Use as Terrain, REQ-DEM-02). `vertical`: 'egm96'
   * (orthometric; converted to HAE with the embedded geoid), 'hae', 'egm2008' (converted with
   * EGM96 when no EGM2008 pack is loaded: differences ≲ 1 m, said in the name) or 'navd88'
   * (not converted).
   */
  addGrid(layer, g, { vertical = 'egm96', sigmaV = NaN, label = '', aligned = true } = {}) {
    const hae = vertical === 'hae';
    this.app.ensureGeoid?.();
    const coreId = this.app.core.loadDem({ lat0: g.lat0, lon0: g.lon0, dlat: g.dlat, dlon: g.dlon, width: g.width, height: g.height, heights: g.heights, hae, sigmaV });
    const vname = { egm96: 'MSL EGM96', hae: 'HAE', egm2008: 'MSL EGM2008 (converted with EGM96)', navd88: 'NAVD88 (not converted)' }[vertical] ?? vertical;
    this.remove(layer.id);
    this.dems.push({
      layerId: layer.id,
      name: `${layer.rec.name} (${label || 'DEM'}, ${vname})`,
      coreId,
      sigmaV,
      vertical,
      grid: { lat0: g.lat0, lon0: g.lon0, dlat: g.dlat, dlon: g.dlon, width: g.width, height: g.height, heights: g.heights },
      aligned,
      bounds: { north: g.lat0, south: g.lat0 - g.dlat * (g.height - 1), west: g.lon0, east: g.lon0 + g.dlon * (g.width - 1) },
    });
    this.app.emit('terrain');
  }

  entry(layerId) {
    return this.dems.find((d) => d.layerId === layerId) ?? null;
  }

  /** Replace a terrain's heights in the core (edited DEMs); the source grid stays as it was. */
  setHeights(layerId, heights) {
    const d = this.entry(layerId);
    if (!d) return;
    const g = d.grid;
    this.app.core.freeDem(d.coreId);
    d.coreId = this.app.core.loadDem({ lat0: g.lat0, lon0: g.lon0, dlat: g.dlat, dlon: g.dlon, width: g.width, height: g.height, heights, hae: d.vertical === 'hae', sigmaV: d.sigmaV });
    d.current = heights;
    this.app.emit('terrain');
  }

  remove(layerId) {
    const i = this.dems.findIndex((d) => d.layerId === layerId);
    if (i >= 0) {
      this.app.core.freeDem(this.dems[i].coreId);
      this.dems.splice(i, 1);
      this.app.emit('terrain');
    }
  }

  covering(lat, lon) {
    return this.dems.find((d) => lat <= d.bounds.north && lat >= d.bounds.south && lon >= d.bounds.west && lon <= d.bounds.east) ?? null;
  }

  /** DEM height (HAE) at a point, with its source, or null. */
  sample(lat, lon) {
    const d = this.covering(lat, lon);
    if (!d) return null;
    const hae = this.app.core.demHae(d.coreId, lat, lon);
    if (!Number.isFinite(hae)) return null;
    return { hae, msl: hae - this.app.core.undulation(lat, lon), name: d.name, sigmaV: d.sigmaV };
  }

  /** DEM under an image layer's centre, for ray–DEM. */
  demFor(layer) {
    const c = layer.groundAt(layer.width / 2, layer.height / 2);
    return c ? this.covering(c.lat, c.lon) : null;
  }

  get available() {
    return this.dems.length > 0;
  }
}
