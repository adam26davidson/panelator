#!/usr/bin/env bash
# Builds the firmware with idf.py inside the one container image of idf-image.txt. The only way firmware is built.
# PANELATOR_COMMIT (40 hex) names the commit the image is built from; unset, CMake asks git.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
root="$(cd "$here/.." && pwd)"
image="$(tr -d '[:space:]' <"$here/idf-image.txt")"

env_args=(-e HOME=/tmp/idf-home -e IDF_TARGET=esp32s3)
if [ -n "${PANELATOR_COMMIT:-}" ]; then
  env_args+=(-e "PANELATOR_COMMIT=$PANELATOR_COMMIT")
fi

# Reconfigure every time so a different PANELATOR_COMMIT always reaches the image.
# The component manager writes under /opt/esp, which only root owns: give it a scratch directory.
exec docker run --rm --user "$(id -u):$(id -g)" --tmpfs /opt/esp/root_managed_components:rw,mode=1777 "${env_args[@]}" -v "$root:/work" -w /work/firmware "$image" \
  idf.py reconfigure build
