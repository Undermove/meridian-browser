# The Meridian MCP bridge on its own (for MCP directories such as Glama).
# It answers initialize and tools/list without a browser; tool calls then explain that
# Meridian has to be running on the same machine with AI agent access turned on.
FROM node:26-alpine@sha256:6bd9ab43c0ec0190ca7b2d193906cb8b7edf6e7f4afa43ddeccd6452710bffb5
WORKDIR /app
# The MCP SDK at the versions in package-lock.json (npm ci checks their hashes).
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund
COPY mcp/meridian-mcp.js mcp/
COPY src/agent/tools.js src/agent/
ENV MERIDIAN_DATA_DIR=/data
ENTRYPOINT ["node", "mcp/meridian-mcp.js"]
