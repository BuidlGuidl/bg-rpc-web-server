// IP and Origin Timeseries: cached reads of the edge's database (utils/edgeTimeseries.js) and the
// pages that redraw once a minute (utils/timeseriesClient.js). The database is a stand-in here.
// Run: node test/timeseriesPages.test.js
const assert = require('assert');
const vm = require('vm');
const edgeDb = require('../utils/edgeDb');

const HOUR = 3600;
const LATEST = 1790845200; // newest completed hour in the history table (epoch seconds)
const queries = [];
const db = { latest: LATEST, live: [], fail: null };
const historyRows = [
  // two IPs, two hours; origins counted per IP and hour
  { hour_timestamp: String(LATEST - HOUR), ip: '1.1.1.1', request_count: 10, origins: { 'https://a.example': 4 } },
  { hour_timestamp: String(LATEST), ip: '1.1.1.1', request_count: 20, origins: { 'https://a.example': 5, '<b>x</b>': 1 } },
  { hour_timestamp: String(LATEST), ip: '2.2.2.2', request_count: 7, origins: {} }
];
edgeDb.query = async (sql, params) => {
  queries.push({ sql, params });
  if (db.fail) throw db.fail;
  if (/MAX\(hour_timestamp\)/.test(sql)) return { rows: [{ hour: db.latest === null ? null : String(db.latest) }] };
  if (/FROM ip_table/.test(sql)) return { rows: db.live };
  const inWindow = historyRows.filter((r) => Number(r.hour_timestamp) >= params[0]);
  if (/jsonb_each_text/.test(sql)) {
    const sums = new Map(); // `${hour}|${origin}` -> count
    inWindow.forEach((r) => Object.entries(r.origins).forEach(([o, c]) => sums.set(`${r.hour_timestamp}|${o}`, (sums.get(`${r.hour_timestamp}|${o}`) || 0) + c)));
    if (/LIMIT/.test(sql)) {
      const totals = new Map();
      sums.forEach((c, k) => totals.set(k.split('|')[1], (totals.get(k.split('|')[1]) || 0) + c));
      return { rows: [...totals].sort((a, b) => b[1] - a[1]).map(([origin, total]) => ({ origin, total: String(total) })) };
    }
    return { rows: [...sums].filter(([k]) => params[1].includes(k.split('|')[1])).map(([k, c]) => ({ hour_timestamp: k.split('|')[0], origin: k.split('|')[1], request_count: String(c) })) };
  }
  if (/LIMIT/.test(sql)) {
    const totals = new Map();
    inWindow.forEach((r) => totals.set(r.ip, (totals.get(r.ip) || 0) + r.request_count));
    return { rows: [...totals].sort((a, b) => b[1] - a[1]).map(([ip, total]) => ({ ip, total: String(total) })) };
  }
  return { rows: inWindow.filter((r) => params[1].includes(r.ip)) };
};
const realNow = Date.now;
let clock = (LATEST + HOUR + 20 * 60) * 1000; // 20 minutes into the hour after LATEST
Date.now = () => clock;

const { getTimeseries } = require('../utils/edgeTimeseries');
const { timeseriesClient } = require('../utils/timeseriesClient');
const live = (ip, n, origins, hour = LATEST + HOUR) => ({ ip, requests_last_hour: n, origins_last_hour: origins, last_reset_timestamp: String(hour) });

