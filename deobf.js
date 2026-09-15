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
    { name: 'WeAreDevs',   re: /wearedevs\.net\/obfuscator/i },
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
 *  ⑤ 高级混淆模式检测
 *  仅做静态分析，不执行输入代码。
 * ═══════════════════════════════════════════════ */
function detectAdvancedObfuscation(code) {
  const patterns = [];
  const add = (type, name, severity, confidence, desc, evidence) => {
    patterns.push({ type, name, severity, confidence, desc, evidence });
  };

  const numericOps = (code.match(/\b(?:tonumber|bit32\.(?:bxor|band|bnot)|math\.(?:floor|mod)|string\.byte)\s*\(/g) || []).length;
  const booleanOps = (code.match(/\b(?:true|false)\s*==?\s*[^\n;]+|\b(?:not|and|or)\s+(?:true|false)\b/g) || []).length;
  if (numericOps + booleanOps >= 3 || /(?:0x[\da-f]+|\d+\s*[+\-*%^]\s*\d+).*(?:true|false)/is.test(code)) {
    add('hybrid-literal', '混合字面量混淆', 'medium', 0.78,
      '数字、布尔值或位运算被拆分为不同表达式，疑似采用多策略隐藏常量',
      `numeric=${numericOps}, boolean=${booleanOps}`);
  }

  const gotoCount = (code.match(/\bgoto\s+[A-Za-z_]\w*|::[A-Za-z_]\w*::/g) || []).length;
  const labelCount = (code.match(/::[A-Za-z_]\w*::/g) || []).length;
  if (gotoCount >= 2 || (gotoCount && labelCount)) {
    add('dynamic-goto', '动态 GOTO 模式', 'high', 0.94,
      '检测到 goto/标签跳转，控制流可能被改造成非线性路径',
      `jumps=${gotoCount}, labels=${labelCount}`);
  }

  const integrityChecks = /debug\.getinfo|debug\.getlocal|debug\.getupvalue|rawget\s*\(|rawequal\s*\(|string\.dump|loadstring|load\s*\(/i.test(code);
  const hookChecks = /hookfunction|replaceclosure|checkcaller|iscclosure|newcclosure|getgc|cloneref/i.test(code);
  if (integrityChecks || hookChecks) {
    add('anti-tamper', '防篡改检查', 'high', 0.86,
      '检测到调试 API、函数完整性、环境或 Hook 检测逻辑，可能在修改后触发失效',
      [integrityChecks && 'integrity/debug', hookChecks && 'hook/environment'].filter(Boolean).join(', '));
  }

  const comments = (code.match(/--/g) || []).length;
  const locals = (code.match(/\blocal\s+[A-Za-z_]\w*/g) || []).length;
  const debugStrip = comments === 0 && locals === 0 && code.length > 300;
  if (debugStrip || /debug\.setlocal|debug\.setupvalue/i.test(code)) {
    add('metadata-stripping', '元数据剥离', 'medium', 0.72,
      '代码缺少注释或局部变量线索，可能已移除调试元数据与可读命名',
      `comments=${comments}, locals=${locals}`);
  }

  const stateVars = (code.match(/\b(?:state|step|idx|pc|instruction|_ENV)\s*=/gi) || []).length;
  const dispatch = /while\s+[^\n]*do[\s\S]{0,1200}(?:if|elseif|repeat)[\s\S]{0,1200}(?:state|step|pc|instruction)/i.test(code);
  if ((stateVars >= 2 && dispatch) || /while\s+true\s+do[\s\S]{0,800}(?:elseif|switch)/i.test(code)) {
    add('control-flow-flattening', '控制流平坦化', 'high', 0.88,
      '检测到状态变量驱动的 while/if 分发循环，疑似控制流平坦化',
      `stateAssignments=${stateVars}`);
  }

  const arrayLiteral = /(?:local\s+)?[A-Za-z_]\w*\s*=\s*\{[\s\S]{20,20000}\}/i.test(code);
  const encodedValues = (code.match(/(?:0x[\da-f]{2,}|\\x[\da-f]{2}|[A-Za-z0-9+/]{20,}={0,2})/gi) || []).length;
  if (arrayLiteral && encodedValues >= 2 && !/base64\s*=\s*\{[\s\S]*gsub/i.test(code)) {
    add('constant-array', '常量加密与数组化', 'high', 0.9,
      '检测到大型常量数组与编码值，运行时可能统一解密后再使用',
      `encodedValues=${encodedValues}`);
  }

  const vmNames = /\b(?:opcode|bytecode|instruction|dispatch|registers?|stack|vm|execute)\b/gi;
  const vmHits = (code.match(vmNames) || []).length;
  if (vmHits >= 5 && /while\s+/i.test(code) && /opcode|dispatch|table\.unpack|select\s*\(|setmetatable/i.test(code)) {
    add('vm-based-execution', '基于虚拟机的执行', 'critical', 0.91,
      '检测到 opcode/寄存器/栈/分发器等组合特征，疑似自定义 Lua VM',
      `vmKeywords=${vmHits}`);
  }

  const stringArray = /\{[\s\S]{40,}\}/.test(code) && /(?:string\.char|frombase64|base64|decode|decrypt|xor|gsub)/i.test(code);
  const base64Codec = /ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789\+\/[\s\S]{0,1800}(?:gsub|:find)\s*\(/.test(code)
    && /(?:%\s*2\^|2\^\s*[ife]|string\.char)/.test(code);
  if (base64Codec) {
    add('base64-codec', 'Base64 编解码器', 'low', 0.98,
      '检测到标准 Base64 字母表、位拆分循环和 gsub/char 组合；这是编码模块本身，不等同于恶意字符串解密',
      'alphabet + bit-loop + gsub/char');
  }
  const dynamicString = /string\.char\s*\([^)]*\)|table\.concat\s*\(|string\.gsub\s*\(/gi;
  const dynamicCount = (code.match(dynamicString) || []).length;
  if (!base64Codec && (stringArray || dynamicCount >= 3 || /(?:decrypt|decode)\s*=.*function/i.test(code))) {
    add('dynamic-string-decryption', '字符串加密与动态解密', 'high', 0.87,
      '检测到编码字符串数组及运行时解码/拼接逻辑，字符串可能只在执行期间还原',
      `dynamicStringCalls=${dynamicCount}`);
  }

  return patterns;
}

function analyzeVMControlFlow(code) {
  const comparisons = [...code.matchAll(/\b([A-Za-z_]\w*)\s*(?:==|~=|<=|>=|<|>)\s*(-?\d+)\b/g)];
  const frequency = new Map();
  for (const [, variable] of comparisons) frequency.set(variable, (frequency.get(variable) || 0) + 1);
  const stateVar = [...frequency.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] || null;
  if (!stateVar) return { detected: false, blocks: [], edges: [] };

  const candidates = comparisons.filter(([, variable]) => variable === stateVar);
  const states = [...new Set(candidates.map(([, , state]) => Number(state)))];
  const edges = [];
  const assignment = new RegExp(`\\b${escapeRegExp(stateVar)}\\s*=\\s*(-?\\d+)`, 'g');
  for (const match of code.matchAll(assignment)) {
    const next = Number(match[1]);
    const before = code.slice(Math.max(0, match.index - 180), match.index);
    const from = [...before.matchAll(new RegExp(`\\b${escapeRegExp(stateVar)}\\s*(?:==|~=|<=|>=|<|>)\\s*(-?\\d+)`, 'g'))].pop();
    edges.push({ from: from ? Number(from[1]) : null, to: next });
  }

  return {
    detected: comparisons.length >= 2 && states.length >= 2 && edges.length >= 1,
    stateVariable: stateVar,
    states: states.sort((a, b) => a - b),
    blocks: states.map(state => ({ state, condition: `${stateVar} == ${state}` })),
    edges: edges.slice(0, 100)
  };
}

function analyzeObfuscationLayers(source, output) {
  const count = (re, value) => (value.match(re) || []).length;
  const sourceStrings = count(/"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'/g, source);
  const outputStrings = count(/"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'/g, output);
  const numericExpressions = count(/\(?-?\d+\s*[+%*/-]\s*\(?-?\d+\)?/g, source);
  const encodedStrings = count(/(?:\\x[\da-f]{2}|\\\d{1,3}|[A-Za-z0-9+/]{24,}={0,2})/gi, source);
  const vmKeywords = count(/\b(?:opcode|bytecode|instruction|dispatch|registers?|stack|vm|execute)\b/gi, source);
  const dynamicCalls = count(/\b(?:loadstring|load|getfenv|setfenv|newproxy|setmetatable)\s*\(/gi, source);
  const hasPool = /local\s+[A-Za-z_]\w*\s*=\s*\{[\s\S]{80,}\}/.test(source);
  const hasDecoder = /(?:string\.char|string\.byte|string\.gsub|table\.concat|:find)\s*\(/.test(source);
  const hasStateMachine = /while\s+(?:true|[A-Za-z_]\w*)\s+do[\s\S]{0,1500}(?:if|elseif)[\s\S]{0,1500}(?:state|step|pc|instruction)/i.test(source);
  const layers = [
    { id: 'numeric-constants', name: '数字常量', detected: numericExpressions > 0, action: '已执行安全整数折叠', status: numericExpressions ? 'processed' : 'none' },
    { id: 'constant-pool', name: '常量池/字符表', detected: hasPool, action: '已提取候选表；动态索引保留', status: hasPool ? 'partial' : 'none' },
    { id: 'decoder-pipeline', name: '解码管线', detected: hasDecoder, action: '已识别 char/byte/gsub/concat 管线', status: hasDecoder ? 'partial' : 'none' },
    { id: 'vm-dispatch', name: 'VM 状态分发', detected: hasStateMachine || vmKeywords >= 5, action: '已提取静态状态信息；未执行 VM', status: (hasStateMachine || vmKeywords >= 5) ? 'partial' : 'none' },
    { id: 'dynamic-runtime', name: '运行时环境依赖', detected: dynamicCalls > 0, action: '需要运行时语义，保持原样', status: dynamicCalls ? 'blocked' : 'none' }
  ];
  const detected = layers.filter(layer => layer.detected);
  return {
    inputBytes: source.length, outputBytes: output.length,
    reducedBytes: Math.max(0, source.length - output.length),
    staticReductionPercent: source.length ? Number(((Math.max(0, source.length - output.length) / source.length) * 100).toFixed(1)) : 0,
    sourceStrings, outputStrings, encodedStrings, layers,
    detectedLayers: detected.length,
    processedLayers: detected.filter(layer => layer.status === 'processed').length,
    remainingLayers: detected.filter(layer => layer.status !== 'processed').map(layer => layer.name),
    nextSteps: layers.filter(layer => layer.status === 'partial' || layer.status === 'blocked').map(layer => layer.action)
  };
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

function foldNumericConstants(code) {
  let count = 0;
  const strings = [];
  const maskStrings = (value) => value.replace(/("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|\[=\[[\s\S]*?\]=\])/g, (literal) => {
    strings.push(literal);
    return `\u0000${strings.length - 1}\u0000`;
  });
  const restoreStrings = (value) => value.replace(/\u0000(\d+)\u0000/g, (_, index) => strings[Number(index)]);
  let out = maskStrings(code);
  const re = /(?<![\w.])\(?\s*(-?\d+)\s*\)?\s*([+%*/-])\s*\(?\s*(-?\d+)\s*\)?(?![\w.])/g;
  let previous;
  do {
    previous = out;
    out = out.replace(re, (full, left, op, right) => {
      const a = Number(left);
      const b = Number(right);
      let value;
      if (op === '+') value = a + b;
      else if (op === '-') value = a - b;
      else if (op === '*') value = a * b;
      else if (op === '/' && b !== 0) value = a / b;
      else if (op === '%' && b !== 0) value = a % b;
      else return full;
      if (!Number.isFinite(value) || !Number.isSafeInteger(value)) return full;
      count++;
      return String(value);
    });
  } while (out !== previous && count < 100000);
  return { code: restoreStrings(out), count };
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

    // ② 纯数字常量折叠：只计算安全整数，不执行变量或函数。
    {
      const r = foldNumericConstants(code);
      code = r.code;
      report.phases.push({ name: '数字常量折叠', changed: r.count });
    }

    // ② 加密检测（结构完整时执行）
    {
      const enc = detectEncryption(code);
      if (enc.length) report.hints.encryption = enc;
    }

    // ⑤ 高级混淆模式检测
    {
      const advanced = detectAdvancedObfuscation(code);
      if (advanced.length) report.hints.advanced = advanced;
      const vmFlow = analyzeVMControlFlow(code);
      if (vmFlow.detected) report.hints.vmControlFlow = vmFlow;
      report.phases.push({ name: '高级混淆模式检测', changed: advanced.length });
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
    report.progress = analyzeObfuscationLayers(source, code);

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

module.exports = { deobfuscate, decodeEscapes, formatLua, foldNumericConstants, detectAdvancedObfuscation, analyzeVMControlFlow, analyzeObfuscationLayers };
