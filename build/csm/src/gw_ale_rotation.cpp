// GIS Workbench: ale::Rotation without Eigen (REQ-GAP-24).
//
// ALE's src/Rotation.cpp keeps the rotation as an Eigen quaternion. Eigen is MPL-2.0 (weak
// copyleft) and the browser bundle is permissive-only, so the wasm build compiles this file in its
// place: the same class (ale/include/ale/Rotation.h, unchanged) over a plain (w, x, y, z)
// quaternion, with the textbook formulas the Eigen version evaluates (Hamilton product, the
// rotation matrix of a unit quaternion, Shoemake's matrix → quaternion, axis-angle, slerp with a
// linear fallback within one ulp of parallel). The differential test (docs/validation/2.5/csm.md)
// compares the wasm build against native usgscsm built with ALE's own Eigen file.
//
// toEuler and toAxisAngle are not used by usgscsm; toAxisAngle is given, toEuler refuses.
//
// Licence: Apache-2.0 (GIS Workbench). ALE is public domain.

#include "ale/Rotation.h"

#include <cmath>
#include <limits>
#include <stdexcept>

#include "ale/InterpUtils.h"

namespace ale {

namespace {

struct Q {
  double w, x, y, z;
};

Q mul(const Q &a, const Q &b) {
  return {a.w * b.w - a.x * b.x - a.y * b.y - a.z * b.z,
          a.w * b.x + a.x * b.w + a.y * b.z - a.z * b.y,
          a.w * b.y + a.y * b.w + a.z * b.x - a.x * b.z,
          a.w * b.z + a.z * b.w + a.x * b.y - a.y * b.x};
}

double norm(const Q &q) { return std::sqrt(q.x * q.x + q.y * q.y + q.z * q.z + q.w * q.w); }

Q normalized(const Q &q) {
  const double n = norm(q);
  if (n > 0) return {q.w / n, q.x / n, q.y / n, q.z / n};
  return q;
}

// Rotation matrix of a quaternion, m[r][c] (as Eigen's toRotationMatrix).
void matrix(const Q &q, double m[3][3]) {
  const double tx = 2 * q.x, ty = 2 * q.y, tz = 2 * q.z;
  const double twx = tx * q.w, twy = ty * q.w, twz = tz * q.w;
  const double txx = tx * q.x, txy = ty * q.x, txz = tz * q.x;
  const double tyy = ty * q.y, tyz = tz * q.y, tzz = tz * q.z;
  m[0][0] = 1 - (tyy + tzz);
  m[0][1] = txy - twz;
  m[0][2] = txz + twy;
  m[1][0] = txy + twz;
  m[1][1] = 1 - (txx + tzz);
  m[1][2] = tyz - twx;
  m[2][0] = txz - twy;
  m[2][1] = tyz + twx;
  m[2][2] = 1 - (txx + tyy);
}

// Quaternion of a rotation matrix m[r][c] (Shoemake 1987, as Eigen).
Q fromMatrix(const double m[3][3]) {
  Q q;
  double t = m[0][0] + m[1][1] + m[2][2];
  if (t > 0) {
    t = std::sqrt(t + 1.0);
    q.w = 0.5 * t;
    t = 0.5 / t;
    q.x = (m[2][1] - m[1][2]) * t;
    q.y = (m[0][2] - m[2][0]) * t;
    q.z = (m[1][0] - m[0][1]) * t;
  } else {
    int i = 0;
    if (m[1][1] > m[0][0]) i = 1;
    if (m[2][2] > m[i][i]) i = 2;
    const int j = (i + 1) % 3, k = (j + 1) % 3;
    t = std::sqrt(m[i][i] - m[j][j] - m[k][k] + 1.0);
    double v[3];
    v[i] = 0.5 * t;
    t = 0.5 / t;
    q.w = (m[k][j] - m[j][k]) * t;
    v[j] = (m[j][i] + m[i][j]) * t;
    v[k] = (m[k][i] + m[i][k]) * t;
    q.x = v[0];
    q.y = v[1];
    q.z = v[2];
  }
  return q;
}

Q axisAngle(double theta, double ax, double ay, double az) {
  const double ha = 0.5 * theta;
  const double s = std::sin(ha);
  return {std::cos(ha), s * ax, s * ay, s * az};
}

// The transpose of the skew AV matrix (AV from the destination to the source, as NAIF and ALE).
void avSkew(const Vec3d &av, double s[3][3]) {
  s[0][0] = 0.0;
  s[0][1] = av.z;
  s[0][2] = -av.y;
  s[1][0] = -av.z;
  s[1][1] = 0.0;
  s[1][2] = av.x;
  s[2][0] = av.y;
  s[2][1] = -av.x;
  s[2][2] = 0.0;
}

void matMul(const double a[3][3], const double b[3][3], double c[3][3]) {
  for (int r = 0; r < 3; r++)
    for (int k = 0; k < 3; k++) c[r][k] = a[r][0] * b[0][k] + a[r][1] * b[1][k] + a[r][2] * b[2][k];
}

}  // namespace

class Rotation::Impl {
 public:
  Impl() : q{1.0, 0.0, 0.0, 0.0} {}
  Impl(double w, double x, double y, double z) : q{w, x, y, z} {}

