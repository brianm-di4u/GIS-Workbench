// gwb-csm-host: one CSM 3.0.x plug-in, out of process, behind a fixed protocol (REQ-GAP-25,
// OD-2.18). The sidecar starts one host per session, inside its sandbox, and speaks length-framed
// binary over the host's stdin and stdout. The wire format is in docs/design/csm-host.md; both
// sides of it are checked against sidecar/csmhost/contract/csm-host-contract.json.
//
//   gwb-csm-host <plug-in file>
//
// The plug-in's code starts running at LOAD, so the host checks its own confinement first and
// refuses to load anything if a part of it is missing:
//   Windows: the token must be an AppContainer's, at Low integrity or below. Job limits are set
//            from outside by the sidecar.
//   Linux:   a seccomp filter installed here, after exec, refuses sockets, new processes, ptrace
//            and the rest of the list below. Landlock and rlimits come from the sidecar.
// The protocol's own handles are moved off stdin and stdout before anything is loaded, so what a
// plug-in prints cannot reach the wire by accident. A plug-in that looks for those handles on
// purpose can still forge a reply: the sidecar treats every reply as untrusted.

#include "Error.h"
#include "Isd.h"
#include "Plugin.h"
#include "RasterGM.h"
#include "Version.h"
#include "Warning.h"

#include <cmath>
#include <csignal>
#include <cstdint>
#include <cstdio>
#include <cstring>
#include <exception>
#include <memory>
#include <string>
#include <vector>

#ifdef _WIN32
#define WIN32_LEAN_AND_MEAN
#define NOMINMAX
#include <windows.h>
#include <fcntl.h>
#include <io.h>
#else
#include <dlfcn.h>
#include <errno.h>
#include <fcntl.h>
#include <linux/audit.h>
#include <linux/filter.h>
#include <linux/seccomp.h>
#include <stddef.h>
#include <sys/prctl.h>
#include <sys/socket.h>
#include <sys/syscall.h>
#include <unistd.h>
#endif

#undef major
#undef minor

