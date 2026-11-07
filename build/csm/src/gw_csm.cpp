// GIS Workbench: a hand-written C ABI over usgscsm (REQ-GAP-24, spike S-60).
//
// No embind and no Emscripten JS glue: the module is built STANDALONE_WASM (a WASI reactor) and
// app/src/sensor/csm-wasm.js instantiates it with a handful of WASI stubs. Every entry point is a
// plain C function over numbers and linear-memory pointers; C++ exceptions never cross it (each
// call catches them and returns a negative status, the text in gwc_last_error).
//
// The same file is compiled natively (build/csm/oracle) as the differential oracle, so the wasm
// and native builds answer the same calls.
//
// Coordinates. CSM image coordinates are (line, sample) with the centre of the first pixel at
// (0.5, 0.5), as usgscsm and ALE use them (ALE detector centres are ISIS centres − 0.5); that is the
// GIS Workbench convention, so x = sample and y = line with no offset. The *_ecef calls take and
// give body-fixed X, Y, Z (m) as CSM does. The geodetic calls (gwc_i2g, gwc_g2i, the partials)
// convert on the model's own ellipsoid (CSM getEllipsoid: the ISD's radii): latitude is geodetic
// (planetographic) and longitude east-positive, in degrees; height is above that ellipsoid (m).
//
// Licence: Apache-2.0 (GIS Workbench). usgscsm, ALE and the CSM API are public domain.

#include <cmath>
#include <cstdint>
#include <cstdlib>
#include <cstring>
#include <limits>
#include <memory>
#include <string>
#include <vector>

#include <csm.h>
#include <Error.h>
#include <Warning.h>
#include <RasterGM.h>
#include <SettableEllipsoid.h>
#include <nlohmann/json.hpp>

#include "Logging.h"
#include "Utilities.h"

#if defined(__wasm__)
#define GWC_EXPORT(name) extern "C" __attribute__((export_name(#name), used))
#else
#define GWC_EXPORT(name) extern "C"
#endif

