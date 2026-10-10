const express = require('express');
const router = express.Router();
const { getTimeseries, ALLOWED_DAYS } = require('../utils/edgeTimeseries');
const { timeseriesClient } = require('../utils/timeseriesClient');
const { lookupIp } = require('../utils/ipLookup');
const { IP_MODAL_STYLES, IP_MODAL_MARKUP, IP_MODAL_SCRIPT } = require('../utils/ipInfoModal');

// Top 30 IPs by request units, hourly, from the edge's database (utils/edgeTimeseries.js: cached,
// read-only, so the edge's own use of the database comes first). The page redraws once a minute.

const parseDays = (value) => (ALLOWED_DAYS.includes(parseInt(value)) ? parseInt(value) : 1);

// JSON safe inside a <script> tag (and never containing '<html', which the navbar middleware looks for)
function safeJson(value) {
  return JSON.stringify(value).replace(/\//g, '\\/').replace(/</g, '\\u003c').replace(/>/g, '\\u003e');
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

// API endpoint for IP lookup
router.get("/iptimeseries/lookup/:ip", async (req, res) => {
  try {
    const ip = req.params.ip;
    const ipInfo = await lookupIp(ip);
    res.json(ipInfo);
  } catch (error) {
    console.error('Error in IP lookup endpoint:', error);
    res.status(500).json({ error: error.message });
  }
});

// The page polls this once a minute (and on a day button)
router.get("/iptimeseries/data", async (req, res) => {
  try {
    const data = await getTimeseries('ip', parseDays(req.query.days));
    res.set('Cache-Control', 'no-store');
    res.type('application/json').send(safeJson(data));
  } catch (error) {
    console.error('Error fetching IP timeseries data:', error.message);
    res.status(502).json({ error: 'edge database unavailable' });
  }
});

router.get("/iptimeseries", async (req, res) => {
  try {
    const initialPayload = safeJson(await getTimeseries('ip', parseDays(req.query.days)));

    res.send(`
      <html>
        <head>
          <title>IP Timeseries</title>
          <script src="https://cdn.plot.ly/plotly-latest.min.js"></script>
          <style>
            html, body { 
              font-family: Arial, sans-serif;
              margin: 0;
              padding: 0;
              height: 100%;
              overflow: hidden;
            }
            body {
              display: flex;
              flex-direction: column;
            }
            .header-container {
              display: flex;
              justify-content: space-between;
              align-items: center;
              padding: 15px 20px;
              flex-shrink: 0;
              background-color: #f8f9fa;
              border-bottom: 1px solid #e0e0e0;
            }
            h1 {
              color: #333;
              margin: 0;
            }
            .controls {
              display: flex;
              gap: 20px;
              align-items: center;
            }
            .time-filter-btn, .origin-filter-btn {
              padding: 8px 16px;
              margin: 0 5px;
              border: 1px solid #ccc;
              background-color: white;
              border-radius: 4px;
              cursor: pointer;
              font-size: 14px;
              transition: all 0.2s;
            }
            .time-filter-btn:hover, .origin-filter-btn:hover {
              background-color: #f0f0f0;
            }
            .time-filter-btn.active {
              background-color: #1f77b4;
              color: white;
              border-color: #1f77b4;
            }
            .origin-filter-btn.active {
              background-color: #2ca02c;
              color: white;
              border-color: #2ca02c;
            }
            .filter-group {
              display: flex;
              gap: 5px;
              align-items: center;
            }
            .filter-group .filter-label {
              margin-right: 5px;
            }
            .filter-label {
              font-weight: bold;
              color: #555;
              font-size: 14px;
            }
            #ipTimeseriesPlot {
              width: 100%;
              flex: 1;
              min-height: 0;
            }
            ${IP_MODAL_STYLES}
            .timeseries-status {
              color: #666;
              font-size: 13px;
              margin-top: 4px;
            }
            .timeseries-status.problem {
              color: #d9534f;
            }
          </style>
        </head>
        <body>
          <div class="header-container">
            <div>
              <h1>IP Request Units Timeseries - Top 30 IPs</h1>
              <div id="timeseries-status" class="timeseries-status"></div>
            </div>
            <div class="controls">
              <div class="filter-group">
                <span class="filter-label">Origin:</span>
                <button class="origin-filter-btn active" data-filter="all">All</button>
                <button class="origin-filter-btn" data-filter="origin">Origin</button>
                <button class="origin-filter-btn" data-filter="no-origin">No Origin</button>
              </div>
              <div class="filter-group">
                <span class="filter-label">Time:</span>
                <button class="time-filter-btn" data-days="1">1 Day</button>
                <button class="time-filter-btn" data-days="3">3 Days</button>
                <button class="time-filter-btn" data-days="7">1 Week</button>
                <button class="time-filter-btn" data-days="14">2 Weeks</button>
                <button class="time-filter-btn" data-days="30">1 Month</button>
              </div>
            </div>
          </div>
          
          ${IP_MODAL_MARKUP}
          
          <div id="ipTimeseriesPlot"></div>

          <script>
            // Origin filter: all request units, those from requests with an origin, or without one
            let currentOriginFilter = 'all';
            const pick = (entry) => (entry === undefined || entry === null) ? 0
              : currentOriginFilter === 'origin' ? entry.withOrigin
              : currentOriginFilter === 'no-origin' ? entry.withoutOrigin
              : entry.total;

            // IP lookup popup (legend click)
            ${IP_MODAL_SCRIPT}

            // Chart, hour in progress, day buttons, refresh: utils/timeseriesClient.js
            const chart = (${timeseriesClient.toString()})({
              plotId: 'ipTimeseriesPlot',
              statusId: 'timeseries-status',
              dataPath: '/iptimeseries/data',
              pagePath: '/iptimeseries',
              initialPayload: ${initialPayload},
              values: (series) => currentOriginFilter === 'origin' ? series.countsWithOrigin
                : currentOriginFilter === 'no-origin' ? series.countsWithoutOrigin
                : series.countsTotal,
              liveValue: pick,
              // the y range stays the "All" range whichever filter is shown
              scaleValues: (series) => series.countsTotal,
              scaleLiveValue: (entry) => (entry ? entry.total : 0),
              onLegendClick: (series) => fetchIpInfo(series.key)
            });

            document.querySelectorAll('.origin-filter-btn').forEach(btn => {
              btn.addEventListener('click', () => {
                currentOriginFilter = btn.getAttribute('data-filter');
                document.querySelectorAll('.origin-filter-btn').forEach(other => {
                  other.classList.toggle('active', other === btn);
                });
                chart.rerender();
              });
            });
          </script>
        </body>
      </html>
    `);
  } catch (error) {
    console.error('Error fetching IP timeseries data from RDS:', error);
    res.status(500).send(`
      <html>
        <head>
          <title>Error - IP Timeseries</title>
          <style>
            body { padding: 20px; font-family: Arial, sans-serif; }
            .error { color: red; }
          </style>
        </head>
        <body>
          <h1>Error Fetching IP Timeseries Data</h1>
          <p class="error">${escapeHtml(error.message)}</p>
          <p>Please check your RDS database connection and ip_history_table schema.</p>
        </body>
      </html>
    `);
  }
});

module.exports = router;