namespace {

const uint32_t REQ_MAGIC = 0x51534347; // "GCSQ"
const uint32_t REP_MAGIC = 0x52534347; // "GCSR"
const uint32_t PROTOCOL = 1;
const uint32_t MAX_PAYLOAD = 16u << 20;
const size_t MAX_POINTS = 65536;
const size_t MAX_TEXT = 4096;

enum Op : uint32_t { OP_HELLO = 1, OP_LOAD = 2, OP_OPEN = 3, OP_G2I = 4, OP_I2G = 5, OP_PARTIALS = 6, OP_COVARIANCE = 7, OP_QUIT = 8 };
enum Status : uint32_t { ST_OK = 0, ST_BAD_REQUEST = 1, ST_NOT_READY = 2, ST_CSM_VERSION = 3, ST_NO_MODEL = 4, ST_CSM_ERROR = 5, ST_PLUGIN_EXCEPTION = 6, ST_LOAD_FAILED = 7, ST_SANDBOX = 8 };

int g_in = -1;
int g_out = -1;

#ifdef _WIN32
int raw_read(int fd, void* p, unsigned n) { return _read(fd, p, n); }
int raw_write(int fd, const void* p, unsigned n) { return _write(fd, p, n); }
#else
int raw_read(int fd, void* p, unsigned n) { return (int)read(fd, p, n); }
int raw_write(int fd, const void* p, unsigned n) { return (int)write(fd, p, n); }
#endif

bool read_full(void* p, size_t n) {
  char* c = static_cast<char*>(p);
  while (n > 0) {
    int r = raw_read(g_in, c, n > (1u << 20) ? (1u << 20) : (unsigned)n);
    if (r <= 0) return false;
    c += r;
    n -= (size_t)r;
  }
  return true;
}

bool write_full(const void* p, size_t n) {
  const char* c = static_cast<const char*>(p);
  while (n > 0) {
    int r = raw_write(g_out, c, n > (1u << 20) ? (1u << 20) : (unsigned)n);
    if (r <= 0) return false;
    c += r;
    n -= (size_t)r;
  }
  return true;
}

// ---- payloads: a list of strings, or doubles ----

void put_u32(std::string& s, uint32_t v) { s.append(reinterpret_cast<const char*>(&v), 4); }

std::string strings(const std::vector<std::string>& v) {
  std::string s;
  put_u32(s, (uint32_t)v.size());
  for (const std::string& t : v) {
    size_t n = t.size() > MAX_TEXT ? MAX_TEXT : t.size();
    put_u32(s, (uint32_t)n);
    s.append(t.data(), n);
  }
  return s;
}

bool parse_strings(const std::string& p, std::vector<std::string>& out) {
  if (p.size() < 4) return false;
  uint32_t count;
  std::memcpy(&count, p.data(), 4);
  if (count > 16) return false;
  size_t at = 4;
  for (uint32_t i = 0; i < count; i++) {
    if (at + 4 > p.size()) return false;
    uint32_t n;
    std::memcpy(&n, p.data() + at, 4);
    at += 4;
    if (n > MAX_TEXT || at + n > p.size()) return false;
    out.emplace_back(p.data() + at, n);
    at += n;
  }
  return at == p.size();
}

std::string doubles(const std::vector<double>& v) { return std::string(reinterpret_cast<const char*>(v.data()), v.size() * sizeof(double)); }

bool parse_doubles(const std::string& p, std::vector<double>& out) {
  if (p.size() % sizeof(double)) return false;
  out.resize(p.size() / sizeof(double));
  if (!out.empty()) std::memcpy(out.data(), p.data(), p.size());
  for (double d : out)
    if (!std::isfinite(d)) return false;
  return true;
}

void reply(uint32_t status, uint32_t id, const std::string& payload) {
  uint32_t head[4] = {REP_MAGIC, status, id, (uint32_t)payload.size()};
  if (!write_full(head, sizeof head) || !write_full(payload.data(), payload.size())) std::_Exit(4);
}

void fail(uint32_t status, uint32_t id, const std::string& why) { reply(status, id, strings({why})); }

// ---- confinement ----

std::string g_confinement;
bool g_confined = false;

#ifdef _WIN32
void check_confinement() {
  // No dialog of any kind: a missing DLL or a crash in a plug-in ends the host, nothing else.
  SetErrorMode(SEM_FAILCRITICALERRORS | SEM_NOGPFAULTERRORBOX | SEM_NOOPENFILEERRORBOX);
  HANDLE tok = nullptr;
  if (!OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &tok)) {
    g_confinement = "the process token could not be read";
    return;
  }
  DWORD app = 0, got = 0;
  BOOL ok = GetTokenInformation(tok, TokenIsAppContainer, &app, sizeof app, &got);
  unsigned char buf[128];
  DWORD il = 0xFFFFFFFF;
  if (GetTokenInformation(tok, TokenIntegrityLevel, buf, sizeof buf, &got)) {
    TOKEN_MANDATORY_LABEL* t = reinterpret_cast<TOKEN_MANDATORY_LABEL*>(buf);
    il = *GetSidSubAuthority(t->Label.Sid, (DWORD)(UCHAR)(*GetSidSubAuthorityCount(t->Label.Sid) - 1));
  }
  CloseHandle(tok);
  g_confined = ok && app != 0 && il <= SECURITY_MANDATORY_LOW_RID;
  g_confinement = std::string("AppContainer ") + (app ? "yes" : "NO") + ", integrity " + std::to_string(il);
}
#else
#define ALLOW BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_ALLOW)
#define DENY BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_ERRNO | EPERM)
#define KILL BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_KILL_PROCESS)
#define REFUSE(nr) BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, nr, 0, 1), DENY

