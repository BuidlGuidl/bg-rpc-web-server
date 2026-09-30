// Logs page: asks the logs service for one page of each table (filtered and paged there) and
// colours rows by the errorClass it returns. Run: node test/logsPage.test.js
const assert = require('assert');
const axios = require('axios');
const { logItemsPerPage } = require('../config');

const calls = [];
const row = (i, errorClass) => ({ timestamp: `t${i}`, requester: 'https://app.example', ip: '203.0.113.7', method: 'eth_call',
  params: '{}', elapsed: i, status: errorClass === 'ok' ? 'success' : 'x', errorClass });
axios.get = async (url, config) => {
  calls.push({ path: new URL(url).pathname, ...config.params });
  if (url.endsWith('/poolCompareResults')) return { data: { total: 0, entries: [] } };
  return { data: { total: 95, entries: [row(1, 'error'), row(2, 'warning'), row(3, 'caller'), row(4, 'ok')] } };
};
const handler = require('../routes/logs').stack.find((l) => l.route && l.route.path === '/logs').route.stack[0].handle;
const get = (query) => new Promise((resolve) => {
  const res = { statusCode: 200, setHeader() {}, status(c) { this.statusCode = c; return this; },
    send(body) { resolve({ status: this.statusCode, body }); }, json(o) { resolve({ status: this.statusCode, body: o }); } };
  handler({ query }, res);
});

(async () => {
  // ---- full page: one page of each of the five tables, same page and filter
  let r = await get({ page: '2', filter: 'warning' });
  assert.deepStrictEqual(calls.map((c) => c.path).sort(),
    ['/cacheRequests', '/fallbackRequests', '/poolCompareResults', '/poolNodes', '/poolRequests']);
  assert.ok(calls.every((c) => c.page === 2 && c.limit === logItemsPerPage && c.filter === 'warning'));
  assert.ok(r.body.includes('Pool Request Logs (95 total entries)'), 'heading shows the filtered total');
  assert.ok(r.body.includes(`changePage('poolLogs', ${Math.ceil(95 / logItemsPerPage)})`), 'pagination from total');
  const pool = r.body.slice(r.body.indexOf('id="poolLogs-body"'));
  assert.deepStrictEqual([...pool.slice(0, pool.indexOf('</tbody>')).matchAll(/<tr( class="(\w+)")?>/g)].map((m) => m[2] || ''),
    ['error', 'warning', '', ''], 'row colours from errorClass; a caller\'s mistake is plain');

  // ---- AJAX: only the table asked for
  calls.length = 0;
  r = await get({ page: '3', filter: 'no-client', tableId: 'poolNodeLogs' });
  assert.deepStrictEqual(calls, [{ path: '/poolNodes', page: 3, limit: logItemsPerPage, filter: 'no-client' }]);
  assert.ok(r.body.tbody.includes('<td>t1</td>') && typeof r.body.pagination === 'string');

  // ---- defaults and bad input
  calls.length = 0;
  await get({ page: '-4', filter: 'bogus', tableId: 'poolLogs' });
  assert.deepStrictEqual(calls, [{ path: '/poolRequests', page: 1, limit: logItemsPerPage, filter: 'all' }]);
  r = await get({ tableId: 'nope' });
  assert.strictEqual(r.status, 400);

  console.log('logsPage: all passed');
})().catch((e) => { console.error(e); process.exit(1); });
