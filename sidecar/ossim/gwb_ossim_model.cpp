// gwb-ossim-model: OSSIM's rigorous sensor models, sampled for the app (REQ-GAP-21).
//
//   gwb-ossim-model grid [--h-min m] [--h-max m] <image or metadata file> <output.json>
//   gwb-ossim-model g2i  <image or metadata file> <in.csv: lat,lon,h per line> <output.csv>
//
// `grid` asks OSSIM's image-to-ground for the ground position of a lattice of image points at several
// heights: 17 x 17 x 7 for the fit, and 9 x 9 x 3 on another lattice to check it. The app fits an
// RPC00B to the first set (gw_adjust::rpcfit) and measures it on the second, so the number it reports
// is the distance from OSSIM's model at points the fit did not see. The lattice is in image space
// because a strip lies skew in a lat/lon box: the corners of such a box are off the image, where a
// SAR model has no orbit to work from and OSSIM's generic ground-to-image only extrapolates. `g2i`
// is OSSIM's ground-to-image for one list of points: the oracle of the tests.
//
// Image coordinates in the output are corner-origin (the centre of the first pixel is 0.5, 0.5),
// as the app's sensor models use; OSSIM's put that centre at 0, 0. Heights are above the WGS 84
// ellipsoid, as in OSSIM's models and in RPC00B.
//
// It writes PROGRESS lines for the job system and refuses by name: an exit of 2 with one line on
// stderr that says why.

#include <ossim/ossimVersion.h>
#include <ossim/base/ossimFilename.h>
#include <ossim/base/ossimGpt.h>
#include <ossim/base/ossimDpt.h>
#include <ossim/base/ossimIrect.h>
#include <ossim/base/ossimNotify.h>
#include <ossim/base/ossimRefPtr.h>
#include <ossim/base/ossimTraceManager.h>
#include <ossim/imaging/ossimImageGeometry.h>
#include <ossim/imaging/ossimImageHandler.h>
#include <ossim/imaging/ossimImageHandlerRegistry.h>
#include <ossim/init/ossimInit.h>
#include <ossim/plugin/ossimSharedPluginRegistry.h>
#include <ossim/projection/ossimMapProjection.h>
#include <ossim/projection/ossimProjection.h>
#include <ossim/projection/ossimSensorModel.h>

#include <algorithm>
#include <cmath>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <fstream>
#include <iomanip>
#include <iostream>
#include <sstream>
#include <string>
#include <vector>

