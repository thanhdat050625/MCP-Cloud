import express from 'express';
import cors from 'cors';
import { spawn } from 'child_process';
import crypto from 'crypto';

const app = express();
app.use(cors());
app.use(express.json());

// 1. Kiểm tra bắt buộc biến môi trường PORT và GATEWAY_SECRET (Không dùng fallback)
const portEnv = process.env.PORT;
if (!portEnv) {
  console.error("FATAL: Missing required environment variable PORT");
  process.exit(1);
}
const PORT = parseInt(portEnv, 10);

const GATEWAY_SECRET = process.env.GATEWAY_SECRET;
if (!GATEWAY_SECRET) {
  console.error("FATAL: Missing required environment variable GATEWAY_SECRET");
  process.exit(1);
}

const rawEnabled = process.env.ENABLED_MCPS;
if (!rawEnabled) {
  console.error("FATAL: Missing required environment variable ENABLED_MCPS");
  process.exit(1);
}
const enabledList = rawEnabled.split(',').map((s) => s.trim().toLowerCase());

function isEnabled(toolName) {
  if (enabledList.includes('all')) {
    return true;
  }
  return enabledList.includes(toolName.toLowerCase());
}

// 2. Quản lý active sessions
const activeSessions = new Map();

// 3. Endpoint health check (Dùng cho UptimeRobot ping mỗi 5 phút chống sleep)
app.get('/health', (req, res) => {
  res.status(200).json({
    status: "OK",
    timestamp: new Date().toISOString(),
    enabled_mcps: enabledList,
    active_sessions: activeSessions.size
  });
});

// 4. Middleware xác thực Gateway Key (Bắt buộc chính xác, không dùng fallback)
app.use((req, res, next) => {
  if (req.path === '/health') {
    return next();
  }
  const key = req.headers['x-gateway-key'];
  if (!key || key !== GATEWAY_SECRET) {
    return res.status(401).json({ error: "Unauthorized: Invalid or missing x-gateway-key" });
  }
  next();
});

// 5. Cầu nối Stdio -> SSE 2 chiều chuẩn Model Context Protocol
function registerMcpTool(routePath, commandResolver) {
  // Chiều 1: Nhận kết nối SSE (Stream dữ liệu từ MCP server con về IDE)
  app.get(`${routePath}/sse`, (req, res) => {
    let config;
    try {
      config = commandResolver(req);
    } catch (err) {
      return res.status(400).json({ error: err.message });
    }

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    if (typeof res.flushHeaders === 'function') {
      res.flushHeaders();
    }

    const sessionId = crypto.randomUUID();

    // Khởi tạo tiến trình MCP con (gọi trực tiếp node ./node_modules/... siêu nhẹ)
    const child = spawn(config.command, config.args, {
      env: { ...process.env, ...config.env }
    });

    const sessionData = { child, res };
    activeSessions.set(sessionId, sessionData);

    // Heartbeat mỗi 20s (chống timeout 100s của Render proxy)
    const keepAliveTimer = setInterval(() => {
      res.write(': keepalive\n\n');
    }, 20000);

    // Gửi endpoint event chuẩn MCP specification
    res.write(`event: endpoint\ndata: ${routePath}/messages?sessionId=${sessionId}\n\n`);

    child.stdout.on('data', (chunk) => {
      const lines = chunk.toString().split('\n').filter(Boolean);
      for (const line of lines) {
        res.write(`event: message\ndata: ${line}\n\n`);
      }
    });

    child.stderr.on('data', (err) => {
      console.error(`[${routePath}] Child Error:`, err.toString());
    });

    req.on('close', () => {
      clearInterval(keepAliveTimer);
      activeSessions.delete(sessionId);
      child.kill();
    });
  });

  // Chiều 2: Nhận request JSON-RPC POST từ client và ghi vào stdin của tiến trình MCP
  app.post(`${routePath}/messages`, (req, res) => {
    const sessionId = req.query.sessionId;
    if (!sessionId) {
      return res.status(400).json({ error: "Missing required query parameter: sessionId" });
    }

    const session = activeSessions.get(sessionId);
    if (!session || !session.child) {
      return res.status(404).json({ error: "Session expired or not found" });
    }

    try {
      const message = JSON.stringify(req.body) + '\n';
      session.child.stdin.write(message);
      res.status(202).send("Accepted");
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });
}

// =========================================================================
// KHỞI TẠO 3 CÔNG CỤ THEO BIẾN ENABLED_MCPS
// =========================================================================

// 1. POSTGRES (Bắt buộc header x-postgres-url, không fallback)
if (isEnabled('postgres')) {
  registerMcpTool('/mcp/postgres', (req) => {
    const pgUrl = req.headers['x-postgres-url'];
    if (!pgUrl) {
      throw new Error("Missing required header: x-postgres-url");
    }
    return {
      command: 'node',
      args: ['./custom_mcps/postgres/index.js', pgUrl],
      env: { NODE_TLS_REJECT_UNAUTHORIZED: "0" }
    };
  });
  console.log("[Gateway] Registered tool: /mcp/postgres");
}

// 2. RABBITMQ (Bắt buộc đủ 5 headers, không fallback)
if (isEnabled('rabbitmq')) {
  registerMcpTool('/mcp/rabbitmq', (req) => {
    const host = req.headers['x-rmq-host'];
    const port = req.headers['x-rmq-port'];
    const user = req.headers['x-rmq-user'];
    const pass = req.headers['x-rmq-pass'];
    const proto = req.headers['x-rmq-proto'];

    if (!host || !port || !user || !pass || !proto) {
      throw new Error("Missing required RabbitMQ headers: x-rmq-host, x-rmq-port, x-rmq-user, x-rmq-pass, x-rmq-proto");
    }

    return {
      command: 'node',
      args: ['./node_modules/rabbitmq-mcp/dist/index.js'],
      env: {
        RABBITMQ_HOST: host,
        RABBITMQ_MANAGEMENT_PORT: port,
        RABBITMQ_PROTOCOL: proto,
        RABBITMQ_USERNAME: user,
        RABBITMQ_PASSWORD: pass
      }
    };
  });
  console.log("[Gateway] Registered tool: /mcp/rabbitmq");
}

// 3. PLANTUML (Không cần key bảo mật)
if (isEnabled('plantuml')) {
  registerMcpTool('/mcp/plantuml', () => {
    return {
      command: 'node',
      args: ['./node_modules/plantuml-mcp-server/dist/plantuml-mcp-server.js'],
      env: {}
    };
  });
  console.log("[Gateway] Registered tool: /mcp/plantuml");
}

app.listen(PORT, () => {
  console.log(`[MCP Gateway] Server listening on port ${PORT}`);
  console.log(`[MCP Gateway] Active tools: ${enabledList.join(', ')}`);
});
