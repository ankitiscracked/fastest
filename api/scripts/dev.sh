#!/bin/bash

# Start Colima if not running
if ! docker info > /dev/null 2>&1; then
  echo "Starting Colima..."
  colima start --cpu 2 --memory 4
fi

# Stop Colima on exit
cleanup() {
  echo ""
  echo "Stopping Colima..."
  colima stop
}
trap cleanup EXIT

# Run wrangler dev
wrangler dev
