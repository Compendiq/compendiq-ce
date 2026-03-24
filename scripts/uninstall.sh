#!/usr/bin/env bash
# AtlasMind Uninstaller
# Usage: bash ~/atlasmind/uninstall.sh
# Custom install dir: INSTALL_DIR=~/mydir bash ~/mydir/uninstall.sh

set -euo pipefail

# ─── Colour helpers ───────────────────────────────────────────────────────────
if [ -t 1 ] && command -v tput >/dev/null 2>&1; then
  BOLD=$(tput bold 2>/dev/null || printf '')
  RED=$(tput setaf 1 2>/dev/null || printf '')
  GREEN=$(tput setaf 2 2>/dev/null || printf '')
  YELLOW=$(tput setaf 3 2>/dev/null || printf '')
  RESET=$(tput sgr0 2>/dev/null || printf '')
else
  BOLD='' RED='' GREEN='' YELLOW='' RESET=''
fi

info()    { printf '  %s%s\n' "$*" "${RESET}"; }
success() { printf '%s✓%s  %s\n' "${GREEN}" "${RESET}" "$*"; }
warn()    { printf '%s⚠%s  %s\n' "${YELLOW}" "${RESET}" "$*"; }
error()   { printf '%s✗%s  %s\n' "${RED}" "${RESET}" "$*" >&2; }

# ─── Configuration ────────────────────────────────────────────────────────────
INSTALL_DIR="${INSTALL_DIR:-$HOME/atlasmind}"

# ─── Sanity check ─────────────────────────────────────────────────────────────
if [ ! -f "${INSTALL_DIR}/docker-compose.yml" ]; then
  error "AtlasMind installation not found at: ${INSTALL_DIR}"
  error "Set INSTALL_DIR to the correct path and retry."
  exit 1
fi

# ─── Confirm ──────────────────────────────────────────────────────────────────
printf '\n%s%sAtlasMind Uninstaller%s\n\n' "${BOLD}" "${RED}" "${RESET}"
warn "This will STOP all AtlasMind containers and DELETE all data (including the database)."
warn "Install directory to remove: ${BOLD}${INSTALL_DIR}${RESET}"
printf '\n'
read -r -p "Type 'yes' to confirm: " CONFIRM
if [ "${CONFIRM}" != "yes" ]; then
  info "Uninstall cancelled."
  exit 0
fi

# ─── Stop and remove containers + volumes ─────────────────────────────────────
printf '\n'
info "Stopping containers and removing volumes..."
docker compose -f "${INSTALL_DIR}/docker-compose.yml" down -v 2>/dev/null || true
success "Containers and volumes removed"

# ─── Remove install directory ─────────────────────────────────────────────────
info "Removing install directory: ${INSTALL_DIR}"
rm -rf "${INSTALL_DIR}"
success "Install directory removed"

# ─── Done ─────────────────────────────────────────────────────────────────────
printf '\n'
success "AtlasMind has been uninstalled."
