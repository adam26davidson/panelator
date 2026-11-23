#!/usr/bin/env bash
# The firmware's host-side checks: clang-format, the host build with sanitizers, clang-tidy, ctest.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
build="${PANELATOR_HOST_BUILD:-$here/build/host}"
cd "$here"

echo "check-host: clang-format"
find . \( -path ./build -o -path '*/third_party' \) -prune -o \( -name '*.c' -o -name '*.h' \) -print0 |
  xargs -0 clang-format-18 --dry-run --Werror

echo "check-host: host build"
cmake -S test/host -B "$build" -DCMAKE_BUILD_TYPE=Debug >/dev/null
cmake --build "$build"

echo "check-host: clang-tidy"
find components test/host -path test/host/third_party -prune -o -name '*.c' -print0 |
  xargs -0 clang-tidy-18 -p "$build" --quiet

echo "check-host: ctest"
ctest --test-dir "$build" --output-on-failure

echo "check-host: ok"
