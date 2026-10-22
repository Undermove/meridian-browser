# Meridian Workbench sandbox image: coding agents in a container that only sees the project folder.
#
# Built by Meridian on first use (tag meridian-sandbox:<hash of this file>), never pushed anywhere.
# The container runs as the unprivileged `node` user (uid 1000); the project is mounted at /workspace;
# there is no host home and no Docker socket inside. Credentials (only the vault secrets picked for the
# session, e.g. ANTHROPIC_API_KEY) arrive in a read-only file mounted at /run/meridian/env — not as
# container environment, so they don't show up in `docker inspect`. The entrypoint below exports them
# into the agent's environment and then runs the command.
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

# NAME=<base64 value> per line -> exported variables, then exec the command (tini is PID 1 via --init).
RUN cat > /usr/local/bin/meridian-entrypoint <<'EOF'
#!/bin/bash
f=/run/meridian/env
if [ -r "$f" ]; then
  while IFS= read -r line || [ -n "$line" ]; do
    n="${line%%=*}"; v="${line#*=}"
    [[ "$line" == *=* && "$n" =~ ^[A-Za-z_][A-Za-z0-9_]*$ ]] || continue
    val="$(printf '%s' "$v" | base64 -d 2>/dev/null; printf x)"
    export "$n=${val%x}"
  done < "$f"
fi
unset f line n v val
exec "$@"
EOF
RUN chmod 0755 /usr/local/bin/meridian-entrypoint

ENV HOME=/home/node \
    TERM=xterm-256color \
    COLORTERM=truecolor \
    DISABLE_AUTOUPDATER=1 \
    MERIDIAN_SANDBOX=1

USER node
WORKDIR /workspace
ENTRYPOINT ["/usr/local/bin/meridian-entrypoint"]
CMD ["bash", "-l"]