namespace {

// Status codes as the GIS Workbench C ABI (app/src/wasm/abi.js STATUS): returned negated.
enum Status { OK = 0, INVALID = 1, RANGE = 2, LIMIT = 3, UNSUPPORTED = 4, INTERNAL = 5 };

struct Slot {
  std::unique_ptr<csm::RasterGM> model;
  double a = 0, b = 0;           // ellipsoid semi-axes (m)
  double g2iPrecision = 1e-6;    // desired precision of ground → image (px)
  double i2gPrecision = 1e-6;    // desired precision of image → ground (m)
};

std::vector<Slot> slots;         // handle = index + 1
std::string lastError;
std::string out;                 // the out buffer (gwc_out_ptr / gwc_out_len)

int statusOf(const csm::Error &e) {
  switch (e.getError()) {
    case csm::Error::BOUNDS:
    case csm::Error::INDEX_OUT_OF_RANGE:
      return RANGE;
    case csm::Error::MEMORY:
    case csm::Error::STRING_TOO_LONG:
      return LIMIT;
    case csm::Error::ISD_NOT_SUPPORTED:
    case csm::Error::SENSOR_MODEL_NOT_SUPPORTED:
    case csm::Error::UNSUPPORTED_FUNCTION:
    case csm::Error::UNKNOWN_SUPPORT_DATA:
      return UNSUPPORTED;
    case csm::Error::INVALID_USE:
    case csm::Error::INVALID_SENSOR_MODEL_STATE:
    case csm::Error::SENSOR_MODEL_NOT_CONSTRUCTIBLE:
    case csm::Error::FILE_READ:
      return INVALID;
    default:
      return INTERNAL;
  }
}

// Run fn, mapping C++ exceptions to −status with the message in lastError.
template <class F>
int guarded(F &&fn) {
  try {
    return fn();
  } catch (const csm::Error &e) {
    lastError = e.getMessage();
    if (!e.getFunction().empty()) lastError += " (" + e.getFunction() + ")";
    return -statusOf(e);
  } catch (const nlohmann::json::exception &e) {
    lastError = std::string("ISD or state JSON: ") + e.what();
    return -INVALID;
  } catch (const std::bad_alloc &) {
    lastError = "out of memory";
    return -LIMIT;
  } catch (const std::exception &e) {
    lastError = e.what();
    return -INTERNAL;
  } catch (...) {
    lastError = "unknown C++ exception";
    return -INTERNAL;
  }
}

Slot *slotOf(int h) {
  if (h < 1 || static_cast<size_t>(h) > slots.size() || !slots[h - 1].model) {
    throw csm::Error(csm::Error::INVALID_USE, "unknown CSM model handle", "gw_csm");
  }
  return &slots[h - 1];
}

int store(csm::RasterGM *m) {
  Slot s;
  s.model.reset(m);
  auto *se = dynamic_cast<csm::SettableEllipsoid *>(m);
  if (!se) throw csm::Error(csm::Error::UNSUPPORTED_FUNCTION, "the model states no ellipsoid", "gw_csm");
  csm::Ellipsoid e = se->getEllipsoid();
  s.a = e.getSemiMajorRadius();
  s.b = e.getSemiMinorRadius();
  if (!(s.a > 0 && s.b > 0 && s.b <= s.a)) throw csm::Error(csm::Error::INVALID_SENSOR_MODEL_STATE, "the model's ellipsoid radii are not valid", "gw_csm");
  for (size_t i = 0; i < slots.size(); i++) {
    if (!slots[i].model) {
      slots[i] = std::move(s);
      return static_cast<int>(i) + 1;
    }
  }
  slots.push_back(std::move(s));
  return static_cast<int>(slots.size());
}

const double D2R = M_PI / 180.0;

void geodeticToEcef(const Slot &s, double lat, double lon, double h, double xyz[3]) {
  const double e2 = 1.0 - (s.b * s.b) / (s.a * s.a);
  const double sp = std::sin(lat * D2R), cp = std::cos(lat * D2R);
  const double n = s.a / std::sqrt(1.0 - e2 * sp * sp);
  xyz[0] = (n + h) * cp * std::cos(lon * D2R);
  xyz[1] = (n + h) * cp * std::sin(lon * D2R);
  xyz[2] = (n * (1.0 - e2) + h) * sp;
}

// ECEF → geodetic on (a, b): exact for a sphere; otherwise Bowring's formula as the start and
// the fixed-point latitude iteration φ ← atan2(z + e² N(φ) sin φ, p), which gains about −log10(e²)
// digits a step (Earth, Mars: 2), until the step is below 1e-15 rad.
void ecefToGeodetic(const Slot &s, double x, double y, double z, double llh[3]) {
  const double a = s.a, b = s.b;
  const double p = std::hypot(x, y);
  const double lon = std::atan2(y, x);
  double lat, h;
  if (a == b) {
    lat = std::atan2(z, p);
    h = std::sqrt(p * p + z * z) - a;
  } else {
    const double e2 = 1.0 - (b * b) / (a * a);
    const double ep2 = (a * a) / (b * b) - 1.0;
    const double th = std::atan2(z * a, p * b);
    const double st = std::sin(th), ct = std::cos(th);
    lat = std::atan2(z + ep2 * b * st * st * st, p - e2 * a * ct * ct * ct);
    for (int i = 0; i < 20; i++) {
      const double sp = std::sin(lat);
      const double n = a / std::sqrt(1.0 - e2 * sp * sp);
      const double next = std::atan2(z + e2 * n * sp, p);
      const double d = next - lat;
      lat = next;
      if (std::fabs(d) < 1e-15) break;
    }
    const double sp = std::sin(lat), cp = std::cos(lat);
    const double n = a / std::sqrt(1.0 - e2 * sp * sp);
    h = std::fabs(cp) > 1e-3 ? p / cp - n : z / sp - n * (1.0 - e2);
  }
  llh[0] = lat / D2R;
  llh[1] = lon / D2R;
  llh[2] = h;
}

// usgscsm's plugin sets INFO logging when USGSCSM_LOG_LEVEL is unset; the module has no log.
void quiet() { usgscsm::logger::set_log_level(usgscsm::logger::OFF); }

double nan() { return std::numeric_limits<double>::quiet_NaN(); }

std::string str(const uint8_t *p, size_t n) { return std::string(reinterpret_cast<const char *>(p), n); }

}  // namespace

