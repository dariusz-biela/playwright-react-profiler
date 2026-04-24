#!/bin/bash
# Builds React DevTools extension from react-source with the service worker architecture.
#
# Architecture (3 scripts):
#   backend.js   — MAIN world content script (Agent, initBackend, Bridge)
#   proxy.js     — ISOLATED world content script (window.postMessage ↔ chrome.runtime port)
#   frontend.js  — Service worker (Store, ProfilerStore, prepareProfilingDataExport)
#
# Output goes to devtools-extension/ as a loadable Chrome extension.

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

# ── Copy our entry points (prefixed names to avoid conflicts with existing entries) ──
echo "Copying entry points..."
cp "$ROOT_DIR/src/backend.js" "$EXTENSIONS_DIR/src/profilerBackend.js"
cp "$ROOT_DIR/src/frontend.js" "$EXTENSIONS_DIR/src/profilerFrontend.js"

# ── Patch webpack config ──
echo "Patching webpack config..."
WEBPACK_CONFIG="$EXTENSIONS_DIR/webpack.config.js"

# Remove old headlessProfiler entry if present
if grep -q "headlessProfiler" "$WEBPACK_CONFIG"; then
    sed -i.bak "/headlessProfiler/d" "$WEBPACK_CONFIG"
    rm -f "$WEBPACK_CONFIG.bak"
    echo "  Removed old headlessProfiler entry"
fi

# Add profilerBackend + profilerFrontend entries (idempotent)
if ! grep -q "profilerBackend" "$WEBPACK_CONFIG"; then
    sed -i.bak "s|installHook: './src/contentScripts/installHook.js',|installHook: './src/contentScripts/installHook.js',\n    profilerBackend: './src/profilerBackend.js',\n    profilerFrontend: './src/profilerFrontend.js',|" "$WEBPACK_CONFIG"
    rm -f "$WEBPACK_CONFIG.bak"
    echo "  Added profilerBackend + profilerFrontend entries"
else
    echo "  profilerBackend/profilerFrontend entries already present"
fi

# Add filename mappings (idempotent)
if ! grep -qF "case 'profilerBackend'" "$WEBPACK_CONFIG"; then
    sed -i.bak "s|case 'backend':|case 'profilerBackend':\n          return 'backend.js';\n        case 'profilerFrontend':\n          return 'frontend.js';\n        case 'backend':|" "$WEBPACK_CONFIG"
    rm -f "$WEBPACK_CONFIG.bak"
    echo "  Added output filename mappings"
else
    echo "  Output filename mappings already present"
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
cp "$CHROME_BUILD/backend.js" "$OUTPUT_DIR/"
cp "$CHROME_BUILD/frontend.js" "$OUTPUT_DIR/"
# proxy.js is plain JS, already committed in devtools-extension/ — no build needed

# ── Generate LICENSE from react-source ──
REACT_LICENSE="$REACT_SOURCE/LICENSE"
if [ -f "$REACT_LICENSE" ]; then
    {
        echo "The files installHook.js, backend.js, and frontend.js in this directory"
        echo "are built from facebook/react (https://github.com/facebook/react) and"
        echo "contain code subject to the following license:"
        echo ""
        cat "$REACT_LICENSE"
    } > "$OUTPUT_DIR/LICENSE"
    echo "  Generated devtools-extension/LICENSE from react-source/LICENSE"
else
    echo "  WARNING: react-source/LICENSE not found, keeping existing devtools-extension/LICENSE"
fi

# ── Prepend license header to built files ──
# Extract copyright line from react-source LICENSE for the header
COPYRIGHT_LINE=$(grep -m1 "^Copyright" "$REACT_LICENSE" 2>/dev/null || echo "Copyright (c) Meta Platforms, Inc. and affiliates.")
LICENSE_HEADER="/**
 * Built from facebook/react (https://github.com/facebook/react)
 * $COPYRIGHT_LINE
 * Licensed under the MIT License. See devtools-extension/LICENSE for details.
 */"

for file in installHook.js backend.js frontend.js; do
    TARGET="$OUTPUT_DIR/$file"
    if [ -f "$TARGET" ] && ! head -1 "$TARGET" | grep -q "Built from facebook/react"; then
        echo "$LICENSE_HEADER" | cat - "$TARGET" > "$TARGET.tmp"
        mv "$TARGET.tmp" "$TARGET"
        echo "  Added license header to $file"
    fi
done

echo ""
echo "DevTools extension build complete: $OUTPUT_DIR/"
ls -la "$OUTPUT_DIR/"
