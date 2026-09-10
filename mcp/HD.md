# CHIẾN LƯỢC TOÀN DIỆN: TRIỂN KHAI MCP-CLOUD TRÊN RENDER FREE
*(Stateless Gateway Hub - 1 Repo Duy Nhất - 3 MCP Tối Ưu - Tuyệt Đối Không Dùng Fallback Mặc Định)*

---

## I. TỔNG QUAN PHÂN BỔ HỆ THỐNG MCP SAU TỐI ƯU

Sau quá trình rà soát, toàn bộ hệ thống MCP của bạn được quy hoạch thành 3 nhóm tối ưu triệt để:

### 1. Nhóm Cloud Gốc Chính Chủ (Không tốn RAM, không cần deploy):
* **Cloudinary**: `https://asset-management.mcp.cloudinary.com/mcp`
* **Aiven**: `https://mcp.aiven.live/mcp` (Quản trị hạ tầng Kafka, OpenSearch, MySQL, Valkey)
* **Jira (Atlassian)**: `https://mcp.atlassian.com/v1/sse`
* **Render (3 tài khoản: dat, ngan, nganhang5742)**: `https://mcp.render.com/mcp` (22 tools chính chủ)

### 2. Nhóm Deploy Lên Render Free (Repo `MCP-Cloud`):
Chỉ còn đúng **3 công cụ** cần đưa lên Render:
1. **`postgres`**: Thực thi truy vấn SQL linh hoạt cho 2 database `taxiai` và `restaurant_db` (nhận connection string qua header).
2. **`rabbitmq`**: Quản lý hàng đợi CloudAMQP (nhận host/user/pass qua header).
3. **`plantuml`**: Sinh biểu đồ sơ đồ kiến trúc (siêu nhẹ ~30MB RAM).

### 3. Nhóm Giữ Local (Đặt `disabled: true`):
* **`mobile-mcp`**: Bắt buộc local do cắm cáp USB điều khiển Android/ADB.
* **`semgrep` & `snyk`**: Bắt buộc local để quét mã nguồn trên ổ cứng.
* **`cyber-mcp`**: Bộ công cụ test bảo mật API localhost.

---

## II. CẤU TRÚC DỰ ÁN `MCP-Cloud`

```text
MCP-Cloud/
├── custom_mcps/
│   └── postgres/
│       └── index.js                 <-- Mã nguồn query PostgreSQL (KHÔNG có node_modules)
├── .gitignore                       <-- Bỏ qua node_modules, .env, log, IDE configs
├── package.json                     <-- Hoist toàn bộ dependencies (express, cors, pg, rabbitmq, plantuml)
├── server.js                        <-- Gateway Hub chuẩn MCP SSE 2 chiều (Stateless, No Fallback)
├── README.md                        <-- Giới thiệu dự án
└── HD.md                            <-- Hướng dẫn chi tiết
```

---

## III. QUY TẮC BẢO MẬT & VẬN HÀNH GATEWAY

1. **Stateless 100%**:
   - Server Render **tuyệt đối không lưu connection string hay password**.
   - Mọi thông tin nhạy cảm được gửi từ máy cá nhân (`mcp_config.json`) qua HTTP Headers (`x-postgres-url`, `x-rmq-...`).
2. **Tuyệt đối không dùng Fallback (`||` hoặc `??`)**:
   - Mọi header và biến môi trường bắt buộc phải có mặt chính xác. Thiếu là trả về HTTP 400 hoặc báo lỗi ngay lập tức.
3. **Chống ngủ đông Render Free**:
   - Server có endpoint `/health`. Dùng **UptimeRobot** ping vào `https://<ten-service>.onrender.com/health` mỗi 5 phút/lần.
   - Có cơ chế heartbeat định kỳ mỗi 20s (`: keepalive\n\n`) chống ngắt kết nối SSE 100s của Render proxy.

---

## IV. CẤU HÌNH BIẾN MÔI TRƯỜNG TRÊN RENDER DASHBOARD

Khi tạo Web Service mới trên Render từ repo `MCP-Cloud`:
* **Name**: `mcp-cloud-gateway`
* **Runtime**: `Node`
* **Build Command**: `npm install`
* **Start Command**: `node server.js`
* **Environment Variables**:
  * `PORT`: `10000`
  * `GATEWAY_SECRET`: `<mật_khẩu_gateway_tự_đặt_của_bạn>`
  * `ENABLED_MCPS`: `postgres,rabbitmq,plantuml` (hoặc chọn lọc từng công cụ nếu chia nhiều server)

