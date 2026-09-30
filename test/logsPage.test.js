// Logs page: asks the logs service for one page of each table (filtered, searched and paged
// there), colours rows by the errorClass it returns, and escapes every log value it puts into
// the page. Run: node test/logsPage.test.js
const assert = require('assert');
const axios = require('axios');
const { logItemsPerPage } = require('../config');

const XSS = `<img src=x onerror=alert(1)>"'&`;
const calls = [];
const row = (i, errorClass) => ({ timestamp: `t${i}`, requester: 'https://app.example', ip: '203.0.113.7', method: 'eth_call',
  params: '{}', elapsed: i, status: errorClass === 'ok' ? 'success' : 'x', errorClass });
const compareRow = { timestamp: 't9', resultsMatch: false, mismatchedNode: XSS, mismatchedOwner: 'o', mismatchedResults: [XSS.repeat(10)],
  nodeId1: XSS, nodeResult1: { hash: XSS }, nodeId2: 'n2', nodeResult2: 'result:"0x1"', nodeId3: 'n3', nodeResult3: XSS, method: 'eth_call', params: XSS };
axios.get = async (url, config) => {
  const params = Object.fromEntries(Object.entries(config.params).filter(([, v]) => v !== undefined));
  calls.push({ path: new URL(url).pathname, ...params });
  if (url.endsWith('/poolCompareResults')) return { data: { total: 1, methods: ['eth_call'], entries: [compareRow] } };
  if (url.endsWith('/cacheRequests')) {
    return { data: { total: 1, methods: [XSS], entries: [{ ...row(5, 'error'), requester: XSS, params: XSS, status: XSS, method: XSS }] } };
  }
  return { data: { total: 95, methods: ['eth_blockNumber', 'eth_call'], entries: [row(1, 'error'), row(2, 'warning'), row(3, 'caller'), row(4, 'ok')] } };
};
const handler = require('../routes/logs').stack.find((l) => l.route && l.route.path === '/logs').route.stack[0].handle;
const get = (query) => new Promise((resolve) => {
  const res = { statusCode: 200, setHeader() {}, status(c) { this.statusCode = c; return this; },
    send(body) { resolve({ status: this.statusCode, body }); }, json(o) { resolve({ status: this.statusCode, body: o }); } };
  handler({ query }, res);
});
const unescapeHtml = (s) => s.replace(/&(amp|lt|gt|quot|#39);/g, (m, e) => ({ amp: '&', lt: '<', gt: '>', quot: '"', '#39': "'" })[e]);

(async () => {
  // ---- full page: one page of each of the five tables, same page, filter and search
  let r = await get({ page: '2', filter: 'warning' });
  assert.deepStrictEqual(calls.map((c) => c.path).sort(),
    ['/cacheRequests', '/fallbackRequests', '/poolCompareResults', '/poolNodes', '/poolRequests']);
  assert.ok(calls.every((c) => c.page === 2 && c.limit === logItemsPerPage && c.filter === 'warning' && !('method' in c) && !('q' in c)));
  assert.ok(r.body.includes('Pool Request Logs (<span id="poolLogs-total">95</span> total entries)'), 'heading shows the filtered total');
  assert.ok(r.body.includes(`changePage('poolLogs', ${Math.ceil(95 / logItemsPerPage)})`), 'pagination from total');
  const pool = r.body.slice(r.body.indexOf('id="poolLogs-body"'));
  assert.deepStrictEqual([...pool.slice(0, pool.indexOf('</tbody>')).matchAll(/<tr( class="(\w+)")?>/g)].map((m) => m[2] || ''),
    ['error', 'warning', '', ''], 'row colours from errorClass; a caller\'s mistake is plain');
  assert.ok(r.body.includes('<select id="poolLogs-method" onchange="searchLogs(\'poolLogs\')">'));
  assert.ok(r.body.includes('<option value="eth_blockNumber">eth_blockNumber</option>'), 'methods in the dropdown');
  assert.ok(r.body.includes('<input id="poolNodeLogs-q"'), 'node table has a search box');
  assert.ok(!r.body.includes('id="poolCompareResults-method"'), 'compare table: no search bar (its filters are hidden too)');

  // ---- the page script compiles
  const script = r.body.slice(r.body.indexOf('<script>') + 8, r.body.indexOf('</script>'));
  assert.doesNotThrow(() => new Function(script));

  // ---- escaping: nothing from a log entry becomes markup
  assert.ok(!r.body.includes('<img'), 'no injected tag anywhere');
  const esc = '&lt;img src=x onerror=alert(1)&gt;&quot;&#39;&amp;';
  const cache = r.body.slice(r.body.indexOf('id="cacheLogs-body"'), r.body.indexOf('id="cacheLogs-pagination"'));
  assert.strictEqual(cache.split(`<td>${esc}</td>`).length - 1, 4, 'status, origin, method and params shown as text');
  assert.ok(r.body.includes(`<option value="${esc}">${esc}</option>`), 'dropdown option escaped');
  const compare = r.body.slice(r.body.indexOf('id="poolCompareResults-body"'));
  assert.ok(compare.includes(`<span class="node-id">${esc}</span>`), 'node id escaped');
  assert.ok(compare.includes('<br>&quot;0x1&quot;</td>'), 'short result inline, escaped');
  // modal links: the attribute unescapes to showModal(<JSON literal>) of the exact value
  const links = [...compare.matchAll(/onclick="showModal\((.*?)\)">View (Object|Value)<\/a>/g)].map((m) => JSON.parse(unescapeHtml(m[1])));
  assert.deepStrictEqual(links, [{ hash: XSS }, XSS.repeat(10)]);
  assert.ok(compare.includes(`<td>${esc}</td>`), 'params escaped');
  assert.ok(compare.includes(`<br>${esc}</td>`), 'a short raw result escaped');

  // ---- AJAX: only the table asked for, with the search; count for the heading
  calls.length = 0;
  r = await get({ page: '3', filter: 'no-client', tableId: 'poolNodeLogs', method: 'eth_call', q: '  0xabc  ' });
  assert.deepStrictEqual(calls, [{ path: '/poolNodes', page: 3, limit: logItemsPerPage, filter: 'no-client', method: 'eth_call', q: '0xabc' }]);
  assert.ok(r.body.tbody.includes('<td>t1</td>') && typeof r.body.pagination === 'string');
  assert.strictEqual(r.body.total, 95);

  // ---- defaults and bad input
  calls.length = 0;
  await get({ page: '-4', filter: 'bogus', tableId: 'poolLogs', q: 'x'.repeat(500), method: ['a', 'b'] });
  assert.deepStrictEqual(calls, [{ path: '/poolRequests', page: 1, limit: logItemsPerPage, filter: 'all', q: 'x'.repeat(200) }]);
  r = await get({ tableId: 'nope' });
  assert.strictEqual(r.status, 400);

  console.log('logsPage: all passed');
})().catch((e) => { console.error(e); process.exit(1); });
