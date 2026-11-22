#!/usr/bin/env bash
# Refresh review artifacts; preserve the native schematic unless explicitly regenerated.
set -euo pipefail
hardware_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
case "${1:-}" in
  "") ;;
  --regenerate) python3 "$hardware_dir/tools/generate_schematic.py" ;;
  *) echo 'Usage: bash hardware/tools/review_schematic.sh [--regenerate]' >&2; exit 2 ;;
esac
project_dir="$hardware_dir/kicad/carrier"
mkdir -p "$project_dir/review"
kicad-cli sch erc "$project_dir/carrier.kicad_sch" --exit-code-violations -o "$project_dir/review/erc.rpt"
kicad-cli sch export netlist --format kicadxml "$project_dir/carrier.kicad_sch" -o "$project_dir/review/carrier.xml"
python3 "$hardware_dir/tools/check_connectivity.py"
kicad-cli sch export pdf "$project_dir/carrier.kicad_sch" -o "$project_dir/review/carrier.pdf"
echo 'Review exports refreshed. Electrical and manufacturing gates remain in README.md.'
