# Meridian Workbench sandbox image: coding agents in a container that only sees the project folder.
#
# Built by Meridian on first use (tag meridian-sandbox:<hash of this file>), never pushed anywhere.
# The container runs as the unprivileged `node` user (uid 1000); the project is mounted at /workspace;
# there is no host home and no Docker socket inside. Credentials arrive only as environment variables
# from the Meridian vault (ANTHROPIC_API_KEY, OPENAI_API_KEY, …).
FROM node:22-bookworm-slim

ARG CLAUDE_CODE_VERSION=latest
ARG CODEX_VERSION=latest

RUN apt-get update \
 && apt-get install -y --no-install-recommends git ripgrep ca-certificates curl less procps openssh-client jq python3 \
 && rm -rf /var/lib/apt/lists/*

# Official npm packages of the two agent CLIs.
RUN npm install -g "@anthropic-ai/claude-code@${CLAUDE_CODE_VERSION}" "@openai/codex@${CODEX_VERSION}" \
 && npm cache clean --force

# A writable home for the agent's own config (kept in a per-project Docker volume, not on the host).
RUN mkdir -p /workspace /home/node/.claude /home/node/.codex && chown -R node:node /workspace /home/node

ENV HOME=/home/node \
    TERM=xterm-256color \
    COLORTERM=truecolor \
    DISABLE_AUTOUPDATER=1 \
    MERIDIAN_SANDBOX=1

USER node
WORKDIR /workspace
CMD ["bash", "-l"]