void check_confinement() {
#if !defined(__x86_64__)
  g_confinement = "this architecture has no seccomp filter";
#else
  // CLONE_THREAD is what separates a thread from a process in clone(); clone3 hides its flags in
  // memory a filter cannot read, so it answers ENOSYS and glibc falls back to clone.
  struct sock_filter f[] = {
      BPF_STMT(BPF_LD | BPF_W | BPF_ABS, offsetof(struct seccomp_data, arch)),
      BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, AUDIT_ARCH_X86_64, 1, 0),
      KILL,
      BPF_STMT(BPF_LD | BPF_W | BPF_ABS, offsetof(struct seccomp_data, nr)),
      // The x32 ABI would reach the same calls under other numbers.
      BPF_JUMP(BPF_JMP | BPF_JGE | BPF_K, 0x40000000, 0, 1),
      KILL,
      REFUSE(__NR_socket),
      REFUSE(__NR_socketpair),
      REFUSE(__NR_connect),
      REFUSE(__NR_bind),
      REFUSE(__NR_listen),
      REFUSE(__NR_accept),
      REFUSE(__NR_accept4),
      REFUSE(__NR_execve),
      REFUSE(__NR_execveat),
      REFUSE(__NR_fork),
      REFUSE(__NR_vfork),
      REFUSE(__NR_ptrace),
      REFUSE(__NR_process_vm_readv),
      REFUSE(__NR_process_vm_writev),
      REFUSE(__NR_io_uring_setup),
      REFUSE(__NR_bpf),
      REFUSE(__NR_unshare),
      REFUSE(__NR_setns),
      REFUSE(__NR_mount),
      REFUSE(__NR_userfaultfd),
      REFUSE(__NR_perf_event_open),
      BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, __NR_clone3, 0, 1),
      BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_ERRNO | ENOSYS),
      BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, __NR_clone, 0, 3),
      BPF_STMT(BPF_LD | BPF_W | BPF_ABS, offsetof(struct seccomp_data, args[0])),
      BPF_JUMP(BPF_JMP | BPF_JSET | BPF_K, 0x00010000 /* CLONE_THREAD */, 1, 0),
      DENY,
      ALLOW,
  };
  struct sock_fprog prog = {(unsigned short)(sizeof f / sizeof f[0]), f};
  if (prctl(PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0) != 0 || prctl(PR_SET_SECCOMP, SECCOMP_MODE_FILTER, &prog) != 0) {
    g_confinement = "the seccomp filter could not be installed";
    return;
  }
  // Prove it: the call the filter exists for has to fail, and by the filter's hand.
  int s = socket(AF_INET, SOCK_STREAM, 0);
  g_confined = s < 0 && errno == EPERM;
  if (s >= 0) close(s);
  g_confinement = g_confined ? "seccomp: no sockets, no new processes" : "the seccomp filter did not take effect";
#endif
}
#endif

// Move the protocol off fds 0 and 1, and leave those pointing nowhere useful.
bool private_io() {
#ifdef _WIN32
  _setmode(0, _O_BINARY);
  _setmode(1, _O_BINARY);
  g_in = _dup(0);
  g_out = _dup(1);
  int nul = _open("NUL", _O_RDWR);
  if (g_in < 0 || g_out < 0) return false;
  if (nul >= 0) {
    _dup2(nul, 0);
    _dup2(nul, 1);
    _close(nul);
  }
  return true;
#else
  g_in = fcntl(0, F_DUPFD_CLOEXEC, 3);
  g_out = fcntl(1, F_DUPFD_CLOEXEC, 3);
  int nul = open("/dev/null", O_RDWR);
  if (g_in < 0 || g_out < 0) return false;
  if (nul >= 0) {
    dup2(nul, 0);
    dup2(nul, 1);
    close(nul);
  }
  return true;
#endif
}

// ---- the plug-in and its model ----

std::string g_plugin_path;
bool g_loaded = false;
const csm::Plugin* g_plugin = nullptr;
std::unique_ptr<csm::RasterGM> g_model;

std::string load_error() {
#ifdef _WIN32
  return "error " + std::to_string(GetLastError());
#else
  const char* e = dlerror();
  return e ? e : "unknown";
#endif
}

bool load_plugin() {
#ifdef _WIN32
  int n = MultiByteToWideChar(CP_UTF8, 0, g_plugin_path.c_str(), -1, nullptr, 0);
  std::wstring w((size_t)n, L'\0');
  MultiByteToWideChar(CP_UTF8, 0, g_plugin_path.c_str(), -1, &w[0], n);
  return LoadLibraryExW(w.c_str(), nullptr, LOAD_LIBRARY_SEARCH_DLL_LOAD_DIR | LOAD_LIBRARY_SEARCH_SYSTEM32) != nullptr;
#else
  return dlopen(g_plugin_path.c_str(), RTLD_NOW | RTLD_LOCAL) != nullptr;
#endif
}