// ---- memory and messages -------------------------------------------------------------------

GWC_EXPORT(gwc_alloc) void *gwc_alloc(size_t n) { return std::malloc(n ? n : 1); }
GWC_EXPORT(gwc_free) void gwc_free(void *p) { std::free(p); }

/** Copy the last error's text into buf (at most cap bytes); returns its full length. */
GWC_EXPORT(gwc_last_error) size_t gwc_last_error(uint8_t *buf, size_t cap) {
  size_t n = lastError.size();
  if (buf && cap) std::memcpy(buf, lastError.data(), n < cap ? n : cap);
  return n;
}

GWC_EXPORT(gwc_out_ptr) const char *gwc_out_ptr() { return out.data(); }
GWC_EXPORT(gwc_out_len) size_t gwc_out_len() { return out.size(); }

/** usgscsm and CSM API versions → out (JSON). */
GWC_EXPORT(gwc_version) int gwc_version() {
  return guarded([] {
    nlohmann::json j;
    j["usgscsm"] = USGSCSM_VERSION_TEXT;
    j["csm"] = CSM_VERSION_TEXT;
    j["abi"] = 1;
    out = j.dump();
    return 0;
  });
}

// ---- construction --------------------------------------------------------------------------

/**
 * A model from an ISD (usgscsm JSON). `name` selects the model (USGS_ASTRO_FRAME_SENSOR_MODEL …);
 * empty: the ISD's own "name_model". `id` is the image identifier when the ISD has none (usgscsm's
 * plugin uses the ISD file name, as here). Returns a handle > 0, or −status. Warnings → out (JSON
 * array).
 */
GWC_EXPORT(gwc_model_from_isd) int gwc_model_from_isd(const uint8_t *isd, size_t n, const uint8_t *name, size_t nameLen, const uint8_t *id, size_t idLen) {
  return guarded([&] {
    quiet();
    std::string text = str(isd, n);
    std::string model = str(name, nameLen);
    nlohmann::json j = nlohmann::json::parse(text);
    if (!j.is_object()) throw csm::Error(csm::Error::ISD_NOT_SUPPORTED, "the ISD is not a JSON object", "gwc_model_from_isd");
    if (model.empty()) {
      if (!j.contains("name_model") || !j["name_model"].is_string())
        throw csm::Error(csm::Error::ISD_NOT_SUPPORTED, "the ISD names no model (name_model)", "gwc_model_from_isd");
      model = j["name_model"].get<std::string>();
    }
    if (!j.contains("image_identifier")) {
      j["image_identifier"] = idLen ? str(id, idLen) : std::string("image");
      text = j.dump();
    }
    csm::WarningList warnings;
    csm::RasterGM *m = getUsgsCsmModelFromIsd(text, model, &warnings);
    if (!m) throw csm::Error(csm::Error::SENSOR_MODEL_NOT_CONSTRUCTIBLE, "the ISD did not give a model", "gwc_model_from_isd");
    int h = store(m);
    nlohmann::json w = nlohmann::json::array();
    for (const auto &x : warnings) w.push_back(x.getMessage());
    out = w.dump();
    return h;
  });
}

