/**
 * 10ms-deobf — 加强版 Lua 反混淆引擎
 * 面向 Roblox 平台：Prometheus / Luraph / MoonSec / IronBrew
 *
 * 能力概览：
 *   ① 全类型转义解码（\ddd \xHH \u{...} \uHHHH）
 *   ② 混淆器指纹识别
 *   ③ 多层包装器剥离（return (function()...end)()）
 *   ④ 加密逻辑检测（LCG / xorshift / bit32 / gsub 表）
 *   ⑤ 字符串表提取（含数字表）
 *   ⑥ string.char 还原（含 ["char"] 与别名追踪）
 *   ⑦ 字符串拼接折叠
 *   ⑧ 垃圾变量重命名
 *   ⑨ 基础格式化
 */

/* ═══════════════════════════════════════════════
 *  工具
 * ═══════════════════════════════════════════════ */
const escapeRegExp = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const LUA_KEYWORDS = new Set([
  'and', 'break', 'do', 'else', 'elseif', 'end', 'false', 'for', 'function',
  'if', 'in', 'local', 'nil', 'not', 'or', 'repeat', 'return', 'then',
  'true', 'until', 'while', 'goto'
]);

/* ═══════════════════════════════════════════════
 *  ① 转义解码
 * ═══════════════════════════════════════════════ */
