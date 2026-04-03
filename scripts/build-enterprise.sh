#!/usr/bin/env bash
set -euo pipefail

# ═══════════════════════════════════════════════════════════════════════
# Compendiq Enterprise Build Script (Template)
#
# This script is a TEMPLATE that lives in the public CE repository.
# The private compendiq-enterprise repo uses this as a reference for
# its CI/CD pipeline.
#
# The enterprise build process:
#
#   1. CE code is included as a git submodule in the EE repo
#   2. EE overlay files mirror CE structure and add enterprise code
#   3. This script merges CE + overlay into a single source tree
#   4. TypeScript is compiled to JavaScript
#   5. javascript-obfuscator runs on enterprise-specific JS files (Layer 2)
#   6. Docker multi-stage build ships only compiled+obfuscated JS (Layer 3)
#
# Protection layers:
#   Layer 1: Proprietary (All Rights Reserved) license on EE source (legal)
#   Layer 2: javascript-obfuscator on enterprise JS after tsc
#   Layer 3: Multi-stage Dockerfile — no .ts, .map, or test files
#
# Prerequisites:
#   - Node.js 24+
#   - npm with access to @compendiq scope on GitHub Packages
#   - javascript-obfuscator (npm install -g javascript-obfuscator)
#   - Docker (for the final image build)
#
# Usage:
#   ./scripts/build-enterprise.sh
#
# Environment variables:
#   GITHUB_TOKEN    — GitHub PAT with packages:read scope (required)
#   SKIP_OBFUSCATE  — Set to "true" to skip obfuscation (dev builds)
#   IMAGE_TAG       — Docker image tag (default: "latest")
#
# ═══════════════════════════════════════════════════════════════════════

echo "=== Compendiq Enterprise Build ==="
echo ""
echo "This is a template script in the CE repository."
echo "The actual build is performed by the EE repo's CI pipeline."
echo ""
echo "See docs/ENTERPRISE-ARCHITECTURE.md for the full build process."
echo "See docker/Dockerfile.enterprise for the multi-stage Docker build."
echo ""
echo "To build the enterprise Docker image manually:"
echo ""
echo "  docker build -f docker/Dockerfile.enterprise \\"
echo "    --build-arg GITHUB_TOKEN=\$GITHUB_TOKEN \\"
echo "    -t compendiq-enterprise:\${IMAGE_TAG:-latest} ."
echo ""

# ─── Overlay Merge Process (reference implementation) ───────────────
#
# The EE repo structure:
#
#   compendiq-enterprise/
#   ├── ce/                     ← git submodule (this repo)
#   ├── overlay/
#   │   ├── backend/src/
#   │   │   └── enterprise/     ← EE-only backend code
#   │   └── frontend/src/
#   │       └── enterprise/     ← EE-only frontend code
#   ├── scripts/
#   │   └── build.sh            ← Real build script (not this template)
#   └── package.json
#
# Merge steps:
#   1. Copy ce/ to build/
#   2. Copy overlay/ on top (overlay files take precedence)
#   3. Install @compendiq/enterprise from GitHub Packages
#   4. Run tsc
#   5. Obfuscate enterprise dirs
#   6. Build Docker image
#
# ═══════════════════════════════════════════════════════════════════════

exit 0
