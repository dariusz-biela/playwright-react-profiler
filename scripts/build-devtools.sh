#!/bin/bash
# Builds React DevTools extension from react-source with the headless profiler entry point.
# Output goes to devtools-extension/ directory as a loadable Chrome extension.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
REACT_SOURCE="$ROOT_DIR/react-source"
OUTPUT_DIR="$ROOT_DIR/devtools-extension"
EXTENSIONS_DIR="$REACT_SOURCE/packages/react-devtools-extensions"

# ── Verify react-source exists ──
if [ ! -d "$REACT_SOURCE/packages/react-devtools-extensions" ]; then
    echo "ERROR: react-source not found or incomplete."
    echo "Run: git clone --depth 1 https://github.com/facebook/react.git react-source"
    exit 1
fi

# ── Copy our headless profiler entry point ──
echo "Copying headlessProfiler.js entry point..."
cp "$ROOT_DIR/src/headlessProfiler.js" "$EXTENSIONS_DIR/src/headlessProfiler.js" 2>/dev/null || true

# ── Patch webpack config to add headlessProfiler entry ──
echo "Patching webpack config..."
WEBPACK_CONFIG="$EXTENSIONS_DIR/webpack.config.js"
if ! grep -q "headlessProfiler" "$WEBPACK_CONFIG"; then
    sed -i.bak "s|installHook: './src/contentScripts/installHook.js',|installHook: './src/contentScripts/installHook.js',\n    headlessProfiler: './src/headlessProfiler.js',|" "$WEBPACK_CONFIG"
    rm -f "$WEBPACK_CONFIG.bak"
    echo "  Added headlessProfiler entry to webpack config"
else
    echo "  headlessProfiler entry already present"
fi

# ── Install dependencies in react-source root ──
echo "Installing dependencies..."
cd "$REACT_SOURCE"
if [ ! -d "node_modules" ]; then
    yarn install --frozen-lockfile 2>&1 || yarn install 2>&1
fi

# ── Build React packages (oss-experimental) if not present ──
BUILD_DIR="$REACT_SOURCE/build/oss-experimental"
if [ ! -d "$BUILD_DIR" ]; then
    echo "Building React packages (oss-experimental)..."
    yarn build-for-devtools 2>&1
fi

# ── Install extension-specific dependencies ──
cd "$EXTENSIONS_DIR"
if [ ! -d "node_modules" ]; then
    yarn install --frozen-lockfile 2>&1 || yarn install 2>&1
fi

# ── Build the Chrome extension ──
echo "Building Chrome extension..."
yarn build:chrome 2>&1

# ── Copy built artifacts to devtools-extension/ ──
CHROME_BUILD="$EXTENSIONS_DIR/chrome/build/unpacked/build"
if [ ! -d "$CHROME_BUILD" ]; then
    CHROME_BUILD="$EXTENSIONS_DIR/chrome/build/unpacked"
fi

mkdir -p "$OUTPUT_DIR"
cp "$CHROME_BUILD/installHook.js" "$OUTPUT_DIR/"
cp "$CHROME_BUILD/headlessProfiler.js" "$OUTPUT_DIR/"

echo ""
echo "DevTools extension build complete: $OUTPUT_DIR/"
ls -la "$OUTPUT_DIR/"