void op_load(uint32_t id) {
  if (!g_confined) return fail(ST_SANDBOX, id, "the host is not confined: " + g_confinement);
  if (g_loaded) return fail(ST_NOT_READY, id, "a plug-in is already loaded");
  if (!load_plugin()) return fail(ST_LOAD_FAILED, id, "the plug-in could not be loaded: " + load_error());
  g_loaded = true;
  const csm::PluginList& list = csm::Plugin::getList();
  if (list.empty()) return fail(ST_LOAD_FAILED, id, "the file loaded, but no CSM plug-in registered itself");
  if (list.size() > 1) return fail(ST_LOAD_FAILED, id, "the file registered more than one CSM plug-in");
  const csm::Plugin* p = list.front();
  csm::Version v = p->getCsmVersion();
  if (v.major() != 3 || v.minor() != 0) return fail(ST_CSM_VERSION, id, "the plug-in is built for CSM " + v.version() + "; this host takes CSM 3.0.x only");
  g_plugin = p;
  reply(ST_OK, id, strings({p->getPluginName(), p->getManufacturer(), p->getReleaseDate(), v.version(), std::to_string(p->getNumModels())}));
}

void op_open(uint32_t id, const std::string& payload) {
  if (!g_plugin) return fail(ST_NOT_READY, id, "no plug-in is loaded");
  if (g_model) return fail(ST_NOT_READY, id, "a model is already open");
  std::vector<std::string> a;
  if (!parse_strings(payload, a) || a.size() != 2) return fail(ST_BAD_REQUEST, id, "OPEN takes an ISD file and a model name");
  csm::Isd isd(a[0]);
  csm::WarningList warnings;
  for (size_t i = 0; i < g_plugin->getNumModels(); i++) {
    std::string name = g_plugin->getModelName(i);
    if (!a[1].empty() && a[1] != name) continue;
    if (!g_plugin->canModelBeConstructedFromISD(isd, name, &warnings)) continue;
    std::unique_ptr<csm::Model> m(g_plugin->constructModelFromISD(isd, name, &warnings));
    csm::RasterGM* r = dynamic_cast<csm::RasterGM*>(m.get());
    if (!r) return fail(ST_NO_MODEL, id, "model " + name + " is not a RasterGM");
    m.release();
    g_model.reset(r);
    reply(ST_OK, id, strings({name, r->getVersion().version(), r->getSensorIdentifier(), r->getPlatformIdentifier(), r->getCollectionIdentifier(), r->getTrajectoryIdentifier(), r->getSensorType(), r->getSensorMode()}));
    return;
  }
  fail(ST_NO_MODEL, id, "no model of this plug-in accepts the ISD");
}

void op_g2i(uint32_t id, const std::vector<double>& q) {
  size_t n = q.size() / 4;
  if (q.empty() || q.size() % 4 || n > MAX_POINTS) return fail(ST_BAD_REQUEST, id, "ground to image takes 1 to 65536 points of x, y, z, precision");
  std::vector<double> r;
  r.reserve(n * 3);
  for (size_t i = 0; i < n; i++) {
    double achieved = 0;
    csm::ImageCoord c = g_model->groundToImage(csm::EcefCoord(q[4 * i], q[4 * i + 1], q[4 * i + 2]), q[4 * i + 3], &achieved);
    r.push_back(c.line);
    r.push_back(c.samp);
    r.push_back(achieved);
  }
  reply(ST_OK, id, doubles(r));
}

void op_i2g(uint32_t id, const std::vector<double>& q) {
  size_t n = q.size() / 4;
  if (q.empty() || q.size() % 4 || n > MAX_POINTS) return fail(ST_BAD_REQUEST, id, "image to ground takes 1 to 65536 points of line, sample, height, precision");
  std::vector<double> r;
  r.reserve(n * 4);
  for (size_t i = 0; i < n; i++) {
    double achieved = 0;
    csm::EcefCoord c = g_model->imageToGround(csm::ImageCoord(q[4 * i], q[4 * i + 1]), q[4 * i + 2], q[4 * i + 3], &achieved);
    r.push_back(c.x);
    r.push_back(c.y);
    r.push_back(c.z);
    r.push_back(achieved);
  }
  reply(ST_OK, id, doubles(r));
}

