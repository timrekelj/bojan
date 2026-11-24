# Headless OpenCode V2 "agent" server that plans and builds features in the bojan repo.
# Node 22 (glibc) because the repo needs `npm ci`, `npm run build` and `npm run smoke`.
FROM node:22-bookworm-slim

ARG OPENCODE_VERSION=2.4.0

RUN apt-get update \
 && apt-get install -y --no-install-recommends git curl ca-certificates gnupg ripgrep openssh-client \
 && mkdir -p -m 755 /etc/apt/keyrings \
 && curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg -o /etc/apt/keyrings/githubcli-archive-keyring.gpg \
 && chmod go+r /etc/apt/keyrings/githubcli-archive-keyring.gpg \
 && echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" > /etc/apt/sources.list.d/github-cli.list \
 && apt-get update \
 && apt-get install -y --no-install-recommends gh \
 && rm -rf /var/lib/apt/lists/*

RUN npm install -g "@opencode/cli@${OPENCODE_VERSION}" --no-audit --no-fund \
 && npm cache clean --force \
 && opencode --version

# Non-root `node` user (uid 1000). Pre-create the volume mount points owned by it so
# fresh named volumes inherit the right ownership.
ENV HOME=/home/node \
    OPENCODE_DISABLE_AUTOUPDATE=1
RUN mkdir -p /workspace /home/node/.local/share/opencode /home/node/.config /home/node/.cache \
 && chown -R node:node /workspace /home/node

COPY --chmod=755 entrypoint.sh /usr/local/bin/entrypoint.sh

USER node
WORKDIR /workspace
VOLUME ["/workspace", "/home/node/.local/share/opencode"]
EXPOSE 4096
ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
