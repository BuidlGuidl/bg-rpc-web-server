const express = require('express');
// Counts on this page are request units from the edge proxy's rate limiter (the shared cost
// table, getLogs plan D17), not raw requests like the dashboard: most calls 1, eth_getLogs
// 2-11 by block range, blocks and block receipts 2, eth_feeHistory / eth_getProof by size
// (eth_getLogs was 100 before 2026-09-28). The edge doesn't count buidlguidl-client traffic,
// requests it rejects, or requests served by the fallback.
const router = express.Router();
const axios = require('axios');
const { IP_MODAL_STYLES, IP_MODAL_MARKUP, IP_MODAL_SCRIPT } = require('../utils/ipInfoModal');

require('dotenv').config();

// Origins and IPs come from callers: escaped. An origin links to its site in a new tab (the edge stores
// origins without the scheme, so https:// is added); anything that isn't a plain host[:port] stays text.
// An IP opens the IP information popup (utils/ipInfoModal.js), as on the IP Timeseries page.
function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}
function originLink(origin) {
  const host = String(origin).replace(/^https?:\/\//i, '');
  if (!/^[a-z0-9.-]+(:\d+)?$/i.test(host)) return escapeHtml(origin);
  return `<a href="https://${escapeHtml(host)}" target="_blank" rel="noopener noreferrer">${escapeHtml(origin)}</a>`;
}
function ipLink(ip) {
  return `<a href="#" class="ip-link" onclick="fetchIpInfo(${escapeHtml(JSON.stringify(String(ip)))}); return false;">${escapeHtml(ip)}</a>`;
}

// A usage cell with a light progress bar behind the text: the share of the limit used, green under
// 50%, yellow from 50%, red from 80% (full and red at or past the limit). percent is a number, or
// '-' when the limit isn't known (no bar).
function usageCell(value, percent) {
  const share = Number(percent);
  if (!Number.isFinite(share)) return `<td><strong>${value}</strong> <span class="percent">(${percent}%)</span></td>`;
  const width = Math.max(0, Math.min(100, share));
  const color = share >= 80 ? '#f8d7da' : share >= 50 ? '#fff3cd' : '#d4edda';
  const bar = `background: linear-gradient(to right, ${color} ${width}%, transparent ${width}%);`;
  return `<td class="usage-cell" style="${bar}" title="${percent}% of the limit"><strong>${value}</strong> <span class="percent">(${percent}%)</span></td>`;
}

router.get("/ratelimitstatus", async (req, res) => {
  try {
    const proxyHost = process.env.RPC_PROXY_HOST;
    const adminKey = process.env.RPC_PROXY_ADMIN_KEY;

    if (!proxyHost || !adminKey) {
      throw new Error('RPC_PROXY_HOST or RPC_PROXY_ADMIN_KEY not configured');
    }

    const response = await axios.get(`${proxyHost}/ratelimitstatus`, {
      headers: {
        'X-Admin-Key': adminKey
      }
    });

    const data = response.data;

    // Build origins table rows
    let originsRows = '';
    if (data.origins && typeof data.origins === 'object') {
      for (const [origin, stats] of Object.entries(data.origins)) {
        const hourlyPercent = data.config?.originRateLimitPerHour 
          ? ((stats.effectiveHourly / data.config.originRateLimitPerHour) * 100).toFixed(1) 
          : '-';
        const dailyPercent = data.config?.originRateLimitPerDay 
          ? ((stats.daily / data.config.originRateLimitPerDay) * 100).toFixed(1) 
          : '-';
        originsRows += `
          <tr class="${stats.hourlyBlocked || stats.dailyBlocked ? 'blocked-row' : ''}">
            <td class="origin-cell">${originLink(origin)}</td>
            <td>${stats.currentHour}</td>
            <td>${stats.previousHour}</td>
            ${usageCell(stats.effectiveHourly, hourlyPercent)}
            <td class="${stats.hourlyBlocked ? 'blocked' : 'ok'}">${stats.hourlyBlocked ? '🚫 YES' : '✅ No'}</td>
            ${usageCell(stats.daily, dailyPercent)}
            <td class="${stats.dailyBlocked ? 'blocked' : 'ok'}">${stats.dailyBlocked ? '🚫 YES' : '✅ No'}</td>
          </tr>
        `;
      }
    }

    // Build IPs table rows
    let ipsRows = '';
    if (data.ips && typeof data.ips === 'object') {
      for (const [ip, stats] of Object.entries(data.ips)) {
        const hourlyPercent = data.config?.ipRateLimitPerHour 
          ? ((stats.effectiveHourly / data.config.ipRateLimitPerHour) * 100).toFixed(1) 
          : '-';
        const dailyPercent = data.config?.ipRateLimitPerDay 
          ? ((stats.daily / data.config.ipRateLimitPerDay) * 100).toFixed(1) 
          : '-';
        ipsRows += `
          <tr class="${stats.hourlyBlocked || stats.dailyBlocked ? 'blocked-row' : ''}">
            <td class="ip-cell">${ipLink(ip)}</td>
            <td>${stats.currentHour}</td>
            <td>${stats.previousHour}</td>
            ${usageCell(stats.effectiveHourly, hourlyPercent)}
            <td class="${stats.hourlyBlocked ? 'blocked' : 'ok'}">${stats.hourlyBlocked ? '🚫 YES' : '✅ No'}</td>
            ${usageCell(stats.daily, dailyPercent)}
            <td class="${stats.dailyBlocked ? 'blocked' : 'ok'}">${stats.dailyBlocked ? '🚫 YES' : '✅ No'}</td>
          </tr>
        `;
      }
    }

    res.send(`
      <html>
        <head>
          <title>Rate Limit Status</title>
          <style>
            body { 
              font-family: Arial, sans-serif;
              margin: 0px;
            }
            .container {
              max-width: 1800px;
              margin: 0 auto;
              padding: 0 20px;
            }
            h1 { 
              color: #333;
              margin-bottom: 10px;
              padding: 0px 20px;
            }
            h2 {
              color: #444;
              margin-top: 30px;
              margin-bottom: 15px;
              border-bottom: 2px solid #667eea;
              padding-bottom: 5px;
            }
            
            /* Info cards */
            .info-section {
              display: flex;
              flex-wrap: wrap;
              gap: 20px;
              margin-bottom: 30px;
            }
            .info-card {
              background: #f8f9fa;
              border: 1px solid #e9ecef;
              border-radius: 8px;
              padding: 15px 20px;
              min-width: 200px;
              flex: 1;
            }
            .info-card h3 {
              margin: 0 0 10px 0;
              color: #495057;
              font-size: 14px;
              text-transform: uppercase;
              letter-spacing: 0.5px;
            }
            .info-card .value {
              font-size: 24px;
              font-weight: bold;
              color: #333;
            }
            .info-card .sub-value {
              font-size: 13px;
              color: #6c757d;
              margin-top: 5px;
            }
            .info-card.warning {
              background: #fff3cd;
              border-color: #ffc107;
            }
            .info-card.danger {
              background: #f8d7da;
              border-color: #dc3545;
            }
            .info-card.success {
              background: #d4edda;
              border-color: #28a745;
            }
            
            /* Summary stats */
            .summary-grid {
              display: grid;
              grid-template-columns: repeat(auto-fit, minmax(150px, 1fr));
              gap: 10px;
              margin-bottom: 20px;
            }
            .stat-box {
              background: #f8f9fa;
              border: 1px solid #dee2e6;
              border-radius: 6px;
              padding: 12px;
              text-align: center;
            }
            .stat-box .label {
              font-size: 11px;
              color: #6c757d;
              text-transform: uppercase;
            }
            .stat-box .number {
              font-size: 20px;
              font-weight: bold;
              color: #333;
            }
            .stat-box.blocked .number {
              color: #dc3545;
            }
            
            /* Config display */
            .config-grid {
              display: grid;
              grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
              gap: 10px;
              background: #e9ecef;
              padding: 15px;
              border-radius: 8px;
              margin-bottom: 20px;
            }
            .config-item {
              font-size: 13px;
            }
            .config-item .config-label {
              color: #6c757d;
            }
            .config-item .config-value {
              font-weight: bold;
              color: #333;
            }
            
            /* Tables */
            table { 
              font-size: 14px;
              width: 100%;
              margin: 15px 0 30px 0;
              border-collapse: collapse;
            }
            th, td { 
              padding: 10px 12px;
              text-align: left;
              vertical-align: middle;
              border: 1px solid #ddd;
            }
            th {
              background-color: #f2f2f2;
              font-weight: bold;
              white-space: nowrap;
            }
            tr:nth-child(even) { 
              background-color: #f9f9f9;
            }
            tr:hover { 
              background-color: rgb(227, 227, 227);
            }
            .blocked-row {
              background-color: #f8d7da !important;
            }
            .blocked {
              color: #dc3545;
              font-weight: bold;
            }
            .ok {
              color: #28a745;
            }
            .origin-cell, .ip-cell {
              font-family: monospace;
              font-size: 13px;
            }
            .origin-cell a, .ip-cell a {
              color: #0066cc;
              text-decoration: none;
            }
            .origin-cell a:hover, .ip-cell a:hover {
              text-decoration: underline;
            }
            ${IP_MODAL_STYLES}
            .percent {
              color: #6c757d;
              font-size: 12px;
            }
            
            /* Buttons */
            .refresh-btn {
              margin: 0 20px 20px 20px;
              padding: 10px 20px;
              background-color: #667eea;
              color: white;
              border: none;
              border-radius: 5px;
              cursor: pointer;
              font-size: 14px;
            }
            .refresh-btn:hover {
              background-color: #5568d3;
            }
            
            /* Timestamp */
            .timestamp {
              color: #6c757d;
              font-size: 12px;
              margin-left: 20px;
            }
            
            /* Empty state */
            .empty-message {
              color: #6c757d;
              font-style: italic;
              padding: 20px;
              text-align: center;
              background: #f8f9fa;
              border-radius: 8px;
            }
          </style>
        </head>
        <body>
          <h1>🚦 Rate Limit Status</h1>
          <button class="refresh-btn" onclick="location.reload()">↻ Refresh</button>
          <span class="timestamp">Last updated: ${data.timestamp ? new Date(data.timestamp).toLocaleString() : 'N/A'}</span>
          
          <div class="container">
            <!-- Time Info Cards -->
            <div class="info-section">
              <div class="info-card">
                <h3>⏱️ Sliding Window</h3>
                <div class="value">${data.slidingWindow?.minutesIntoHour || 0} min</div>
                <div class="sub-value">Previous hour weight: ${((data.slidingWindow?.previousHourWeight || 0) * 100).toFixed(1)}%</div>
              </div>
              <div class="info-card">
                <h3>🔄 Hourly Reset In</h3>
                <div class="value">${data.timeUntilReset?.hourlyMinutes || 0} min</div>
                <div class="sub-value">${data.timeUntilReset?.hourlySeconds || 0} seconds</div>
              </div>
              <div class="info-card">
                <h3>📅 Daily Reset In</h3>
                <div class="value">${(data.timeUntilReset?.dailyHours || 0).toFixed(1)} hrs</div>
                <div class="sub-value">${data.timeUntilReset?.dailySeconds || 0} seconds</div>
              </div>
              <div class="info-card ${data.pollErrors > 0 ? 'warning' : 'success'}">
                <h3>📡 Poll Status</h3>
                <div class="value">${data.pollErrors || 0} errors</div>
                <div class="sub-value">Last: ${data.lastPollTime ? new Date(data.lastPollTime).toLocaleTimeString() : 'N/A'}</div>
              </div>
            </div>

            <!-- Summary Stats -->
            <h2>📊 Summary</h2>
            <div class="summary-grid">
              <div class="stat-box ${data.summary?.hourlyBlockedOrigins > 0 ? 'blocked' : ''}">
                <div class="label">Hourly Blocked Origins</div>
                <div class="number">${data.summary?.hourlyBlockedOrigins || 0}</div>
              </div>
              <div class="stat-box ${data.summary?.hourlyBlockedIPs > 0 ? 'blocked' : ''}">
                <div class="label">Hourly Blocked IPs</div>
                <div class="number">${data.summary?.hourlyBlockedIPs || 0}</div>
              </div>
              <div class="stat-box ${data.summary?.dailyBlockedOrigins > 0 ? 'blocked' : ''}">
                <div class="label">Daily Blocked Origins</div>
                <div class="number">${data.summary?.dailyBlockedOrigins || 0}</div>
              </div>
              <div class="stat-box ${data.summary?.dailyBlockedIPs > 0 ? 'blocked' : ''}">
                <div class="label">Daily Blocked IPs</div>
                <div class="number">${data.summary?.dailyBlockedIPs || 0}</div>
              </div>
              <div class="stat-box">
                <div class="label">Tracked Origins</div>
                <div class="number">${data.summary?.totalTrackedOrigins || 0}</div>
              </div>
              <div class="stat-box">
                <div class="label">Tracked IPs</div>
                <div class="number">${data.summary?.totalTrackedIPs || 0}</div>
              </div>
            </div>

            <!-- Rate Limit Config -->
            <h2>⚙️ Configuration</h2>
            <div class="config-grid">
              <div class="config-item">
                <span class="config-label">Origin Hourly Limit:</span>
                <span class="config-value">${data.config?.originRateLimitPerHour?.toLocaleString() || 'N/A'} request units</span>
              </div>
              <div class="config-item">
                <span class="config-label">Origin Daily Limit:</span>
                <span class="config-value">${data.config?.originRateLimitPerDay?.toLocaleString() || 'N/A'} request units</span>
              </div>
              <div class="config-item">
                <span class="config-label">IP Hourly Limit:</span>
                <span class="config-value">${data.config?.ipRateLimitPerHour?.toLocaleString() || 'N/A'} request units</span>
              </div>
              <div class="config-item">
                <span class="config-label">IP Daily Limit:</span>
                <span class="config-value">${data.config?.ipRateLimitPerDay?.toLocaleString() || 'N/A'} request units</span>
              </div>
              <div class="config-item">
                <span class="config-label">Poll Interval:</span>
                <span class="config-value">${data.config?.rateLimitPollInterval || 'N/A'}s</span>
              </div>
            </div>

            <!-- Origins Table -->
            <h2>🌐 Origins (${Object.keys(data.origins || {}).length})</h2>
            ${originsRows ? `
              <table>
                <thead>
                  <tr>
                    <th>Origin</th>
                    <th>Current Hour (request units)</th>
                    <th>Previous Hour (request units)</th>
                    <th>Effective Hourly (request units)</th>
                    <th>Hourly Blocked</th>
                    <th>Daily (request units)</th>
                    <th>Daily Blocked</th>
                  </tr>
                </thead>
                <tbody>
                  ${originsRows}
                </tbody>
              </table>
            ` : '<div class="empty-message">No origins tracked</div>'}

            <!-- IPs Table -->
            <h2>🔢 IP Addresses (${Object.keys(data.ips || {}).length})</h2>
            ${ipsRows ? `
              <table>
                <thead>
                  <tr>
                    <th>IP Address</th>
                    <th>Current Hour (request units)</th>
                    <th>Previous Hour (request units)</th>
                    <th>Effective Hourly (request units)</th>
                    <th>Hourly Blocked</th>
                    <th>Daily (request units)</th>
                    <th>Daily Blocked</th>
                  </tr>
                </thead>
                <tbody>
                  ${ipsRows}
                </tbody>
              </table>
            ` : '<div class="empty-message">No IPs tracked</div>'}
          </div>
          ${IP_MODAL_MARKUP}
          <script>
            ${IP_MODAL_SCRIPT}
          </script>
        </body>
      </html>
    `);
  } catch (error) {
    console.error('Error fetching rate limit status:', error);
    res.status(500).send(`
      <html>
        <head>
          <title>Error - Rate Limit Status</title>
          <style>
            body { padding: 20px; font-family: Arial, sans-serif; margin: 0; }
            .error { color: red; }
            h1 { padding: 0 20px; }
          </style>
        </head>
        <body>
          <h1>Error Fetching Rate Limit Status</h1>
          <p class="error">${error.message}</p>
          <p>Please try refreshing the page.</p>
        </body>
      </html>
    `);
  }
});

module.exports = router;
