// GIS Workbench: the native usgscsm oracle for the REQ-GAP-24 differential test.
//
// Built natively (build/csm/oracle/build-oracle.sh: g++ in WSL) from the same usgscsm, ALE and CSM
// sources as the wasm module, linking the same gw_csm.cpp C ABI. Two variants:
//   upstream — ALE's own Rotation.cpp and usgscsm's EigenUtilities.cpp (Eigen 3, as usgscsm ships);
//   gw       — the Eigen-free replacements the wasm module uses (build/csm/src).
// For each ISD it writes the grid it evaluated and every answer, with 17 significant digits, so the
// vitest diff (tests/unit/csm-diff.test.js) feeds the wasm module the same inputs and compares.
//
// usage: csm_oracle <isd.json> <out.json>
//
// Licence: Apache-2.0 (GIS Workbench).

#include <chrono>
#include <cmath>
#include <cstdio>
#include <cstring>
#include <fstream>
#include <limits>
#include <sstream>
#include <string>
#include <vector>

extern "C" {
int gwc_model_from_isd(const uint8_t *isd, size_t n, const uint8_t *name, size_t nameLen, const uint8_t *id, size_t idLen);
int gwc_model_info(int h);
const char *gwc_out_ptr();
size_t gwc_out_len();
size_t gwc_last_error(uint8_t *buf, size_t cap);
int gwc_i2g_ecef(int h, const double *pts, size_t n, double *res);
int gwc_g2i_ecef(int h, const double *pts, size_t n, double *res);
int gwc_i2g(int h, const double *pts, size_t n, double *res);
int gwc_g2i(int h, const double *pts, size_t n, double *res);
int gwc_sensor_partials(int h, double lat, double lon, double hae, double *res);
int gwc_ground_partials_ecef(int h, double x, double y, double z, double *res);
int gwc_locus(int h, double x, double y, double *res);
}

namespace {

std::string num(double v) {
  if (std::isnan(v)) return "null";
  char b[40];
  std::snprintf(b, sizeof b, "%.17g", v);
  return b;
}

std::string arr(const std::vector<double> &v) {
  std::string s = "[";
  for (size_t i = 0; i < v.size(); i++) {
    if (i) s += ",";
    s += num(v[i]);
  }
  return s + "]";
}

std::string outText() { return std::string(gwc_out_ptr(), gwc_out_len()); }

double jsonNum(const std::string &j, const std::string &key) {
  size_t p = j.find("\"" + key + "\":");
  if (p == std::string::npos) return std::numeric_limits<double>::quiet_NaN();
  return std::strtod(j.c_str() + p + key.size() + 3, nullptr);
}

}  // namespace

int main(int argc, char **argv) {
  if (argc < 3) {
    std::fprintf(stderr, "usage: csm_oracle <isd.json> <out.json>\n");
    return 2;
  }
  std::ifstream f(argv[1], std::ios::binary);
  std::stringstream ss;
  ss << f.rdbuf();
  std::string isd = ss.str();
  auto t0 = std::chrono::steady_clock::now();
  std::string id = argv[1];
  id = id.substr(id.find_last_of("/\\") + 1);
  id = id.substr(0, id.rfind('.'));
  int h = gwc_model_from_isd(reinterpret_cast<const uint8_t *>(isd.data()), isd.size(), nullptr, 0, reinterpret_cast<const uint8_t *>(id.data()), id.size());
  double loadMs = std::chrono::duration<double, std::milli>(std::chrono::steady_clock::now() - t0).count();
  std::ofstream o(argv[2]);
  if (h <= 0) {
    char e[1024];
    size_t n = gwc_last_error(reinterpret_cast<uint8_t *>(e), sizeof e);
    o << "{\"error\":" << -h << ",\"message\":\"" << std::string(e, n < sizeof e ? n : sizeof e) << "\"}\n";
    return 0;
  }
  gwc_model_info(h);
  std::string info = outText();
  const double lines = jsonNum(info, "lines"), samples = jsonNum(info, "samples"), a = jsonNum(info, "a");
  int np = 0;  // one "name" key per parameter
  for (size_t p = info.find("\"name\":"); p != std::string::npos; p = info.find("\"name\":", p + 1)) np++;

  // The grid: 9 × 9 pixel centres from the first to the last, at two heights.
  const int N = 9;
  const double heights[2] = {0.0, a * 1e-4};
  std::vector<double> img;  // (line, sample, h)
  for (double hh : heights)
    for (int r = 0; r < N; r++)
      for (int c = 0; c < N; c++) {
        img.push_back(0.5 + r * (lines - 1) / (N - 1));
        img.push_back(0.5 + c * (samples - 1) / (N - 1));
        img.push_back(hh);
      }
  const size_t n = img.size() / 3;
  std::vector<double> ecef(3 * n), back(3 * n), llh(3 * n), xy(2 * n), appImg(3 * n);
  auto t1 = std::chrono::steady_clock::now();
  int badI2g = gwc_i2g_ecef(h, img.data(), n, ecef.data());
  double i2gUs = std::chrono::duration<double, std::micro>(std::chrono::steady_clock::now() - t1).count() / n;
  auto t2 = std::chrono::steady_clock::now();
  int badG2i = gwc_g2i_ecef(h, ecef.data(), n, back.data());
  double g2iUs = std::chrono::duration<double, std::micro>(std::chrono::steady_clock::now() - t2).count() / n;
  for (size_t i = 0; i < n; i++) {
    appImg[3 * i] = img[3 * i + 1];
    appImg[3 * i + 1] = img[3 * i];
    appImg[3 * i + 2] = img[3 * i + 2];
  }
  gwc_i2g(h, appImg.data(), n, llh.data());
  gwc_g2i(h, llh.data(), n, xy.data());

  // Partials and the locus at the image centre.
  std::vector<double> cen = {lines / 2, samples / 2, 0.0}, cg(3), cllh(3);
  gwc_i2g_ecef(h, cen.data(), 1, cg.data());
  std::vector<double> capp = {samples / 2, lines / 2, 0.0};
  gwc_i2g(h, capp.data(), 1, cllh.data());
  std::vector<double> sp(2 * (np > 0 ? np : 1), std::numeric_limits<double>::quiet_NaN()), gp(6, std::numeric_limits<double>::quiet_NaN()), locus(6);
  int spn = std::isnan(cllh[0]) ? -1 : gwc_sensor_partials(h, cllh[0], cllh[1], cllh[2], sp.data());
  if (!std::isnan(cg[0])) gwc_ground_partials_ecef(h, cg[0], cg[1], cg[2], gp.data());
  gwc_locus(h, samples / 2, lines / 2, locus.data());
  if (spn > 0) sp.resize(2 * spn);

  o << "{\"info\":" << info << ",\"loadMs\":" << num(loadMs) << ",\"i2gUs\":" << num(i2gUs) << ",\"g2iUs\":" << num(g2iUs)
    << ",\"badI2g\":" << badI2g << ",\"badG2i\":" << badG2i << ",\"img\":" << arr(img) << ",\"ecef\":" << arr(ecef) << ",\"back\":" << arr(back)
    << ",\"appImg\":" << arr(appImg) << ",\"llh\":" << arr(llh) << ",\"xy\":" << arr(xy) << ",\"centre\":" << arr(cllh)
    << ",\"sensorPartials\":" << arr(sp) << ",\"groundPartials\":" << arr(gp) << ",\"locus\":" << arr(locus) << "}\n";
  return 0;
}
