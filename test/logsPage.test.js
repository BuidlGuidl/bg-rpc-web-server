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
// merged entries as the logs service serves them: status, params and errorClass from their cache line
const mergedRow = (value, errorClass, sameCaller) => ({ timestamp: 't7', epoch: '1791493451248', requester: value, ip: '203.0.113.7',
  method: 'eth_call', waitMs: 40, leaderEpoch: '1791493451227', gapMs: 21, sameCaller, status: value || '', params: value, errorClass });
const compareRow = { timestamp: 't9', resultsMatch: false, mismatchedNode: XSS, mismatchedOwner: 'o', mismatchedResults: [XSS.repeat(10)],
  nodeId1: XSS, nodeResult1: { hash: XSS }, nodeId2: 'n2', nodeResult2: 'result:"0x1"', nodeId3: 'n3', nodeResult3: XSS, method: 'eth_call', params: XSS };
axios.get = async (url, config) => {
  const params = Object.fromEntries(Object.entries(config.params).filter(([, v]) => v !== undefined));
  calls.push({ path: new URL(url).pathname, ...params });
  if (url.endsWith('/poolCompareResults')) return { data: { total: 1, methods: ['eth_call'], entries: [compareRow] } };
  if (url.endsWith('/mergedRequests')) return { data: { total: 2, methods: ['eth_call'], entries: [mergedRow(XSS, 'ok', true), mergedRow('', null, false)] } };
  if (url.endsWith('/cacheRequests')) {
    return { data: { total: 1, methods: [XSS], entries: [{ ...row(5, 'error'), requester: XSS, params: XSS, status: XSS, method: XSS }] } };
  }
  const revert = { ...row(3, 'caller'), status: JSON.stringify({ jsonrpc: '2.0', error: { code: 3, message: 'execution reverted: ERC20: transfer amount exceeds balance', data: '0x08c379a0' + 'ab'.repeat(100) }, id: 'rv-3' }) };
  const longParams = { ...row(4, 'ok'), params: '{"data":"0x82ad56cb' + 'cd'.repeat(300) + '","to":"0xca11bde05977b3631167028862be2a173976ca11"},0x18f0564' };
  return { data: { total: 95, methods: ['eth_blockNumber', 'eth_call'], entries: [row(1, 'error'), row(2, 'warning'), revert, longParams] } };
};
const handler = require('../routes/logs').stack.find((l) => l.route && l.route.path === '/logs').route.stack[0].handle;
const get = (query) => new Promise((resolve) => {
  const res = { statusCode: 200, setHeader() {}, status(c) { this.statusCode = c; return this; },
    send(body) { resolve({ status: this.statusCode, body }); }, json(o) { resolve({ status: this.statusCode, body: o }); } };
  handler({ query }, res);
});
const escapeHtmlForTest = (v) => String(v).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const same = (a, b, m) => assert.deepStrictEqual(JSON.parse(JSON.stringify(a)), JSON.parse(JSON.stringify(b)), m);
// The XSS test value as a params cell: longer than 20 characters, so its first 20, escaped, then … and View
const cutParamsCell = (value) => `<td>${escapeHtmlForTest(value.slice(0, 20))}… <a class="view-object-link"`;
const unescapeHtml = (s) => s.replace(/&(amp|lt|gt|quot|#39);/g, (m, e) => ({ amp: '&', lt: '<', gt: '>', quot: '"', '#39': "'" })[e]);

(async () => {
  // ---- full page: one page of each of the six tables, same page, filter and search
  let r = await get({ page: '2', filter: 'warning' });
  assert.deepStrictEqual(calls.map((c) => c.path).sort(),
    ['/cacheRequests', '/fallbackRequests', '/mergedRequests', '/poolCompareResults', '/poolNodes', '/poolRequests']);
  assert.ok(calls.every((c) => c.page === 2 && c.limit === logItemsPerPage && c.filter === 'warning' && !('method' in c) && !('q' in c)));
  assert.ok(r.body.includes('Pool Request Logs (<span id="poolLogs-total">95</span> total entries) <span class="title-emoji">🤿</span></h2>'), 'heading shows the filtered total');
  assert.ok(r.body.includes(`changePage('poolLogs', ${Math.ceil(95 / logItemsPerPage)})`), 'pagination from total');
  const pool = r.body.slice(r.body.indexOf('id="poolLogs-body"'));
  assert.deepStrictEqual([...pool.slice(0, pool.indexOf('</tbody>')).matchAll(/<tr( class="(\w+)")?>/g)].map((m) => m[2] || ''),
    ['error', 'warning', '', ''], 'row colours from errorClass; a caller\'s mistake is plain');
  // a long error status: code and message in the cell, the full JSON (with its hex data) behind View
  const poolBody = pool.slice(0, pool.indexOf('</tbody>'));
  assert.ok(poolBody.includes('<td>3: execution reverted: ERC20: transfer amount exceeds balance <a class="view-object-link" onclick="showModal('), 'short status with a View link');
  const statusLink = [...poolBody.matchAll(/onclick="showModal\((.*?)\)">View<\/a>/g)].map((x) => JSON.parse(unescapeHtml(x[1])));
  assert.strictEqual(statusLink[0].error.data, '0x08c379a0' + 'ab'.repeat(100), 'the full status in the popup');
  assert.ok(!poolBody.replace(/onclick="[^"]*"/g, '').includes('abababab'), 'no hex data in the visible cell');
  // pool and fallback durations rounded to whole ms on the page; cache durations as they are
  {
    const rowTimes = (html, id) => [...html.slice(html.indexOf(`id="${id}-body"`), html.indexOf(`id="${id}-pagination"`))
      .matchAll(/<tr[^>]*>\s*<td>[^<]*<\/td>\s*<td>[\s\S]*?<\/td>\s*<td>([^<]*)<\/td>/g)].map((m) => m[1]); // duration: 3rd column
    const realGet = axios.get;
    axios.get = async (url, config) => {
      const res = await realGet(url, config);
      if (/\/(pool|fallback|cache)Requests$/.test(new URL(url).pathname)) res.data.entries = res.data.entries.map((e, i) => ({ ...e, elapsed: [3011.186, 35.597, 0.063, 71.5][i % 4] }));
      return res;
    };
    const page = await get({});
    axios.get = realGet;
    same(rowTimes(page.body, 'poolLogs'), ['3011', '36', '0', '72']);
    same(rowTimes(page.body, 'fallbackLogs'), ['3011', '36', '0', '72']);
    same(rowTimes(page.body, 'cacheLogs'), ['3011.186']);
  }

  // success shown as OK in every table's status column (display only; the logs keep 'success')
  {
    const statusCells = (id, col) => [...r.body.slice(r.body.indexOf(`id="${id}-body"`), r.body.indexOf(`id="${id}-pagination"`))
      .matchAll(/<tr[^>]*>((?:\s*<td>[\s\S]*?<\/td>)+)\s*<\/tr>/g)].map((m) => [...m[1].matchAll(/<td>([\s\S]*?)<\/td>/g)][col][1]);
    // pool rows: row 4 is a success (row 3 the revert); node rows use the same entries (status in column 2)
    assert.strictEqual(statusCells('poolLogs', 1)[3], 'OK');
    assert.strictEqual(statusCells('fallbackLogs', 1)[3], 'OK');
    assert.strictEqual(statusCells('poolNodeLogs', 1)[3], 'OK');
    assert.ok(statusCells('poolNodeLogs', 1)[2].startsWith('3: execution reverted'), 'node errors get the short status too');
    assert.ok(!/<td>success<\/td>/.test(r.body), 'no success text left in any table');
  }

  // status right after the timestamp in every table that has one (request, node, merged)
  {
    const nodeHeads = [...r.body.slice(r.body.indexOf('id="poolNodeLogs"'), r.body.indexOf('id="poolNodeLogs-body"')).matchAll(/<th[^>]*>([^<]+)<\/th>/g)].map((x) => x[1]);
    same(nodeHeads, ['Timestamp', 'Status', 'Duration (ms)', 'Node ID', 'Owner', 'Method', 'Params']);
    const poolHeads = [...r.body.slice(r.body.indexOf('id="poolLogs"'), r.body.indexOf('id="poolLogs-body"')).matchAll(/<th[^>]*>([^<]+)<\/th>/g)].map((x) => x[1]);
    same(poolHeads, ['Timestamp', 'Status', 'Duration (ms)', 'Origin', 'IP', 'Method', 'Params']);
  }

  // long params: the first 20 characters, then … and a View link to the whole value
  const longText = '{"data":"0x82ad56cb' + 'cd'.repeat(300) + '","to":"0xca11bde05977b3631167028862be2a173976ca11"},0x18f0564';
  assert.ok(poolBody.includes(`<td>${escapeHtmlForTest(longText.slice(0, 20))}… <a class="view-object-link" onclick="showModal(`), 'params cut at 20 with a View link');
  const paramLinks = [...poolBody.matchAll(/onclick="showModal\((.*?)\)">View<\/a>/g)].map((x) => JSON.parse(unescapeHtml(x[1])));
  assert.ok(paramLinks.includes(longText), 'the whole params in the popup');
  assert.ok(!poolBody.replace(/onclick="[^"]*"/g, '').includes('ca11bde0'), 'the rest of the params not in the visible cell');
  assert.ok(/th, td \{[^}]*overflow-wrap: anywhere;/.test(r.body), 'long strings with no spaces break instead of stretching columns');
  assert.ok(r.body.includes("pre.textContent = typeof content === 'string' ? content : JSON.stringify(content, null, 2);"), 'text shown as text in the popup');
  assert.ok(r.body.includes('<select id="poolLogs-method" onchange="searchLogs(\'poolLogs\')">'));
  assert.ok(r.body.includes('<option value="eth_blockNumber">eth_blockNumber</option>'), 'methods in the dropdown');
  assert.ok(r.body.includes('<input id="poolNodeLogs-q"'), 'node table has a search box');
  assert.ok(!r.body.includes('id="poolCompareResults-method"'), 'compare table: no search bar (its filters are hidden too)');

  // ---- table order and titles: fallback below merged; an emoji on each title
  const order = ['cacheLogs', 'poolLogs', 'poolNodeLogs', 'mergedLogs', 'fallbackLogs', 'poolCompareResults'].map((id) => r.body.indexOf(`<div id="${id}"`));
  assert.ok(order.every((pos, i) => pos > 0 && (i === 0 || pos > order[i - 1])), 'cache, pool, node, merged, fallback, compare');
  for (const [emoji, text] of [['💾', 'Cache Request Logs'], ['🤿', 'Pool Request Logs'], ['📟', 'Pool Node Logs'], ['🔗', 'Merged Request Logs'], ['🛟', 'Fallback Request Logs'], ['⚖️', 'Pool Compare Results']]) {
    assert.ok(new RegExp(`<h2><span class="title-emoji">${emoji}</span> ${text} \\(<span id="\\w+-total">\\d+</span> total entries\\) <span class="title-emoji">${emoji}</span></h2>`).test(r.body), text);
  }
  assert.ok(r.body.includes('.title-emoji { font-size: 2em;'), 'emojis drawn at twice the heading size');

  // ---- merged requests: below Pool Node Logs, with the request tables' filters, search and pagination
  assert.ok(r.body.indexOf('id="poolNodeLogs"') < r.body.indexOf('id="mergedLogs"') && r.body.indexOf('id="mergedLogs"') < r.body.indexOf('id="poolCompareResults"'));
  assert.ok(r.body.includes('Merged Request Logs (<span id="mergedLogs-total">2</span> total entries) <span class="title-emoji">🔗</span></h2>'));
  for (const f of ['no-client', 'all', 'success', 'warning', 'error']) assert.ok(r.body.includes(`filterLogs('mergedLogs', '${f}')`), f);
  assert.ok(r.body.includes('<select id="mergedLogs-method"') && r.body.includes('<input id="mergedLogs-q"'));
  assert.ok(r.body.includes('<div id="mergedLogs-pagination">'));
  assert.ok(r.body.includes("filterLogs('mergedLogs', 'no-client');"), 'loads with No Client, like the request tables');
  const mergedBody = r.body.slice(r.body.indexOf('id="mergedLogs-body"'), r.body.indexOf('id="mergedLogs-pagination"'));
  assert.ok(mergedBody.includes('<td>yes</td>') && mergedBody.includes('<td>no</td>'), 'same caller shown');
  // after Timestamp and Status, the times in the order they happened: after first (21), wait (40), first took (61)
  assert.ok(/<td>t7<\/td>\n\s*<td>[\s\S]*?<\/td>\n\s*<td>21<\/td>\n\s*<td>40<\/td>\n\s*<td>61<\/td>/.test(mergedBody), 'status, then the times in order');
  const heads = [...r.body.slice(r.body.indexOf('id="mergedLogs"'), r.body.indexOf('id="mergedLogs-body"')).matchAll(/<th[^>]*>([^<]+)<\/th>/g)].map((x) => x[1]);
  assert.deepStrictEqual(heads, ['Timestamp', 'Status', 'After first (ms)', 'Wait (ms)', 'First took (ms)', 'Origin', 'IP', 'Method', 'Same caller', 'Params']);
  assert.strictEqual(mergedBody.split(`<td>${'&lt;img src=x onerror=alert(1)&gt;&quot;&#39;&amp;'}</td>`).length - 1, 2, 'status and origin escaped');
  assert.ok(mergedBody.includes(cutParamsCell(XSS)), 'params cut to 20 characters, escaped');


  // ---- the page script compiles
  const script = r.body.slice(r.body.indexOf('<script>') + 8, r.body.indexOf('</script>'));
  assert.doesNotThrow(() => new Function(script));

  // ---- escaping: nothing from a log entry becomes markup
  assert.ok(!r.body.includes('<img'), 'no injected tag anywhere');
  const esc = '&lt;img src=x onerror=alert(1)&gt;&quot;&#39;&amp;';
  const cache = r.body.slice(r.body.indexOf('id="cacheLogs-body"'), r.body.indexOf('id="cacheLogs-pagination"'));
  assert.strictEqual(cache.split(`<td>${esc}</td>`).length - 1, 3, 'status, origin and method shown as text');
  assert.ok(cache.includes(cutParamsCell(XSS)), 'params cut to 20 characters, escaped');
  assert.ok(r.body.includes(`<option value="${esc}">${esc}</option>`), 'dropdown option escaped');
  const compare = r.body.slice(r.body.indexOf('id="poolCompareResults-body"'));
  assert.ok(compare.includes(`<span class="node-id">${esc}</span>`), 'node id escaped');
  assert.ok(compare.includes('<br>&quot;0x1&quot;</td>'), 'short result inline, escaped');
  // modal links: the attribute unescapes to showModal(<JSON literal>) of the exact value
  const links = [...compare.matchAll(/onclick="showModal\((.*?)\)">View (Object|Value)<\/a>/g)].map((m) => JSON.parse(unescapeHtml(m[1])));
  assert.deepStrictEqual(links, [{ hash: XSS }, XSS.repeat(10)]);
  assert.ok(compare.includes(cutParamsCell(XSS)), 'params cut to 20 characters, escaped');
  assert.ok(compare.includes(`<br>${esc}</td>`), 'a short raw result escaped');

  // ---- AJAX: only the table asked for, with the search; count for the heading
  calls.length = 0;
  r = await get({ page: '3', filter: 'no-client', tableId: 'poolNodeLogs', method: 'eth_call', q: '  0xabc  ' });
  assert.deepStrictEqual(calls, [{ path: '/poolNodes', page: 3, limit: logItemsPerPage, filter: 'no-client', method: 'eth_call', q: '0xabc' }]);
  assert.ok(r.body.tbody.includes('<td>t1</td>') && typeof r.body.pagination === 'string');
  assert.strictEqual(r.body.total, 95);

  calls.length = 0;
  r = await get({ page: '2', filter: 'success', tableId: 'mergedLogs' });
  assert.deepStrictEqual(calls, [{ path: '/mergedRequests', page: 2, limit: logItemsPerPage, filter: 'success' }]);
  assert.ok(r.body.tbody.includes('<td>t7</td>') && r.body.total === 2);

  // ---- defaults and bad input
  calls.length = 0;
  await get({ page: '-4', filter: 'bogus', tableId: 'poolLogs', q: 'x'.repeat(500), method: ['a', 'b'] });
  assert.deepStrictEqual(calls, [{ path: '/poolRequests', page: 1, limit: logItemsPerPage, filter: 'all', q: 'x'.repeat(200) }]);
  r = await get({ tableId: 'nope' });
  assert.strictEqual(r.status, 400);

  console.log('logsPage: all passed');
})().catch((e) => { console.error(e); process.exit(1); });
