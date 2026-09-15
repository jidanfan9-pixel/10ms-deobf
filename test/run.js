const assert = require('node:assert/strict');
const { deobfuscate, formatLua, detectAdvancedObfuscation } = require('../deobf');

const cases = [
  {
    name: 'decodes string.char and escapes',
    input: 'local x = string.char(72, 105) .. "\\x21"',
    expected: 'local x = "Hi!"'
  },
  {
    name: 'formats control blocks with one indentation level',
    input: 'if x then print("ok") end',
    expected: 'if x then\n  print("ok")\nend'
  },
  {
    name: 'strips wrappers',
    input: 'return (function() local x = 1 return x end)()',
    expected: 'local x = 1 return x'
  }
];

for (const test of cases) {
  const actual = test.name.startsWith('formats')
    ? formatLua(test.input)
    : deobfuscate(test.input).deobfuscated;
  assert.equal(actual, test.expected, test.name);
}

assert.equal(deobfuscate('').success, false);
const advanced = detectAdvancedObfuscation(`
  local constants = { "QWxhZGRpbjpvcGVuIHNlc2FtZQ==", "0xdeadbeef" }
  local state = 1
  while true do
    if state == 1 then goto next_step end
    state = state + 1
    ::next_step::
  end
  local x = string.char(65, 66)
  local vm = opcode + register + stack + instruction + dispatch
`);
for (const type of ['constant-array', 'dynamic-goto', 'dynamic-string-decryption', 'vm-based-execution']) {
  assert.ok(advanced.some(item => item.type === type), `detects ${type}`);
}
console.log(`Passed ${cases.length + 1} deobfuscator tests`);