// Ground partials (6: d line and d sample by x, y, z), then line and sample by each parameter.
void op_partials(uint32_t id, const std::vector<double>& q) {
  if (q.size() != 3) return fail(ST_BAD_REQUEST, id, "partials take x, y, z");
  csm::EcefCoord g(q[0], q[1], q[2]);
  std::vector<double> r = g_model->computeGroundPartials(g);
  if (r.size() != 6) return fail(ST_CSM_ERROR, id, "the plug-in returned ground partials of the wrong size");
  std::vector<csm::RasterGM::SensorPartials> s = g_model->computeAllSensorPartials(g, csm::param::VALID);
  for (const csm::RasterGM::SensorPartials& p : s) {
    r.push_back(p.first);
    r.push_back(p.second);
  }
  reply(ST_OK, id, doubles(r));
}

// Unmodelled error at an image point (3: line², line·sample, sample²), the parameter count, then
// the parameter covariance by rows.
void op_covariance(uint32_t id, const std::vector<double>& q) {
  if (q.size() != 2) return fail(ST_BAD_REQUEST, id, "covariance takes line, sample");
  std::vector<double> u = g_model->getUnmodeledError(csm::ImageCoord(q[0], q[1]));
  if (u.size() != 4) return fail(ST_CSM_ERROR, id, "the plug-in returned unmodelled error of the wrong size");
  int n = g_model->getNumParameters();
  if (n < 0 || n > 1024) return fail(ST_CSM_ERROR, id, "the plug-in states an unreasonable parameter count");
  std::vector<double> r = {u[0], u[1], u[3], (double)n};
  r.reserve(4 + (size_t)n * (size_t)n);
  for (int i = 0; i < n; i++)
    for (int j = 0; j < n; j++) r.push_back(g_model->getParameterCovariance(i, j));
  reply(ST_OK, id, doubles(r));
}

void dispatch(uint32_t op, uint32_t id, const std::string& payload) {
  if (op == OP_HELLO) {
    if (!payload.empty()) return fail(ST_BAD_REQUEST, id, "HELLO takes nothing");
    csm::Version v = CURRENT_CSM_VERSION;
    return reply(g_confined ? ST_OK : ST_SANDBOX, id, strings({"gwb-csm-host", std::to_string(PROTOCOL), v.version(), g_confinement}));
  }
  if (op == OP_LOAD) {
    if (!payload.empty()) return fail(ST_BAD_REQUEST, id, "LOAD takes nothing");
    return op_load(id);
  }
  if (op == OP_OPEN) return op_open(id, payload);
  if (op < OP_G2I || op > OP_COVARIANCE) return fail(ST_BAD_REQUEST, id, "no such operation");
  if (!g_model) return fail(ST_NOT_READY, id, "no model is open");
  std::vector<double> q;
  if (!parse_doubles(payload, q)) return fail(ST_BAD_REQUEST, id, "the numbers are not finite doubles");
  switch (op) {
    case OP_G2I:
      return op_g2i(id, q);
    case OP_I2G:
      return op_i2g(id, q);
    case OP_PARTIALS:
      return op_partials(id, q);
    default:
      return op_covariance(id, q);
  }
}

} // namespace

int main(int argc, char** argv) {
  if (argc != 2) {
    std::fputs("usage: gwb-csm-host <plug-in file>\n", stderr);
    return 2;
  }
  g_plugin_path = argv[1];
  if (!private_io()) return 3;
  check_confinement();
  for (;;) {
    uint32_t head[4];
    if (!read_full(head, sizeof head)) return 0; // the sidecar closed the pipe
    if (head[0] != REQ_MAGIC || head[3] > MAX_PAYLOAD) return 5;
    std::string payload(head[3], '\0');
    if (head[3] && !read_full(&payload[0], head[3])) return 5;
    if (head[1] == OP_QUIT) return 0;
    try {
      dispatch(head[1], head[2], payload);
    } catch (const csm::Error& e) {
      fail(ST_CSM_ERROR, head[2], e.getMessage());
    } catch (const std::exception& e) {
      fail(ST_PLUGIN_EXCEPTION, head[2], e.what());
    } catch (...) {
      fail(ST_PLUGIN_EXCEPTION, head[2], "the plug-in threw something that is not an exception");
    }
  }
}