(async () => {
  // ---------------------------------------------------------------- data: queries, caching, live hour
  db.live = [live('1.1.1.1', 6, { 'https://a.example': 2, '<b>x</b>': 1 }), live('2.2.2.2', 3, {}), live('3.3.3.3', 9, { 'https://a.example': 9 })];
  let r = await getTimeseries('ip', 1);
  assert.strictEqual(queries.length, 5, 'newest hour, top 30, their series, live counters, series of an IP busy only now');
  assert.ok(/updated_at >= NOW\(\) - INTERVAL '2 hours'/.test(queries.find((q) => /ip_table/.test(q.sql)).sql), 'live read goes through the updated_at index');
  assert.ok(queries.every((q) => !/EXTRACT/.test(q.sql)), 'history windows are a plain cutoff on the indexed column');
  assert.strictEqual(queries[1].params[0], LATEST + HOUR - 24 * HOUR, '1 day = the 24 completed hours ending at the newest');
  assert.deepStrictEqual(r.hours, [new Date((LATEST - HOUR) * 1000).toISOString(), new Date(LATEST * 1000).toISOString()]);
  // ranked by completed hours plus the hour in progress: 1.1.1.1 30+6, 2.2.2.2 7+3, 3.3.3.3 0+9
  assert.deepStrictEqual(r.series.map((s) => s.key), ['1.1.1.1', '2.2.2.2', '3.3.3.3'], 'rank order');
  assert.deepStrictEqual(r.series[0], { key: '1.1.1.1', countsTotal: [10, 20], countsWithOrigin: [4, 6], countsWithoutOrigin: [6, 14] });
  assert.deepStrictEqual(r.series[1].countsTotal, [0, 7], 'hours without data are 0');
  assert.strictEqual(r.live.hour, new Date((LATEST + HOUR) * 1000).toISOString());
  assert.deepStrictEqual(r.series[2].countsTotal, [0, 0], 'busy only in the hour in progress: no completed hours');
  assert.deepStrictEqual(r.live.byKey, { '1.1.1.1': { total: 6, withOrigin: 3, withoutOrigin: 3 }, '2.2.2.2': { total: 3, withOrigin: 0, withoutOrigin: 3 },
    '3.3.3.3': { total: 9, withOrigin: 9, withoutOrigin: 0 } }, 'live for the shown IPs');

  // origins: summed over IPs, live too
  r = await getTimeseries('origin', 1);
  assert.deepStrictEqual(r.series, [{ key: 'https://a.example', counts: [4, 5] }, { key: '<b>x</b>', counts: [0, 1] }]);
  assert.deepStrictEqual(r.live.byKey, { 'https://a.example': 11, '<b>x</b>': 1 });

  // cached: the same pages again within 30 s, from several viewers at once: no queries
  queries.length = 0;
  await Promise.all([getTimeseries('ip', 1), getTimeseries('ip', 1), getTimeseries('origin', 1)]);
  assert.strictEqual(queries.length, 0);

  // after 30 s, no new hour: only the newest-hour check and the live counters
  clock += 31 * 1000;
  queries.length = 0;
  await Promise.all([getTimeseries('ip', 1), getTimeseries('origin', 1), getTimeseries('ip', 1)]);
  assert.strictEqual(queries.length, 2, 'concurrent requests share one query each');

  // a new completed hour: history reloaded once per page and window
  clock += 31 * 1000;
  db.latest = LATEST + HOUR;
  db.live = [live('1.1.1.1', 1, {}, LATEST + 2 * HOUR)];
  queries.length = 0;
  r = await getTimeseries('ip', 1);
  assert.strictEqual(queries.length, 4);
  assert.strictEqual(queries[1].params[0], LATEST + 2 * HOUR - 24 * HOUR, 'window moves with the newest hour');

  // the edge between writing an hour to history and resetting its counters: that hour is not shown twice
  clock += 31 * 1000;
  db.live = [live('1.1.1.1', 30, {}, LATEST + HOUR)];
  r = await getTimeseries('ip', 1);
  assert.strictEqual(r.live, null);
  // counters stamped with different hours (a moment during the edge's reset): only the newest hour
  clock += 31 * 1000;
  db.live = [live('1.1.1.1', 2, {}, LATEST + 2 * HOUR), live('2.2.2.2', 50, {}, LATEST + HOUR)];
  r = await getTimeseries('ip', 1);
  assert.deepStrictEqual(r.live.byKey['2.2.2.2'], { total: 0, withOrigin: 0, withoutOrigin: 0 });

  // a failed query isn't cached: the next request tries again
  clock += 31 * 1000;
  db.fail = new Error('timeout');
  await assert.rejects(getTimeseries('origin', 3));
  db.fail = null;
  r = await getTimeseries('origin', 3);
  assert.ok(r.series.length > 0);
  await assert.rejects(getTimeseries('ip', 2), /days must be one of/);

  // ---------------------------------------------------------------- routes
  const route = (file, path) => require(file).stack.find((l) => l.route && l.route.path === path).route.stack[0].handle;
  const get = (file, path, query = {}) => new Promise((resolve) => {
    const res = { statusCode: 200, headers: {}, set(k, v) { this.headers[k] = v; return this; }, type(t) { this.headers['content-type'] = t; return this; },
      status(c) { this.statusCode = c; return this; }, send(body) { resolve({ status: this.statusCode, headers: this.headers, body }); },
      json(o) { resolve({ status: this.statusCode, headers: this.headers, body: JSON.stringify(o) }); } };
    route(file, path)({ query, params: {} }, res);
  });
  for (const [file, base] of [['../routes/iptimeseries', '/iptimeseries'], ['../routes/origintimeseries', '/origintimeseries']]) {
    let res = await get(file, `${base}/data`, { days: '7' });
    assert.strictEqual(res.status, 200, base);
    assert.strictEqual(res.headers['Cache-Control'], 'no-store');
    assert.ok(!res.body.includes('<'), `${base}: no raw < in JSON (origin names come from callers)`);
    assert.strictEqual(JSON.parse(res.body).days, 7);
    res = await get(file, `${base}/data`, { days: '5' });
    assert.strictEqual(JSON.parse(res.body).days, 1, 'unknown window: 1 day');
    res = await get(file, base, { days: '3' });
    const script = res.body.slice(res.body.lastIndexOf('<script>') + 8, res.body.lastIndexOf('</script>'));
    assert.doesNotThrow(() => new Function(script), `${base}: page script compiles`);
    assert.ok(res.body.includes('id="timeseries-status"'));
    assert.ok(!res.body.includes('<b>x</b>'), `${base}: no caller markup in the page`);
    clock += 31 * 1000;
    db.fail = new Error('connection refused');
    assert.strictEqual((await get(file, `${base}/data`)).status, 502);
    res = await get(file, base);
    assert.strictEqual(res.status, 500);
    db.fail = null;
  }

  // ---------------------------------------------------------------- the IP page's script in a stand-in browser
  Date.now = realNow;
  db.latest = LATEST;
  db.live = [live('1.1.1.1', 6, { 'https://a.example': 2 }), live('2.2.2.2', 3, {})];
  const page = await get('../routes/iptimeseries', '/iptimeseries', { days: '1' });
  const script = page.body.slice(page.body.lastIndexOf('<script>') + 8, page.body.lastIndexOf('</script>'));
  const env = browser();
  vm.runInNewContext(script, env);
  await flush();
  const plot = env.el('ipTimeseriesPlot');
  const same = (actual, expected, message) => assert.deepStrictEqual(JSON.parse(JSON.stringify(actual)), expected, message);
  same(plot.data.map((t) => t.name), ['1.1.1.1', '2.2.2.2', '1.1.1.1 (hour in progress)', '2.2.2.2 (hour in progress)']);
  const liveTrace = plot.data[2];
  same([liveTrace.y, liveTrace.line.dash, liveTrace.showlegend], [[20, 6], 'dot', false], 'dotted from the last completed hour');
  assert.match(liveTrace.text[1], /^6 so far \(\d+ min into the hour\)$/);
  same(plot.layout.yaxis.range, [0, 20 * 1.02]);
  assert.match(env.el('timeseries-status').textContent, /^Data as of \d\d:\d\d:\d\d UTC, refreshes every minute$/);
  assert.ok(env.buttons.find((b) => b.days === '1').classList.has('active'));

  // origin filter: redraw from the same data, y range kept at the "All" range
  env.originButtons[1].listeners.click();
  await flush();
  same([plot.data[0].y, plot.data[2].y], [[4, 6], [6, 2]], 'with-origin values, live too');
  same(plot.layout.yaxis.range, [0, 20 * 1.02]);

  // hovering a line highlights its series, hour in progress included
  plot.handlers.plotly_hover({ points: [{ curveNumber: 2 }] });
  same(env.lastRestyle['line.width'], [6, 3, 6, 3]);
  same(env.lastRestyle.opacity, [1, 0.3, 1, 0.3]);
  // a legend click opens the IP lookup for that IP
  env.fetchResponses.push(json({ query: '2.2.2.2', isp: '<img src=x onerror=alert(1)>' }));
  plot.listeners.click({ target: legendItem(env, plot, 1), preventDefault() {}, stopPropagation() {} });
  await flush();
  assert.strictEqual(env.fetched[0], '/iptimeseries/lookup/2.2.2.2');
  assert.ok(env.el('modalBody').innerHTML.includes('&lt;img'), 'lookup values shown as text');

  // a zoom by hand is kept across refreshes
  plot.handlers.plotly_relayout({ 'xaxis.range[0]': '2026-10-01T00:00:00Z', 'xaxis.range[1]': '2026-10-01T06:00:00Z' });
  env.fetchResponses.push(json(JSON.parse(JSON.stringify(Object.assign(env.payload(), { asOf: realNow() })))));
  await env.timers[0].f(); await flush();
  same(plot.layout.xaxis.range, ['2026-10-01T00:00:00Z', '2026-10-01T06:00:00Z']);

  // a day button: fetched in place, URL updated, zoom cleared; a slower earlier response is dropped
  const slow = deferred();
  env.fetchResponses.push(slow.promise);
  env.timers[0].f();
  env.fetchResponses.push(json({ days: 7, hours: ['2026-09-25T00:00:00.000Z'], series: [{ key: '9.9.9.9', countsTotal: [5], countsWithOrigin: [0], countsWithoutOrigin: [5] }], live: null, asOf: realNow() }));
  env.buttons.find((b) => b.days === '7').listeners.click();
  await flush();
  slow.resolve(json(env.payload()));
  await flush();
  assert.strictEqual(env.fetched[env.fetched.length - 1], '/iptimeseries/data?days=7');
  assert.strictEqual(env.urls[0], '/iptimeseries?days=7');
  same(plot.data.map((t) => t.name), ['9.9.9.9'], 'the 7-day data, not the late 1-day response');
  same(plot.layout.xaxis.range, ['2026-09-25T00:00:00.000Z', '2026-09-25T00:00:00.000Z']);
  assert.ok(env.buttons.find((b) => b.days === '7').classList.has('active') && !env.buttons.find((b) => b.days === '1').classList.has('active'));

  // an expired login stops polling and says so
  env.fetchResponses.push({ redirected: true, ok: true, headers: { get: () => 'text/html' } });
  await env.timers[0].f(); await flush();
  assert.strictEqual(env.el('timeseries-status').textContent, 'Session expired: reload the page to log in again.');
  assert.ok(!env.timers[0].active);

  console.log('timeseriesPages: all passed');
})().catch((e) => { Date.now = realNow; console.error(e); process.exit(1); });

