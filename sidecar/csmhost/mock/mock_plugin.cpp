// A mock CSM 3.0 plug-in for the host's tests (REQ-GAP-25, SCN-64). It is never packaged: the
// project distributes no plug-ins. Its model is analytic, so the contract's numbers can be worked
// out without it (sidecar/csmhost/contract/make-contract.mjs).
//
// An ISD is a text file of `key value` lines, starting `gwb-mock-isd 1`:
//   lat0 lon0            reference point, degrees, height 0 on WGS 84
//   gsd                  metres per pixel
//   lines samples        image size; the reference point is at its centre
//   tilt                 sample shift per metre of height above the ground plane, in pixels·gsd
//   behaviour            normal, probe, crash, hang, alloc, throw, nan, print, burn
//   probe_port           a loopback TCP port for `probe` to try
//   probe_udp            a loopback UDP port for `probe` to try
//   canary_read          a file for `probe` to try to read
//   canary_write         a file for `probe` to try to create
//
// With `probe` the model tries what the sandbox must stop and reports each result in its trajectory
// identifier, the one free text field the fixed protocol passes back.
//
// The line runs south and the sample east:
//   line   = lines/2   + bias_line - n/gsd
//   sample = samples/2 + bias_samp + (e + tilt·u)/gsd
// for a ground point at (e, n, u) metres in the east, north and up directions of the reference point.

#include "Error.h"
#include "Ellipsoid.h"
#include "Isd.h"
#include "CorrelationModel.h"
#include "Plugin.h"
#include "RasterGM.h"
#include "Version.h"
#include "Warning.h"

#include <chrono>
#include <cmath>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <fstream>
#include <map>
#include <sstream>
#include <thread>
#include <vector>

#ifdef _WIN32
#define WIN32_LEAN_AND_MEAN
#define NOMINMAX
#include <winsock2.h>
#include <ws2tcpip.h>
#include <windows.h>
#else
#include <arpa/inet.h>
#include <errno.h>
#include <fcntl.h>
#include <sys/select.h>
#include <netinet/in.h>
#include <sys/socket.h>
#include <sys/wait.h>
#include <unistd.h>
#endif

#ifndef GWB_MOCK_VERSION_MAJOR
#define GWB_MOCK_VERSION_MAJOR 3
#define GWB_MOCK_VERSION_MINOR 0
#define GWB_MOCK_VERSION_REV 4
#endif

