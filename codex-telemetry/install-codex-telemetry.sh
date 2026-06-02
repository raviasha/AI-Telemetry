#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

if ! command -v node >/dev/null 2>&1; then
  echo "Node.js is required. Install Node 18+ and retry."
  exit 1
fi

if ! command -v npm >/dev/null 2>&1; then
  echo "npm is required. Install Node.js/npm and retry."
  exit 1
fi

echo "Installing dependencies..."
npm install

echo "Compiling codex-telemetry..."
npm run compile

echo "Installing launchd service..."
npm run launchd:install

echo "Running health check..."
npm run health

echo "Done. codex-telemetry is installed and running as a launchd agent."
