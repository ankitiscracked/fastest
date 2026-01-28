FROM e2bdev/code-interpreter:latest

USER root
RUN npm install -g opencode-ai
COPY opencode-tools /opt/fastest/opencode-tools
USER user