namespace {

const double A = 6378137.0;
const double B = 6356752.314245179;
const double RAD = 3.14159265358979323846 / 180.0;
const char* const MODEL_NAME = "GWB_MOCK_ORTHO";

struct Vec {
  double x, y, z;
};
double dot(const Vec& a, const Vec& b) { return a.x * b.x + a.y * b.y + a.z * b.z; }

typedef std::map<std::string, std::string> Keys;

bool read_isd(const std::string& file, Keys& k) {
  std::ifstream in(file);
  std::string first;
  if (!in || !std::getline(in, first) || first.rfind("gwb-mock-isd 1", 0) != 0) return false;
  std::string line;
  while (std::getline(in, line)) {
    size_t i = line.find(' ');
    if (i == std::string::npos) continue;
    std::string v = line.substr(i + 1);
    while (!v.empty() && (v.back() == '\r' || v.back() == ' ')) v.pop_back();
    k[line.substr(0, i)] = v;
  }
  return true;
}

std::string os_code() {
#ifdef _WIN32
  return std::to_string(WSAGetLastError());
#else
  return std::to_string(errno);
#endif
}

// Each answers `blocked` when the sandbox stopped it, or says what went through.
std::string try_tcp(int port) {
  auto s = socket(AF_INET, SOCK_STREAM, 0);
#ifdef _WIN32
  if (s == INVALID_SOCKET) return "blocked:socket:" + os_code();
#else
  if (s < 0) return "blocked:socket:" + os_code();
#endif
  sockaddr_in a;
  std::memset(&a, 0, sizeof a);
  a.sin_family = AF_INET;
  a.sin_port = htons((unsigned short)port);
  a.sin_addr.s_addr = htonl(INADDR_LOOPBACK);
  // Not blocking, with a short wait: a firewall that drops the packet would otherwise hold this
  // call longer than the host's wall limit.
#ifdef _WIN32
  u_long on = 1;
  ioctlsocket(s, FIONBIO, &on);
#else
  fcntl(s, F_SETFL, fcntl(s, F_GETFL) | O_NONBLOCK);
#endif
  int r = connect(s, reinterpret_cast<sockaddr*>(&a), sizeof a);
  std::string out = "CONNECTED";
  if (r != 0) {
    out = "blocked:connect:" + os_code();
    fd_set w, e;
    FD_ZERO(&w);
    FD_ZERO(&e);
    FD_SET(s, &w);
    FD_SET(s, &e);
    timeval t = {2, 0};
    if (select((int)s + 1, nullptr, &w, &e, &t) > 0 && FD_ISSET(s, &w)) {
      int code = 1;
      socklen_t n = sizeof code;
      getsockopt(s, SOL_SOCKET, SO_ERROR, reinterpret_cast<char*>(&code), &n);
      if (code == 0) out = "CONNECTED";
    }
  }
#ifdef _WIN32
  closesocket(s);
#else
  close(s);
#endif
  return out;
}

std::string try_udp(int port) {
  auto s = socket(AF_INET, SOCK_DGRAM, 0);
#ifdef _WIN32
  if (s == INVALID_SOCKET) return "blocked:socket:" + os_code();
#else
  if (s < 0) return "blocked:socket:" + os_code();
#endif
  sockaddr_in a;
  std::memset(&a, 0, sizeof a);
  a.sin_family = AF_INET;
  a.sin_port = htons((unsigned short)port);
  a.sin_addr.s_addr = htonl(INADDR_LOOPBACK);
  auto r = sendto(s, "x", 1, 0, reinterpret_cast<sockaddr*>(&a), sizeof a);
  std::string out = r == 1 ? "SENT" : "blocked:sendto:" + os_code();
#ifdef _WIN32
  closesocket(s);
#else
  close(s);
#endif
  return out;
}

std::string try_read(const std::string& f) {
  std::ifstream in(f, std::ios::binary);
  if (!in) return "blocked";
  char c;
  return in.get(c) ? "READ" : "blocked:empty";
}

std::string try_write(const std::string& f) {
  std::FILE* o = std::fopen(f.c_str(), "wb");
  if (!o) return "blocked";
  std::fputs("the plug-in wrote this", o);
  std::fclose(o);
  return "WROTE";
}

std::string try_spawn() {
#ifdef _WIN32
  char cmd[] = "C:\\Windows\\System32\\cmd.exe /c exit 0";
  STARTUPINFOA si;
  PROCESS_INFORMATION pi;
  std::memset(&si, 0, sizeof si);
  si.cb = sizeof si;
  if (!CreateProcessA(nullptr, cmd, nullptr, nullptr, FALSE, CREATE_NO_WINDOW, nullptr, nullptr, &si, &pi)) return "blocked:" + std::to_string(GetLastError());
  WaitForSingleObject(pi.hProcess, 2000);
  CloseHandle(pi.hThread);
  CloseHandle(pi.hProcess);
  return "SPAWNED";
#else
  pid_t p = fork();
  if (p < 0) return "blocked:" + std::to_string(errno);
  if (p == 0) _exit(0);
  waitpid(p, nullptr, 0);
  return "SPAWNED";
#endif
}

class MockModel : public csm::RasterGM {
 public:
  explicit MockModel(const Keys& k) : keys(k) {
    lat0 = num("lat0", 40.0) * RAD;
    lon0 = num("lon0", -105.0) * RAD;
    gsd = num("gsd", 1.0);
    lines = num("lines", 1000);
    samples = num("samples", 1000);
    tilt = num("tilt", 0.0);
    bias[0] = bias[1] = 0;
    const double e2 = 1.0 - (B * B) / (A * A);
    const double sl = std::sin(lat0), cl = std::cos(lat0), so = std::sin(lon0), co = std::cos(lon0);
    const double N = A / std::sqrt(1 - e2 * sl * sl);
    ref = {N * cl * co, N * cl * so, N * (1 - e2) * sl};
    east = {-so, co, 0};
    north = {-sl * co, -sl * so, cl};
    up = {cl * co, cl * so, sl};
    behaviour = text("behaviour", "normal");
    if (behaviour == "probe") {
      int port = (int)num("probe_port", 1);
#ifdef _WIN32
      WSADATA w;
      WSAStartup(MAKEWORD(2, 2), &w);
#endif
      // One at a time: the operands of a + have no order of their own.
      report = "tcp=" + try_tcp(port);
      report += ";udp=" + try_udp((int)num("probe_udp", port));
      report += ";read=" + try_read(text("canary_read", ""));
      report += ";write=" + try_write(text("canary_write", ""));
      report += ";spawn=" + try_spawn();
    } else if (behaviour == "print") {
      // Text on stdout must not reach the wire.
      std::fputs("GCSR this is what a careless plug-in prints\n", stdout);
      std::fflush(stdout);
      std::fputs("and on stderr\n", stderr);
    }
  }