  explicit Impl(const std::vector<double> &m) {
    if (m.size() != 9) throw std::invalid_argument("Rotation matrix must be 3 by 3.");
    // Row-major input, as ALE.
    const double mm[3][3] = {{m[0], m[1], m[2]}, {m[3], m[4], m[5]}, {m[6], m[7], m[8]}};
    q = normalized(fromMatrix(mm));
  }

  Impl(const std::vector<double> &angles, const std::vector<int> &axes) {
    if (angles.empty() || axes.empty()) throw std::invalid_argument("Angles and axes must be non-empty.");
    if (angles.size() != axes.size()) throw std::invalid_argument("Number of angles and axes must be equal.");
    q = {1.0, 0.0, 0.0, 0.0};
    for (size_t i = 0; i < angles.size(); i++) {
      double a[3] = {0, 0, 0};
      if (axes[i] < 0 || axes[i] > 2) throw std::invalid_argument("Axis index must be 0, 1, or 2.");
      a[axes[i]] = 1.0;
      q = mul(q, axisAngle(angles[i], a[0], a[1], a[2]));
    }
    q = normalized(q);
  }

  Impl(const std::vector<double> &axis, double theta) {
    if (axis.size() != 3) throw std::invalid_argument("Rotation axis must have 3 elements.");
    const double n = std::sqrt(axis[0] * axis[0] + axis[1] * axis[1] + axis[2] * axis[2]);
    const double ax = n > 0 ? axis[0] / n : axis[0], ay = n > 0 ? axis[1] / n : axis[1], az = n > 0 ? axis[2] / n : axis[2];
    q = normalized(axisAngle(theta, ax, ay, az));
  }