namespace {

[[noreturn]] void refuse(const std::string& why) {
  std::fprintf(stderr, "ERROR: %s\n", why.c_str());
  std::exit(2);
}

void progress(double p) {
  std::printf("PROGRESS %.3f\n", p);
  std::fflush(stdout);
}

struct Scene {
  ossimRefPtr<ossimImageHandler> handler;
  ossimRefPtr<ossimImageGeometry> geom;
  ossimSensorModel* sensor = nullptr;
  double width = 0, height = 0;
  std::string model;
};

bool g2i(const Scene& s, double lat, double lon, double h, double& x, double& y) {
  ossimDpt p;
  ossimGpt g(lat, lon, h);
  if (!s.geom->worldToLocal(g, p) || p.hasNans()) return false;
  x = p.x + 0.5;
  y = p.y + 0.5;
  return true;
}

Scene open_scene(const std::string& file) {
  Scene s;
  s.handler = ossimImageHandlerRegistry::instance()->open(ossimFilename(file));
  if (!s.handler.valid()) refuse("OSSIM cannot open " + file + ": no reader of this build knows it");
  s.geom = s.handler->getImageGeometry();
  if (!s.geom.valid() || !s.geom->getProjection()) refuse("OSSIM found no sensor model for " + file);
  ossimProjection* proj = s.geom->getProjection();
  s.model = proj->getClassName().string();
  if (dynamic_cast<ossimMapProjection*>(proj)) refuse(file + " is map-projected (" + s.model + "), so it has no sensor geometry to model");
  s.sensor = dynamic_cast<ossimSensorModel*>(proj);
  if (!s.sensor) refuse("OSSIM's model for " + file + " is " + s.model + ", which is not a sensor model");
  ossimIrect r = s.handler->getBoundingRect(0);
  s.width = r.width();
  s.height = r.height();
  if (s.width < 2 || s.height < 2) refuse(file + " has no image size");
  return s;
}

std::string quoted(const std::string& t) {
  std::string o = "\"";
  for (char c : t) {
    if (c == '"' || c == '\\') {
      o += '\\';
      o += c;
    } else if ((unsigned char)c >= 0x20) {
      o += c;
    }
  }
  return o + "\"";
}

struct Box {
  double lat0 = 1e9, lat1 = -1e9, lon0 = 1e9, lon1 = -1e9;
};

struct Sample {
  double lat, lon, h, x, y;
};

// nx x ny x nh image points, at cell offsets when `ox` is not negative, else corner to corner.
std::vector<Sample> lattice(const Scene& s, double hmin, double hmax, int nx, int ny, int nh, double ox, double oy, double p0, double p1) {
  std::vector<Sample> out;
  out.reserve((size_t)nx * ny * nh);
  for (int k = 0; k < nh; k++) {
    const double h = hmin + (hmax - hmin) * k / (nh - 1);
    for (int j = 0; j < ny; j++) {
      for (int i = 0; i < nx; i++) {
        const double fx = ox < 0 ? (double)i / (nx - 1) : (i + ox) / nx;
        const double fy = ox < 0 ? (double)j / (ny - 1) : (j + oy) / ny;
        // Corner-origin coordinates across the image, and OSSIM's own for the call.
        const double x = s.width * fx, y = s.height * fy;
        ossimGpt g;
        s.geom->localToWorld(ossimDpt(x - 0.5, y - 0.5), h, g);
        if (g.isLatNan() || g.isLonNan()) refuse("OSSIM's model gives no ground position for an image point; the height range may be outside the model");
        out.push_back({g.lat, g.lon, h, x, y});
      }
      progress(p0 + (p1 - p0) * (k * ny + j + 1) / ((double)nh * ny));
    }
  }
  return out;
}

// Across the antimeridian the longitudes run on past 180, so the fit sees no jump.
Box box_of(std::vector<Sample>& a, std::vector<Sample>& b) {
  Box box;
  const double ref = a[0].lon;
  for (std::vector<Sample>* v : {&a, &b}) {
    for (Sample& p : *v) {
      while (p.lon - ref > 180) p.lon -= 360;
      while (p.lon - ref < -180) p.lon += 360;
      box.lat0 = std::min(box.lat0, p.lat);
      box.lat1 = std::max(box.lat1, p.lat);
      box.lon0 = std::min(box.lon0, p.lon);
      box.lon1 = std::max(box.lon1, p.lon);
    }
  }
  return box;
}

void rows(std::ostream& o, const std::vector<Sample>& v) {
  o << "[";
  for (size_t i = 0; i < v.size(); i++) o << (i ? ",[" : "[") << v[i].lat << "," << v[i].lon << "," << v[i].h << "," << v[i].x << "," << v[i].y << "]";
  o << "]";
}

int cmd_grid(const std::vector<std::string>& a) {
  double hmin = -100, hmax = 3000;
  std::vector<std::string> pos;
  for (size_t i = 0; i < a.size(); i++) {
    if (a[i] == "--h-min" && i + 1 < a.size()) hmin = std::atof(a[++i].c_str());
    else if (a[i] == "--h-max" && i + 1 < a.size()) hmax = std::atof(a[++i].c_str());
    else pos.push_back(a[i]);
  }
  if (pos.size() != 2) refuse("grid takes an input file and an output file");
  if (!(hmax > hmin)) refuse("the height range is empty");
  Scene s = open_scene(pos[0]);
  progress(0.02);
  std::vector<Sample> fit = lattice(s, hmin, hmax, 17, 17, 7, -1, -1, 0.02, 0.85);
  std::vector<Sample> check = lattice(s, hmin, hmax, 9, 9, 3, 0.61, 0.37, 0.85, 1.0);
  Box b = box_of(fit, check);
  if (!(b.lat1 > b.lat0 && b.lon1 > b.lon0)) refuse("the model's footprint is empty");
  std::ostringstream o;
  o << std::setprecision(15);
  o << "{\"tool\":\"gwb-ossim-model\",\"ossim\":" << quoted(OSSIM_VERSION) << ",\"model\":" << quoted(s.model);
  o << ",\"width\":" << s.width << ",\"height\":" << s.height;
  o << ",\"box\":{\"lat\":[" << b.lat0 << "," << b.lat1 << "],\"lon\":[" << b.lon0 << "," << b.lon1 << "],\"h\":[" << hmin << "," << hmax << "]}";
  o << ",\"fit\":";
  rows(o, fit);
  o << ",\"check\":";
  rows(o, check);
  o << "}\n";
  std::ofstream f(pos[1], std::ios::binary);
  f << o.str();
  f.close();
  if (!f) refuse("the output could not be written");
  progress(1);
  return 0;
}

int cmd_g2i(const std::vector<std::string>& a) {
  if (a.size() != 3) refuse("g2i takes an input file, a CSV of lat,lon,h and an output file");
  Scene s = open_scene(a[0]);
  std::ifstream in(a[1]);
  std::ofstream out(a[2], std::ios::binary);
  out << std::setprecision(15);
  std::string line;
  while (std::getline(in, line)) {
    double lat, lon, h, x, y;
    if (std::sscanf(line.c_str(), "%lf,%lf,%lf", &lat, &lon, &h) != 3) continue;
    if (g2i(s, lat, lon, h, x, y)) out << x << "," << y << "\n";
    else out << "nan,nan\n";
  }
  return 0;
}

void load_plugin() {
  // A plug-in that does not load only takes its sensors away: the refusal for such a file names it.
  const char* dir = std::getenv("GWB_OSSIM_PLUGINS");
  if (!dir || !*dir) return;
#ifdef _WIN32
  const std::string file = std::string(dir) + "\\ossim_cnes_plugin.dll";
#else
  const std::string file = std::string(dir) + "/libossim_cnes_plugin.so";
#endif
  if (!ossimSharedPluginRegistry::instance()->registerPlugin(ossimFilename(file))) std::fprintf(stderr, "WARNING: %s did not load, so its sensors are not available\n", file.c_str());
}

} // namespace

int main(int argc, char** argv) {
  if (argc < 2) refuse("usage: gwb-ossim-model grid|g2i ...");
  if (const char* t = std::getenv("GWB_OSSIM_TRACE")) ossimTraceManager::instance()->setTracePattern(t);
  int oargc = 1;
  ossimInit::instance()->initialize(oargc, argv);
  load_plugin();
  const std::string cmd = argv[1];
  std::vector<std::string> a(argv + 2, argv + argc);
  if (cmd == "version") {
    std::printf("OSSIM %s\n", OSSIM_VERSION);
    return 0;
  }
  if (cmd == "grid") return cmd_grid(a);
  if (cmd == "g2i") return cmd_g2i(a);
  refuse("no such command: " + cmd);
}
