# Cloudflare Sandbox container for running agent jobs
# IMPORTANT: Version must match @cloudflare/sandbox npm package version
FROM docker.io/cloudflare/sandbox:0.7.0

# Wrangler container detection requires an explicit EXPOSE in this Dockerfile.
EXPOSE 3000

# NOTE: OpenCode is NOT installed in this image due to emulation issues on Apple Silicon.
# For local development, set OPENCODE_URL in .dev.vars to point to an external OpenCode server.
# For production, this runs on native x86-64 where OpenCode can be installed.

# Copy startup script
COPY startup.sh /workspace/startup.sh
RUN chmod +x /workspace/startup.sh

# Copy OpenCode tools into the sandbox image
COPY opencode-tools /opt/fastest/opencode-tools

# Start with the custom startup script
# The startup script must end with 'exec bun /container-server/dist/index.js'
# to properly replace the shell process and handle signals
CMD ["/workspace/startup.sh"]
