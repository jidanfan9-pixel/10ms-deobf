/**
 * 10ms-deobf API Server
 * 加强版：面向 Prometheus / Luraph / MoonSec / IronBrew 的 Lua 反混淆服务
 */

const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const { deobfuscate } = require('./deobf');

const app = express();
const PORT = process.env.PORT || 3000;
const HOST = process.env.HOST || '0.0.0.0';
const NODE_ENV = process.env.NODE_ENV || 'development';
const MAX_BODY = process.env.MAX_BODY || '5mb';

/* ═══════════════════════════════════════════════
 *  中间件
 * ═══════════════════════════════════════════════ */

// CORS — 允许网页 Demo 与第三方调用
app.use(cors({
  origin: '*',
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization']
}));

// Body 解析
app.use(express.json({ limit: MAX_BODY }));
app.use(express.text({ type: ['text/plain', 'text/*'], limit: MAX_BODY }));
app.use(express.urlencoded({ extended: true, limit: MAX_BODY }));

// 请求日志
app.use((req, res, next) => {
  const start = Date.now();
  const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress || '-';
  res.on('finish', () => {
    const ms = Date.now() - start;
    const size = res.get('Content-Length') || 0;
    console.log(
      `[${new Date().toISOString()}] ${req.method} ${req.originalUrl} ` +
      `${res.statusCode} ${ms}ms ${size}b — ${ip}`
    );
  });
  next();
});

// 简易速率限制（内存版，每分钟 60 次/IP）
const rateStore = new Map();
const RATE_LIMIT = 60;
const RATE_WINDOW = 60 * 1000;

function rateLimit(req, res, next) {
  const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress || 'unknown';
  const now = Date.now();
  const entry = rateStore.get(ip) || { count: 0, reset: now + RATE_WINDOW };

  if (now > entry.reset) {
    entry.count = 0;
    entry.reset = now + RATE_WINDOW;
  }

  entry.count++;
  rateStore.set(ip, entry);

  res.set('X-RateLimit-Limit', RATE_LIMIT);
  res.set('X-RateLimit-Remaining', Math.max(0, RATE_LIMIT - entry.count));
  res.set('X-RateLimit-Reset', Math.ceil(entry.reset / 1000));

  if (entry.count > RATE_LIMIT) {
    return res.status(429).json({
      success: false,
      message: `请求过于频繁，请稍后重试（每 ${RATE_WINDOW / 1000}s 最多 ${RATE_LIMIT} 次）`
    });
  }
  next();
}

// 定期清理速率表
setInterval(() => {
  const now = Date.now();
  for (const [ip, entry] of rateStore.entries()) {
    if (now > entry.reset) rateStore.delete(ip);
  }
}, RATE_WINDOW);

/* ═══════════════════════════════════════════════
 *  静态资源 & 网页 Demo
 * ═══════════════════════════════════════════════ */
const PUBLIC_DIR = path.join(__dirname, 'public');
if (fs.existsSync(PUBLIC_DIR)) {
  app.use(express.static(PUBLIC_DIR, {
    index: 'index.html',
    maxAge: NODE_ENV === 'production' ? '1h' : 0
  }));
} else {
  console.warn('⚠ public/ 目录不存在，跳过静态资源服务');
}

/* ═══════════════════════════════════════════════
 *  工具函数
 * ═══════════════════════════════════════════════ */
function extractCode(req) {
  // 1) JSON body: { code: "..." }
  if (req.body && typeof req.body === 'object' && typeof req.body.code === 'string') {
    return { code: req.body.code, opts: req.body.options || {} };
  }
  // 2) 纯文本 body
  if (typeof req.body === 'string' && req.body.length) {
    return { code: req.body, opts: {} };
  }
  // 3) Query: ?code=...
  if (req.query && typeof req.query.code === 'string') {
    return { code: req.query.code, opts: {} };
  }
  // 4) 自定义 header: X-Code: base64
  const b64 = req.get('X-Code-Base64');
  if (b64) {
    try {
      return { code: Buffer.from(b64, 'base64').toString('utf8'), opts: {} };
    } catch (_) { /* 忽略 */ }
  }
  return null;
}

function slimResult(result) {
  // 精简返回（去掉 report/hints 的详细阶段数据）
  return {
    success: result.success,
    deobfuscated: result.deobfuscated,
    message: result.message
  };
}

/* ═══════════════════════════════════════════════
 *  路由
 * ═══════════════════════════════════════════════ */

// ── 首页 / 健康检查 ────────────────────────────
app.get('/', (req, res) => {
  if (fs.existsSync(path.join(PUBLIC_DIR, 'index.html'))) {
    return res.sendFile(path.join(PUBLIC_DIR, 'index.html'));
  }
  res.json(apiInfo());
});

app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    uptime: process.uptime(),
    memory: process.memoryUsage().rss,
    version: require('./package.json').version,
    env: NODE_ENV
  });
});

