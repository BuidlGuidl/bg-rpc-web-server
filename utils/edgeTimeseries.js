// Data for the IP and Origin Timeseries pages, from the edge's database (utils/edgeDb.js), cached so
// that the database sees the same small load however many pages are open or how often they refresh:
//   - completed hours (ip_history_table): the edge writes each hour's rows once, when the hour ends,
//     and never changes them. A page's result is reused until a newer hour appears; checking for one
//     is a one-row index lookup, done at most every 30 s.
//   - the hour in progress (ip_table *_last_hour counters, updated by the edge every 10 s): one query
//     at most every 30 s, shared by both pages. It reads only rows the edge wrote in the last 2 hours,
//     through the updated_at index (a plain requests_last_hour > 0 filter would scan the whole table).
// Concurrent requests for the same data share one query.
const edgeDb = require('./edgeDb');

const ALLOWED_DAYS = [1, 3, 7, 14, 30];
const TOP_N = 30;
const HOUR_S = 3600;
const CHECK_TTL_MS = 30 * 1000;

// A cached async value: reloaded at most every ttlMs; callers in the meantime share it
function cached(ttlMs, load) {
  let entry = null; // { at, promise }
  return function get() {
    if (entry && Date.now() - entry.at < ttlMs) return entry.promise;
    const promise = load();
    entry = { at: Date.now(), promise };
    promise.catch(() => { if (entry && entry.promise === promise) entry = null; });
    return promise;
  };
}

// Newest completed hour in ip_history_table (epoch seconds), or null
const latestHistoryHour = cached(CHECK_TTL_MS, async () => {
  const { rows } = await edgeDb.query('SELECT MAX(hour_timestamp) AS hour FROM ip_history_table');
  return rows[0].hour === null ? null : Number(rows[0].hour);
});

// The edge's counters for the hour in progress: { hour (epoch seconds) | null, rows, asOf (ms) }.
// Every counter belongs to the hour in its row's last_reset_timestamp (the edge stamps all rows at
// its hourly reset, and new IPs with the current hour), so the newest stamp is the live hour.
const liveCounters = cached(CHECK_TTL_MS, async () => {
  const { rows } = await edgeDb.query(
    `SELECT ip, requests_last_hour, origins_last_hour, last_reset_timestamp
       FROM ip_table
      WHERE updated_at >= NOW() - INTERVAL '2 hours' AND requests_last_hour > 0`
  );
  const hour = rows.reduce((max, row) => Math.max(max, Number(row.last_reset_timestamp)), -Infinity);
  return {
    hour: Number.isFinite(hour) ? hour : null,
    rows: rows.filter(row => Number(row.last_reset_timestamp) === hour),
    asOf: Date.now()
  };
});

const originTotal = (origins) => Object.values(origins || {}).reduce((sum, count) => sum + Number(count), 0);
const isoHour = (hourS) => new Date(hourS * 1000).toISOString();

// Top IPs over the window and their hourly series: total, from requests with an origin, without
async function loadIpHistory(cutoff) {
  const top = await edgeDb.query(
    `SELECT ip, SUM(request_count) AS total
       FROM ip_history_table
      WHERE hour_timestamp >= $1
      GROUP BY ip
      ORDER BY total DESC, ip
      LIMIT ${TOP_N}`,
    [cutoff]
  );
  const keys = top.rows.map(row => row.ip);
  if (keys.length === 0) return { hours: [], series: [] };
  const { rows } = await edgeDb.query(
    `SELECT hour_timestamp, ip, request_count, origins
       FROM ip_history_table
      WHERE hour_timestamp >= $1 AND ip = ANY($2)
      ORDER BY hour_timestamp, ip`,
    [cutoff, keys]
  );
  const byKey = new Map(keys.map(key => [key, new Map()]));
  const hourSet = new Set();
  rows.forEach(row => {
    const hour = Number(row.hour_timestamp);
    const total = Number(row.request_count);
    const withOrigin = originTotal(row.origins);
    hourSet.add(hour);
    byKey.get(row.ip).set(hour, { total, withOrigin, withoutOrigin: total - withOrigin });
  });
  const hours = [...hourSet].sort((a, b) => a - b);
  return {
    hours,
    series: keys.map(ip => {
      const points = hours.map(hour => byKey.get(ip).get(hour) || { total: 0, withOrigin: 0, withoutOrigin: 0 });
      return {
        key: ip,
        countsTotal: points.map(p => p.total),
        countsWithOrigin: points.map(p => p.withOrigin),
        countsWithoutOrigin: points.map(p => p.withoutOrigin)
      };
    })
  };
}