function decodeEscapes(code) {
  const stats = { decimal: 0, hex: 0, unicode: 0, brace: 0 };
  let out = code;

  // Lua 常用短转义，放在数值转义之前，避免误伤已解码内容。
  const shortEscapes = { n: '\n', r: '\r', t: '\t', b: '\b', f: '\f', v: '\v', a: '\x07' };
  out = out.replace(/\\([nrtbfva\\"'])/g, (full, key) => {
    if (key === '\\' || key === '"' || key === "'") return key;
    return shortEscapes[key];
  });

  // \xHH
  out = out.replace(/\\x([0-9a-fA-F]{2})/g, (_, h) => {
    stats.hex++;
    return String.fromCharCode(parseInt(h, 16));
  });

  // \u{XXXX}
  out = out.replace(/\\u\{([0-9a-fA-F]+)\}/g, (_, h) => {
    stats.brace++;
    return String.fromCodePoint(parseInt(h, 16));
  });

  // \uXXXX
  out = out.replace(/\\u([0-9a-fA-F]{4})/g, (_, h) => {
    stats.unicode++;
    return String.fromCharCode(parseInt(h, 16));
  });

  // \ddd （十进制，≤255）
  out = out.replace(/\\(\d{1,3})/g, (full, d) => {
    const n = parseInt(d, 10);
    if (n <= 255) {
      stats.decimal++;
      return String.fromCharCode(n);
    }
    return full;
  });

  return { code: out, stats };
}

/* ═══════════════════════════════════════════════
 *  ② 混淆器指纹识别
 * ═══════════════════════════════════════════════ */
function detectObfuscator(code) {
  const signatures = [
    { name: 'Prometheus',  re: /prometheus|getfenv\s*\(\s*\)\s*\[|\(\s*function\s*\(\s*\)\s*return\s+getfenv/i },
    { name: 'Luraph',      re: /luraph|LPH_[0-9A-F]+/i },
    { name: 'MoonSec',     re: /moonsec|MBX_[0-9A-F]+/i },
    { name: 'IronBrew',    re: /ironbrew|IB2?_|IronBrew/i },
    { name: 'AztupBrew',   re: /aztupbrew|aztup/i },
    { name: 'Obfuscator.io (JS)', re: /_0x[0-9a-f]{4,}\s*=\s*\[/i }
  ];
  for (const { name, re } of signatures) {
    if (re.test(code)) return name;
  }
  return null;
}

/* ═══════════════════════════════════════════════
 *  ③ 注释剥离
 * ═══════════════════════════════════════════════ */
function stripComments(code) {
  // 长块注释 --[[ ... ]] / --[==[ ... ]==]
  let out = code.replace(/--\[(=*)\[[\s\S]*?\]\1\]/g, '');
  // 混淆器特征单行注释
  out = out.replace(
    /--[^\n]*(?:prometheus|obfuscator|luraph|moonsec|ironbrew|aztup|https?:\/\/|discord\.gg)[^\n]*/gi,
    ''
  );
  return out;
}

/* ═══════════════════════════════════════════════
 *  ④ 包装器剥离
 * ═══════════════════════════════════════════════ */
function stripWrappers(code) {
  let layers = 0;
  let out = code.trim();

  for (let i = 0; i < 10; i++) {
    const before = out;

    // return (function(args) BODY end)(args)
    out = out.replace(
      /^\s*return\s*\(\s*function\s*\([^)]*\)\s*([\s\S]*?)\s*end\s*\)\s*\([^)]*\)\s*;?\s*$/,
      (_, body) => { layers++; return body.trim(); }
    );

    // return function(args) BODY end
    out = out.replace(
      /^\s*return\s+function\s*\([^)]*\)\s*([\s\S]*?)\s*end\s*;?\s*$/,
      (_, body) => { layers++; return body.trim(); }
    );

    // do ... end
    out = out.replace(
      /^\s*do\s*([\s\S]*?)\s*end\s*;?\s*$/,
      (_, body) => { layers++; return body.trim(); }
    );

    // if true then ... end
    out = out.replace(
      /^\s*if\s+true\s+then\s*([\s\S]*?)\s*end\s*;?\s*$/,
      (_, body) => { layers++; return body.trim(); }
    );

    if (out === before) break;
  }

  return { code: out, layers };
}

/* ═══════════════════════════════════════════════
 *  ⑤ 加密逻辑检测
 * ═══════════════════════════════════════════════ */
function detectEncryption(code) {
  const findings = [];

  if (/math\s*\.\s*randomseed\s*\(/.test(code)) {
    findings.push({
      type: 'prng-math-random',
      desc: '检测到 math.randomseed，字符串可能由伪随机序列加密'
    });
  }

  const lcg = code.match(
    /\(\s*([A-Za-z_]\w*)\s*\*\s*(\d{4,})\s*\+\s*(\d+)\s*\)\s*%\s*(\d+)/
  );
  if (lcg) {
    findings.push({
      type: 'prng-lcg',
      desc: `LCG 模式: (${lcg[1]} * ${lcg[2]} + ${lcg[3]}) % ${lcg[4]}`,
      multiplier: lcg[2], increment: lcg[3], modulus: lcg[4]
    });
  }

  if (/bit32\s*\.\s*(?:bxor|band|bnot|rshift|lshift)\s*\(/.test(code)) {
    findings.push({
      type: 'bitwise-xor',
      desc: '检测到 bit32 位运算，可能用于 XOR 字符串解密'
    });
  }

  if (/string\s*\.\s*byte\s*\(/.test(code) && /[+\-]\s*\d+/.test(code)) {
    findings.push({
      type: 'byte-arithmetic',
      desc: '检测到 string.byte + 算术运算，可能为字符位移解密'
    });
  }

  if (/string\s*\.\s*gsub\s*\(/.test(code)) {
    findings.push({
      type: 'gsub-substitution',
      desc: '检测到 gsub，可能为逐字符替换解密'
    });
  }

  if (/\bgetfenv\s*\(/.test(code) && /\bsetfenv\s*\(/.test(code)) {
    findings.push({
      type: 'fenv-manipulation',
      desc: '检测到 getfenv/setfenv 沙箱操作，典型 VM 保护特征'
    });
  }

  return findings;
}

/* ═══════════════════════════════════════════════
 *  ⑥ 字符串表提取
 * ═══════════════════════════════════════════════ */
function decodeInPlace(s) {
  return s
    .replace(/\\(\d{1,3})/g, (full, d) => {
      const n = parseInt(d, 10);
      return n <= 255 ? String.fromCharCode(n) : full;
    })
    .replace(/\\x([0-9a-fA-F]{2})/g, (_, h) => String.fromCharCode(parseInt(h, 16)))
    .replace(/\\u\{([0-9a-fA-F]+)\}/g, (_, h) => String.fromCodePoint(parseInt(h, 16)));
}

function extractStringTables(code) {
  const tables = [];
  const tableRe = /local\s+([A-Za-z_]\w*)\s*=\s*\{([\s\S]{0,20000}?)\n?\}/g;
  let m;
  while ((m = tableRe.exec(code)) !== null) {
    const [, name, body] = m;

    const strings = [];
    const strRe = /"((?:\\.|[^"\\])*)"|'((?:\\.|[^'\\])*)'/g;
    let sm;
    while ((sm = strRe.exec(body)) !== null) {
      strings.push(sm[1] !== undefined ? sm[1] : sm[2]);
    }

    const nums = [];
    const numRe = /(?:^|[^\w.])(\d+)(?=\s*[,}])/g;
    let nm;
    while ((nm = numRe.exec(body)) !== null) nums.push(Number(nm[1]));

    if (strings.length >= 3) {
      tables.push({
        name, type: 'string-array', count: strings.length,
        samples: strings.slice(0, 8).map(decodeInPlace)
      });
    } else if (nums.length >= 8) {
      tables.push({
        name, type: 'number-array', count: nums.length,
        samples: nums.slice(0, 16)
      });
    }
  }
  return tables;
}

/* ═══════════════════════════════════════════════
 *  ⑦ string.char 还原（含别名追踪）
 * ═══════════════════════════════════════════════ */
function restoreStringChar(code) {
  let count = 0;

  // 收集别名：local sc = string.char
  const aliasNames = [];
  const aliasRe = /local\s+([A-Za-z_]\w*)\s*=\s*string\s*\.\s*char\b/g;
  let m;
  while ((m = aliasRe.exec(code)) !== null) aliasNames.push(m[1]);

  const patterns = [
    /\bstring\s*\.\s*char\s*\(([^()]*)\)/g,
    /\bstring\s*\[\s*["']char["']\s*\]\s*\(([^()]*)\)/g
  ];
  for (const alias of aliasNames) {
    patterns.push(new RegExp(`\\b${escapeRegExp(alias)}\\s*\\(([^()]*)\\)`, 'g'));
  }

  for (const re of patterns) {
    code = code.replace(re, (full, args) => {
      if (args.length > 4000) return full;
      const parts = args.split(',').map(s => s.trim()).filter(Boolean);
      if (!parts.length) return full;

      const codes = [];
      for (const p of parts) {
        const v = Number(p);
        if (!Number.isInteger(v) || v < 0 || v > 255) return full;
        codes.push(v);
      }
      count++;
      return JSON.stringify(String.fromCharCode(...codes));
    });
  }

  return { code, count };
}

/* ═══════════════════════════════════════════════
 *  ⑧ 字符串拼接折叠  "a" .. "b" -> "ab"
 * ═══════════════════════════════════════════════ */
function mergeStringConcat(code) {
  let count = 0;
  const re = /(["'])((?:\\.|(?!\1).)*)\1\s*\.\.\s*(["'])((?:\\.|(?!\3).)*)\3/g;

  let prev;
  do {
    prev = code;
    code = code.replace(re, (_, q1, a, __, b) => {
      count++;
      return q1 + a + b + q1;
    });
  } while (code !== prev);

  return { code, count };
}

/* ═══════════════════════════════════════════════
 *  ⑨ 垃圾变量重命名
 * ═══════════════════════════════════════════════ */
function renameJunkVars(code) {
  const re = /(?<![.\w:])(_0x[0-9a-fA-F]{3,}|[A-Za-z]{1,3}\d{4,})(?!\w)/g;
  const map = new Map();
  let counter = 0;

  const out = code.replace(re, (name) => {
    if (LUA_KEYWORDS.has(name)) return name;
    if (!map.has(name)) map.set(name, 'v' + (++counter));
    return map.get(name);
  });

  return { code: out, renamed: map.size };
}

/* ═══════════════════════════════════════════════
 *  ⑩ 基础格式化
 * ═══════════════════════════════════════════════ */
function formatLua(code) {
  let out = code.replace(/\r\n/g, '\n');
  out = out.replace(/[ \t]{2,}/g, ' ');
  out = out.replace(/[ \t]+\n/g, '\n');
  out = out.replace(/\n{3,}/g, '\n\n');

  // 语句边界断行
  out = out.replace(/\s*;\s*/g, ';\n');
  out = out.replace(/\bthen\s+/g, 'then\n');
  out = out.replace(/\bdo\s+/g, 'do\n');
  out = out.replace(/\bend\b/g, '\nend');
  out = out.replace(/\belse\b/g, '\nelse\n');
  out = out.replace(/\belseif\b/g, '\nelseif ');
  out = out.replace(/\n{2,}/g, '\n');

  // 缩进
  const lines = out.split('\n').map(l => l.trim()).filter(Boolean);
  const result = [];
  let indent = 0;

  for (const line of lines) {
    if (/^(end|else|elseif|until)\b/.test(line)) indent = Math.max(0, indent - 1);
    result.push('  '.repeat(indent) + line);

    const opens = (line.match(/\b(function|if|for|while|repeat)\b/g) || []).length;
    const ends = (line.match(/\bend\b/g) || []).length;
    const untils = (line.match(/\buntil\b/g) || []).length;
    indent = Math.max(0, indent + opens - ends - untils);

    if (/^(else|elseif)\b/.test(line)) indent++;
  }

  return result.join('\n').trim();
}

/* ═══════════════════════════════════════════════
 *  主流程
 * ═══════════════════════════════════════════════ */
function deobfuscate(source) {
  if (typeof source !== 'string' || !source.trim()) {
    return {
      success: false,
      deobfuscated: '',
      message: '请提供有效的 Lua 代码字符串'
    };
  }

  const report = {
    inputBytes: source.length,
    phases: [],
    warnings: [],
    hints: {}
  };

  try {
    let code = source;

    // 指纹识别
    const obfuscator = detectObfuscator(source);
    if (obfuscator) report.hints.obfuscator = obfuscator;

    // ① 转义解码
    {
      const r = decodeEscapes(code);
      code = r.code;
      const total = Object.values(r.stats).reduce((a, b) => a + b, 0);
      report.phases.push({ name: '转义解码', changed: total, detail: r.stats });
    }

    // ② 加密检测（结构完整时执行）
    {
      const enc = detectEncryption(code);
      if (enc.length) report.hints.encryption = enc;
    }

    // ③ 注释剥离
    {
      const before = code;
      code = stripComments(code);
      report.phases.push({ name: '注释剥离', changed: before.length - code.length });
    }

    // ④ 包装器剥离
    {
      const r = stripWrappers(code);
      code = r.code;
      report.phases.push({ name: '包装器剥离', changed: r.layers });
    }

    // ⑤ 字符串表提取
    {
      const tables = extractStringTables(code);
      if (tables.length) report.hints.stringTables = tables;
    }

    // ⑥ string.char 还原
    {
      const r = restoreStringChar(code);
      code = r.code;
      report.phases.push({ name: 'string.char 还原', changed: r.count });
    }

    // ⑦ 拼接折叠
    {
      const r = mergeStringConcat(code);
      code = r.code;
      report.phases.push({ name: '字符串拼接合并', changed: r.count });
    }

    // ⑧ 变量重命名
    {
      const r = renameJunkVars(code);
      code = r.code;
      report.phases.push({ name: '变量重命名', changed: r.renamed });
    }

    // ⑨ 格式化
    {
      const before = code;
      code = formatLua(code);
      report.phases.push({ name: '格式美化', changed: before !== code ? 1 : 0 });
    }

    report.outputBytes = code.length;

    // 生成总结
    const changedPhases = report.phases.filter(p => p.changed).map(p => p.name);
    const prefix = obfuscator ? `[${obfuscator}] ` : '';
    const message = changedPhases.length
      ? `${prefix}反混淆完成：${changedPhases.join(' · ')}`
      : `${prefix}未检测到可静态还原的混淆（可能使用 VM/PRNG 强加密）`;

    if (report.hints.encryption && report.hints.encryption.length) {
      report.warnings.push(
        '检测到加密逻辑：完整还原需要运行时执行或实现对应 PRNG/XOR 算法'
      );
    }

    return {
      success: true,
      deobfuscated: code,
      message,
      report,
      hints: report.hints
    };
  } catch (err) {
    return {
      success: false,
      deobfuscated: '',
      message: '处理出错: ' + (err && err.message ? err.message : String(err)),
      report
    };
  }
}

module.exports = { deobfuscate, decodeEscapes, formatLua };
