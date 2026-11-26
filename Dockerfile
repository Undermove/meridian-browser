# The Meridian MCP bridge on its own (for MCP directories such as Glama).
# It answers initialize and tools/list without a browser; tool calls then explain that
# Meridian has to be running on the same machine with AI agent access turned on.
FROM node:22-alpine@sha256:1314fb30ec37592d5845e5a160d522c0e680972aa534549940b8d73bde88481a
WORKDIR /app
# The MCP SDK at the versions in package-lock.json (npm ci checks their hashes).
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund
COPY mcp/meridian-mcp.js mcp/
COPY src/agent/tools.js src/agent/
ENV MERIDIAN_DATA_DIR=/data
ENTRYPOINT ["node", "mcp/meridian-mcp.js"]
