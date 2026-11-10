// Build steps whose output must depend only on the commit, not on the machine or the files left
// in the cargo target directory: the same commit builds the same HTML on Windows and Linux (#31).
import { gzipSync } from 'node:zlib';

/**
 * gzip at level 9 with the header's OS byte set to 255, "unknown" (RFC 1952). zlib writes the
 * build machine's own code there (10 on Windows, 3 on Unix), so the bytes differed by platform (#34).
 */
export function gzipStable(bytes) {
  const z = gzipSync(bytes, { level: 9 });
  z[9] = 255;
  return z;
}

