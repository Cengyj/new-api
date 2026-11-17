#!/bin/bash

set -e

echo "Building New API Electron App..."

# Keep the embedded server and browser on the same release identifier. The
# optional override is also used by packaged/custom builds.
BUILD_VERSION=${VITE_REACT_APP_VERSION:-$(cat ../VERSION)}

echo "Step 1: Building frontend..."
cd ../web
bun install --frozen-lockfile
DISABLE_ESLINT_PLUGIN='true' VITE_REACT_APP_VERSION="$BUILD_VERSION" bun run build
cd ../electron

echo "Step 2: Building Go backend..."
cd ..

if [[ "$OSTYPE" == "darwin"* ]]; then
    echo "Building for macOS..."
    CGO_ENABLED=1 go build -pgo="$(go list -m -f '{{.Dir}}' github.com/MoeForge/moejs)/default.pgo" -ldflags="-s -w -X github.com/QuantumNous/new-api/common.Version=$BUILD_VERSION" -o new-api
    cd electron
    npm install
    npm run build:mac
elif [[ "$OSTYPE" == "linux-gnu"* ]]; then
    echo "Building for Linux..."
    CGO_ENABLED=1 go build -pgo="$(go list -m -f '{{.Dir}}' github.com/MoeForge/moejs)/default.pgo" -ldflags="-s -w -X github.com/QuantumNous/new-api/common.Version=$BUILD_VERSION" -o new-api
    cd electron
    npm install
    npm run build:linux
elif [[ "$OSTYPE" == "msys" || "$OSTYPE" == "cygwin" || "$OSTYPE" == "win32" ]]; then
    echo "Building for Windows..."
    CGO_ENABLED=1 go build -pgo="$(go list -m -f '{{.Dir}}' github.com/MoeForge/moejs)/default.pgo" -ldflags="-s -w -X github.com/QuantumNous/new-api/common.Version=$BUILD_VERSION" -o new-api.exe
    cd electron
    npm install
    npm run build:win
else
    echo "Unknown OS, building for current platform..."
    CGO_ENABLED=1 go build -pgo="$(go list -m -f '{{.Dir}}' github.com/MoeForge/moejs)/default.pgo" -ldflags="-s -w -X github.com/QuantumNous/new-api/common.Version=$BUILD_VERSION" -o new-api
    cd electron
    npm install
    npm run build
fi

echo "Build complete! Check electron/dist/ for output."
