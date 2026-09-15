const assert = require('node:assert/strict');
const { deobfuscate, formatLua, foldNumericConstants, detectAdvancedObfuscation, analyzeVMControlFlow } = require('../deobf');
const fs = require('node:fs');

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
const plain = deobfuscate('print("78")');
assert.equal(plain.deobfuscated, 'print("78")');
assert.equal(plain.report.outputBytes, plain.report.inputBytes);
assert.equal(foldNumericConstants('local x = 426706428 % 4539430').code, 'local x = 8');
assert.equal(foldNumericConstants('print("1+2")').code, 'print("1+2")');
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
const flow = analyzeVMControlFlow('local state=1; if state == 1 then state=2 end; if state == 2 then state=3 end');
assert.equal(flow.detected, true);
assert.deepEqual(flow.states, [1, 2]);
const base64 = deobfuscate(fs.readFileSync(__dirname + '/base64-sample.lua', 'utf8'));
assert.equal(base64.report.inputBytes > base64.report.outputBytes, true);
assert.ok(base64.hints.advanced.some(item => item.type === 'base64-codec'));
assert.equal(base64.hints.advanced.some(item => item.type === 'dynamic-string-decryption'), false);
console.log(`Passed ${cases.length + 1} deobfuscator tests`);
