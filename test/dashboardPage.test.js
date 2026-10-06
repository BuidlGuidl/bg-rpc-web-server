// Dashboard: drawn from one payload, redrawn once a minute from /dashboard/data without a reload;
// the hourly charts show the hour in progress as a dotted line and keep the chosen window.
// The page script runs here against stand-ins for the DOM, Plotly, fetch and timers.
// Run: node test/dashboardPage.test.js
const assert = require('assert');
const vm = require('vm');
const axios = require('axios');

const HOUR = 60 * 60 * 1000;
const H = Date.UTC(2026, 9, 1, 12); // the hour in progress: 12:00 UTC
const hour = (hourMs, pool) => ({ hourMs, nCacheRequestsSuccess: 10, nCacheRequestsError: 0, nCacheRequestsWarning: 0,
  nPoolRequestsSuccess: pool, nPoolRequestsError: 1, nPoolRequestsWarning: 2, nFallbackRequestsSuccess: 3, nFallbackRequestsError: 0, nFallbackRequestsWarning: 0 });
const dashboard = (poolNow, minutesIn) => ({
  timestamp: H + minutesIn * 60000, nTotalRequestsLastHour: 50, nCacheRequestsClientLastHour: 5, nCacheRequestsLastHour: 10,
  nPoolRequestsLastHour: 30, nFallbackRequestsLastHour: 3, methodDurationHist: { eth_call: { p1: 1, p25: 2, p50: 3, p75: 4, p99: 5 }, '<b>method</b>': { p1: 1, p25: 2, p50: 3, p75: 4, p99: 5 } },
  nodeDurationHist: {},
  requestHistory: Array.from({ length: 72 }, (_, i) => hour(H - (72 - i) * HOUR, 100 + i)), // 3 days, last at 11:00
  requestHistoryCurrentHour: hour(H, poolNow)
});
// Last week and last day list different nodes: n3 only last week; n1 and n2 share a short name
const weekNodes = [
  { nodeId: 'n1-aa', nodeIdPretty: 'box', owner: 'o', percentTimeout: 0.01 },
  { nodeId: 'n2-bb', nodeIdPretty: 'box', owner: 'p', percentTimeout: 0.02 },
  { nodeId: 'n3-cc', nodeIdPretty: 'old', owner: 'o', percentTimeout: 0.5 }
];
const dayNodes = [
  { nodeId: 'n2-bb', nodeIdPretty: 'box', owner: 'p', percentTimeout: 0.04 },
  { nodeId: 'n1-aa', nodeIdPretty: 'box', owner: 'o', percentTimeout: 0 }
];
let logsDown = false;
axios.get = async (url) => {
  if (logsDown) throw new Error('connect ECONNREFUSED');
  const path = new URL(url).pathname;
  return { data: path === '/dashboard' ? dashboard(40, 23) : path === '/nodeTimeoutPercentLastDay' ? dayNodes : weekNodes };
};
const router = require('../routes/dashboard');
const handler = (p) => router.stack.find((l) => l.route && l.route.path === p).route.stack[0].handle;
const get = (p) => new Promise((resolve) => {
  const res = { statusCode: 200, headers: {}, set(k, v) { this.headers[k] = v; return this; }, type(t) { this.headers['content-type'] = t; return this; },
    status(c) { this.statusCode = c; return this; }, send(body) { resolve({ status: this.statusCode, headers: this.headers, body }); },
    json(o) { resolve({ status: this.statusCode, headers: this.headers, body: JSON.stringify(o) }); } };
  handler(p)({}, res);
});

// ---- stand-ins for the browser
function browser() {
  const elements = {};
  const el = (id) => (elements[id] ||= { id, textContent: '', classList: classes(), handlers: {}, on(e, f) { this.handlers[e] = f; } });
  const classes = () => { const set = new Set(); return { add: (c) => set.add(c), remove: (c) => set.delete(c), toggle: (c, on) => (on ? set.add(c) : set.delete(c)), has: (c) => set.has(c) }; };
  const buttons = ['1', '3', '7', '14', '30', 'all'].map((range) => ({ dataset: { range }, classList: classes(), listeners: {},
    addEventListener(e, f) { this.listeners[e] = f; } }));
  const docListeners = {};
  const timers = [];
  const env = {
    elements, buttons, timers, docListeners, fetchResponses: [],
    document: {
      hidden: false,
      getElementById: el,
      querySelectorAll: (sel) => (sel === '.time-filter-btn' ? buttons : []),
      querySelector: () => null,
      addEventListener: (e, f) => { docListeners[e] = f; }
    },
    Plotly: {
      react: (id, data, layout) => { const e = el(id); e.data = data; e.layout = JSON.parse(JSON.stringify(layout)); return Promise.resolve(e); },
      relayout: (id, update) => { const e = el(id); if (update['xaxis.range']) e.layout.xaxis.range = update['xaxis.range']; return Promise.resolve(); }
    },
    fetch: async () => { const r = env.fetchResponses.shift(); if (r instanceof Error) throw r; return r; },
    setInterval: (f, ms) => { timers.push({ f, ms, active: true }); return timers.length; },
    clearInterval: (id) => { if (id) timers[id - 1].active = false; },
    console
  };
  env.window = env;
  return env;
}
const json = (body) => ({ redirected: false, ok: true, status: 200, headers: { get: () => 'application/json; charset=utf-8' }, json: async () => body });
const flush = () => new Promise((r) => setImmediate(r));
// Values made inside the vm sandbox have its own prototypes: compare plain copies
const same = (actual, expected, message) => assert.deepStrictEqual(JSON.parse(JSON.stringify(actual)), expected, message);
const trace = (env, plot, name) => env.elements[plot].data.find((t) => t.name === name);