  // ---- what the fixed protocol reaches ----
  csm::ImageCoord groundToImage(const csm::EcefCoord& g, double, double* achieved, csm::WarningList*) const override {
    misbehave();
    if (achieved) *achieved = 0;
    if (behaviour == "nan") return csm::ImageCoord(std::nan(""), 0);
    Vec d = {g.x - ref.x, g.y - ref.y, g.z - ref.z};
    return csm::ImageCoord(lines / 2 + bias[0] - dot(d, north) / gsd, samples / 2 + bias[1] + (dot(d, east) + tilt * dot(d, up)) / gsd);
  }
  csm::EcefCoord imageToGround(const csm::ImageCoord& p, double height, double, double* achieved, csm::WarningList*) const override {
    misbehave();
    const double n = (lines / 2 + bias[0] - p.line) * gsd;
    const double e0 = (p.samp - samples / 2 - bias[1]) * gsd;
    double u = height;
    csm::Ellipsoid wgs84(A, B);
    csm::EcefCoord g;
    for (int i = 0; i < 20; i++) {
      const double e = e0 - tilt * u;
      g = csm::EcefCoord(ref.x + e * east.x + n * north.x + u * up.x, ref.y + e * east.y + n * north.y + u * up.y, ref.z + e * east.z + n * north.z + u * up.z);
      const double dh = height - wgs84.calculateHeight(g, 1e-6);
      if (std::fabs(dh) < 1e-6) break;
      u += dh;
    }
    if (achieved) *achieved = 1e-6;
    return g;
  }
  std::vector<double> computeGroundPartials(const csm::EcefCoord&) const override {
    return {-north.x / gsd, -north.y / gsd, -north.z / gsd, (east.x + tilt * up.x) / gsd, (east.y + tilt * up.y) / gsd, (east.z + tilt * up.z) / gsd};
  }
  SensorPartials computeSensorPartials(int index, const csm::EcefCoord&, double, double*, csm::WarningList*) const override { return index == 0 ? SensorPartials(1, 0) : SensorPartials(0, 1); }
  SensorPartials computeSensorPartials(int index, const csm::ImageCoord&, const csm::EcefCoord&, double, double*, csm::WarningList*) const override { return index == 0 ? SensorPartials(1, 0) : SensorPartials(0, 1); }
  double getParameterCovariance(int i, int j) const override { return i == j ? 0.25 : 0.05; }
  std::vector<double> getUnmodeledCrossCovariance(const csm::ImageCoord&, const csm::ImageCoord&) const override { return {0.01, 0.002, 0.002, 0.04}; }
  int getNumParameters() const override { return 2; }
  std::string getParameterName(int i) const override { return i == 0 ? "bias_line" : "bias_samp"; }
  std::string getParameterUnits(int) const override { return "pixels"; }
  double getParameterValue(int i) const override { return bias[i ? 1 : 0]; }
  void setParameterValue(int i, double v) override { bias[i ? 1 : 0] = v; }
  csm::param::Type getParameterType(int) const override { return csm::param::REAL; }
  void setParameterType(int, csm::param::Type) override {}

