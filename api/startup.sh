#!/bin/bash

echo "[startup] Starting Cloudflare Sandbox container"

# OpenCode is installed via npm and started on-demand by the API
# (conversation.ts handles starting opencode serve on a dynamic port)

echo "[startup] Starting Cloudflare Sandbox control plane..."
exec bun /container-server/dist/index.js