// ---- stand-ins for the browser
function classes() {
  const set = new Set();
  return { add: (c) => set.add(c), remove: (c) => set.delete(c), toggle: (c, on) => (on === undefined ? (set.has(c) ? set.delete(c) : set.add(c)) : on ? set.add(c) : set.delete(c)), has: (c) => set.has(c) };
}
function browser() {
  const elements = {};
  const env = { elements, fetchResponses: [], fetched: [], urls: [], timers: [], lastRestyle: null };
  // Like a real div: no .on() until Plotly has drawn into it (Plotly.react adds it)
  env.el = (id) => (elements[id] ||= { id, textContent: '', innerHTML: '', style: {}, classList: classes(), handlers: {}, listeners: {}, legend: [],
    addEventListener(e, f) { this.listeners[e] = f; },
    querySelectorAll(sel) { return sel === '.legend g.traces' ? this.legend : []; }, replaceChildren() {} });
  const button = (attrs, text) => ({ attrs, days: attrs['data-days'], textContent: text, classList: classes(), listeners: {},
    getAttribute: (k) => attrs[k], addEventListener(e, f) { this.listeners[e] = f; } });
  env.buttons = ['1', '3', '7', '14', '30'].map((d) => button({ 'data-days': d }, d + ' days'));
  env.originButtons = ['all', 'origin', 'no-origin'].map((f) => button({ 'data-filter': f }, f));
  const docListeners = {};
  Object.assign(env, {
    document: {
      hidden: false,
      getElementById: env.el,
      querySelector: () => ({ onclick: null }),
      querySelectorAll: (sel) => (sel === '.time-filter-btn' ? env.buttons : sel === '.origin-filter-btn' ? env.originButtons : []),
      addEventListener: (e, f) => { docListeners[e] = f; },
      createElement: () => ({ insertRow: () => ({ insertCell: () => ({}) }) })
    },
    history: { replaceState: (s, t, url) => env.urls.push(url) },
    Plotly: {
      react: (id, data, layout) => {
        const e = env.el(id);
        e.on = function (name, f) { this.handlers[name] = f; };
        e.data = data; e.layout = JSON.parse(JSON.stringify(layout));
        e.legend = data.filter((t) => t.showlegend !== false).map((t, i) => legendNode(e, i));
        return Promise.resolve(e);
      },
      restyle: (id, update) => { env.lastRestyle = update; return Promise.resolve(); }
    },
    fetch: async (url) => { env.fetched.push(url); const r = env.fetchResponses.shift(); return r instanceof Promise ? r : r; },
    setInterval: (f, ms) => { env.timers.push({ f, ms, active: true }); return env.timers.length; },
    clearInterval: (id) => { if (id) env.timers[id - 1].active = false; },
    encodeURIComponent, console
  });
  env.window = env;
  // the page's chart handle, for building a refresh response
  env.payload = () => JSON.parse(JSON.stringify(vm.runInNewContext('chart.payload()', env)));
  return env;
}
function legendNode(plotEl, i) {
  const node = { i, closest: (sel) => (sel === 'g.traces' ? node : sel === '.legend' ? plotEl : null) };
  return node;
}
function legendItem(env, plotEl, i) { return plotEl.legend[i]; }
function json(body) { return { redirected: false, ok: true, status: 200, headers: { get: () => 'application/json; charset=utf-8' }, json: async () => body }; }
function deferred() { let resolve; const promise = new Promise((r) => { resolve = r; }); return { promise, resolve }; }
function flush() { return new Promise((r) => setImmediate(r)); }
