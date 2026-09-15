const express = require('express');
const cors = require('cors');
const path = require('path');
const { deobfuscate } = require('./deobf');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json({ limit: '2mb' }));
app.use(express.text({ type: 'text/plain', limit: '2mb' }));

// 静态网页 Demo
app.use(express.static(path.join(__dirname, 'public')));

// 健康检查 / API 信息
app.get('/api', (req, res) => {
  res.json({
    name: '10ms-deobf',
    version: '1.0.0',
    description: 'Simple Prometheus Roblox Lua deobfuscator API',
    endpoints: {
      'POST /deobf': 'Body: { "code": "混淆的Lua代码" } 或纯文本',
      'GET /': '网页 Demo',
      'GET /api': '本信息'
    }
  });
});

// 核心 API
app.post('/deobf', (req, res) => {
  let code = '';
  if (typeof req.body === 'string') {
    code = req.body;
  } else if (req.body && typeof req.body.code === 'string') {
    code = req.body.code;
  } else {
    return res.status(400).json({
      success: false,
      message: '请提供 code 字段或纯文本 body'
    });
  }
  res.json(deobfuscate(code));
});

app.get('/deobf', (req, res) => {
  const code = req.query.code || '';
  if (!code) {
    return res.status(400).json({ success: false, message: '缺少 code 参数' });
  }
  res.json(deobfuscate(code));
});

app.listen(PORT, () => {
  console.log(`10ms-deobf API running on http://localhost:${PORT}`);
  console.log(`网页 Demo: http://localhost:${PORT}`);
});