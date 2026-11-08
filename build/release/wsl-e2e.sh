#!/bin/bash
# Runs the sidecar Playwright project on Linux, in WSL, against a built dist. Run it after the
# Linux packages are built, from Windows:
#
#   wsl.exe -e bash "/mnt/c/GIS Workbench/gwb-main/build/release/wsl-e2e.sh" "/mnt/c/GIS Workbench/gwb-main" [playwright args]
#
# Node and the Chromium libraries come from ~/gwb unless GWB_WSL_HOME says otherwise.
# The JSON report goes to reports/sidecar/e2e-linux.json.
set -euo pipefail
repo=$1
shift
home=${GWB_WSL_HOME:-$HOME/gwb}
cd "$repo"
export PATH=$home/node/bin:$PATH
export LD_LIBRARY_PATH=$home/chromelibs/usr/lib/x86_64-linux-gnu
export GW_DIST=${GW_DIST:-dist}
export PLAYWRIGHT_JSON_OUTPUT_NAME=reports/sidecar/e2e-linux.json
node node_modules/@playwright/test/cli.js test --project=sidecar --reporter=list,json "$@"
