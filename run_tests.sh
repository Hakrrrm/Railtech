#!/usr/bin/env bash
# Builds and runs the full host test suite. Keep this green at all times.
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")"

echo "== tools/test_track_pipeline =="
python3 tools/test_track_pipeline.py

echo
echo "run_tests.sh: all suites passed"