// ── API 元信息 ─────────────────────────────────
function apiInfo() {
  return {
    name: '10ms-deobf',
    version: require('./package.json').version,
    description: 'Prometheus / Luraph / MoonSec / IronBrew Lua 反混淆 API',
    endpoints: {
      'GET  /'          : '网页 Demo',
      'GET  /api'       : '本信息',
      'GET  /health'    : '健康检查',
      'POST /deobf'     : '反混淆（JSON / text / form）',
      'GET  /deobf'     : '反混淆（?code=...）',
      'POST /deobf/slim': '仅返回精简结果',
      'POST /deobf/batch': '批量反混淆（最多 20 段）'
    },
    params: {
      code: 'Lua 源码字符串',
      options: {
        slim: 'boolean，true 时仅返回 deobfuscated/message'
      }
    },
    example: {
      curl: 'curl -X POST http://localhost:3000/deobf -H "Content-Type: application/json" -d \'{"code":"..."}\''
    }
  };
}

app.get('/api', (req, res) => res.json(apiInfo()));

// ── 核心：POST /deobf ─────────────────────────
app.post('/deobf', rateLimit, (req, res) => {
  const extracted = extractCode(req);

  if (!extracted || !extracted.code) {
    return res.status(400).json({
      success: false,
      message: '未提供代码。请使用 JSON { "code": "..." }、纯文本 body 或 ?code= 参数'
    });
  }

  if (extracted.code.length > 5_000_000) {
    return res.status(413).json({
      success: false,
      message: '代码过长（>5MB），请拆分后重试'
    });
  }

  try {
    const result = deobfuscate(extracted.code);

    // ?slim=1 或 body.options.slim 时精简返回
    const slim = req.query.slim === '1' || extracted.opts.slim === true;
    return res.json(slim ? slimResult(result) : result);
  } catch (err) {
    console.error('[/deobf] 处理异常:', err);
    return res.status(500).json({
      success: false,
      message: '服务器内部错误: ' + (err.message || String(err))
    });
  }
});

// ── GET /deobf ────────────────────────────────
app.get('/deobf', rateLimit, (req, res) => {
  const code = req.query.code || '';
  if (!code) {
    return res.status(400).json({ success: false, message: '缺少 code 参数' });
  }
  try {
    const result = deobfuscate(code);
    const slim = req.query.slim === '1';
    res.json(slim ? slimResult(result) : result);
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ── POST /deobf/slim ──────────────────────────
app.post('/deobf/slim', rateLimit, (req, res) => {
  const extracted = extractCode(req);
  if (!extracted || !extracted.code) {
    return res.status(400).json({ success: false, message: '未提供代码' });
  }
  try {
    res.json(slimResult(deobfuscate(extracted.code)));
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ── POST /deobf/batch ─────────────────────────
app.post('/deobf/batch', rateLimit, (req, res) => {
  const list = req.body && Array.isArray(req.body.items) ? req.body.items : null;
  if (!list) {
    return res.status(400).json({
      success: false,
      message: '需要 JSON body: { "items": ["code1", "code2", ...] }'
    });
  }
  if (list.length > 20) {
    return res.status(400).json({
      success: false,
      message: '单次最多 20 段代码'
    });
  }

  const results = list.map((item, i) => {
    if (typeof item !== 'string') {
      return { index: i, success: false, message: '非字符串项' };
    }
    try {
      const r = deobfuscate(item);
      return { index: i, ...slimResult(r) };
    } catch (err) {
      return { index: i, success: false, message: err.message };
    }
  });

  res.json({ success: true, count: results.length, results });
});

/* ═══════════════════════════════════════════════
 *  404 & 错误处理
 * ═══════════════════════════════════════════════ */
app.use((req, res) => {
  res.status(404).json({
    success: false,
    message: `未找到路由: ${req.method} ${req.originalUrl}`,
    hint: '访问 GET /api 查看可用接口'
  });
});

app.use((err, req, res, next) => {
  console.error('[ErrorHandler]', err);
  if (err.type === 'entity.too.large') {
    return res.status(413).json({ success: false, message: '请求体过大' });
  }
  if (err instanceof SyntaxError && 'body' in err) {
    return res.status(400).json({ success: false, message: 'JSON 解析失败: ' + err.message });
  }
  res.status(500).json({
    success: false,
    message: NODE_ENV === 'production' ? '服务器内部错误' : (err.message || String(err))
  });
});

/* ═══════════════════════════════════════════════
 *  启动
 * ═══════════════════════════════════════════════ */
const server = app.listen(PORT, HOST, () => {
  const url = `http://localhost:${PORT}`;
  console.log('──────────────────────────────────────────────');
  console.log('  10ms-deobf API 已启动');
  console.log('──────────────────────────────────────────────');
  console.log(`  环境      : ${NODE_ENV}`);
  console.log(`  监听      : ${HOST}:${PORT}`);
  console.log(`  网页 Demo : ${url}`);
  console.log(`  API 信息  : ${url}/api`);
  console.log(`  健康检查  : ${url}/health`);
  console.log('──────────────────────────────────────────────');
});

// 优雅关闭
function shutdown(signal) {
  console.log(`\n收到 ${signal}，正在关闭...`);
  server.close(() => {
    console.log('服务器已关闭');
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 5000).unref();
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT',  () => shutdown('SIGINT'));
process.on('unhandledRejection', (r) => console.error('未处理的 Promise 拒绝:', r));
process.on('uncaughtException',  (e) => console.error('未捕获异常:', e));