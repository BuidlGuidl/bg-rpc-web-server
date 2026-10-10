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
  nodeDurationHist: { 'n2-bb': { p1: 40, p25: 50, p50: 60, p75: 70, p99: 300 }, 'n9-zz': { p1: 1, p25: 2, p50: 3, p75: 4, p99: 5 },
    'damu-MINIPC-PN64-cc:28:aa:47:44:77-linux-x64': { p1: 1, p25: 2, p50: 3, p75: 4, p99: 5 } },
  requestHistory: Array.from({ length: 72 }, (_, i) => hour(H - (72 - i) * HOUR, 100 + i)), // 3 days, last at 11:00
  requestHistoryCurrentHour: hour(H, poolNow),
  // pool request time percentiles (ms): 3 days of hours, p95 rising with the hour; the hour in progress
  poolTimeHistory: Array.from({ length: 72 }, (_, i) => ({ hourMs: H - (72 - i) * HOUR, n: 200, p5: 50, p25: 60, p50: 75, p75: 120, p95: 300 + i })),
  poolTimeCurrentHour: { hourMs: H, n: 40, p5: 52, p25: 61, p50: 80, p75: 130, p95: 500 }
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
      // Like Plotly: the chart keeps the layout object it was given (gd.layout), and a zoom changes its range
      // array in place (relayout 'yaxis.range[0]'), so a page that shares that array with its own state sees it
      react: (id, data, layout) => { const e = el(id); e.data = data; e.layout = layout; return Promise.resolve(e); },
      relayout: (id, update) => {
        const e = el(id);
        for (const [key, value] of Object.entries(update)) {
          // 'xaxis.range', 'yaxis.dtick', 'shapes'...: set the (nested) layout value
          const indexed = key.match(/^(.*)\[(\d+)\]$/); // 'yaxis.range[0]': set that element of the existing array
          const path = (indexed ? indexed[1] : key).split('.');
          let target = e.layout;
          path.slice(0, -1).forEach((part) => { target = target[part] ||= {}; });
          const last = path[path.length - 1];
          if (indexed) (target[last] ||= [])[Number(indexed[2])] = value;
          else target[last] = JSON.parse(JSON.stringify(value));
        }
        return Promise.resolve();
      }
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
const same = (actual, expected, message) => assert.deepStrictEqual(JSON.parse(JSON.stringify(actual)), JSON.parse(JSON.stringify(expected)), message);
const poolTimeAxisFormat = (env) => env.elements.poolTimeHistoryPlot.layout.xaxis.tickformat;
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
    'methodDurationHist', 'requestHistoryPlot', 'warningHistoryPlot', 'errorHistoryPlot', 'poolTimeHistoryPlot', 'nodeTimeoutChart']) {
    assert.ok(env.elements[id] && env.elements[id].data, `${id} drawn`);
  }
  assert.ok(!env.elements.nodeTimeoutDayChart, 'last day is part of the node timeout chart now');

  // node duration boxes: the hover label names the node and its owner (from the node timeout data);
  // a node with no known owner shows just its ID; the name is never cut short
  const durations = env.elements.nodeDurationHist;
  // grouped by owner (n2-bb: owner p), nodes with no known owner last, by short name
  same(durations.data.map((t) => t.name), ['n2-bb<br>owner: p', 'damu-MINIPC-PN64-cc:28:aa:47:44:77-linux-x64', 'n9-zz']);
  // duration charts: no chart titles; the section heading says what they are
  assert.ok(r.body.includes('<h2>Request Duration Distribution (ms)</h2>\n            <div id="methodDurationHist"'));
  assert.ok(r.body.includes('<h2>Node Duration Distribution (ms)</h2>\n            <div id="nodeDurationHist"'), 'the node histogram has its own heading');
  assert.strictEqual(durations.layout.title, undefined);
  assert.strictEqual(env.elements.methodDurationHist.layout.title, undefined);
  // y grid: labeled major lines every 200 ms; light minor lines across the plot every 50 ms between them,
  // behind the boxes, never on a major line. Axis 0 to the highest p99 + 5% up to the next 50
  // (method p99s 5 → 0–50: no minor lines; node p99s up to 300 → 0–350: majors 0, 200; minors 50, 100, 150, 250, 300)
  same(env.elements.methodDurationHist.layout.yaxis.range, [0, 50]);
  same(env.elements.methodDurationHist.layout.shapes, []);
  same([durations.layout.yaxis.range, durations.layout.yaxis.dtick, durations.layout.yaxis.tick0], [[0, 350], 200, 0]);
  same(env.elements.methodDurationHist.layout.yaxis.dtick, 200);
  same(durations.layout.shapes.map((sh) => sh.y0), [50, 100, 150, 250, 300]);
  assert.ok(durations.layout.shapes.every((sh) => sh.type === 'line' && sh.layer === 'below' && sh.xref === 'paper'
    && sh.x0 === 0 && sh.x1 === 1 && sh.y0 === sh.y1 && sh.y0 % 200 !== 0), 'across the plot, never on a major line');
  // zoomed in: the grid follows the visible range (at most ~7 labeled lines, never above 200 ms; minor ~1/4)
  // as Plotly does on a drag zoom: the range array changed in place, then the event
  await env.Plotly.relayout('nodeDurationHist', { 'yaxis.range[0]': 40, 'yaxis.range[1]': 80 });
  durations.handlers.plotly_relayout({ 'yaxis.range[0]': 40, 'yaxis.range[1]': 80 });
  await flush();
  assert.strictEqual(durations.layout.yaxis.dtick, 10, 'a 40 ms window: labeled every 10 ms');
  same(durations.layout.shapes.map((sh) => sh.y0), [42, 44, 46, 48, 52, 54, 56, 58, 62, 64, 66, 68, 72, 74, 76, 78], 'minor every 2 ms, only in view, never on a major line');
  // an x-only zoom leaves the y grid alone
  durations.handlers.plotly_relayout({ 'xaxis.range[0]': 0, 'xaxis.range[1]': 1 });
  await flush();
  assert.strictEqual(durations.layout.yaxis.dtick, 10);
  // a wide zoom: never above 200 ms
  durations.handlers.plotly_relayout({ 'yaxis.range[0]': 0, 'yaxis.range[1]': 3000 });
  await flush();
  assert.strictEqual(durations.layout.yaxis.dtick, 200);
  // the minute refresh keeps the zoom (uirevision) and its grid
  assert.strictEqual(durations.layout.uirevision, 'nodeDurationHist');
  durations.handlers.plotly_relayout({ 'yaxis.range[0]': 100, 'yaxis.range[1]': 300 });
  await flush();
  const zoomed = durations.layout.yaxis.dtick;
  // reset (double-click): back to the full view and its 200/50 grid
  durations.handlers.plotly_relayout({ 'yaxis.autorange': true });
  await flush();
  same([durations.layout.yaxis.range, durations.layout.yaxis.dtick], [[0, 350], 200]);
  same(durations.layout.shapes.map((sh) => sh.y0), [50, 100, 150, 250, 300]);
  assert.strictEqual(zoomed, 50, 'a 200 ms window: labeled every 50 ms');

  // duration charts: the y axis never goes below 0 ms
  assert.strictEqual(durations.layout.yaxis.rangemode, 'nonnegative');
  assert.strictEqual(env.elements.methodDurationHist.layout.yaxis.rangemode, 'nonnegative');
  // axis labels sit right under the axis (no gap) and the bottom margin fits the longest label at 45°
  // (no canvas here: widths estimated at 0.6 × font size per character)
  const fits = (labels) => Math.max(40, Math.ceil((Math.max(...labels.map((t) => t.length * 12 * 0.6)) + 12 * 1.2) * Math.SQRT1_2) + 12);
  for (const [chart, labels] of [[durations, ['n2-bb', 'n9-zz', 'damu-MINIPC-PN64']], [env.elements.methodDurationHist, ['eth_call', '<b>method</b>']]]) {
    assert.ok(chart.layout.annotations.every((a) => a.y === 0 && a.yanchor === 'top' && a.xanchor === 'right' && a.textangle === -45));
    assert.strictEqual(chart.layout.margin.b, fits(labels));
  }
  // a junk method name is cut at 40 characters, label and margin alike
  {
    const longMethod = 'x_' + 'y'.repeat(200);
    const env2 = browser();
    const script2 = r.body.slice(r.body.lastIndexOf('<script>') + 8, r.body.lastIndexOf('</script>'))
      .replace(/const initialPayload = .*?;\n/, `const initialPayload = ${JSON.stringify({ ...payload, data: { ...payload.data, methodDurationHist: { [longMethod]: { p1: 1, p25: 2, p50: 3, p75: 4, p99: 5 } } } })};\n`);
    vm.runInNewContext(script2, env2);
    await flush();
    const ann = env2.elements.methodDurationHist.layout.annotations[0];
    assert.strictEqual(ann.text, longMethod.slice(0, 39) + '…');
    assert.strictEqual(env2.elements.methodDurationHist.layout.margin.b, Math.ceil((40 * 12 * 0.6 + 12 * 1.2) * Math.SQRT1_2) + 12);
  }
  // method names come from callers: escaped for Plotly
  same(env.elements.methodDurationHist.layout.annotations.map((a) => a.text), ['eth_call', '&lt;b&gt;method&lt;/b&gt;']);
  // axis labels: the node ID up to its MAC address; IDs without one unchanged
  same(durations.layout.annotations.map((a) => a.text), ['n2-bb', 'damu-MINIPC-PN64', 'n9-zz']);
  assert.ok(durations.data.every((t) => t.hoverlabel && t.hoverlabel.namelength === -1));

  // node timeouts: one chart, a last-day and a last-week bar per node, placed by nodeId. Grouped by owner
  // like the duration chart (owner o: n1-aa, n3-cc; owner p: n2-bb). Colors follow the duration chart:
  // n2-bb is first there (palette 0); n1-aa and n3-cc aren't in it, so they continue the palette (3, 4)
  const timeouts = env.elements.nodeTimeoutChart;
  same(timeouts.data.map((t) => t.name), ['Last day', 'Last week']); // day bar on the left
  same(timeouts.data[0].x, ['n1-aa', 'n3-cc', 'n2-bb']);
  same(timeouts.data[0].y, [0, null, 4]); // n3 had no requests in the last day: no bar
  same(timeouts.data[1].y, [1, 50, 2]);
  assert.strictEqual(timeouts.layout.barmode, 'group');
  assert.strictEqual(timeouts.layout.title, undefined, 'no chart title: the section heading names it');
  assert.ok(r.body.includes('<h2>Node Percent Timeout (Light: last day, solid: last week)</h2>'), 'the light/solid key in the heading');
  const weekColors = timeouts.data[1].marker.color;
  assert.strictEqual(weekColors[2], durations.layout.annotations[0].font.color, 'n2-bb: the same color as in the duration chart');
  same(weekColors, ['rgb(214, 39, 40)', 'rgb(148, 103, 189)', 'rgb(31, 119, 180)']);
  // the day bar: the same color, lighter, as a real color (its tooltip takes it), not opacity
  same(timeouts.data[0].marker.color[2], 'rgb(' + [31, 119, 180].map((c) => Math.round(c + (255 - c) * 0.55)).join(', ') + ')');
  assert.strictEqual(timeouts.data[0].marker.opacity, undefined);
  // labels: rotated annotations in each node's bar color, short names; no plain tick labels
  same(timeouts.layout.annotations.map((a) => [a.text, a.font.color]), [['n1-aa', weekColors[0]], ['n3-cc', weekColors[1]], ['n2-bb', weekColors[2]]]);
  assert.strictEqual(timeouts.layout.xaxis.showticklabels, false);
  assert.ok(timeouts.layout.annotations.every((a) => a.y === 0 && a.yanchor === 'top' && a.textangle === -45));
  assert.ok(timeouts.data[0].hovertext[1].includes('no requests'));
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

  // time axis tick labels: 26-10-09 00:00 (two-digit year, no UTC; the title says it)
  assert.strictEqual(poolTimeAxisFormat(env), '%y-%m-%d %H:%M');
  assert.strictEqual(env.elements.requestHistoryPlot.layout.xaxis.tickformat, '%y-%m-%d %H:%M');

  // pool request time: 5 percentile lines, the hour in progress dotted, same window
  const poolTime = env.elements.poolTimeHistoryPlot;
  same(poolTime.data.filter((t) => !t.name.includes('in progress')).map((t) => t.name), ['p5', 'p25', 'p50', 'p75', 'p95']);
  same(trace(env, 'poolTimeHistoryPlot', 'p95').y.slice(-2), [370, 371]);
  live = trace(env, 'poolTimeHistoryPlot', 'p95 (hour in progress)');
  same(live.y, [371, 500]);
  assert.strictEqual(live.line.dash, 'dot');
  same(live.text, ['371 ms (full hour, 200 requests)', '500 ms so far (40 requests, 23 min into the hour)']);
  assert.strictEqual(poolTime.layout.yaxis.type, 'linear');
  same(poolTime.layout.xaxis.range, env.elements.requestHistoryPlot.layout.xaxis.range);
  // visible values 50..500 ms, padded 10% of 450 each way
  assert.ok(Math.abs(poolTime.layout.yaxis.range[0] - 5) < 1e-9);
  assert.ok(Math.abs(poolTime.layout.yaxis.range[1] - 545) < 1e-9);
  assert.strictEqual(poolTime.layout.showlegend, true);
  assert.strictEqual(env.elements.requestHistoryPlot.layout.showlegend, false);
  // its container is taller by the room its time labels and legend take, so the plot area matches the others
  assert.ok(r.body.includes('#time-series-section #poolTimeHistoryPlot {\n              height: calc((100vh - 150px) / 3 + 130px);'));
  // the bottom chart carries the time labels now
  assert.strictEqual(env.elements.errorHistoryPlot.layout.xaxis.showticklabels, false);
  assert.notStrictEqual(poolTime.layout.xaxis.showticklabels, false);

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
  same(env.elements.poolTimeHistoryPlot.layout.xaxis.range, dragged, 'the pool time chart follows too');

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