(async () => {
  // ---- the JSON route: everything the page draws, safe to embed, not cached
  let r = await get('/dashboard/data');
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.headers['Cache-Control'], 'no-store');
  assert.ok(!r.body.includes('<'), 'no raw < (method and origin names come from callers)');
  const payload = JSON.parse(r.body);
  assert.deepStrictEqual(Object.keys(payload), ['data', 'nodeTimeoutData', 'nodeTimeoutDayData']);
  assert.strictEqual(payload.data.requestHistoryCurrentHour.nPoolRequestsSuccess, 40);
  logsDown = true;
  assert.strictEqual((await get('/dashboard/data')).status, 502);
  logsDown = false;

  // ---- the page: its script runs and draws everything
  r = await get('/dashboard');
  assert.ok(r.body.includes('<div id="dashboard-status"'));
  const script = r.body.slice(r.body.lastIndexOf('<script>') + 8, r.body.lastIndexOf('</script>'));
  const env = browser();
  vm.runInNewContext(script, env);
  await flush();
  for (const id of ['totalGauge', 'clientGauge1', 'gauge2', 'gauge3', 'gauge4', 'timeGauge1', 'warningGauge1', 'errorGauge1',
    'methodDurationHist', 'requestHistoryPlot', 'warningHistoryPlot', 'errorHistoryPlot', 'nodeTimeoutChart']) {
    assert.ok(env.elements[id] && env.elements[id].data, `${id} drawn`);
  }
  assert.ok(!env.elements.nodeTimeoutDayChart, 'last day is part of the node timeout chart now');

  // node timeouts: one chart, a last-week and a last-day bar per node, placed by nodeId, labeled by short name
  const timeouts = env.elements.nodeTimeoutChart;
  same(timeouts.data.map((t) => t.name), ['Last day', 'Last week']); // day bar on the left
  same(timeouts.data[0].x, ['n1-aa', 'n2-bb', 'n3-cc']);
  same(timeouts.data[0].y, [0, 4, null]); // n3 had no requests in the last day: no bar
  same(timeouts.data[1].y, [1, 2, 50]);
  same(timeouts.layout.xaxis.ticktext, ['box', 'box', 'old']);
  assert.strictEqual(timeouts.layout.barmode, 'group');
  // both bars in the owner color; the day bar a lighter shade as a real color (its tooltip takes it), not opacity
  const ownerColor = timeouts.data[1].marker.color[0];
  assert.match(ownerColor, /^#[0-9a-f]{6}$/);
  const lighter = 'rgb(' + [1, 3, 5].map((i) => parseInt(ownerColor.slice(i, i + 2), 16)).map((c) => Math.round(c + (255 - c) * 0.55)).join(', ') + ')';
  assert.strictEqual(timeouts.data[0].marker.color[0], lighter);
  assert.strictEqual(timeouts.data[0].marker.opacity, undefined);
  assert.notStrictEqual(timeouts.data[1].marker.color[0], timeouts.data[1].marker.color[1], 'owners told apart');
  assert.ok(timeouts.data[0].hovertext[2].includes('no requests'));
  assert.ok(Math.abs(timeouts.layout.yaxis.range[1] - 55) < 1e-9, '10% headroom over the highest bar');
  assert.strictEqual(env.elements.totalGauge.data[0].value, 50);
  assert.strictEqual(env.elements['dashboard-status'].textContent, 'Data as of 12:23:00 UTC, refreshes every minute');

  // the hour in progress: dotted, from the last completed hour (11:00) to the count so far
  let live = trace(env, 'requestHistoryPlot', 'Pool Requests (hour in progress)');
  same(live.x, [new Date(H - HOUR).toISOString(), new Date(H).toISOString()]);
  same(live.y, [171, 40]);
  assert.strictEqual(live.line.dash, 'dot');
  same(live.text, ['171 (full hour)', '40 so far (23 min into the hour)']);
  same(trace(env, 'warningHistoryPlot', 'Pool Warnings (hour in progress)').y, [2, 2]);
  same(trace(env, 'errorHistoryPlot', 'Pool Errors (hour in progress)').y, [1, 1]);
  assert.strictEqual(trace(env, 'requestHistoryPlot', 'Pool Requests').x.length, 72, 'completed hours solid');
  // window: 1 day by default, ending at the hour in progress; y range from what's visible
  same(env.elements.requestHistoryPlot.layout.xaxis.range, [new Date(H - 24 * HOUR).toISOString(), new Date(H).toISOString()]);
  const y = env.elements.requestHistoryPlot.layout.yaxis.range;
  // visible values 3..171 (fallback 3, pool up to 171), padded 10% of 168 each way, never under 0
  assert.strictEqual(y[0], 0);
  assert.ok(Math.abs(y[1] - (171 + 16.8)) < 1e-9);
  assert.ok(env.buttons[0].classList.has('active'));

  // ---- once a minute: refetch and redraw in place
  const timer = env.timers[0];
  assert.strictEqual(timer.ms, 60000);
  const later = { ...payload, data: { ...dashboard(75, 47), nTotalRequestsLastHour: 80 } };
  env.fetchResponses.push(json(later));
  await timer.f(); await flush();
  assert.strictEqual(env.elements.totalGauge.data[0].value, 80, 'gauges redraw');
  same(trace(env, 'requestHistoryPlot', 'Pool Requests (hour in progress)').text[1], '75 so far (47 min into the hour)');
  assert.strictEqual(env.elements['dashboard-status'].textContent, 'Data as of 12:47:00 UTC, refreshes every minute');

  // ---- a range button changes the window; it moves with the data
  env.buttons[5].listeners.click(); await flush();
  assert.strictEqual(env.elements.errorHistoryPlot.layout.xaxis.range[0], new Date(H - 72 * HOUR).toISOString(), 'all');
  assert.ok(env.buttons[5].classList.has('active') && !env.buttons[0].classList.has('active'));

  // ---- a range dragged by hand: the other charts follow, and refreshes keep it
  const dragged = ['2026-09-30T00:00:00.000Z', '2026-09-30T06:00:00.000Z'];
  env.elements.requestHistoryPlot.layout.xaxis.range = dragged;
  env.elements.requestHistoryPlot.handlers.plotly_relayout({ 'xaxis.range[0]': dragged[0], 'xaxis.range[1]': dragged[1] });
  same(env.elements.warningHistoryPlot.layout.xaxis.range, dragged);
  assert.ok(env.buttons.every((b) => !b.classList.has('active')), 'no button: a custom range');
  env.fetchResponses.push(json(later));
  await timer.f(); await flush();
  same(env.elements.requestHistoryPlot.layout.xaxis.range, dragged, 'kept across a refresh');
  same(env.elements.errorHistoryPlot.layout.xaxis.range, dragged);

  // ---- a failed update says so and keeps polling
  env.fetchResponses.push(new Error('Failed to fetch'));
  await timer.f(); await flush();
  assert.match(env.elements['dashboard-status'].textContent, /^Update failed at \d\d:\d\d:\d\d UTC \(Failed to fetch\), retrying every minute\.$/);
  assert.ok(env.elements['dashboard-status'].classList.has('problem'));
  assert.ok(timer.active);

  // ---- a hidden tab stops polling; shown again, it catches up and resumes
  env.document.hidden = true; env.docListeners.visibilitychange();
  assert.ok(!timer.active);
  env.document.hidden = false; env.fetchResponses.push(json(later)); env.docListeners.visibilitychange(); await flush();
  assert.strictEqual(env.timers.length, 2);
  assert.ok(env.timers[1].active);
  assert.ok(!env.elements['dashboard-status'].classList.has('problem'));

  // ---- an expired login (redirected to the login page) stops polling and says so
  env.fetchResponses.push({ redirected: true, ok: true, status: 200, headers: { get: () => 'text/html; charset=utf-8' }, json: async () => { throw new Error('html'); } });
  await env.timers[1].f(); await flush();
  assert.strictEqual(env.elements['dashboard-status'].textContent, 'Session expired: reload the page to log in again.');
  assert.ok(!env.timers[1].active);
  env.docListeners.visibilitychange();
  assert.strictEqual(env.timers.length, 2, 'not restarted after expiry');

  console.log('dashboardPage: all passed');
})().catch((e) => { console.error(e); process.exit(1); });
