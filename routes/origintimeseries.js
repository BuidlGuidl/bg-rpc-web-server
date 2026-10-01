const express = require('express');
const router = express.Router();
const { getTimeseries, ALLOWED_DAYS } = require('../utils/edgeTimeseries');
const { timeseriesClient } = require('../utils/timeseriesClient');

// Top 30 origins by request units (summed over all IPs), hourly, from the edge's database
// (utils/edgeTimeseries.js: cached, read-only, so the edge's own use of the database comes first).
// The page redraws once a minute.

const parseDays = (value) => (ALLOWED_DAYS.includes(parseInt(value)) ? parseInt(value) : 1);

// JSON safe inside a <script> tag (and never containing '<html', which the navbar middleware looks for)
function safeJson(value) {
  return JSON.stringify(value).replace(/\//g, '\\/').replace(/</g, '\\u003c').replace(/>/g, '\\u003e');
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

// The page polls this once a minute (and on a day button)
router.get("/origintimeseries/data", async (req, res) => {
  try {
    const data = await getTimeseries('origin', parseDays(req.query.days));
    res.set('Cache-Control', 'no-store');
    res.type('application/json').send(safeJson(data));
  } catch (error) {
    console.error('Error fetching origin timeseries data:', error.message);
    res.status(502).json({ error: 'edge database unavailable' });
  }
});

router.get("/origintimeseries", async (req, res) => {
  try {
    const initialPayload = safeJson(await getTimeseries('origin', parseDays(req.query.days)));

    res.send(`
      <html>
        <head>
          <title>Origin Timeseries</title>
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
              padding: 10px;
              flex-shrink: 0;
            }
            h1 {
              color: #333;
              margin: 0;
            }
            .controls {
              display: flex;
              gap: 5px;
            }
            .time-filter-btn {
              padding: 8px 16px;
              margin: 0 5px;
              border: 1px solid #ccc;
              background-color: white;
              border-radius: 4px;
              cursor: pointer;
              font-size: 14px;
              transition: all 0.2s;
            }
            .time-filter-btn:hover {
              background-color: #f0f0f0;
            }
            .time-filter-btn.active {
              background-color: #1f77b4;
              color: white;
              border-color: #1f77b4;
            }
            #originTimeseriesPlot {
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
              word-break: break-all;
            }
            .close {
              color: #aaa;
              font-size: 28px;
              font-weight: bold;
              cursor: pointer;
              line-height: 20px;
              flex-shrink: 0;
              margin-left: 10px;
            }
            .close:hover,
            .close:focus {
              color: #000;
            }
            .modal-body {
              color: #333;
            }
            .origin-info-table {
              width: 100%;
              border-collapse: collapse;
            }
            .origin-info-table td {
              padding: 10px;
              border-bottom: 1px solid #f0f0f0;
            }
            .origin-info-table td:first-child {
              font-weight: bold;
              width: 40%;
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
              <h1>Origin Request Units Timeseries - Top 30 Origins</h1>
              <div id="timeseries-status" class="timeseries-status"></div>
            </div>
            <div class="controls">
              <button class="time-filter-btn" data-days="1">1 Day</button>
              <button class="time-filter-btn" data-days="3">3 Days</button>
              <button class="time-filter-btn" data-days="7">1 Week</button>
              <button class="time-filter-btn" data-days="14">2 Weeks</button>
              <button class="time-filter-btn" data-days="30">1 Month</button>
            </div>
          </div>
          
          <!-- Origin Info Modal -->
          <div id="originModal" class="modal">
            <div class="modal-content">
              <div class="modal-header">
                <h2 id="originTitle">Origin Information</h2>
                <span class="close">&times;</span>
              </div>
              <div class="modal-body" id="modalBody">
                <div>Click on a legend item to see origin details.</div>
              </div>
            </div>
          </div>
          
          <div id="originTimeseriesPlot"></div>

          <script>
            // Origin info modal (legend click): totals over the completed hours shown
            const modal = document.getElementById('originModal');
            const modalBody = document.getElementById('modalBody');
            const originTitle = document.getElementById('originTitle');
            const closeBtn = document.querySelector('.close');

            // Origin names come from callers: built as text, never as markup
            function showOriginInfo(series) {
              const counts = series.counts;
              const totalRequests = counts.reduce((sum, count) => sum + count, 0);
              const rows = [
                ['Origin', series.key],
                ['Total Request Units', totalRequests.toLocaleString()],
                ['Average Request Units/Hour', counts.length ? (totalRequests / counts.length).toFixed(2) : '0'],
                ['Peak Request Units/Hour', Math.max(0, ...counts).toLocaleString()],
                ['Active Hours', counts.filter(count => count > 0).length + ' / ' + counts.length]
              ];
              originTitle.textContent = series.key;
              const table = document.createElement('table');
              table.className = 'origin-info-table';
              rows.forEach(([label, value]) => {
                const tr = table.insertRow();
                tr.insertCell().textContent = label;
                tr.insertCell().textContent = value;
              });
              modalBody.replaceChildren(table);
              modal.style.display = 'block';
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
            (${timeseriesClient.toString()})({
              plotId: 'originTimeseriesPlot',
              statusId: 'timeseries-status',
              dataPath: '/origintimeseries/data',
              pagePath: '/origintimeseries',
              initialPayload: ${initialPayload},
              values: (series) => series.counts,
              liveValue: (count) => count || 0,
              scaleValues: (series) => series.counts,
              scaleLiveValue: (count) => count || 0,
              onLegendClick: (series) => showOriginInfo(series)
            });
          </script>
        </body>
      </html>
    `);
  } catch (error) {
    console.error('Error fetching origin timeseries data from RDS:', error);
    res.status(500).send(`
      <html>
        <head>
          <title>Error - Origin Timeseries</title>
          <style>
            body { padding: 20px; font-family: Arial, sans-serif; }
            .error { color: red; }
          </style>
        </head>
        <body>
          <h1>Error Fetching Origin Timeseries Data</h1>
          <p class="error">${escapeHtml(error.message)}</p>
          <p>Please check your RDS database connection and ip_history_table schema.</p>
        </body>
      </html>
    `);
  }
});

module.exports = router;
