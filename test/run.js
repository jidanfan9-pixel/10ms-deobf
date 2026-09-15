const assert = require('node:assert/strict');
const { deobfuscate, formatLua, foldNumericConstants, evaluateConstantNumber, foldConstantPools, simplifyLuaStructures, restoreStringChar, detectAdvancedObfuscation, analyzeVMControlFlow, analyzeVMDispatcher, buildSymbolicExecutionPlan, createTracePlan, compareKnownSource } = require('../deobf');
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
assert.equal(foldNumericConstants('local x = 426706428 % 4539430').code, 'local x =8');
assert.equal(foldNumericConstants('local x = -22027 - (-22028)').code, 'local x =1');
assert.equal(foldNumericConstants('local x = 1023818 + -1023773').code, 'local x =45');
assert.equal(foldNumericConstants('print("1+2")').code, 'print("1+2")');
assert.equal(evaluateConstantNumber('-22027-(-22028)'), 1);
const pool = foldConstantPools('local U = { "alpha", "beta", "gamma" }\nlocal function S(i) return U[i + 0] end\nprint(S(2))');
assert.equal(pool.code.includes('"beta"'), true);
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
assert.ok(base64.report.progress);
assert.equal(base64.report.progress.inputBytes, base64.report.inputBytes);
assert.ok(Array.isArray(base64.report.progress.remainingLayers));
const trace = createTracePlan('local x = string.char(65); return loadstring(x)');
assert.equal(trace.executable, false);
assert.deepEqual(trace.recommendedOrder, ['string-decoder', 'loadstring']);
const simplified = simplifyLuaStructures(`local t = { ["name"] = 1 }; print(t["name"]);
if false then print("dead") end`);
assert.equal(simplified.code.includes('t.name'), true);
assert.equal(simplified.code.includes('dead'), false);
assert.equal(compareKnownSource({ deobfuscated: 'print("78")' }, 'print("78")').matched, true);
assert.equal(compareKnownSource({ deobfuscated: 'print("79")' }, 'print("78")').matched, false);
const vm = analyzeVMDispatcher('local L=1 while L do ' + 'if L<1 then L=2 elseif L>2 then L=3 end '.repeat(6) + 'end ' + 'function() end '.repeat(5));
assert.equal(vm.detected, true);
assert.equal(vm.stateVariable, 'L');
assert.equal(restoreStringChar('return string.char(65+0, 66)').code, 'return "AB"');
const symbolic = buildSymbolicExecutionPlan('local L=1 while L do if L<2 then L=2 elseif L==2 then L=3 end end');
assert.equal(symbolic.executable, false);
assert.equal(symbolic.symbolicState, 'L');
console.log(`Passed ${cases.length + 1} deobfuscator tests`);
