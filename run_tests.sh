#!/usr/bin/env bash
# Builds and runs the full host test suite. Keep this green at all times.
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")"

CFLAGS="-std=c11 -Wall -Wextra -Werror -DSEQ_STORE_HOST_STUB"
BUILD_DIR="$(mktemp -d)"
trap 'rm -rf "$BUILD_DIR"' EXIT

echo "== firmware/test/test_serializer =="
gcc $CFLAGS -I firmware/src \
    -o "$BUILD_DIR/test_serializer" \
    firmware/test/test_serializer.c \
    firmware/src/event_serializer.c \
    firmware/src/seq_store.c
"$BUILD_DIR/test_serializer"

echo
echo "== firmware/test/test_gnss_parser =="
gcc $CFLAGS -I firmware/src \
    -o "$BUILD_DIR/test_gnss_parser" \
    firmware/test/test_gnss_parser.c \
    firmware/src/gnss_parser.c
"$BUILD_DIR/test_gnss_parser"

echo
echo "== firmware/test/test_map_matcher =="
gcc $CFLAGS -I firmware/src \
    -o "$BUILD_DIR/test_map_matcher" \
    firmware/test/test_map_matcher.c \
    firmware/src/map_matcher.c -lm
"$BUILD_DIR/test_map_matcher"

echo
echo "== firmware/test/test_imu_state =="
gcc $CFLAGS -I firmware/src \
    -o "$BUILD_DIR/test_imu_state" \
    firmware/test/test_imu_state.c \
    firmware/src/imu_state.c
"$BUILD_DIR/test_imu_state"

echo
echo "== tools/test_track_pipeline =="
python3 tools/test_track_pipeline.py

echo
echo "== ingest bridge and simulator =="
NODE_BIN="$(command -v node || command -v node.exe || true)"
if [ -z "$NODE_BIN" ]; then
    echo "ERROR: Node.js is required for ingest tests" >&2
    exit 1
fi
"$NODE_BIN" ingest/test_index.js
"$NODE_BIN" ingest/test_simulator.js

echo
echo "== frontend tests, lint and production build =="
NPM_BIN="$(command -v npm || command -v npm.exe || true)"
if [ -z "$NPM_BIN" ]; then
    echo "ERROR: npm is required for frontend checks" >&2
    exit 1
fi
(cd frontend && "$NPM_BIN" test && "$NPM_BIN" run lint && "$NPM_BIN" run build)

echo
echo "run_tests.sh: all suites passed"
