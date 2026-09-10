import express from 'express';
import cors from 'cors';
import { spawn, execSync } from 'child_process';
import crypto from 'crypto';
import fs from 'fs';

const app = express();

app.use(cors({
  origin: '*',
  methods: ['GET', 'POST', 'DELETE', 'OPTIONS'],
  allowedHeaders: [
    'Content-Type',
    'Authorization',
    'x-gateway-key',
    'x-gateway-secret',
    'x-postgres-url',
    'x-rmq-host',
    'x-rmq-port',
    'x-rmq-user',
    'x-rmq-pass',
    'x-rmq-proto',
    'mcp-session-id',
    'x-mcp-session-id'
  ],
  exposedHeaders: ['Mcp-Session-Id', 'Content-Type']
}));

app.use(express.json());

// Tự động nạp file .env ở local (Node 20+ built-in, không cần thư viện dotenv)
try {
  process.loadEnvFile();
} catch (e) {
  // Bỏ qua nếu chạy trên cloud (Render truyền qua Dashboard Environment Variables)
}

// 1. Kiểm tra bắt buộc biến môi trường PORT và GATEWAY_SECRET (Tuyệt đối không dùng fallback)
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

// Dọn dẹp session quá hạn không hoạt động sau 15 phút
setInterval(() => {
  const now = Date.now();
  for (const [id, session] of activeSessions.entries()) {
    if (!session.sseRes && (now - session.lastActivity > 15 * 60 * 1000)) {
      console.log(`[Gateway] Session ${id} expired due to inactivity. Terminating.`);
      try {
        session.child.kill();
      } catch (e) {
        // Bỏ qua lỗi tiến trình đã đóng
      }
      activeSessions.delete(id);
    }
  }
}, 60000);

function getProcessRssBytes(pid) {
  if (!pid) return 0;
  if (process.platform === 'linux') {
    try {
      const status = fs.readFileSync(`/proc/${pid}/status`, 'utf8');
      const match = status.match(/VmRSS:\s+(\d+)\s+kB/i);
      if (match) {
        return parseInt(match[1], 10) * 1024;
      }
    } catch (e) {
      return 0;
    }
  } else if (process.platform === 'win32') {
    try {
      const out = execSync(`powershell -NoProfile -Command (Get-Process -Id ${pid} -ErrorAction SilentlyContinue).WorkingSet64`, { timeout: 1000 }).toString().trim();
      const bytes = parseInt(out, 10);
      return isNaN(bytes) ? 0 : bytes;
    } catch (e) {
      return 0;
    }
  }
  return 0;
}

