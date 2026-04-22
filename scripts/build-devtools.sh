#!/bin/bash
# Builds React DevTools from the react-source submodule
# Output goes to devtools-build/ directory

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
REACT_SOURCE="$ROOT_DIR/react-source"
OUTPUT_DIR="$ROOT_DIR/devtools-build"

if [ ! -d "$REACT_SOURCE/.git" ] && [ ! -f "$REACT_SOURCE/.git" ]; then
    echo "React source not found. Initializing submodule..."
    cd "$ROOT_DIR"
    git submodule update --init --recursive react-source
fi

if [ ! -d "$REACT_SOURCE/packages/react-devtools-extensions" ]; then
    echo "ERROR: react-source submodule incomplete."
    echo "Run: git submodule update --init --recursive"
    exit 1
fi

echo "Building React DevTools extension..."
cd "$REACT_SOURCE"

# Install dependencies if needed
if [ ! -d "node_modules" ]; then
    yarn install
fi

# Build the Chrome extension
cd packages/react-devtools-extensions
yarn build:chrome

# Copy build artifacts
CHROME_BUILD="chrome/build/unpacked/build"
if [ ! -d "$CHROME_BUILD" ]; then
    # Fallback path
    CHROME_BUILD="chrome/build/unpacked"
fi

mkdir -p "$OUTPUT_DIR"
cp "$CHROME_BUILD/installHook.js" "$OUTPUT_DIR/"
cp "$CHROME_BUILD/react_devtools_backend_compact.js" "$OUTPUT_DIR/"

# Also copy manifest for extension-based mode
if [ -f "chrome/build/unpacked/manifest.json" ]; then
    cp "chrome/build/unpacked/manifest.json" "$OUTPUT_DIR/"
fi

echo "DevTools build complete: $OUTPUT_DIR/"
ls -la "$OUTPUT_DIR/"