// Top origins over the window (summed over all IPs) and their hourly series
async function loadOriginHistory(cutoff) {
  const top = await edgeDb.query(
    `SELECT origin_key AS origin, SUM(origin_value::bigint) AS total
       FROM ip_history_table, jsonb_each_text(origins) AS origin_data(origin_key, origin_value)
      WHERE hour_timestamp >= $1
      GROUP BY origin_key
      ORDER BY total DESC, origin_key
      LIMIT ${TOP_N}`,
    [cutoff]
  );
  const keys = top.rows.map(row => row.origin);
  if (keys.length === 0) return { hours: [], series: [] };
  const { rows } = await edgeDb.query(
    `SELECT hour_timestamp, origin_key AS origin, SUM(origin_value::bigint) AS request_count
       FROM ip_history_table, jsonb_each_text(origins) AS origin_data(origin_key, origin_value)
      WHERE hour_timestamp >= $1 AND origin_key = ANY($2)
      GROUP BY hour_timestamp, origin_key
      ORDER BY hour_timestamp, origin_key`,
    [cutoff, keys]
  );
  const byKey = new Map(keys.map(key => [key, new Map()]));
  const hourSet = new Set();
  rows.forEach(row => {
    const hour = Number(row.hour_timestamp);
    hourSet.add(hour);
    byKey.get(row.origin).set(hour, Number(row.request_count));
  });
  const hours = [...hourSet].sort((a, b) => a - b);
  return { hours, series: keys.map(origin => ({ key: origin, counts: hours.map(hour => byKey.get(origin).get(hour) || 0) })) };
}

const KINDS = {
  ip: {
    loadHistory: loadIpHistory,
    // live counts for the shown IPs, in the same shape as a history point
    live: (rows, keys) => {
      const byIp = new Map(rows.map(row => [row.ip, row]));
      return Object.fromEntries(keys.map(ip => {
        const row = byIp.get(ip);
        const total = row ? Number(row.requests_last_hour) : 0;
        const withOrigin = row ? originTotal(row.origins_last_hour) : 0;
        return [ip, { total, withOrigin, withoutOrigin: total - withOrigin }];
      }));
    }
  },
  origin: {
    loadHistory: loadOriginHistory,
    live: (rows, keys) => {
      const counts = Object.fromEntries(keys.map(origin => [origin, 0]));
      rows.forEach(row => Object.entries(row.origins_last_hour || {}).forEach(([origin, count]) => {
        if (origin in counts) counts[origin] += Number(count);
      }));
      return counts;
    }
  }
};

const historyCache = new Map(); // `${kind}:${days}` -> { latest, promise }

function history(kind, days, latest) {
  const cacheKey = `${kind}:${days}`;
  const hit = historyCache.get(cacheKey);
  if (hit && hit.latest === latest) return hit.promise;
  // The window: the last `days` days of completed hours, ending at the newest one
  const cutoff = latest === null ? 0 : latest + HOUR_S - days * 24 * HOUR_S;
  const promise = KINDS[kind].loadHistory(cutoff);
  historyCache.set(cacheKey, { latest, promise });
  promise.catch(() => { if (historyCache.get(cacheKey)?.promise === promise) historyCache.delete(cacheKey); });
  return promise;
}

/**
 * One page's data: { days, hours (ISO), series, live, asOf }. series: the top 30 (IP or origin) over
 * the window, in rank order. live: { hour (ISO), byKey } for the hour in progress, or null (shown
 * only when newer than the newest completed hour, so an hour the edge is just moving into history
 * isn't counted twice).
 */
async function getTimeseries(kind, days) {
  if (!KINDS[kind]) throw new Error(`unknown kind ${kind}`);
  if (!ALLOWED_DAYS.includes(days)) throw new Error(`days must be one of ${ALLOWED_DAYS.join(', ')}`);
  const latest = await latestHistoryHour();
  const [past, current] = await Promise.all([history(kind, days, latest), liveCounters()]);
  const keys = past.series.map(s => s.key);
  const live = current.hour !== null && (latest === null || current.hour > latest) && keys.length
    ? { hour: isoHour(current.hour), byKey: KINDS[kind].live(current.rows, keys) }
    : null;
  return { days, hours: past.hours.map(isoHour), series: past.series, live, asOf: current.asOf };
}

module.exports = { getTimeseries, ALLOWED_DAYS, TOP_N };