  std::string getModelName() const override { return MODEL_NAME; }
  csm::Version getVersion() const override { return csm::Version(1, 0, 0); }
  std::string getSensorIdentifier() const override { return "MOCK-SENSOR"; }
  std::string getPlatformIdentifier() const override { return "MOCK-PLATFORM"; }
  std::string getCollectionIdentifier() const override { return "MOCK-COLLECTION"; }
  std::string getTrajectoryIdentifier() const override { return report; }
  std::string getSensorType() const override { return CSM_SENSOR_TYPE_EO; }
  std::string getSensorMode() const override { return CSM_SENSOR_MODE_FRAME; }

  // ---- the rest of the interface: nothing here reaches them ----
  std::string getPedigree() const override { return "GWB_MOCK"; }
  std::string getImageIdentifier() const override { return "MOCK"; }
  void setImageIdentifier(const std::string&, csm::WarningList*) override {}
  std::string getReferenceDateAndTime() const override { return "20000101T000000Z"; }
  std::string getModelState() const override { return ""; }
  void replaceModelState(const std::string&) override {}
  csm::EcefCoord getReferencePoint() const override { return csm::EcefCoord(ref.x, ref.y, ref.z); }
  void setReferencePoint(const csm::EcefCoord&) override {}
  bool hasShareableParameters() const override { return false; }
  bool isParameterShareable(int) const override { return false; }
  csm::SharingCriteria getParameterSharingCriteria(int) const override { return csm::SharingCriteria(); }
  void setParameterCovariance(int, int, double) override {}
  int getNumGeometricCorrectionSwitches() const override { return 0; }
  std::string getGeometricCorrectionName(int) const override { return ""; }
  void setGeometricCorrectionSwitch(int, bool, csm::param::Type) override {}
  bool getGeometricCorrectionSwitch(int) const override { return false; }
  std::vector<double> getCrossCovarianceMatrix(const csm::GeometricModel&, csm::param::Set, const GeometricModelList&) const override { return {}; }
  csm::ImageCoordCovar groundToImage(const csm::EcefCoordCovar&, double, double*, csm::WarningList*) const override { return csm::ImageCoordCovar(); }
  csm::EcefCoordCovar imageToGround(const csm::ImageCoordCovar&, double, double, double, double*, csm::WarningList*) const override { return csm::EcefCoordCovar(); }
  csm::EcefLocus imageToProximateImagingLocus(const csm::ImageCoord&, const csm::EcefCoord&, double, double*, csm::WarningList*) const override { return csm::EcefLocus(); }
  csm::EcefLocus imageToRemoteImagingLocus(const csm::ImageCoord&, double, double*, csm::WarningList*) const override { return csm::EcefLocus(); }
  csm::ImageCoord getImageStart() const override { return csm::ImageCoord(0, 0); }
  csm::ImageVector getImageSize() const override { return csm::ImageVector(lines, samples); }
  std::pair<csm::ImageCoord, csm::ImageCoord> getValidImageRange() const override { return {csm::ImageCoord(0, 0), csm::ImageCoord(lines, samples)}; }
  std::pair<double, double> getValidHeightRange() const override { return {-500, 9000}; }
  csm::EcefVector getIlluminationDirection(const csm::EcefCoord&) const override { return csm::EcefVector(0, 0, 1); }
  double getImageTime(const csm::ImageCoord&) const override { return 0; }
  csm::EcefCoord getSensorPosition(const csm::ImageCoord&) const override { return csm::EcefCoord(0, 0, 0); }
  csm::EcefCoord getSensorPosition(double) const override { return csm::EcefCoord(0, 0, 0); }
  csm::EcefVector getSensorVelocity(const csm::ImageCoord&) const override { return csm::EcefVector(0, 0, 0); }
  csm::EcefVector getSensorVelocity(double) const override { return csm::EcefVector(0, 0, 0); }
  const csm::CorrelationModel& getCorrelationModel() const override { return none; }

