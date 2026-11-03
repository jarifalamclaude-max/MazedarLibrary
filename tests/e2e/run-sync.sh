#!/usr/bin/env bash
# Browser test of two phones syncing through the Firebase Auth + Firestore emulators.
set -euo pipefail
cd "$(dirname "$0")/../.."
npx -y firebase-tools@15.34.0 emulators:exec --only auth,firestore,hosting --project demo-mazedar \
  'node --test --test-concurrency=1 tests/emulator/*.test.js tests/e2e/sync.test.js tests/e2e/google.test.js'
