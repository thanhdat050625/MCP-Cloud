# MCP-Cloud & Proxy Monorepo

Dự án hạ tầng đám mây tích hợp triển khai trên Render Free Tier (Singapore Region), gồm 2 dịch vụ độc lập:

1. **`mcp/`**: **MCP Gateway Hub**
   - Triển khai trên: `https://mcp-cloud-gateway-thihuyen3827.onrender.com`
   - Tài khoản Render: `render-thihuyen3827`
   - Công nghệ: Node.js 20, Express, Streamable HTTP & SSE Transport.
   - Chức năng: Cầu nối điều phối các MCP Server (PostgreSQL, RabbitMQ, PlantUML).

2. **`proxy/`**: **Proxy Gateway Hub**
   - Triển khai trên: `https://tools-cloud-thongnguyenthanh286.onrender.com`
   - Tài khoản Render: `render-thongnguyenthanh286`
   - Công nghệ: Python 3.12 Slim (Docker), FastAPI, Headroom AI.
   - Chức năng: Quản lý các HTTP Proxy / Middleware nén ngữ cảnh (Context Compression) theo biến `ENABLED_PROXIES`, tối ưu hóa bộ nhớ 512MB RAM và chống memory leak.
