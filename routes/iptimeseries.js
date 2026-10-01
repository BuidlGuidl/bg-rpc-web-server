const express = require('express');
const router = express.Router();
const { getTimeseries, ALLOWED_DAYS } = require('../utils/edgeTimeseries');
const { timeseriesClient } = require('../utils/timeseriesClient');
const { lookupIp } = require('../utils/ipLookup');

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
            .modal {
              display: none;
              position: fixed;
              z-index: 1000;
              left: 0;
              top: 0;
              width: 100%;
              height: 100%;
              overflow: auto;
              background-color: rgba(0,0,0,0.5);
            }
            .modal-content {
              background-color: #fefefe;
              margin: 5% auto;
              padding: 20px;
              border: 1px solid #888;
              border-radius: 8px;
              width: 80%;
              max-width: 600px;
              box-shadow: 0 4px 6px rgba(0,0,0,0.1);
            }
            .modal-header {
              display: flex;
              justify-content: space-between;
              align-items: center;
              margin-bottom: 20px;
              border-bottom: 2px solid #f0f0f0;
              padding-bottom: 10px;
            }
            .modal-header h2 {
              margin: 0;
              color: #333;
            }
            .close {
              color: #aaa;
              font-size: 28px;
              font-weight: bold;
              cursor: pointer;
              line-height: 20px;
            }
            .close:hover,
            .close:focus {
              color: #000;
            }
            .modal-body {
              color: #333;
            }
            .ip-info-table {
              width: 100%;
              border-collapse: collapse;
            }
            .ip-info-table td {
              padding: 10px;
              border-bottom: 1px solid #f0f0f0;
            }
            .ip-info-table td:first-child {
              font-weight: bold;
              width: 40%;
              color: #666;
            }
            .loading {
              text-align: center;
              padding: 20px;
              color: #666;
            }
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
          
          <!-- IP Info Modal -->
          <div id="ipModal" class="modal">
            <div class="modal-content">
              <div class="modal-header">
                <h2>IP Information</h2>
                <span class="close">&times;</span>
              </div>
              <div class="modal-body" id="modalBody">
                <div class="loading">Loading...</div>
              </div>
            </div>
          </div>
          
          <div id="ipTimeseriesPlot"></div>

          <script>
            // Origin filter: all request units, those from requests with an origin, or without one
            let currentOriginFilter = 'all';
            const pick = (entry) => (entry === undefined || entry === null) ? 0
              : currentOriginFilter === 'origin' ? entry.withOrigin
              : currentOriginFilter === 'no-origin' ? entry.withoutOrigin
              : entry.total;

            // IP lookup modal (legend click)
            const modal = document.getElementById('ipModal');
            const modalBody = document.getElementById('modalBody');
            const closeBtn = document.querySelector('.close');

            // Values from the lookup service go in as text, never as markup
            function escapeText(value) {
              return String(value).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
            }

            async function fetchIpInfo(ip) {
              try {
                modalBody.innerHTML = '<div class="loading">Loading...</div>';
                modal.style.display = 'block';
                const response = await fetch('/iptimeseries/lookup/' + encodeURIComponent(ip));
                if (!response.ok) {
                  throw new Error('Failed to fetch IP information');
                }
                displayIpInfo(await response.json());
              } catch (error) {
                modalBody.innerHTML = '<div class="loading" style="color: red;">Error: ' + escapeText(error.message) + '</div>';
              }
            }

            function displayIpInfo(data) {
              const fields = [
                { key: 'query', label: 'IP Address' },
                { key: 'country', label: 'Country' },
                { key: 'countryCode', label: 'Country Code' },
                { key: 'region', label: 'Region' },
                { key: 'regionName', label: 'Region Name' },
                { key: 'city', label: 'City' },
                { key: 'zip', label: 'Zip Code' },
                { key: 'lat', label: 'Latitude' },
                { key: 'lon', label: 'Longitude' },
                { key: 'timezone', label: 'Timezone' },
                { key: 'isp', label: 'ISP' },
                { key: 'org', label: 'Organization' },
                { key: 'as', label: 'AS Number' },
                { key: 'mobile', label: 'Mobile' },
                { key: 'proxy', label: 'Proxy' },
                { key: 'hosting', label: 'Hosting' }
              ];
              let html = '<table class="ip-info-table">';
              fields.forEach(field => {
                const value = data[field.key];
                if (value !== undefined && value !== null && value !== '') {
                  const displayValue = typeof value === 'boolean' ? (value ? 'Yes' : 'No') : value;
                  html += '<tr><td>' + field.label + '</td><td>' + escapeText(displayValue) + '</td></tr>';
                }
              });
              html += '</table>';
              modalBody.innerHTML = html;
            }

            closeBtn.onclick = function() {
              modal.style.display = 'none';
            };
            window.onclick = function(event) {
              if (event.target === modal) {
                modal.style.display = 'none';
              }
            };
            document.addEventListener('keydown', function(event) {
              if (event.key === 'Escape' && modal.style.display === 'block') {
                modal.style.display = 'none';
              }
            });

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
