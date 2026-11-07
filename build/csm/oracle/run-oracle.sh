#!/usr/bin/env bash
# GIS Workbench: run the native usgscsm oracles (build-oracle.sh) over a folder of ISDs and write
# gzipped answers for tests/unit/csm-diff.test.js (REQ-GAP-24).
#   run-oracle.sh <oracle bin dir> <isd dir> <out dir>   → <out>/{upstream,gw}/<isd>.json.gz
set -euo pipefail
BIN=$(realpath "$1"); ISD=$(realpath "$2"); OUT=$(realpath -m "$3")
for v in upstream gw; do
  mkdir -p "$OUT/$v"
  for f in "$ISD"/*.json; do
    b=$(basename "$f" .json)
    "$BIN/csm_oracle_$v" "$f" "$OUT/$v/$b.json"
    gzip -9 -n -f "$OUT/$v/$b.json"
  done
done
echo "wrote $OUT/{upstream,gw}"
