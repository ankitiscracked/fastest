# Cloudflare Sandbox container for running agent jobs
# IMPORTANT: Version must match @cloudflare/sandbox npm package version
FROM --platform=linux/amd64 docker.io/cloudflare/sandbox:0.7.0 as base

# Wrangler container detection requires an explicit EXPOSE in this Dockerfile.
EXPOSE 3000

# Copy OpenCode binary from official image
# This avoids npm's optional dependency resolution issues in Docker builds
FROM ghcr.io/anomalyco/opencode:latest as opencode-builder

# Final stage: base sandbox + OpenCode binary
FROM base

COPY --from=opencode-builder /usr/local/bin/opencode /usr/local/bin/opencode

# Start the Cloudflare Sandbox container server
# The startup script must use 'exec' to replace the shell process
# without it, the container won't properly handle signals
CMD ["bun", "/container-server/dist/index.js"]
