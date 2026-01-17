# Cloudflare Sandbox container for running agent jobs
# IMPORTANT: Version must match @cloudflare/sandbox npm package version
FROM --platform=linux/amd64 docker.io/cloudflare/sandbox:0.3.3

# Install OpenCode via curl installer
RUN curl -fsSL https://opencode.ai/install | bash && \
    mv /root/.opencode/bin/opencode /usr/local/bin/opencode

# The container server must be started for the SDK to work
CMD ["bun", "/container-server/dist/index.js"]
