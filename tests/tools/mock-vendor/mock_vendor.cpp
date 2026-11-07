// A stand-in for the MrSID and ECW GDAL plug-ins, for the Linux vendor path (REQ-GAP-69), which has
// no route without the vendors' terms (docs/validation/2.6/codecs.md). It registers the drivers
// the sidecar looks for under the real names, so the path from `gwb-sidecar-setup vendor --from`
// through the caps, conversion and views runs as it will with a real plug-in. A mock file is the
// magic below padded to 64 bytes, then an ordinary GeoTIFF; nothing here decodes MrSID or ECW.
// Test only: never packaged. Build: tests/tools/mock-vendor/build.sh
#include "gdal_priv.h"
#include "gdal_proxy.h"
#include <cstring>

static const char MAGIC[] = "GWBMOCKVENDOR\n";

namespace {
class MockBand final : public GDALProxyRasterBand {
  GDALRasterBand *under;

public:
  MockBand(GDALDataset *ds, int n, GDALRasterBand *u) : under(u) {
    poDS = ds;
    nBand = n;
    eDataType = u->GetRasterDataType();
    nRasterXSize = u->GetXSize();
    nRasterYSize = u->GetYSize();
    u->GetBlockSize(&nBlockXSize, &nBlockYSize);
  }

protected:
  GDALRasterBand *RefUnderlyingRasterBand(bool) const override { return under; }
};

class MockDS final : public GDALProxyDataset {
  GDALDataset *under;

public:
  explicit MockDS(GDALDataset *u) : under(u) {
    nRasterXSize = u->GetRasterXSize();
    nRasterYSize = u->GetRasterYSize();
    for (int i = 1; i <= u->GetRasterCount(); i++) SetBand(i, new MockBand(this, i, u->GetRasterBand(i)));
  }
  ~MockDS() override { GDALClose(under); }
  // The proxy would answer with the GeoTIFF driver inside.
  GDALDriver *GetDriver() const override { return GDALDataset::GetDriver(); }

protected:
  GDALDataset *RefUnderlyingDataset() const override { return under; }
};
} // namespace

static int identify(GDALOpenInfo *i) { return i->nHeaderBytes >= 64 && memcmp(i->pabyHeader, MAGIC, sizeof(MAGIC) - 1) == 0; }

static GDALDataset *open(GDALOpenInfo *i) {
  if (!identify(i) || i->eAccess == GA_Update) return nullptr;
  CPLString p;
  p.Printf("/vsisubfile/64_,%s", i->pszFilename);
  auto *u = GDALDataset::Open(p, GDAL_OF_RASTER | GDAL_OF_READONLY);
  return u ? new MockDS(u) : nullptr;
}

static int never(GDALOpenInfo *) { return FALSE; }

static void add(const char *name, bool reads) {
  if (GDALGetDriverByName(name)) return;
  auto *d = new GDALDriver();
  d->SetDescription(name);
  d->SetMetadataItem(GDAL_DCAP_RASTER, "YES");
  d->SetMetadataItem(GDAL_DMD_LONGNAME, "Mock vendor driver (tests only)");
  d->pfnIdentify = reads ? identify : never;
  if (reads) d->pfnOpen = open;
  GetGDALDriverManager()->RegisterDriver(d);
}

extern "C" void GDALRegister_MrSID() {
  add("MrSID", true);
  add("JP2MrSID", false);
}
extern "C" void GDALRegister_ECW_JP2ECW() {
  add("ECW", true);
  add("JP2ECW", false);
}
