#!/bin/bash
# Builds the sidecar's Linux packages in WSL and copies them out. sidecar.mjs calls this.
#
#   wsl-package.sh <repo> <version> <dist> <dest>
#
# Node, appimagetool and the native deps come from ~/gwb unless GWB_WSL_HOME says otherwise.
# The build works in ~/gwb/release, on the Linux file system, because the packages need Linux
# permissions and symlinks. The WSL disk lives on C:, so only one earlier build is kept, as
# ~/gwb/release/<version>-prev. The copies that matter are the ones in <dest>.
set -euo pipefail
repo=$1 version=$2 dist=$3 dest=$4
home=${GWB_WSL_HOME:-$HOME/gwb}
export PATH=$home/node/bin:$HOME/.cargo/bin:$home/bin:$PATH
export GWB_SIDECAR_DEPS=${GWB_SIDECAR_DEPS:-$home/deps}
out=$home/release

if [ -d "$out/$version" ]; then rm -rf "$out/$version-prev" && mv "$out/$version" "$out/$version-prev"; fi
cd "$repo"
node sidecar/installer/package-linux.mjs --version "$version" --dist "$dist" --out "$out"

mkdir -p "$dest"
cd "$out/$version"
cp "GWB-Sidecar-$version-amd64.deb" "GWB-Sidecar-$version-x86_64.AppImage" "GWB-Sidecar-$version-linux-x86_64.tar.gz" "$dest/"
for f in gwb-sidecar-module-*-"$version".tar.gz; do [ -e "$f" ] && cp "$f" "$dest/"; done
cp sbom.cdx.json "$dest/GWB-Sidecar-$version-linux-sbom.cdx.json"
cp SHA256SUMS "$dest/"
ls -la "$dest"