---

## V. CẤU HÌNH DƯỚI LOCAL (`c:\Users\admin\.gemini\config\mcp_config.json`)

```json
{
  "mcpServers": {
    // 1. Cloud Gốc Chính Chủ
    "cloudinary-asset-mgmt": {
      "serverUrl": "https://asset-management.mcp.cloudinary.com/mcp",
      "headers": {
        "cloudinary-url": "cloudinary://<API_KEY>:<API_SECRET>@<CLOUD_NAME>"
      }
    },
    "aiven": {
      "serverUrl": "https://mcp.aiven.live/mcp",
      "headers": {
        "Authorization": "Bearer <YOUR_AIVEN_TOKEN>"
      }
    },
    "jira": {
      "serverUrl": "https://mcp.atlassian.com/v1/sse",
      "headers": {
        "Authorization": "Bearer <YOUR_ATLASSIAN_TOKEN>"
      }
    },
    "render-dat": {
      "serverUrl": "https://mcp.render.com/mcp",
      "headers": {
        "Authorization": "Bearer <YOUR_RENDER_TOKEN_1>"
      }
    },
    "render-ngan": {
      "serverUrl": "https://mcp.render.com/mcp",
      "headers": {
        "Authorization": "Bearer <YOUR_RENDER_TOKEN_2>"
      }
    },
    "render-nganhang5742": {
      "serverUrl": "https://mcp.render.com/mcp",
      "headers": {
        "Authorization": "Bearer <YOUR_RENDER_TOKEN_3>"
      }
    },

    // 2. Gateway Render (Chỉ 3 tool postgres, rabbitmq, plantuml)
    "postgres_taxiai": {
      "serverUrl": "https://<your-render-service>.onrender.com/mcp/postgres/sse",
      "headers": {
        "x-gateway-key": "<mật_khẩu_gateway_của_bạn>",
        "x-postgres-url": "postgres://avnadmin:<YOUR_PASSWORD>@postgresql-datt32285.l.aivencloud.com:23906/taxiai?sslmode=require&connection_limit=1"
      }
    },
    "postgres_restaurant": {
      "serverUrl": "https://<your-render-service>.onrender.com/mcp/postgres/sse",
      "headers": {
        "x-gateway-key": "<mật_khẩu_gateway_của_bạn>",
        "x-postgres-url": "postgres://hcmute:<YOUR_PASSWORD>@postgresql-datt32285.l.aivencloud.com:23906/restaurant_db?sslmode=require&schema=public?connection_limit=1"
      }
    },
    "rabbitmq-cloud": {
      "serverUrl": "https://<your-render-service>.onrender.com/mcp/rabbitmq/sse",
      "headers": {
        "x-gateway-key": "<mật_khẩu_gateway_của_bạn>",
        "x-rmq-host": "armadillo.rmq.cloudamqp.com",
        "x-rmq-port": "443",
        "x-rmq-proto": "https",
        "x-rmq-user": "xeaemmeu",
        "x-rmq-pass": "<YOUR_RMQ_PASSWORD>"
      }
    },
    "plantuml": {
      "serverUrl": "https://<your-render-service>.onrender.com/mcp/plantuml/sse",
      "headers": {
        "x-gateway-key": "<mật_khẩu_gateway_của_bạn>"
      }
    },

    // 3. Local Offline Tools (Chỉ bật khi cần)
    "cyber-mcp": {
      "command": "node",
      "args": ["D:/MCP/CyberMCP/dist/index.js"],
      "disabled": true
    },
    "mobile-mcp": {
      "command": "npx",
      "args": ["-y", "@mobilenext/mobile-mcp"],
      "disabled": true,
      "env": {
        "ANDROID_HOME": "C:\\Users\\admin\\AppData\\Local\\Android\\Sdk"
      }
    },
    "semgrep": {
      "command": "semgrep",
      "args": ["mcp", "--transport", "stdio"],
      "disabled": true
    },
    "snyk": {
      "command": "npx",
      "args": ["-y", "snyk@latest", "mcp", "-t", "stdio"],
      "disabled": true,
      "env": {
        "SNYK_TOKEN": "<YOUR_SNYK_TOKEN>"
      }
    }
  }
}
```