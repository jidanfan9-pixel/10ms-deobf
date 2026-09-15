const assert = require('node:assert/strict');
const { deobfuscate, formatLua } = require('../deobf');

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
console.log(`Passed ${cases.length + 1} deobfuscator tests`);
