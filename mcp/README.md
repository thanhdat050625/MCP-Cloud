# MCP-Cloud Gateway

Stateless, multi-tenant Model Context Protocol (MCP) Gateway designed for high-efficiency deployment on Render Free Tier.

## Architecture

This single repository serves as the central hub for hosting heavy/custom MCP services in the cloud:
- **`postgres`**: Query PostgreSQL databases (TaxiAI & Restaurant) statelessly via client headers.
- **`rabbitmq`**: RabbitMQ management queue inspector via client headers.
- **`plantuml`**: Serverless PlantUML diagram generator.

All credentials (connection strings, tokens, passwords) are supplied dynamically by client HTTP headers (`mcp_config.json`) and are **never stored** on the server.

## Deploying to Render

1. Create a new **Web Service** on Render pointing to this repository.
2. Build Command: `npm install`
3. Start Command: `node server.js`
4. Set Environment Variables:
   - `PORT`: `10000`
   - `GATEWAY_SECRET`: `<your_secret_gateway_key>`
   - `ENABLED_MCPS`: `postgres,rabbitmq,plantuml` (or select individual tools per cluster)

## Endpoints

- `GET /health`: Health check and keepalive endpoint for UptimeRobot.
- `GET /mcp/postgres/sse`: SSE stream for PostgreSQL MCP.
- `GET /mcp/rabbitmq/sse`: SSE stream for RabbitMQ MCP.
- `GET /mcp/plantuml/sse`: SSE stream for PlantUML MCP.
- `POST /mcp/:tool/messages?sessionId=:id`: JSON-RPC message endpoint.