 private:
  double num(const char* k, double d) const {
    auto i = keys.find(k);
    return i == keys.end() ? d : std::atof(i->second.c_str());
  }
  std::string text(const char* k, const char* d) const {
    auto i = keys.find(k);
    return i == keys.end() ? d : i->second;
  }
  void misbehave() const {
    if (behaviour == "crash") {
      volatile int* p = nullptr;
      *p = 1;
    } else if (behaviour == "hang") {
      for (;;) std::this_thread::sleep_for(std::chrono::seconds(1));
    } else if (behaviour == "burn") {
      for (volatile unsigned long long i = 0;; i = i + 1) {
      }
    } else if (behaviour == "alloc") {
      std::vector<std::vector<char>> keep;
      for (;;) {
        keep.emplace_back(64 << 20);
        std::memset(keep.back().data(), 1, keep.back().size());
      }
    } else if (behaviour == "throw") {
      throw csm::Error(csm::Error::ALGORITHM, "the mock was told to fail", "MockModel");
    }
  }

  Keys keys;
  double lat0, lon0, gsd, lines, samples, tilt, bias[2];
  Vec ref, east, north, up;
  std::string behaviour, report;
  csm::NoCorrelationModel none;
};

class MockPlugin : public csm::Plugin {
 public:
  std::string getPluginName() const override { return "GWB mock plug-in"; }
  std::string getManufacturer() const override { return "GIS Workbench tests"; }
  std::string getReleaseDate() const override { return "20261105"; }
  csm::Version getCsmVersion() const override { return csm::Version(GWB_MOCK_VERSION_MAJOR, GWB_MOCK_VERSION_MINOR, GWB_MOCK_VERSION_REV); }
  size_t getNumModels() const override { return 1; }
  std::string getModelName(size_t) const override { return MODEL_NAME; }
  std::string getModelFamily(size_t) const override { return CSM_RASTER_FAMILY; }
  csm::Version getModelVersion(const std::string&) const override { return csm::Version(1, 0, 0); }
  bool canModelBeConstructedFromState(const std::string&, const std::string&, csm::WarningList*) const override { return false; }
  bool canModelBeConstructedFromISD(const csm::Isd& isd, const std::string& name, csm::WarningList*) const override {
    Keys k;
    return name == MODEL_NAME && read_isd(isd.filename(), k);
  }
  csm::Model* constructModelFromState(const std::string&, csm::WarningList*) const override { throw csm::Error(csm::Error::UNSUPPORTED_FUNCTION, "no states", "MockPlugin"); }
  csm::Model* constructModelFromISD(const csm::Isd& isd, const std::string&, csm::WarningList*) const override {
    Keys k;
    if (!read_isd(isd.filename(), k)) throw csm::Error(csm::Error::SENSOR_MODEL_NOT_CONSTRUCTIBLE, "not a mock ISD", "MockPlugin");
    return new MockModel(k);
  }
  std::string getModelNameFromModelState(const std::string&, csm::WarningList*) const override { return MODEL_NAME; }
  bool canISDBeConvertedToModelState(const csm::Isd&, const std::string&, csm::WarningList*) const override { return false; }
  std::string convertISDToModelState(const csm::Isd&, const std::string&, csm::WarningList*) const override { throw csm::Error(csm::Error::UNSUPPORTED_FUNCTION, "no states", "MockPlugin"); }
};

MockPlugin thePlugin;

} // namespace