// 3. Endpoint health check & Memory Telemetry (UptimeRobot ping chống sleep)
app.get('/health', (req, res) => {
  const parentRssBytes = process.memoryUsage().rss;
  const parentRssMb = Math.round((parentRssBytes / (1024 * 1024)) * 100) / 100;

  let totalChildrenBytes = 0;
  const mcpsSummaryMb = {};
  const mcpsDetail = {};
  const sessionsDetail = [];

  for (const mcp of enabledList) {
    if (mcp !== 'all') {
      mcpsSummaryMb[mcp] = 0;
      mcpsDetail[mcp] = { sessions: 0, rss_mb: 0 };
    }
  }

  for (const [id, session] of activeSessions.entries()) {
    const tool = session.toolName || session.routePath.replace(/^\/mcp\//, '').trim();
    const pid = session.child ? session.child.pid : null;
    const rssBytes = pid ? getProcessRssBytes(pid) : 0;
    const rssMb = Math.round((rssBytes / (1024 * 1024)) * 100) / 100;
    totalChildrenBytes += rssBytes;

    if (!mcpsDetail[tool]) {
      mcpsDetail[tool] = { sessions: 0, rss_mb: 0 };
    }
    mcpsDetail[tool].sessions += 1;
    mcpsDetail[tool].rss_mb = Math.round((mcpsDetail[tool].rss_mb + rssMb) * 100) / 100;
    mcpsSummaryMb[tool] = mcpsDetail[tool].rss_mb;

    sessionsDetail.push({
      session_id: id,
      tool,
      pid,
      rss_mb: rssMb,
      uptime_seconds: Math.round((Date.now() - (session.startTime || session.lastActivity)) / 1000)
    });
  }

  const childrenRssMb = Math.round((totalChildrenBytes / (1024 * 1024)) * 100) / 100;
  const totalRssMb = Math.round((parentRssMb + childrenRssMb) * 100) / 100;

  res.status(200).json({
    status: "OK",
    timestamp: new Date().toISOString(),
    enabled_mcps: enabledList,
    active_sessions: activeSessions.size,
    memory: {
      parent_rss_mb: parentRssMb,
      mcps_rss_mb: mcpsSummaryMb,
      children_rss_mb: childrenRssMb,
      total_rss_mb: totalRssMb,
      mcps_detail: mcpsDetail
    },
    sessions: sessionsDetail
  });
});

// 4. Middleware xác thực Gateway Key (Không dùng fallback)
app.use((req, res, next) => {
  if (req.path === '/health') {
    return next();
  }

  let key = null;
  if (req.headers['x-gateway-key']) {
    key = req.headers['x-gateway-key'];
  } else if (req.headers['x-gateway-secret']) {
    key = req.headers['x-gateway-secret'];
  } else if (req.query.gateway_key) {
    key = req.query.gateway_key;
  }

  if (!key || key !== GATEWAY_SECRET) {
    return res.status(401).json({ error: "Unauthorized: Invalid or missing x-gateway-key" });
  }
  next();
});

// Trích xuất sessionId từ header hoặc query (Không dùng toán tử fallback)
function getSessionId(req) {
  if (req.headers['mcp-session-id']) {
    return req.headers['mcp-session-id'];
  }
  if (req.headers['x-mcp-session-id']) {
    return req.headers['x-mcp-session-id'];
  }
  if (req.query.sessionId) {
    return req.query.sessionId;
  }
  return null;
}

// Khởi tạo child process cho session
function createMcpChildSession(sessionId, routePath, commandResolver, req, isLegacy) {
  const config = commandResolver(req);

  const child = spawn(config.command, config.args, {
    env: { ...process.env, ...config.env }
  });

  const toolName = routePath.replace(/^\/mcp\//, '').trim();

  const session = {
    id: sessionId,
    routePath,
    toolName,
    child,
    startTime: Date.now(),
    pendingRequests: new Map(),
    sseRes: null,
    lastActivity: Date.now(),
    stdoutBuffer: '',
    isLegacy
  };

  child.stdout.on('data', (chunk) => {
    session.stdoutBuffer += chunk.toString('utf8');
    let newlineIdx;
    while ((newlineIdx = session.stdoutBuffer.indexOf('\n')) !== -1) {
      const line = session.stdoutBuffer.slice(0, newlineIdx).trim();
      session.stdoutBuffer = session.stdoutBuffer.slice(newlineIdx + 1);
      if (!line) {
        continue;
      }

      try {
        const msg = JSON.parse(line);
        if (!session.isLegacy && msg.id !== undefined && session.pendingRequests.has(msg.id)) {
          const pending = session.pendingRequests.get(msg.id);
          session.pendingRequests.delete(msg.id);
          clearTimeout(pending.timer);
          pending.resolve(msg);
        } else if (session.sseRes && !session.sseRes.writableEnded) {
          session.sseRes.write(`event: message\ndata: ${line}\n\n`);
        }
      } catch (e) {
        console.error(`[${routePath}] Stdout parse error:`, e.message, line);
      }
    }
  });

  child.stderr.on('data', (chunk) => {
    console.log(`[${routePath}] ${chunk.toString().trim()}`);
  });

  child.on('error', (err) => {
    console.error(`[${routePath}] Child error:`, err);
    for (const pending of session.pendingRequests.values()) {
      clearTimeout(pending.timer);
      pending.reject(err);
    }
    session.pendingRequests.clear();
    activeSessions.delete(sessionId);
  });

  child.on('exit', (code, sig) => {
    console.log(`[${routePath}] Child exited (code ${code}, sig ${sig})`);
    for (const pending of session.pendingRequests.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error(`MCP process exited before responding (code ${code})`));
    }
    session.pendingRequests.clear();
    activeSessions.delete(sessionId);
  });

  activeSessions.set(sessionId, session);
  return session;
}

// 5. Cầu nối HTTP POST (Streamable HTTP Transport)
function handlePost(routePath, commandResolver, req, res) {
  let sessionId = getSessionId(req);
  let session = null;

  if (sessionId) {
    session = activeSessions.get(sessionId);
    if (!session) {
      return res.status(404).json({ error: "Session not found or expired" });
    }
  }

  const body = req.body;
  if (!body) {
    return res.status(400).json({ error: "Missing request body" });
  }

  // 1. Khởi tạo session mới qua initialize
  if (body.method === 'initialize') {
    sessionId = crypto.randomUUID();
    try {
      session = createMcpChildSession(sessionId, routePath, commandResolver, req, false);
    } catch (err) {
      return res.status(400).json({ error: err.message });
    }
  }

  if (!session) {
    return res.status(400).json({ error: "Missing Mcp-Session-Id header or initialize request" });
  }

  session.lastActivity = Date.now();

  // 2. JSON-RPC Notifications (không có trường id)
  if (body.id === undefined) {
    try {
      session.child.stdin.write(JSON.stringify(body) + '\n');
      res.setHeader('Mcp-Session-Id', sessionId);
      res.setHeader('Access-Control-Expose-Headers', 'Mcp-Session-Id');
      return res.status(202).json({ status: "Accepted" });
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
  }

  // 3. JSON-RPC Requests (có trường id)
  const reqId = body.id;
  const promise = new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      session.pendingRequests.delete(reqId);
      reject(new Error("Request timeout waiting for child MCP process"));
    }, 30000);
    session.pendingRequests.set(reqId, { resolve, reject, timer });
  });

  try {
    session.child.stdin.write(JSON.stringify(body) + '\n');
  } catch (err) {
    session.pendingRequests.delete(reqId);
    return res.status(500).json({ error: err.message });
  }

  promise.then((responseObj) => {
    res.setHeader('Mcp-Session-Id', sessionId);
    res.setHeader('Access-Control-Expose-Headers', 'Mcp-Session-Id');
    return res.status(200).json(responseObj);
  }).catch((err) => {
    return res.status(500).json({ error: err.message });
  });
}

