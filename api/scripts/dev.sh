#!/bin/bash

set -e

# Configuration
COLIMA_CPU=4
COLIMA_MEMORY=8

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

log_info() { echo -e "${GREEN}[INFO]${NC} $1"; }
log_warn() { echo -e "${YELLOW}[WARN]${NC} $1"; }
log_error() { echo -e "${RED}[ERROR]${NC} $1"; }

# Cleanup function
cleanup() {
  echo ""
  log_info "Shutting down..."

  # Stop any running sandbox containers
  if docker info > /dev/null 2>&1; then
    SANDBOX_CONTAINERS=$(docker ps -q --filter "ancestor=cloudflare-dev/sandbox" 2>/dev/null || true)
    if [ -n "$SANDBOX_CONTAINERS" ]; then
      log_info "Stopping sandbox containers..."
      echo "$SANDBOX_CONTAINERS" | xargs -r docker stop > /dev/null 2>&1 || true
      echo "$SANDBOX_CONTAINERS" | xargs -r docker rm > /dev/null 2>&1 || true
    fi
  fi

  # Stop Colima
  log_info "Stopping Colima..."
  colima stop 2>/dev/null || true

  log_info "Cleanup complete"
}

# Set trap for cleanup on exit
trap cleanup EXIT INT TERM

# Start Colima if not running
if ! docker info > /dev/null 2>&1; then
  log_info "Starting Colima with ${COLIMA_CPU} CPUs and ${COLIMA_MEMORY}GB RAM..."
  colima start --cpu "$COLIMA_CPU" --memory "$COLIMA_MEMORY"
else
  log_info "Docker is already running"

  # Check if resources are sufficient
  CURRENT_CPUS=$(docker info --format '{{.NCPU}}' 2>/dev/null || echo "0")
  CURRENT_MEM=$(docker info --format '{{.MemTotal}}' 2>/dev/null | awk '{printf "%.0f", $1/1024/1024/1024}' || echo "0")

  if [ "$CURRENT_CPUS" -lt "$COLIMA_CPU" ] || [ "$CURRENT_MEM" -lt "$COLIMA_MEMORY" ]; then
    log_warn "Current resources (${CURRENT_CPUS} CPUs, ${CURRENT_MEM}GB) below recommended (${COLIMA_CPU} CPUs, ${COLIMA_MEMORY}GB)"
    log_info "Restarting Colima with more resources..."
    colima stop 2>/dev/null || true
    colima start --cpu "$COLIMA_CPU" --memory "$COLIMA_MEMORY"
  fi
fi

# Clean up any stale sandbox containers from previous runs
log_info "Cleaning up stale containers..."
docker ps -aq --filter "ancestor=cloudflare-dev/sandbox" 2>/dev/null | xargs -r docker rm -f > /dev/null 2>&1 || true

# Verify Docker is ready
if ! docker info > /dev/null 2>&1; then
  log_error "Docker failed to start"
  exit 1
fi

log_info "Docker ready with $(docker info --format '{{.NCPU}}') CPUs and $(docker info --format '{{.MemTotal}}' | awk '{printf "%.1f", $1/1024/1024/1024}')GB RAM"

# Run wrangler dev
log_info "Starting wrangler dev server..."
wrangler dev
