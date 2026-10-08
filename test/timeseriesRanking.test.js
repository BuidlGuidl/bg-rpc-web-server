// IP Timeseries ranking with a full top 30: completed hours plus the hour in progress, so a caller busy
// right now shows up within a minute instead of once its hour is written to history.
// Run: node test/timeseriesRanking.test.js
const assert = require('assert');
const edgeDb = require('../utils/edgeDb');

const HOUR = 3600;
const LATEST = 1790845200;
const queries = [];
// h1..h30 with 100..71 requests in the newest completed hour; small.one with 5
const historyRows = Array.from({ length: 30 }, (_, i) => ({ hour_timestamp: String(LATEST), ip: `h${i + 1}`, request_count: 100 - i, origins: {} }))
  .concat([{ hour_timestamp: String(LATEST - HOUR), ip: 'small.one', request_count: 5, origins: {} }]);
let liveRows = [];
edgeDb.query = async (sql, params) => {
  queries.push({ sql, params });
  if (/MAX\(hour_timestamp\)/.test(sql)) return { rows: [{ hour: String(LATEST) }] };
  if (/FROM ip_table/.test(sql)) return { rows: liveRows };
  const inWindow = historyRows.filter((r) => Number(r.hour_timestamp) >= params[0]);
  if (/LIMIT/.test(sql)) {
    const totals = new Map();
    inWindow.forEach((r) => totals.set(r.ip, (totals.get(r.ip) || 0) + r.request_count));
    return { rows: [...totals].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1)).slice(0, 30).map(([ip, total]) => ({ ip, total: String(total) })) };
  }
  return { rows: inWindow.filter((r) => params[1].includes(r.ip)) };
};
let clock = (LATEST + HOUR + 20 * 60) * 1000;
Date.now = () => clock;
const { getTimeseries } = require('../utils/edgeTimeseries');
const live = (ip, n) => ({ ip, requests_last_hour: n, origins_last_hour: {}, last_reset_timestamp: String(LATEST + HOUR) });

(async () => {
  // new.busy: 500 now, no history → in at the top. small.one: 5 in history + 80 now = 85 → in.
  // new.quiet: 10 now, under the 30th place (71) → not considered. h29 (72) and h30 (71) drop out.
  liveRows = [live('new.busy', 500), live('small.one', 80), live('new.quiet', 10)];
  let r = await getTimeseries('ip', 1);
  const keys = r.series.map((s) => s.key);
  assert.strictEqual(keys.length, 30);
  assert.strictEqual(keys[0], 'new.busy', 'busy right now: ranked first within a minute');
  assert.ok(keys.includes('small.one'), 'history plus the hour in progress beats the 30th place');
  assert.ok(!keys.includes('new.quiet') && !keys.includes('h29') && !keys.includes('h30'));
  assert.deepStrictEqual(r.hours, [new Date((LATEST - HOUR) * 1000).toISOString(), new Date(LATEST * 1000).toISOString()], 'hours of both sets');
  assert.deepStrictEqual(r.series.find((s) => s.key === 'small.one').countsTotal, [5, 0]);
  assert.deepStrictEqual(r.series.find((s) => s.key === 'h1').countsTotal, [0, 100], 'aligned to the shared hours');
  assert.deepStrictEqual(r.series.find((s) => s.key === 'new.busy').countsTotal, [0, 0]);
  assert.strictEqual(r.live.byKey['new.busy'].total, 500);

  // a key whose count in the hour in progress doesn't beat the 30th place isn't fetched
  clock += 31 * 1000;
  liveRows = [live('tiny', 1)];
  queries.length = 0;
  r = await getTimeseries('ip', 1);
  assert.ok(!r.series.some((s) => s.key === 'tiny'));
  assert.strictEqual(queries.length, 2, 'only the newest-hour check and live counters: no series fetch for tiny');

  // the same newcomers a minute later: their series is cached until a new hour completes
  clock += 31 * 1000;
  liveRows = [live('new.busy', 600), live('small.one', 90), live('new.quiet', 12)];
  await getTimeseries('ip', 1); // first time this set of keys
  clock += 31 * 1000;
  queries.length = 0;
  r = await getTimeseries('ip', 1);
  assert.strictEqual(queries.length, 2, 'series for the same newcomers come from the cache');
  assert.strictEqual(r.series[0].key, 'new.busy');

  console.log('timeseriesRanking: all passed');
})().catch((e) => { console.error(e); process.exit(1); });
