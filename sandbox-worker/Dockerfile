# Cloudflare Sandbox container for running agent jobs
# IMPORTANT: Version must match @cloudflare/sandbox npm package version
FROM docker.io/cloudflare/sandbox:0.3.3

# Install OpenCode globally for agent execution
RUN npm install -g opencode

# The container server must be started for the SDK to work
CMD ["bun", "/container-server/dist/index.js"]