/** A model from a usgscsm model state (getModelState). Returns a handle > 0, or −status. */
GWC_EXPORT(gwc_model_from_state) int gwc_model_from_state(const uint8_t *state, size_t n) {
  return guarded([&] {
    quiet();
    std::string s = str(state, n);
    std::string model = stateAsJson(s)["m_modelName"].get<std::string>();
    csm::WarningList warnings;
    return store(getUsgsCsmModelFromJsonState(s, model, &warnings));
  });
}

/** The model state → out. */
GWC_EXPORT(gwc_model_state) int gwc_model_state(int h) {
  return guarded([&] {
    out = slotOf(h)->model->getModelState();
    return 0;
  });
}

GWC_EXPORT(gwc_model_free) void gwc_model_free(int h) {
  if (h >= 1 && static_cast<size_t>(h) <= slots.size()) slots[h - 1].model.reset();
}

/** Desired precisions (px for ground → image, m for image → ground) of later calls. */
GWC_EXPORT(gwc_set_precision) int gwc_set_precision(int h, double px, double m) {
  return guarded([&] {
    Slot *s = slotOf(h);
    if (!(px > 0 && m > 0)) throw csm::Error(csm::Error::INVALID_USE, "precisions must be positive", "gwc_set_precision");
    s->g2iPrecision = px;
    s->i2gPrecision = m;
    return 0;
  });
}

/**
 * A copy of model h with `delta` (n values) added to its first n parameters (the adjustment's
 * corrections). Returns a new handle.
 */
GWC_EXPORT(gwc_model_with_params) int gwc_model_with_params(int h, const double *delta, size_t n) {
  return guarded([&] {
    Slot *s = slotOf(h);
    const int np = s->model->getNumParameters();
    if (n > static_cast<size_t>(np)) throw csm::Error(csm::Error::INDEX_OUT_OF_RANGE, "more corrections than parameters", "gwc_model_with_params");
    std::string state = s->model->getModelState();
    std::string model = s->model->getModelName();
    csm::WarningList warnings;
    std::unique_ptr<csm::RasterGM> m(getUsgsCsmModelFromJsonState(state, model, &warnings));
    for (size_t i = 0; i < n; i++) m->setParameterValue(static_cast<int>(i), m->getParameterValue(static_cast<int>(i)) + delta[i]);
    const double px = s->g2iPrecision, gm = s->i2gPrecision;
    int nh = store(m.release());
    slots[nh - 1].g2iPrecision = px;
    slots[nh - 1].i2gPrecision = gm;
    return nh;
  });
}

/**
 * Model facts → out (JSON): model, sensor, platform, image id, reference time, lines, samples,
 * ellipsoid, height range, parameters (name, units, type, value) and their covariance (row-major).
 */
GWC_EXPORT(gwc_model_info) int gwc_model_info(int h) {
  return guarded([&] {
    Slot *s = slotOf(h);
    csm::RasterGM &m = *s->model;
    nlohmann::json j;
    j["model"] = m.getModelName();
    auto safe = [](auto fn) -> std::string {
      try {
        return fn();
      } catch (...) {
        return std::string();
      }
    };
    j["sensor"] = safe([&] { return m.getSensorIdentifier(); });
    j["platform"] = safe([&] { return m.getPlatformIdentifier(); });
    j["image"] = safe([&] { return m.getImageIdentifier(); });
    j["time"] = safe([&] { return m.getReferenceDateAndTime(); });
    csm::ImageVector sz = m.getImageSize();
    j["lines"] = sz.line;
    j["samples"] = sz.samp;
    j["a"] = s->a;
    j["b"] = s->b;
    std::pair<double, double> hr = m.getValidHeightRange();
    j["hmin"] = hr.first;
    j["hmax"] = hr.second;
    const int np = m.getNumParameters();
    nlohmann::json ps = nlohmann::json::array();
    std::vector<double> cov(static_cast<size_t>(np) * np);
    for (int i = 0; i < np; i++) {
      nlohmann::json p;
      p["name"] = m.getParameterName(i);
      p["units"] = safe([&] { return m.getParameterUnits(i); });
      p["type"] = static_cast<int>(m.getParameterType(i));
      p["value"] = m.getParameterValue(i);
      ps.push_back(p);
      for (int k = 0; k < np; k++) cov[static_cast<size_t>(i) * np + k] = m.getParameterCovariance(i, k);
    }
    j["params"] = ps;
    j["cov"] = cov;
    out = j.dump();
    return 0;
  });
}

