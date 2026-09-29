// Logs page error classes. Run: node test/errorClass.test.js
const assert = require('assert');
const { classifyStatus } = require('../utils/errorClass');
const j = (code, message) => JSON.stringify({ jsonrpc: '2.0', error: { code, message }, id: 1 });
const b = (code, message) => JSON.stringify({ code, message }); // pool node log shape
for (const st of [j(-32000, 'nonce too low: next nonce 5, tx nonce 1'), j(-32003, 'EVM error: OutOfFunds'), b(-32001, 'block not found: 0x18e0873'),
  j(-32000, 'header not found'), b(3, 'execution reverted'), j(-32602, 'Invalid params'), j(-32005, 'capacity exhausted'), '-32601']) {
  assert.strictEqual(classifyStatus(st), 'caller', st);
}
for (const st of ['timeout_error', 'timeout_error_heavy', j(-69005, 'Node timed out'), j(-69000, 'No clients connected to pool'),
  b(4444, 'pruned history unavailable: requested 1, earliest available 15500000'), b(-32000, 'historical state abc is not available')]) {
  assert.strictEqual(classifyStatus(st), 'warning', st);
}
for (const st of ['socket_error', 'invalid_format', 'invalid_response', b(-70000, 'Internal node error'),
  j(-70000, 'Internal Proxy service error'), j(-70002, 'Invalid response from node'), 'garbage', JSON.stringify({ jsonrpc: '2.0' })]) {
  assert.strictEqual(classifyStatus(st), 'error', st);
}
assert.strictEqual(classifyStatus('success'), 'ok');
console.log('errorClass (web server): all passed');
