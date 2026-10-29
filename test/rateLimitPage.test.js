// Rate Limits page: the edge's burst limits section (rpc-ssl-proxy utils/burstLimiter.js), drawn
// from the edge's /ratelimitstatus "burst"; an edge without it gets a note, the rest of the page as before.
// Run: node test/rateLimitPage.test.js
const assert = require('assert');
const axios = require('axios');

process.env.RPC_PROXY_HOST = 'https://edge.test';
process.env.RPC_PROXY_ADMIN_KEY = 'k';
const router = require('../routes/ratelimitstatus');

const base = {
  timestamp: '2026-10-15T21:00:00.000Z',
  config: { originRateLimitPerHour: 4000, originRateLimitPerDay: 40000, ipRateLimitPerHour: 1000, ipRateLimitPerDay: 5000 },
  origins: { 'app.example.com': { currentHour: 10, previousHour: 5, effectiveHourly: 12, daily: 20 } },
  ips: {}
};
const burst = {
  mode: 'log',
  limits: {
    origin: { bucketSize: 300, refillPerSecond: 30, maxInFlight: 50, maxGetLogsInFlight: 4 },
    ip: { bucketSize: 200, refillPerSecond: 20, maxInFlight: 20, maxGetLogsInFlight: 4 }
  },
  since: '2026-10-15T20:00:00.000Z',
  callersTracked: 3,
  totals: { admitted: 1234, refused: 24, bucket: 6, inFlight: 18, getLogs: 0 },
  topRefused: [
    { key: 'ip:1.2.3.4', refused: 18, byCheck: { bucket: 0, inFlight: 18, getLogs: 0 } },
    { key: 'origin:burst.example.com', refused: 6, byCheck: { bucket: 6, inFlight: 0, getLogs: 0 } },
    { key: 'origin:<script>x</script>', refused: 1, byCheck: { bucket: 1, inFlight: 0, getLogs: 0 } }
  ]
};

async function render(payload) {
  const realGet = axios.get;
  let asked = null;
  axios.get = async (url, opts) => { asked = { url, opts }; return { data: payload }; };
  try {
    const layer = router.stack.find(l => l.route && l.route.path === '/ratelimitstatus');
    let html = null;
    let status = 200;
    const res = { status(c) { status = c; return res; }, send(b) { html = b; return res; } };
    await layer.route.stack[0].handle({}, res);
    return { html, status, asked };
  } finally {
    axios.get = realGet;
  }
}

(async () => {
  // Log mode: section with mode, numbers, totals, callers refused most
  {
    const { html, status, asked } = await render({ ...base, burst });
    assert.strictEqual(status, 200);
    assert.strictEqual(asked.url, 'https://edge.test/ratelimitstatus');
    assert.strictEqual(asked.opts.headers['X-Admin-Key'], 'k');
    assert.ok(html.includes('🪣 Burst Limits (log only)'));
    assert.ok(html.includes('Log only (nothing refused)'));
    assert.ok(html.includes('300 units, +30/s · 50 in flight · 4 getLogs in flight'));
    assert.ok(html.includes('200 units, +20/s · 20 in flight · 4 getLogs in flight'));
    assert.ok(html.includes('<div class="label">Would refuse</div><div class="number">24</div>'));
    assert.ok(html.includes('<div class="label">Admitted</div><div class="number">1,234</div>'));
    assert.ok(html.includes('<th>Would refuse (requests)</th>'));
    assert.ok(html.includes(`fetchIpInfo(&quot;1.2.3.4&quot;)`), 'IP opens the IP popup');
    assert.ok(html.includes('href="https://burst.example.com"'), 'origin links to its site');
    assert.ok(!html.includes('<script>x</script>') && html.includes('&lt;script&gt;x&lt;/script&gt;'), 'caller keys are escaped');
    assert.ok(html.indexOf('🪣 Burst Limits') < html.indexOf('🌐 Origins'), 'before the origins table');
    assert.ok(html.includes('app.example.com'), 'the rest of the page is unchanged');
  }

  // Enforce mode, nobody refused
  {
    const { html } = await render({ ...base, burst: { ...burst, mode: 'enforce', totals: { admitted: 5, refused: 0 }, topRefused: [] } });
    assert.ok(html.includes('<h2>🪣 Burst Limits</h2>'));
    assert.ok(html.includes('Enforcing'));
    assert.ok(html.includes('<div class="label">Refused</div><div class="number">0</div>'));
    assert.ok(html.includes('No caller has been refused since the edge started'));
  }

  // An edge without burst limits: a note, the page still renders
  {
    const { html, status } = await render(base);
    assert.strictEqual(status, 200);
    assert.ok(html.includes('The edge reports no burst limits'));
    assert.ok(html.includes('app.example.com'));
  }

  console.log('rateLimitPage: all checks passed');
})().catch(err => { console.error(err); process.exit(1); });
