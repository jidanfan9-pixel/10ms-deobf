function decodeNumericEscapes(str) {
  return str
    .replace(/\\([0-9]{1,3})/g, (_, n) => {
      const code = parseInt(n, 10);
      if (code >= 0 && code <= 255) return String.fromCharCode(code);
      return _;
    })
    .replace(/\\x([0-9a-fA-F]{2})/g, (_, h) => String.fromCharCode(parseInt(h, 16)));
}

function removeCommonWrappers(code) {
  let cleaned = code.trim();
  const wrapperMatch = cleaned.match(/^return\s*\(\s*function\s*\([^)]*\)\s*(.*)\s*end\s*\)\s*\([^)]*\)\s*;?\s*$/s);
  if (wrapperMatch) cleaned = wrapperMatch[1].trim();
  cleaned = cleaned.replace(/^--[[\s\S]*?]]\s*/m, '');
  cleaned = cleaned.replace(/^--\s*v[\d.]+\s*https?:\/\/[^\n]+\n?/m, '');
  return cleaned;
}

function extractStringTableHint(code) {
  const tableMatch = code.match(/local\s+([A-Za-z_][A-Za-z0-9_]*)\s*=\s*\{([\s\S]*?)\}/);
  if (!tableMatch) return null;
  const tableName = tableMatch[1];
  const content = tableMatch[2];
  const strings = [];
  const strRegex = /"((?:\\.|[^"\\])*)"|'((?:\\.|[^'\\])*)'/g;
  let m;
  while ((m = strRegex.exec(content)) !== null) {
    const raw = m[1] !== undefined ? m[1] : m[2];
    strings.push(decodeNumericEscapes(raw));
  }
  if (strings.length === 0) return null;
  return { tableName, count: strings.length, samples: strings.slice(0, 8) };
}

function basicCleanup(code) {
  let out = code
    .replace(/\r\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/\s+;\s*/g, ';\n')
    .trim();
  out = out
    .replace(/\bend\b/g, 'end\n')
    .replace(/\bthen\b/g, 'then\n')
    .replace(/\bdo\b/g, 'do\n');
  return out;
}

function deobfuscate(obfuscatedCode) {
  if (!obfuscatedCode || typeof obfuscatedCode !== 'string') {
    return { success: false, deobfuscated: '', message: '请提供有效的 Lua 代码字符串' };
  }
  try {
    let code = obfuscatedCode;
    code = decodeNumericEscapes(code);
    code = removeCommonWrappers(code);
    const tableHint = extractStringTableHint(code);
    code = basicCleanup(code);

    const result = {
      success: true,
      deobfuscated: code,
      message: '最简 Prometheus 去混淆完成（转义解码 + 包装清理 + 基础美化）'
    };
    if (tableHint) {
      result.hints = {
        stringTable: tableHint,
        note: '检测到可能的字符串表，完整解密需要 PRNG 还原（后续版本加强）'
      };
    }
    return result;
  } catch (err) {
    return { success: false, deobfuscated: '', message: '处理出错: ' + (err.message || String(err)) };
  }
}

module.exports = { deobfuscate };