// ---- projections (n points per call; NaN where a point has no answer) ---------------------

/** pts = n × (line, sample, height) → out n × (X, Y, Z). Returns the number of failed points. */
GWC_EXPORT(gwc_i2g_ecef) int gwc_i2g_ecef(int h, const double *pts, size_t n, double *res) {
  return guarded([&] {
    Slot *s = slotOf(h);
    int bad = 0;
    for (size_t i = 0; i < n; i++) {
      try {
        csm::EcefCoord g = s->model->imageToGround(csm::ImageCoord(pts[3 * i], pts[3 * i + 1]), pts[3 * i + 2], s->i2gPrecision);
        res[3 * i] = g.x;
        res[3 * i + 1] = g.y;
        res[3 * i + 2] = g.z;
      } catch (const std::exception &e) {
        lastError = e.what();
        res[3 * i] = res[3 * i + 1] = res[3 * i + 2] = nan();
        bad++;
      }
    }
    return bad;
  });
}

/** pts = n × (X, Y, Z) → out n × (line, sample, achieved precision). Returns the failed count. */
GWC_EXPORT(gwc_g2i_ecef) int gwc_g2i_ecef(int h, const double *pts, size_t n, double *res) {
  return guarded([&] {
    Slot *s = slotOf(h);
    int bad = 0;
    for (size_t i = 0; i < n; i++) {
      try {
        double achieved = nan();
        csm::ImageCoord c = s->model->groundToImage(csm::EcefCoord(pts[3 * i], pts[3 * i + 1], pts[3 * i + 2]), s->g2iPrecision, &achieved);
        res[3 * i] = c.line;
        res[3 * i + 1] = c.samp;
        res[3 * i + 2] = achieved;
      } catch (const std::exception &e) {
        lastError = e.what();
        res[3 * i] = res[3 * i + 1] = res[3 * i + 2] = nan();
        bad++;
      }
    }
    return bad;
  });
}

/** App convention: pts = n × (x = sample, y = line, HAE) → out n × (lat, lon, HAE). */
GWC_EXPORT(gwc_i2g) int gwc_i2g(int h, const double *pts, size_t n, double *res) {
  return guarded([&] {
    Slot *s = slotOf(h);
    int bad = 0;
    for (size_t i = 0; i < n; i++) {
      try {
        csm::EcefCoord g = s->model->imageToGround(csm::ImageCoord(pts[3 * i + 1], pts[3 * i]), pts[3 * i + 2], s->i2gPrecision);
        ecefToGeodetic(*s, g.x, g.y, g.z, res + 3 * i);
      } catch (const std::exception &e) {
        lastError = e.what();
        res[3 * i] = res[3 * i + 1] = res[3 * i + 2] = nan();
        bad++;
      }
    }
    return bad;
  });
}

/** App convention: pts = n × (lat, lon, HAE) → out n × (x = sample, y = line). */
GWC_EXPORT(gwc_g2i) int gwc_g2i(int h, const double *pts, size_t n, double *res) {
  return guarded([&] {
    Slot *s = slotOf(h);
    int bad = 0;
    for (size_t i = 0; i < n; i++) {
      try {
        double xyz[3];
        geodeticToEcef(*s, pts[3 * i], pts[3 * i + 1], pts[3 * i + 2], xyz);
        csm::ImageCoord c = s->model->groundToImage(csm::EcefCoord(xyz[0], xyz[1], xyz[2]), s->g2iPrecision);
        res[2 * i] = c.samp;
        res[2 * i + 1] = c.line;
      } catch (const std::exception &e) {
        lastError = e.what();
        res[2 * i] = res[2 * i + 1] = nan();
        bad++;
      }
    }
    return bad;
  });
}