// 6. Cầu nối HTTP GET (Standalone SSE hoặc Legacy SSE)
function handleGet(routePath, commandResolver, req, res) {
  let sessionId = getSessionId(req);

  // Nhánh 1: Standalone SSE cho session đang chạy (Streamable HTTP)
  if (sessionId) {
    const session = activeSessions.get(sessionId);
    if (!session) {
      return res.status(404).json({ error: "Session not found or expired" });
    }

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('Mcp-Session-Id', sessionId);
    res.setHeader('Access-Control-Expose-Headers', 'Mcp-Session-Id');
    if (typeof res.flushHeaders === 'function') {
      res.flushHeaders();
    }

    session.sseRes = res;
    session.lastActivity = Date.now();

    const keepAliveTimer = setInterval(() => {
      if (!res.writableEnded) {
        res.write(': keepalive\n\n');
      }
    }, 20000);

    req.on('close', () => {
      clearInterval(keepAliveTimer);
      if (session.sseRes === res) {
        session.sseRes = null;
      }
    });
    return;
  }

  // Nhánh 2: Khởi tạo kết nối Legacy SSE chuẩn MCP 2024
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

  sessionId = crypto.randomUUID();
  let session;
  try {
    session = createMcpChildSession(sessionId, routePath, commandResolver, req, true);
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
  session.sseRes = res;

  const keepAliveTimer = setInterval(() => {
    if (!res.writableEnded) {
      res.write(': keepalive\n\n');
    }
  }, 20000);

  res.write(`event: endpoint\ndata: ${routePath}/messages?sessionId=${sessionId}\n\n`);

  req.on('close', () => {
    clearInterval(keepAliveTimer);
    activeSessions.delete(sessionId);
    try {
      session.child.kill();
    } catch (e) {
      // Bỏ qua lỗi tiến trình đã đóng
    }
  });
}

// 7. Cầu nối HTTP DELETE (Chấm dứt session)
function handleDelete(routePath, req, res) {
  const sessionId = getSessionId(req);
  if (!sessionId) {
    return res.status(400).json({ error: "Missing required session ID (Mcp-Session-Id header or query parameter)" });
  }

  const session = activeSessions.get(sessionId);
  if (!session) {
    return res.status(404).json({ error: "Session not found" });
  }

  try {
    session.child.kill();
  } catch (e) {
    // Bỏ qua lỗi tiến trình đã đóng
  }
  activeSessions.delete(sessionId);
  return res.status(200).json({ status: "Session terminated" });
}

// 8. Cầu nối POST messages cho Legacy SSE
function handleLegacyMessages(routePath, req, res) {
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
}

// Đăng ký toàn diện các giao thức (Streamable HTTP + SSE) cho một công cụ MCP
function registerMcpTool(routePath, commandResolver) {
  // Hỗ trợ cả /routePath và /routePath/sse
  const endpoints = [routePath, `${routePath}/sse`];

  for (const ep of endpoints) {
    app.post(ep, (req, res) => handlePost(routePath, commandResolver, req, res));
    app.get(ep, (req, res) => handleGet(routePath, commandResolver, req, res));
    app.delete(ep, (req, res) => handleDelete(routePath, req, res));
  }

  // Legacy SSE message endpoint
  app.post(`${routePath}/messages`, (req, res) => handleLegacyMessages(routePath, req, res));
}

// =========================================================================
// KHỞI TẠO CÁC CÔNG CỤ THEO BIẾN ENABLED_MCPS
// =========================================================================

// 1. POSTGRES (Bắt buộc header x-postgres-url hoặc query db_url, không fallback)
if (isEnabled('postgres')) {
  registerMcpTool('/mcp/postgres', (req) => {
    let pgUrl = null;
    if (req.headers['x-postgres-url']) {
      pgUrl = req.headers['x-postgres-url'];
    } else if (req.query.db_url) {
      pgUrl = req.query.db_url;
    }

    if (!pgUrl) {
      throw new Error("Missing required PostgreSQL URL (header x-postgres-url or query parameter db_url)");
    }

    return {
      command: 'node',
      args: ['./custom_mcps/postgres/index.js', pgUrl],
      env: { NODE_TLS_REJECT_UNAUTHORIZED: "0" }
    };
  });
  console.log("[Gateway] Registered tool: /mcp/postgres");
}

// 2. RABBITMQ (Bắt buộc đủ 5 thông số kết nối, không fallback)
if (isEnabled('rabbitmq')) {
  registerMcpTool('/mcp/rabbitmq', (req) => {
    let host = null;
    let port = null;
    let user = null;
    let pass = null;
    let proto = null;

    if (req.headers['x-rmq-host']) {
      host = req.headers['x-rmq-host'];
    } else if (req.query.host) {
      host = req.query.host;
    }

    if (req.headers['x-rmq-port']) {
      port = req.headers['x-rmq-port'];
    } else if (req.query.port) {
      port = req.query.port;
    }

    if (req.headers['x-rmq-user']) {
      user = req.headers['x-rmq-user'];
    } else if (req.query.user) {
      user = req.query.user;
    }

    if (req.headers['x-rmq-pass']) {
      pass = req.headers['x-rmq-pass'];
    } else if (req.query.pass) {
      pass = req.query.pass;
    }

    if (req.headers['x-rmq-proto']) {
      proto = req.headers['x-rmq-proto'];
    } else if (req.query.proto) {
      proto = req.query.proto;
    }

    if (!host || !port || !user || !pass || !proto) {
      throw new Error("Missing required RabbitMQ parameters: host, port, user, pass, proto");
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

// 3. PLANTUML
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
