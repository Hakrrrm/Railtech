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
echo "== ingest/test_index (event_mapper) =="
node ingest/test_index.js

echo
echo "run_tests.sh: all suites passed"
