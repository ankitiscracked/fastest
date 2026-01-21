FROM e2bdev/code-interpreter:latest

USER root
RUN npm install -g opencode-ai
USER user
