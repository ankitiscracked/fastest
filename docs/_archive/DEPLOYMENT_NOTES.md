# Deployment Notes: OpenCode Sandbox Fix

## Changes Made

### 1. **Dockerfile** (`api/Dockerfile`)
- ✅ Changed to multi-stage Docker build
- ✅ Copies official OpenCode binary from `ghcr.io/anomalyco/opencode:latest`
- ✅ Keeps npm wrapper script for compatibility

**Why this matters**: The npm package alone doesn't guarantee the platform-specific binary is installed in the Linux container. Using the official image guarantees we have the correct, pre-compiled binary.

### 2. **OpenCode Startup Logic** (`api/src/conversation.ts`)
- ✅ Added binary existence check before startup
- ✅ Improved health check validation (checks for HTML response)
- ✅ Added explicit hostname parameter (`127.0.0.1`)
- ✅ Added process inspection for debugging
- ✅ Enhanced error messages with logs and process status

**Why this matters**: Provides visibility into startup failures and validates the server is actually responding with content.

## Build Instructions

```bash
# Navigate to the API directory
cd api/

# Build the Docker image
docker build -t fastest-sandbox .

# Test locally (optional)
docker run --rm fastest-sandbox opencode --version
```

## Validation

After deployment, the sandbox should:
1. Successfully find and execute `opencode serve`
2. Start the OpenCode server on the assigned port
3. Respond with valid HTML at the `/doc` endpoint
4. Be accessible for API calls within 30 seconds

## Rollback

If issues occur, revert to the previous Dockerfile:
```bash
git checkout api/Dockerfile
```

## Monitoring

Monitor these logs for OpenCode startup issues:
- CloudFlare Worker logs: Check for "OpenCode serve failed to start" errors
- Container logs: `docker logs <container-id>`
- /tmp/opencode.log inside the container

The error message will now include:
- OpenCode version check output
- Full server startup logs
- Running process information

## Known Workaround (if needed)

If the multi-stage build doesn't work in your environment, use the `OPENCODE_URL` environment variable to point to an external OpenCode server. This is set in `api/src/conversation.ts` line 449.

### 3. **OpenCode Tools (Deploy)**

- Custom tools live in `api/opencode-tools` and are mounted into sandbox images at `/opt/fastest/opencode-tools`.
- Set `OPENCODE_TOOLS_DIR` to point OpenCode at that tools folder.
  - Local dev sets this automatically in `api/scripts/dev-server.ts`.
  - Sandbox images copy tools in `api/Dockerfile` and `api/e2b.Dockerfile`.
- The deploy tool requires explicit user approval:
  - The agent must ask the user to deploy first.
  - The tool only executes when called with `confirm: "approve"`.

## Next Steps

1. Commit these changes to your repository
2. Deploy the updated container
3. Monitor the first few OpenCode session startups for any issues
4. If successful, update CI/CD pipelines to use the new build process