  Q q;
};

Rotation::Rotation() : m_impl(new Impl()) {}
Rotation::Rotation(double w, double x, double y, double z) : m_impl(new Impl(w, x, y, z)) {}
Rotation::Rotation(const std::vector<double> &matrix) : m_impl(new Impl(matrix)) {}
Rotation::Rotation(const std::vector<double> &angles, const std::vector<int> &axes) : m_impl(new Impl(angles, axes)) {}
Rotation::Rotation(const std::vector<double> &axis, double theta) : m_impl(new Impl(axis, theta)) {}
Rotation::~Rotation() = default;
Rotation::Rotation(Rotation &&other) noexcept = default;
Rotation &Rotation::operator=(Rotation &&other) noexcept = default;
Rotation::Rotation(const Rotation &other) : m_impl(new Impl(*other.m_impl)) {}
Rotation &Rotation::operator=(const Rotation &other) {
  if (this != &other) m_impl.reset(new Impl(*other.m_impl));
  return *this;
}

std::vector<double> Rotation::toQuaternion() const {
  Q n = normalized(m_impl->q);
  return {n.w, n.x, n.y, n.z};
}

std::vector<double> Rotation::toRotationMatrix() const {
  double m[3][3];
  matrix(m_impl->q, m);
  return {m[0][0], m[0][1], m[0][2], m[1][0], m[1][1], m[1][2], m[2][0], m[2][1], m[2][2]};
}

std::vector<double> Rotation::toStateRotationMatrix(const Vec3d &av) const {
  double r[3][3], s[3][3], d[3][3];
  matrix(m_impl->q, r);
  avSkew(av, s);
  matMul(r, s, d);
  return {r[0][0], r[0][1], r[0][2], 0.0,     0.0,     0.0,
          r[1][0], r[1][1], r[1][2], 0.0,     0.0,     0.0,
          r[2][0], r[2][1], r[2][2], 0.0,     0.0,     0.0,
          d[0][0], d[0][1], d[0][2], r[0][0], r[0][1], r[0][2],
          d[1][0], d[1][1], d[1][2], r[1][0], r[1][1], r[1][2],
          d[2][0], d[2][1], d[2][2], r[2][0], r[2][1], r[2][2]};
}

std::vector<double> Rotation::toEuler(const std::vector<int> &) const {
  throw std::logic_error("Rotation::toEuler is not built in the GIS Workbench usgscsm module");
}

std::pair<std::vector<double>, double> Rotation::toAxisAngle() const {
  const Q &q = m_impl->q;
  double n = std::sqrt(q.x * q.x + q.y * q.y + q.z * q.z);
  if (n != 0.0) {
    const double angle = 2.0 * std::atan2(n, std::fabs(q.w));
    if (q.w < 0) n = -n;
    return {{q.x / n, q.y / n, q.z / n}, angle};
  }
  return {{1.0, 0.0, 0.0}, 0.0};
}

Vec3d Rotation::operator()(const Vec3d &v) const {
  // v + w·uv + q.vec × uv with uv = 2 (q.vec × v), as Eigen's _transformVector.
  const Q &q = m_impl->q;
  double ux = q.y * v.z - q.z * v.y, uy = q.z * v.x - q.x * v.z, uz = q.x * v.y - q.y * v.x;
  ux += ux;
  uy += uy;
  uz += uz;
  return Vec3d(v.x + q.w * ux + (q.y * uz - q.z * uy), v.y + q.w * uy + (q.z * ux - q.x * uz), v.z + q.w * uz + (q.x * uy - q.y * ux));
}

State Rotation::operator()(const State &state, const Vec3d &av) const {
  double r[3][3], s[3][3], d[3][3];
  matrix(m_impl->q, r);
  avSkew(av, s);
  matMul(r, s, d);
  const Vec3d &p = state.position, &v = state.velocity;
  const double px = r[0][0] * p.x + r[0][1] * p.y + r[0][2] * p.z;
  const double py = r[1][0] * p.x + r[1][1] * p.y + r[1][2] * p.z;
  const double pz = r[2][0] * p.x + r[2][1] * p.y + r[2][2] * p.z;
  const double vx = (r[0][0] * v.x + r[0][1] * v.y + r[0][2] * v.z) + (d[0][0] * p.x + d[0][1] * p.y + d[0][2] * p.z);
  const double vy = (r[1][0] * v.x + r[1][1] * v.y + r[1][2] * v.z) + (d[1][0] * p.x + d[1][1] * p.y + d[1][2] * p.z);
  const double vz = (r[2][0] * v.x + r[2][1] * v.y + r[2][2] * v.z) + (d[2][0] * p.x + d[2][1] * p.y + d[2][2] * p.z);
  return State({px, py, pz, vx, vy, vz});
}

Rotation Rotation::inverse() const {
  const Q &q = m_impl->q;
  const double n2 = q.x * q.x + q.y * q.y + q.z * q.z + q.w * q.w;
  if (n2 > 0) return Rotation(q.w / n2, -q.x / n2, -q.y / n2, -q.z / n2);
  return Rotation(0.0, 0.0, 0.0, 0.0);
}

Rotation Rotation::operator*(const Rotation &right) const {
  Q c = mul(m_impl->q, right.m_impl->q);
  return Rotation(c.w, c.x, c.y, c.z);
}

Rotation Rotation::interpolate(const Rotation &next, double t, RotationInterpolation interpType) const {
  const Q &a = m_impl->q, &b = next.m_impl->q;
  Q r;
  switch (interpType) {
    case SLERP: {
      const double one = 1.0 - std::numeric_limits<double>::epsilon();
      const double d = a.x * b.x + a.y * b.y + a.z * b.z + a.w * b.w;
      const double absD = std::fabs(d);
      double s0, s1;
      if (absD >= one) {
        s0 = 1.0 - t;
        s1 = t;
      } else {
        const double theta = std::acos(absD);
        const double st = std::sin(theta);
        s0 = std::sin((1.0 - t) * theta) / st;
        s1 = std::sin(t * theta) / st;
      }
      if (d < 0) s1 = -s1;
      r = {s0 * a.w + s1 * b.w, s0 * a.x + s1 * b.x, s0 * a.y + s1 * b.y, s0 * a.z + s1 * b.z};
      break;
    }
    case NLERP:
      r = normalized(Q{linearInterpolate(a.w, b.w, t), linearInterpolate(a.x, b.x, t), linearInterpolate(a.y, b.y, t), linearInterpolate(a.z, b.z, t)});
      break;
    default:
      throw std::invalid_argument("Unsupported rotation interpolation type.");
  }
  return Rotation(r.w, r.x, r.y, r.z);
}

}  // namespace ale