/** Geodetic ↔ ECEF on the model's ellipsoid: dir 0 = (lat, lon, h) → XYZ, 1 = XYZ → (lat, lon, h). */
GWC_EXPORT(gwc_convert) int gwc_convert(int h, int dir, const double *pts, size_t n, double *res) {
  return guarded([&] {
    Slot *s = slotOf(h);
    for (size_t i = 0; i < n; i++) {
      if (dir == 0) geodeticToEcef(*s, pts[3 * i], pts[3 * i + 1], pts[3 * i + 2], res + 3 * i);
      else ecefToGeodetic(*s, pts[3 * i], pts[3 * i + 1], pts[3 * i + 2], res + 3 * i);
    }
    return 0;
  });
}

/**
 * Sensor partials at a ground point (lat, lon, HAE): out = nParams × (∂x/∂p, ∂y/∂p) in pixels per
 * parameter unit (x = sample, y = line), from CSM computeSensorPartials.
 */
GWC_EXPORT(gwc_sensor_partials) int gwc_sensor_partials(int h, double lat, double lon, double hae, double *res) {
  return guarded([&] {
    Slot *s = slotOf(h);
    double xyz[3];
    geodeticToEcef(*s, lat, lon, hae, xyz);
    csm::EcefCoord g(xyz[0], xyz[1], xyz[2]);
    const int np = s->model->getNumParameters();
    for (int i = 0; i < np; i++) {
      csm::RasterGM::SensorPartials p = s->model->computeSensorPartials(i, g, s->g2iPrecision);
      res[2 * i] = p.second;     // ∂sample/∂p
      res[2 * i + 1] = p.first;  // ∂line/∂p
    }
    return np;
  });
}

/** Ground partials ∂(line, sample)/∂(X, Y, Z) at an ECEF point (CSM order, 6 values). */
GWC_EXPORT(gwc_ground_partials_ecef) int gwc_ground_partials_ecef(int h, double x, double y, double z, double *res) {
  return guarded([&] {
    std::vector<double> p = slotOf(h)->model->computeGroundPartials(csm::EcefCoord(x, y, z));
    for (size_t i = 0; i < 6 && i < p.size(); i++) res[i] = p[i];
    return 0;
  });
}

/** Unmodelled error at image (x, y): out = [σxx, σxy, σyy] (px², x = sample). */
GWC_EXPORT(gwc_unmodeled) int gwc_unmodeled(int h, double x, double y, double *res) {
  return guarded([&] {
    std::vector<double> c = slotOf(h)->model->getUnmodeledError(csm::ImageCoord(y, x));
    if (c.size() < 4) throw csm::Error(csm::Error::ALGORITHM, "unmodelled error has fewer than 4 values", "gwc_unmodeled");
    res[0] = c[3];  // samp variance
    res[1] = c[1];  // line/samp covariance
    res[2] = c[0];  // line variance
    return 0;
  });
}

/** Imaging locus at image (x, y): out = [Px, Py, Pz, Dx, Dy, Dz] (remote locus, ECEF). */
GWC_EXPORT(gwc_locus) int gwc_locus(int h, double x, double y, double *res) {
  return guarded([&] {
    Slot *s = slotOf(h);
    csm::EcefLocus l = s->model->imageToRemoteImagingLocus(csm::ImageCoord(y, x), s->i2gPrecision);
    res[0] = l.point.x;
    res[1] = l.point.y;
    res[2] = l.point.z;
    res[3] = l.direction.x;
    res[4] = l.direction.y;
    res[5] = l.direction.z;
    return 0;
  });
}
