#!/bin/bash
# ─────────────────────────────────────────────────────────
#  Build Business Manager POS for Windows using Docker
#  Run from project root: bash docker-build-win.sh
# ─────────────────────────────────────────────────────────

set -e

echo "🔨 Building Business Manager POS for Windows..."
echo ""

# Colors
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m'

# Ensure dist directory exists
mkdir -p dist

# Create cache dirs for faster rebuilds
mkdir -p ~/.cache/electron
mkdir -p ~/.cache/electron-builder

echo -e "${YELLOW}📦 Method: Docker with electron-builder:wine${NC}"
echo ""

# Check if Docker is running
if ! docker info > /dev/null 2>&1; then
    echo -e "${RED}❌ Docker is not running. Please start Docker first.${NC}"
    exit 1
fi

# ─── Option 1: Direct docker run (simpler, recommended) ────────
echo -e "${GREEN}🚀 Starting Docker build...${NC}"
echo "   This may take 5-15 minutes on first run (downloading image + deps)"
echo ""

docker run --rm \
  -v "$(pwd)":/project \
  -v "$(pwd)/dist":/project/dist \
  -v ~/.cache/electron:/root/.cache/electron \
  -v ~/.cache/electron-builder:/root/.cache/electron-builder \
  -w /project \
  electronuserland/builder:wine \
  /bin/bash -c "
    echo '📥 Installing dependencies (with timeout handling)...'
    npm ci --no-audit --no-fund --timeout=120000 2>&1 | tail -10
    echo ''
    echo '🔧 Setting up native modules for Windows...'
    npm run postinstall 2>&1 | tail -10 || true
    echo ''
    echo '📦 Building Windows installer...'
    npx electron-builder --win --x64 -p never
    echo ''
    echo '✅ Build complete!'
  "

echo ""
echo -e "${GREEN}════════════════════════════════════════════════════${NC}"
echo -e "${GREEN}  ✅ BUILD COMPLETE!${NC}"
echo -e "${GREEN}════════════════════════════════════════════════════${NC}"
echo ""
echo "📁 Output files are in: ./dist/"
echo ""

# List the output files
if [ -d "dist" ]; then
    echo "📄 Generated files:"
    ls -lh dist/*.exe 2>/dev/null || echo "   (no .exe found)"
    ls -lh dist/*.msi 2>/dev/null || true
    echo ""
fi

echo "🎉 Copy the .exe file to Windows and install it!"
