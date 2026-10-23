# The Meridian MCP bridge on its own (for MCP directories such as Glama).
# It answers initialize and tools/list without a browser; tool calls then explain that
# Meridian has to be running on the same machine with AI agent access turned on.
FROM node:22-alpine
WORKDIR /app
RUN npm init -y >/dev/null && npm install --omit=dev --no-audit --no-fund @modelcontextprotocol/sdk@1.32.1
COPY package.json ./meridian-package.json
COPY mcp/meridian-mcp.js mcp/
COPY src/agent/tools.js src/agent/
RUN sed -i "s#require('../package.json')#require('../meridian-package.json')#" mcp/meridian-mcp.js
ENV MERIDIAN_DATA_DIR=/data
ENTRYPOINT ["node", "mcp/meridian-mcp.js"]
