// GIS Workbench: usgscsm's EigenUtilities.cpp without Eigen (REQ-GAP-24).
//
// computeBestFitProjectiveTransform fits the 14-coefficient 3-D → 2-D projective transform the
// line-scanner model uses as the starting point of its ground → image search. usgscsm solves it
// with Eigen's column-pivoting Householder QR; Eigen is MPL-2.0, so the wasm build compiles this
// file in its place: Householder QR with column pivoting (Golub & Van Loan, Algorithm 5.4.1),
// the rank cut at ε · max(rows, cols) · |R₀₀| as Eigen's default threshold, and the basic
// least-squares solution (zero for the columns beyond the rank). The fit only seeds an iteration
// that runs to the requested precision, so the final ground → image answer does not depend on its
// last bits.
//
// Licence: Apache-2.0 (GIS Workbench). usgscsm is public domain.

#include "EigenUtilities.h"

#include <Error.h>

#include <cmath>
#include <limits>
#include <vector>

namespace {

// Least squares min ‖M u − b‖ for M (rows × cols, row-major), rows ≥ cols.
std::vector<double> lstsqColPivQr(std::vector<double> M, std::vector<double> b, int rows, int cols) {
  auto at = [&](int r, int c) -> double & { return M[static_cast<size_t>(r) * cols + c]; };
  std::vector<int> perm(cols);
  std::vector<double> colNorm(cols);
  for (int c = 0; c < cols; c++) {
    perm[c] = c;
    double s = 0;
    for (int r = 0; r < rows; r++) s += at(r, c) * at(r, c);
    colNorm[c] = s;
  }
  const int steps = rows < cols ? rows : cols;
  std::vector<double> rdiag(steps, 0.0);
  for (int k = 0; k < steps; k++) {
    // Pivot: the remaining column of largest norm (recomputed: 14 columns, exact).
    int best = k;
    double bestN = -1;
    for (int c = k; c < cols; c++) {
      double s = 0;
      for (int r = k; r < rows; r++) s += at(r, c) * at(r, c);
      colNorm[c] = s;
      if (s > bestN) {
        bestN = s;
        best = c;
      }
    }
    if (best != k) {
      for (int r = 0; r < rows; r++) std::swap(at(r, k), at(r, best));
      std::swap(perm[k], perm[best]);
    }
    // Householder vector for column k below the diagonal.
    double alpha = std::sqrt(bestN);
    if (alpha == 0) {
      rdiag[k] = 0;
      continue;
    }
    if (at(k, k) > 0) alpha = -alpha;
    std::vector<double> v(rows - k);
    for (int r = k; r < rows; r++) v[r - k] = at(r, k);
    v[0] -= alpha;
    double vn = 0;
    for (double x : v) vn += x * x;
    if (vn == 0) {
      rdiag[k] = at(k, k);
      continue;
    }
    // Apply H = I − 2 v vᵀ / (vᵀ v) to the remaining columns and to b.
    for (int c = k; c < cols; c++) {
      double s = 0;
      for (int r = k; r < rows; r++) s += v[r - k] * at(r, c);
      s = 2 * s / vn;
      for (int r = k; r < rows; r++) at(r, c) -= s * v[r - k];
    }
    double s = 0;
    for (int r = k; r < rows; r++) s += v[r - k] * b[r];
    s = 2 * s / vn;
    for (int r = k; r < rows; r++) b[r] -= s * v[r - k];
    rdiag[k] = at(k, k);
  }
  // Rank as Eigen: |R_ii| > ε · max(rows, cols) · max |R_ii|.
  double maxPivot = 0;
  for (double d : rdiag) maxPivot = std::fmax(maxPivot, std::fabs(d));
  const double thr = std::numeric_limits<double>::epsilon() * (rows > cols ? rows : cols);
  int rank = 0;
  for (int k = 0; k < steps; k++)
    if (std::fabs(rdiag[k]) > thr * maxPivot) rank++;
    else break;
  // Back substitution on the leading rank × rank block; the rest are zero.
  std::vector<double> z(cols, 0.0);
  for (int k = rank - 1; k >= 0; k--) {
    double s = b[k];
    for (int c = k + 1; c < rank; c++) s -= at(k, c) * z[c];
    z[k] = s / at(k, k);
  }
  std::vector<double> u(cols, 0.0);
  for (int c = 0; c < cols; c++) u[perm[c]] = z[c];
  return u;
}

}  // namespace

void usgscsm::computeBestFitProjectiveTransform(std::vector<csm::ImageCoord> const &imagePts, std::vector<csm::EcefCoord> const &groundPts, std::vector<double> &transformCoeffs) {
  if (imagePts.size() != groundPts.size())
    throw csm::Error(csm::Error::INVALID_USE, "The number of inputs and outputs must agree.", "computeBestFitProjectiveTransform");
  const int numPts = static_cast<int>(imagePts.size());
  if (numPts < 8)
    throw csm::Error(csm::Error::INVALID_USE, "At least 8 points are needed to fit a 3D-to-2D projective transform. Ideally more are preferred.", "computeBestFitProjectiveTransform");
  const int rows = 2 * numPts, cols = 14;
  std::vector<double> M(static_cast<size_t>(rows) * cols, 0.0), b(rows, 0.0);
  for (int it = 0; it < numPts; it++) {
    const double x = groundPts[it].x, y = groundPts[it].y, z = groundPts[it].z;
    const double r = imagePts[it].line, c = imagePts[it].samp;
    double *a = &M[static_cast<size_t>(2 * it) * cols];
    double *e = &M[static_cast<size_t>(2 * it + 1) * cols];
    const double ra[14] = {1, x, y, z, -x * r, -y * r, -z * r, 0, 0, 0, 0, 0, 0, 0};
    const double rb[14] = {0, 0, 0, 0, 0, 0, 0, 1, x, y, z, -x * c, -y * c, -z * c};
    for (int k = 0; k < cols; k++) {
      a[k] = ra[k];
      e[k] = rb[k];
    }
    b[2 * it] = r;
    b[2 * it + 1] = c;
  }
  transformCoeffs = lstsqColPivQr(M, b, rows, cols);
}
