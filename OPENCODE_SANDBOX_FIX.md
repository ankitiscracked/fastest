# OpenCode Sandbox Linux Installation Fix

## Problem

The OpenCode `serve` command was failing to start in the CloudFlare Sandbox (Linux x64 environment) with the error:
```
OpenCode serve failed to start
```

## Root Cause

The `opencode-ai` npm package is a Node.js **wrapper script** that searches for platform-specific binaries at runtime:
- On macOS: looks for `opencode-darwin-arm64` or `opencode-darwin-x64`
- On Linux: looks for `opencode-linux-x64`
- On Windows: looks for `opencode-windows-x64.exe`

When `npm install -g opencode-ai@latest` was run in the Docker build (inside the Linux x64 container), npm's optional dependency resolution was not correctly installing the `opencode-linux-x64` binary. The wrapper script would then fail silently, and the `serve` command would never actually start.

This is a known issue with npm's optional dependency handling in Docker builds, especially under QEMU emulation on Apple Silicon.

## Solution

Use a **multi-stage Docker build** to copy the official OpenCode binary from the official OpenCode Docker image:

```dockerfile
# Copy OpenCode binary from official image
FROM ghcr.io/anomalyco/opencode:latest as opencode-builder

# Final stage: base sandbox + OpenCode binary
FROM base

COPY --from=opencode-builder /usr/local/bin/opencode /usr/local/bin/opencode
```

This approach:
1. ✅ Uses the officially-maintained OpenCode binary from Anomaly's Docker image
2. ✅ Avoids npm's optional dependency resolution issues entirely
3. ✅ Ensures the binary is properly compiled for Linux x64
4. ✅ No wrapper script overhead (binary is directly in PATH)
5. ✅ Smaller image size
6. ✅ Aligns with official OpenCode documentation

The npm wrapper script was not needed since we're directly invoking the binary that's already in `/usr/local/bin/opencode`.

## Dockerfile Alignment with CloudFlare Documentation

The updated Dockerfile aligns with [CloudFlare's official Sandbox documentation](https://developers.cloudflare.com/sandbox/configuration/dockerfile/):

✅ **Base image** with version matching: `docker.io/cloudflare/sandbox:0.7.0`  
✅ **Multi-stage build**: Minimal, clean approach  
✅ **CMD format**: Uses JSON array format `["bun", "/container-server/dist/index.js"]`  
✅ **Proper entrypoint**: Directly invokes the control plane server  
✅ **EXPOSE 3000**: Required for Wrangler container detection  

The key difference from the documentation's startup script example is that we use `CMD` directly instead of a shell script. This is equivalent and simpler, since we have no background services to start before the control plane.

## Enhanced Error Handling

Added diagnostic checks in `conversation.ts`:

- **Binary verification**: Checks if `opencode` exists and is executable before attempting to start
- **Better health checks**: Validates the HTTP response contains actual HTML (`<!DOCTYPE`) instead of just checking exit code
- **Process inspection**: Shows running processes if startup fails
- **Verbose logging**: Displays full server logs and process status for debugging

## Testing

To verify the fix works:

```bash
# Build the Docker image
docker build -t cloudflare-sandbox-opencode api/

# Run a test to verify OpenCode serves correctly
docker run --rm cloudflare-sandbox-opencode \
  opencode serve --port 4096 --hostname 127.0.0.1 &

sleep 3

# Check if it's responding
curl -s http://127.0.0.1:4096/doc | head -20
```

## Related Documentation

- [OpenCode Official Docs](https://opencode.ai/docs/)
- [OpenCode CLI Docs](https://opencode.ai/docs/cli/)
- [OpenCode Server API](https://opencode.ai/docs/server/)
- [OpenCode GitHub](https://github.com/anomalyco/opencode)
