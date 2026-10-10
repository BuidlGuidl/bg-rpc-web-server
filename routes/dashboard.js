const express = require('express');
const router = express.Router();
const axios = require('axios');
const https = require('https');
const fs = require('fs');

require('dotenv').config();

const { logsPort } = require('../config');

// Create an HTTPS agent that accepts self-signed certificates
const httpsAgent = new https.Agent({
  rejectUnauthorized: true,
  cert: fs.readFileSync('/home/ubuntu/shared/server.cert'),
  key: fs.readFileSync('/home/ubuntu/shared/server.key')
});

// Everything the dashboard draws, from the logs service: { data, nodeTimeoutData, nodeTimeoutDayData }
async function fetchDashboardPayload() {
  const get = (path) => axios.get(`https://${process.env.HOST}:${logsPort}${path}`, { httpsAgent }).then(response => response.data);
  const [data, nodeTimeoutData, nodeTimeoutDayData] = await Promise.all([
    get('/dashboard'),
    get('/nodeTimeoutPercentLastWeek'),
    get('/nodeTimeoutPercentLastDay')
  ]);
  return { data, nodeTimeoutData, nodeTimeoutDayData };
}

// JSON safe inside a <script> tag (and never containing '<html', which the navbar middleware looks for)
function safeJson(value) {
  return JSON.stringify(value).replace(/\//g, '\\/').replace(/</g, '\\u003c').replace(/>/g, '\\u003e');
}

// The page polls this once a minute and redraws without a reload
router.get("/dashboard/data", async (req, res) => {
  try {
    const payload = await fetchDashboardPayload();
    res.set('Cache-Control', 'no-store');
    res.type('application/json').send(safeJson(payload));
  } catch (error) {
    console.error('Error fetching dashboard data:', error.message);
    res.status(502).json({ error: 'logs service unavailable' });
  }
});

router.get("/dashboard", async (req, res) => {
  try {
    // Escape the data for safe injection into script tag
    const safePayload = safeJson(await fetchDashboardPayload());

    res.send(`
      <html>
        <head>
          <title>RPC Dashboard</title>
          <script src="https://cdn.plot.ly/plotly-latest.min.js"></script>
          <style>
            body { font-family: Arial, sans-serif; margin: 0; }
            .dashboard-section { margin-bottom: 30px; padding: 0px 20px; }
            .dashboard-section h2 { 
              color: #333;
              margin-bottom: 15px;
              padding-bottom: 10px;
              border-bottom: 2px solid #eee;
            }
            .dashboard { display: flex; flex-wrap: wrap; gap: 20px; }
            .gauge { flex: 1; min-width: 300px; height: 300px; }
            .hist-plot { width: 100%; height: 800px; margin-bottom: 20px; }
            h1 { padding: 0px 20px; }
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
            /* Grows with its four charts: each keeps a third of the window, as when there were three */
            #time-series-section {
              min-height: 100vh;
              margin: 0;
              padding: 20px;
              display: flex;
              flex-direction: column;
              box-sizing: border-box;
            }
            #time-series-section h2 {
              margin-top: 0;
              margin-bottom: 5px;
            }
            #time-series-section .hist-plot {
              flex: none;
              height: calc((100vh - 150px) / 3);
              margin-bottom: 0px;
            }
            /* The bottom chart also holds the time labels (120px) and its legend (30px), which the
               others don't (20px of margins): taller by the difference, so its plot area matches */
            #time-series-section #poolTimeHistoryPlot {
              height: calc((100vh - 150px) / 3 + 130px);
            }
            /* Make non-time-series hist-plot elements have height equal to window height */
            .dashboard-section:not(#time-series-section) .hist-plot {
              height: calc(100vh - 20px);
              margin-bottom: 20px;
            }
            #time-series-section .time-filter-buttons {
              margin-bottom: 6px;
              width: 540px;
            }
            .filter-legend-container {
              display: flex;
              justify-content: space-between;
              align-items: center;
              margin-bottom: 6px;
            }
            .time-legend {
              display: flex;
              gap: 15px;
            }
            .time-legend span {
              position: relative;
              padding-left: 20px;
            }
            .time-legend span:before {
              content: "";
              position: absolute;
              left: 0;
              top: 50%;
              transform: translateY(-50%);
              width: 15px;
              height: 2px;
            }
            .time-legend span:nth-child(1):before {
              background-color: #9370db; /* Purple for Cache */
            }
            .time-legend span:nth-child(1) {
              color: #9370db; /* Purple for Cache */
            }
            .time-legend span:nth-child(2):before {
              background-color: #ff7f0e; /* Orange for Pool */
            }
            .time-legend span:nth-child(2) {
              color: #ff7f0e; /* Orange for Pool */
            }
            .time-legend span:nth-child(3):before {
              background-color: #2ca02c; /* Green for Fallback */
            }
            .time-legend span:nth-child(3) {
              color: #2ca02c; /* Green for Fallback */
            }
            .dashboard-status {
              padding: 0px 20px;
              margin-top: -10px;
              color: #666;
              font-size: 13px;
            }
            .dashboard-status.problem {
              color: #d9534f;
            }
          </style>
        </head>
        <body>
          <h1>Dashboard</h1>
          <div id="dashboard-status" class="dashboard-status"></div>
          
          <div class="dashboard-section">
            <h2>Total Requests Last Hour (Non-Client)</h2>
            <div class="dashboard">
              <div id="totalGauge" class="gauge"></div>
            </div>
          </div>

          <div class="dashboard-section">
            <h2>Request Source Metrics Last Hour</h2>
            <div class="dashboard">
              <div id="clientGauge1" class="gauge"></div>
              <div id="gauge2" class="gauge"></div>
              <div id="gauge3" class="gauge"></div>
              <div id="gauge4" class="gauge"></div>
            </div>
          </div>

          <div class="dashboard-section">
            <h2>Warning Metrics Last Hour</h2>
            <div class="dashboard">
              <div id="clientWarningGauge1" class="gauge"></div>
              <div id="warningGauge1" class="gauge"></div>
              <div id="warningGauge2" class="gauge"></div>
              <div id="warningGauge3" class="gauge"></div>
            </div>
          </div>

          <div class="dashboard-section">
            <h2>Error Metrics Last Hour</h2>
            <div class="dashboard">
              <div id="clientErrorGauge1" class="gauge"></div>
              <div id="errorGauge1" class="gauge"></div>
              <div id="errorGauge2" class="gauge"></div>
              <div id="errorGauge3" class="gauge"></div>
            </div>
          </div>

          <div class="dashboard-section">
            <h2>Response Time Metrics Last Hour</h2>
            <div class="dashboard">
              <div id="clientTimeGauge1" class="gauge"></div>
              <div id="timeGauge1" class="gauge"></div>
              <div id="timeGauge2" class="gauge"></div>
              <div id="timeGauge3" class="gauge"></div>
            </div>
          </div>

          <div class="dashboard-section" id="time-series-section">
            <h2>Hourly Request History</h2>
            <div class="filter-legend-container">
              <div class="time-filter-buttons">
                <button class="time-filter-btn" data-range="1">1 Day</button>
                <button class="time-filter-btn" data-range="3">3 Days</button>
                <button class="time-filter-btn" data-range="7">1 Week</button>
                <button class="time-filter-btn" data-range="14">2 Weeks</button>
                <button class="time-filter-btn" data-range="30">1 Month</button>
                <button class="time-filter-btn" data-range="all">All</button>
              </div>
              <div class="time-legend">
                <span>Cache</span>
                <span>Pool</span>
                <span>Fallback</span>
              </div>
            </div>
            <div id="requestHistoryPlot" class="hist-plot"></div>
            <div id="warningHistoryPlot" class="hist-plot"></div>
            <div id="errorHistoryPlot" class="hist-plot"></div>
            <div id="poolTimeHistoryPlot" class="hist-plot"></div>
          </div>

          <div class="dashboard-section">
            <h2>Request Duration Distribution (ms)</h2>
            <div id="methodDurationHist" class="hist-plot"></div>
          </div>

          <div class="dashboard-section">
            <h2>Node Duration Distribution (ms)</h2>
            <div id="nodeDurationHist" class="hist-plot"></div>
          </div>

          <div class="dashboard-section">
            <h2>Node Percent Timeout (Light: last day, solid: last week)</h2>
            <div id="nodeTimeoutChart" class="hist-plot"></div>
          </div>
          
          <script>
            const initialPayload = ${safePayload};
            
            // Format metric names to be more readable
            function formatMetricName(name) {
              return name
                // Only remove the 'n' prefix if it exists, preserve 'med'
                .replace(/^n(?!.*med)/, '')
                // Remove LastHour
                .replace('LastHour', '')
                // Split on capital letters and numbers
                .match(/[A-Z]{1}[a-z]+|[0-9]+|med/g)
                .map(word => word === 'med' ? 'Median' : word)
                .join(' ');
            }
            
            // Define the order of performance metrics
            const orderedMetrics = [
              'nTotalRequestsLastHour'
            ];

            // Draw (or redraw) every chart from one payload: { data, nodeTimeoutData, nodeTimeoutDayData }.
            // Plotly.react updates charts in place.
            // ---- Axis labels drawn as rotated annotations (the duration charts): text for Plotly, and the
            // room they need under the plot
            const plotText = (v) => String(v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
            let measureContext = null;
            // A label's width in px: measured in the browser with Plotly's font; estimated from its length
            // where a canvas isn't available
            function labelWidth(text, fontSize) {
              try {
                if (!measureContext && typeof document !== 'undefined' && document.createElement) {
                  const canvas = document.createElement('canvas');
                  measureContext = canvas && canvas.getContext ? canvas.getContext('2d') : null;
                }
                if (measureContext) {
                  measureContext.font = fontSize + 'px "Open Sans", verdana, arial, sans-serif';
                  const width = measureContext.measureText(text).width;
                  if (width > 0) return width;
                }
              } catch (e) { /* fall back to the estimate */ }
              return String(text).length * fontSize * 0.6;
            }
            // Bottom margin for labels rotated 45° under the axis: a label w wide and h tall reaches down
            // (w + h) · sin 45°, plus a little room
            function rotatedLabelMargin(labels, fontSize) {
              const widest = Math.max(0, ...labels.map(text => labelWidth(text, fontSize)));
              return Math.max(40, Math.ceil((widest + fontSize * 1.2) * Math.SQRT1_2) + 12);
            }
            // A node's axis label: its ID up to the MAC address (damu-MINIPC-PN64-cc:28:aa:47:44:77-linux-x64
            // → damu-MINIPC-PN64); hover labels keep the full ID
            const shortNode = (id) => String(id).replace(/-([0-9a-f]{2}:){5}[0-9a-f]{2}(-.*)?$/i, '');
            // Labels longer than this are cut with … (method names come from callers; the longest real one,
            // eth_getTransactionByBlockNumberAndIndex, is 39), so a junk name can't take over the chart
            const MAX_AXIS_LABEL_CHARS = 40;
            const cutLabel = (text) => (String(text).length > MAX_AXIS_LABEL_CHARS ? String(text).slice(0, MAX_AXIS_LABEL_CHARS - 1) + '…' : String(text));
            // A label under its box: top-right corner at the axis, running down and left at 45°
            const axisLabel = (x, text, color) => ({
              x: x, y: 0, yshift: -4, text: text, textangle: -45, showarrow: false,
              xanchor: 'right', yanchor: 'top', font: { size: 12, color: color }, xref: 'x', yref: 'paper'
            });

            // Y grid for the duration charts (Plotly 1.58 has no minor ticks: minor lines are shapes behind the
            // boxes). Full view: labeled major lines every 200 ms, light minor lines every 50 ms between them,
            // axis 0 to the highest p99 + 5% up to the next 50. Zoomed in: the step follows the visible range
            // (at most ~7 labeled lines, never above 200 ms), minor lines about a quarter of it, drawn only
            // where you're looking. The zoom survives the minute refresh (uirevision) and keeps its grid.
            const MINOR_TICK_MS = 50;
            const MAJOR_TICK_MS = 200;
            const ZOOM_STEPS = [1, 2, 5, 10, 20, 25, 50, 100, 200];
            const MINOR_OF = { 1: 0.2, 2: 0.5, 5: 1, 10: 2, 20: 5, 25: 5, 50: 10, 100: 25, 200: 50 };
            const durationFullRange = {}; // chart id -> [0, top] of the full view
            const durationZoom = {};      // chart id -> [lo, hi] while zoomed in, absent at the full view
            let applyingGrid = false;

            function fullDurationRange(distributions) {
              const highest = Math.max(0, ...distributions.map(d => Number(d && d.p99) || 0));
              return [0, Math.max(MINOR_TICK_MS, Math.ceil((highest * 1.05) / MINOR_TICK_MS) * MINOR_TICK_MS)];
            }
            // { dtick, shapes } for a visible range: minor lines across the plot, never on a major line
            function durationGrid(range, zoomed) {
              const lo = Math.max(0, Math.min(range[0], range[1]));
              const hi = Math.max(range[0], range[1]);
              const major = zoomed ? (ZOOM_STEPS.find(step => (hi - lo) / step <= 7) || MAJOR_TICK_MS) : MAJOR_TICK_MS;
              const minor = zoomed ? MINOR_OF[major] : MINOR_TICK_MS;
              const perMajor = Math.round(major / minor);
              const shapes = [];
              for (let k = Math.ceil(lo / minor); k * minor < hi && shapes.length < 400; k++) { // not on the top edge
                if (k % perMajor === 0) continue; // a labeled major line is here
                const y = Number((k * minor).toFixed(3));
                shapes.push({ type: 'line', layer: 'below', xref: 'paper', yref: 'y', x0: 0, x1: 1,
                  y0: y, y1: y, line: { color: '#f0f0f0', width: 1 } });
              }
              return { dtick: major, shapes: shapes };
            }
            // The grid for a chart now: its zoom if zoomed in, else the full view
            function durationAxis(id, distributions) {
              durationFullRange[id] = fullDurationRange(distributions);
              const zoom = durationZoom[id];
              // A copy: Plotly changes the layout's range array in place when you zoom, and the full range must
              // not change with it (it did: every zoom then looked like the full view, and the grid never adjusted)
              return { range: durationFullRange[id].slice(), ...durationGrid(zoom || durationFullRange[id], Boolean(zoom)) };
            }
            // On zoom (or reset): redraw the grid for the visible y range. Our own relayout is ignored
            const zoomListening = {};
            function followDurationZoom(id) {
              if (zoomListening[id]) return;
              const gd = document.getElementById(id);
              if (!gd || !gd.on) return;
              zoomListening[id] = true;
              gd.on('plotly_relayout', eventData => {
                if (applyingGrid) return;
                let range;
                if (eventData['yaxis.range[0]'] !== undefined && eventData['yaxis.range[1]'] !== undefined) {
                  range = [Number(eventData['yaxis.range[0]']), Number(eventData['yaxis.range[1]'])];
                } else if (Array.isArray(eventData['yaxis.range'])) {
                  range = eventData['yaxis.range'].map(Number);
                } else if (eventData['yaxis.autorange']) {
                  range = null; // reset: back to the full view
                } else {
                  return; // an x-only zoom or our own update: the y grid stays
                }
                const full = durationFullRange[id];
                const atFull = !range || (full && Math.abs(range[0] - full[0]) < 1e-6 && Math.abs(range[1] - full[1]) < 1e-6);
                if (atFull) delete durationZoom[id]; else durationZoom[id] = range;
                const grid = durationGrid(atFull ? full : range, !atFull);
                const update = { 'yaxis.tick0': 0, 'yaxis.dtick': grid.dtick, shapes: grid.shapes };
                if (atFull) update['yaxis.range'] = full.slice();
                applyingGrid = true;
                Promise.resolve(Plotly.relayout(id, update)).finally(() => { applyingGrid = false; });
              });
            }

            function render(payload) {
              const { data, nodeTimeoutData, nodeTimeoutDayData } = payload;
              setStatus('Data as of ' + utcTime(data.timestamp) + ' UTC, refreshes every minute');

              // Calculate shared range based on total requests
              const totalValue = data['nTotalRequestsLastHour'] || 0;
              const sharedMaxValue = Math.max(totalValue * 1.1, 100); // Dynamic range that's at least 100

              // Create total requests gauge
              if ('nTotalRequestsLastHour' in data) {
                const value = data['nTotalRequestsLastHour'];
                const gaugeData = [{
                  type: "indicator",
                  mode: "gauge+number",
                  number: { valueformat: ',d' }, // exact counts; Plotly's default rounds big numbers to the axis tick precision
                  value: value,
                  title: { 
                    text: "Total Requests (Non-Client)",
                    font: { size: 22 }
                  },
                  gauge: {
                    axis: { range: [0, sharedMaxValue] },
                    bar: { color: "#1f77b4" },    // Blue for Total
                    bgcolor: "white",
                    borderwidth: 2,
                    bordercolor: "#ccc",
                  }
                }];
              
                const layout = {
                  margin: { t: 50, b: 25, l: 25, r: 25 },
                  paper_bgcolor: "white",
                  font: { size: 12 }
                };
              
                Plotly.react("totalGauge", gaugeData, layout);
              }

              // Create client request gauge
              if ('nCacheRequestsClientLastHour' in data) {
                const clientMaxValue = Math.max(data['nCacheRequestsClientLastHour'] * 1.1, 100); // Dynamic range that's at least 100
                const value = data['nCacheRequestsClientLastHour'];
                const gaugeData = [{
                  type: "indicator",
                  mode: "gauge+number",
                  number: { valueformat: ',d' }, // exact counts; Plotly's default rounds big numbers to the axis tick precision
                  value: value,
                  title: { 
                    text: formatMetricName('nCacheRequestsClientLastHour'),
                    font: { size: 22 }
                  },
                  gauge: {
                    axis: { range: [0, clientMaxValue] },
                    bar: { color: "#FF69B4" },    // Pink for Client
                    bgcolor: "white",
                    borderwidth: 2,
                    bordercolor: "#ccc",
                  }
                }];
              
                const layout = {
                  margin: { t: 50, b: 25, l: 25, r: 25 },
                  paper_bgcolor: "white",
                  font: { size: 12 }
                };
              
                Plotly.react("clientGauge1", gaugeData, layout);

                // Create client warning gauge
                if ('nWarningCacheRequestsClientLastHour' in data) {
                  const value = data['nWarningCacheRequestsClientLastHour'];
                  const gaugeData = [{
                    type: "indicator",
                    mode: "gauge+number",
                    number: { valueformat: ',d' }, // exact counts; Plotly's default rounds big numbers to the axis tick precision
                    value: value,
                    title: { 
                      text: formatMetricName('nWarningCacheRequestsClientLastHour'),
                      font: { size: 22 }
                    },
                    gauge: {
                      axis: { range: [0, clientMaxValue] },
                      bar: { color: "#FF69B4" },    // Pink for Client
                      bgcolor: "white",
                      borderwidth: 2,
                      bordercolor: "#ccc",
                    }
                  }];
                
                  const layout = {
                    margin: { t: 50, b: 25, l: 25, r: 25 },
                    paper_bgcolor: "white",
                    font: { size: 12 }
                  };
                
                  Plotly.react("clientWarningGauge1", gaugeData, layout);
                }

                // Create client error gauge
                if ('nErrorCacheRequestsClientLastHour' in data) {
                  const value = data['nErrorCacheRequestsClientLastHour'];
                  const gaugeData = [{
                    type: "indicator",
                    mode: "gauge+number",
                    number: { valueformat: ',d' }, // exact counts; Plotly's default rounds big numbers to the axis tick precision
                    value: value,
                    title: { 
                      text: formatMetricName('nErrorCacheRequestsClientLastHour'),
                      font: { size: 22 }
                    },
                    gauge: {
                      axis: { range: [0, clientMaxValue] },
                      bar: { color: "#FF69B4" },    // Pink for Client
                      bgcolor: "white",
                      borderwidth: 2,
                      bordercolor: "#ccc",
                    }
                  }];
                
                  const layout = {
                    margin: { t: 50, b: 25, l: 25, r: 25 },
                    paper_bgcolor: "white",
                    font: { size: 12 }
                  };
                
                  Plotly.react("clientErrorGauge1", gaugeData, layout);
                }
              }

              // Define source metrics
              const sourceMetrics = [
                'nCacheRequestsLastHour',
                'nPoolRequestsLastHour',
                'nFallbackRequestsLastHour'
              ];

              // Create source metrics gauge charts
              sourceMetrics.forEach((key, index) => {
                if (key in data) {
                  const value = data[key];
                  const gaugeData = [{
                    type: "indicator",
                    mode: "gauge+number",
                    number: { valueformat: ',d' }, // exact counts; Plotly's default rounds big numbers to the axis tick precision
                    value: value,
                    title: { 
                      text: formatMetricName(key),
                      font: { size: 22 }
                    },
                    gauge: {
                      axis: { range: [0, sharedMaxValue] },
                      bar: { 
                        color: key.toLowerCase().includes('cache') ? "#9370db" :     // Purple for Cache
                              key.toLowerCase().includes('pool') ? "#ff7f0e" :      // Orange for Pool
                              "#2ca02c"                                            // Green for Fallback
                      },
                      bgcolor: "white",
                      borderwidth: 2,
                      bordercolor: "#ccc",
                    }
                  }];
                
                  const layout = {
                    margin: { t: 50, b: 25, l: 25, r: 25 },
                    paper_bgcolor: "white",
                    font: { size: 12 }
                  };
                
                  Plotly.react("gauge" + (index + 2), gaugeData, layout);
                }
              });

              // Create time-based gauge charts
              const timeMetrics = [
                'medCacheRequestTimeLastHour',
                'medPoolRequestTimeLastHour',
                'medFallbackRequestTimeLastHour'
              ];

              timeMetrics.forEach((key, index) => {
                const value = data[key] || 0;
                const gaugeData = [{
                  type: "indicator",
                  mode: "gauge+number",
                  value: value,
                  title: { 
                    text: formatMetricName(key),
                    font: { size: 22 }
                  },
                  gauge: {
                    axis: { range: [0, 300] },  // Range for milliseconds
                    bar: { 
                      color: key.toLowerCase().includes('cache') ? "#9370db" :     // Purple for Cache
                             key.toLowerCase().includes('pool') ? "#ff7f0e" :      // Orange for Pool
                             "#2ca02c"                                            // Green for Fallback
                    },
                    bgcolor: "white",
                    borderwidth: 2,
                    bordercolor: "#ccc",
                  }
                }];
              
                const layout = {
                  margin: { t: 50, b: 25, l: 25, r: 25 },
                  paper_bgcolor: "white",
                  font: { size: 12 }
                };
              
                Plotly.react("timeGauge" + (index + 1), gaugeData, layout);
              });

              // Create warning gauge charts
              const warningMetrics = [
                'nWarningCacheRequestsLastHour',
                'nWarningPoolRequestsLastHour',
                'nWarningFallbackRequestsLastHour'
              ];

              warningMetrics.forEach((key, index) => {
                const value = data[key] || 0;
                const gaugeData = [{
                  type: "indicator",
                  mode: "gauge+number",
                  number: { valueformat: ',d' }, // exact counts; Plotly's default rounds big numbers to the axis tick precision
                  value: value,
                  title: { 
                    text: formatMetricName(key),
                    font: { size: 22 }
                  },
                  gauge: {
                    axis: { range: [0, sharedMaxValue] },
                    bar: { 
                      color: key.toLowerCase().includes('cache') ? "#9370db" :     // Purple for Cache
                             key.toLowerCase().includes('pool') ? "#ff7f0e" :      // Orange for Pool
                             "#2ca02c"                                            // Green for Fallback
                    },
                    bgcolor: "white",
                    borderwidth: 2,
                    bordercolor: "#ccc",
                  }
                }];
              
                const layout = {
                  margin: { t: 50, b: 25, l: 25, r: 25 },
                  paper_bgcolor: "white",
                  font: { size: 12 }
                };
              
                Plotly.react("warningGauge" + (index + 1), gaugeData, layout);
              });

              // Create error gauge charts
              const errorMetrics = [
                'nErrorCacheRequestsLastHour',
                'nErrorPoolRequestsLastHour',
                'nErrorFallbackRequestsLastHour'
              ];

              errorMetrics.forEach((key, index) => {
                const value = data[key] || 0;
                const gaugeData = [{
                  type: "indicator",
                  mode: "gauge+number",
                  number: { valueformat: ',d' }, // exact counts; Plotly's default rounds big numbers to the axis tick precision
                  value: value,
                  title: { 
                    text: formatMetricName(key),
                    font: { size: 22 }
                  },
                  gauge: {
                    axis: { range: [0, sharedMaxValue] },
                    bar: { 
                      color: key.toLowerCase().includes('cache') ? "#9370db" :     // Purple for Cache
                             key.toLowerCase().includes('pool') ? "#ff7f0e" :      // Orange for Pool
                             "#2ca02c"                                            // Green for Fallback
                    },
                    bgcolor: "white",
                    borderwidth: 2,
                    bordercolor: "#ccc",
                  }
                }];
              
                const layout = {
                  margin: { t: 50, b: 25, l: 25, r: 25 },
                  paper_bgcolor: "white",
                  font: { size: 12 }
                };
              
                Plotly.react("errorGauge" + (index + 1), gaugeData, layout);
              });

              // Create client time gauge
              if ('medCacheRequestClientTimeLastHour' in data) {
                const value = data['medCacheRequestClientTimeLastHour'] || 0;
                const gaugeData = [{
                  type: "indicator",
                  mode: "gauge+number",
                  value: value,
                  title: { 
                    text: formatMetricName('medCacheRequestClientTimeLastHour'),
                    font: { size: 22 }
                  },
                  gauge: {
                    axis: { range: [0, 300] },  // Range for milliseconds
                    bar: { color: "#FF69B4" },    // Pink for Client
                    bgcolor: "white",
                    borderwidth: 2,
                    bordercolor: "#ccc",
                  }
                }];
              
                const layout = {
                  margin: { t: 50, b: 25, l: 25, r: 25 },
                  paper_bgcolor: "white",
                  font: { size: 12 }
                };
              
                Plotly.react("clientTimeGauge1", gaugeData, layout);
              }

              // Define a color palette for the traces
              const colors = [
                'rgba(31, 119, 180, 0.5)',  // blue
                'rgba(255, 127, 14, 0.5)',  // orange
                'rgba(44, 160, 44, 0.5)',   // green
                'rgba(214, 39, 40, 0.5)',   // red
                'rgba(148, 103, 189, 0.5)', // purple
                'rgba(140, 86, 75, 0.5)',   // brown
                'rgba(227, 119, 194, 0.5)', // pink
                'rgba(127, 127, 127, 0.5)', // gray
                'rgba(188, 189, 34, 0.5)',  // yellow-green
                'rgba(23, 190, 207, 0.5)'   // cyan
              ];

              // Define solid colors for lines
              const solidColors = [
                'rgb(31, 119, 180)',  // blue
                'rgb(255, 127, 14)',  // orange
                'rgb(44, 160, 44)',   // green
                'rgb(214, 39, 40)',   // red
                'rgb(148, 103, 189)', // purple
                'rgb(140, 86, 75)',   // brown
                'rgb(227, 119, 194)', // pink
                'rgb(127, 127, 127)', // gray
                'rgb(188, 189, 34)',  // yellow-green
                'rgb(23, 190, 207)'   // cyan
              ];

              if (data.methodDurationHist) {
                const methodTraces = Object.entries(data.methodDurationHist).map(([method, distribution], index) => {
                  const color = colors[index % colors.length];
                  const solidColor = solidColors[index % solidColors.length];
                  return {
                    type: 'box',
                    x: [method],
                    lowerfence: [distribution.p1],
                    q1: [distribution.p25],
                    median: [distribution.p50],
                    q3: [distribution.p75],
                    upperfence: [distribution.p99],
                    name: method,
                    boxpoints: false,
                    fillcolor: color,
                    line: {
                      color: solidColor,
                      width: 2
                    },
                    quartilemethod: "linear"
                  };
                });

                const methodTicks = durationAxis('methodDurationHist', Object.values(data.methodDurationHist));
                const methodLayout = {
                  // No chart title: the section heading above the chart names it
                  xaxis: {
                    title: '',
                    tickangle: -45,
                    showticklabels: false,
                    tickfont: {
                      size: 12
                    }
                  },
                  yaxis: {
                    title: 'Duration (ms)',
                    type: 'linear',
                    rangemode: 'nonnegative', // times can't be negative: the axis starts at 0
                    range: methodTicks.range,
                    tick0: 0,
                    dtick: methodTicks.dtick, // the major step: minor lines skip it
                    gridcolor: '#d9d9d9'
                  },
                  shapes: methodTicks.shapes,
                  uirevision: 'methodDurationHist', // a zoom survives the minute refresh
                  annotations: Object.keys(data.methodDurationHist).map((method, index) =>
                    axisLabel(method, plotText(cutLabel(method)), solidColors[index % solidColors.length])),
                  margin: { t: 20, b: rotatedLabelMargin(Object.keys(data.methodDurationHist).map(cutLabel), 12), l: 50, r: 25 },
                  paper_bgcolor: "white",
                  plot_bgcolor: "white",
                  font: { size: 12 },
                  showlegend: false,
                  boxgap: 0.2,
                  boxgroupgap: 0
                };

                Promise.resolve(Plotly.react('methodDurationHist', methodTraces, methodLayout)).then(() => followDurationZoom('methodDurationHist'));
              }

              // Owners from the node timeout data in the same payload (keyed by the same node IDs): shown in the
              // node charts' hover labels, and used to group their nodes
              const ownerByNode = {};
              [...(nodeTimeoutData || []), ...(nodeTimeoutDayData || [])].forEach(n => {
                if (n && n.nodeId && n.owner && !ownerByNode[n.nodeId]) ownerByNode[n.nodeId] = n.owner;
              });
              // Both node charts list nodes grouped by owner (alphabetical, any case; nodes with no known owner
              // last), then by short name, so the charts line up
              const byOwner = (a, b) => {
                const oa = ownerByNode[a], ob = ownerByNode[b];
                if (!oa !== !ob) return oa ? -1 : 1;
                return (oa || '').toLowerCase().localeCompare((ob || '').toLowerCase())
                  || shortNode(a).localeCompare(shortNode(b)) || (a < b ? -1 : a > b ? 1 : 0);
              };
              const durationOrder = Object.keys(data.nodeDurationHist || {}).sort(byOwner);

              // Add Node Duration Distribution histogram
              if (data.nodeDurationHist) {
                const nodeTraces = durationOrder.map(node => [node, data.nodeDurationHist[node]]).map(([node, distribution], index) => {
                  const color = colors[index % colors.length];
                  const solidColor = solidColors[index % solidColors.length];
                  return {
                    type: 'box',
                    x: [node],
                    lowerfence: [distribution.p1],
                    q1: [distribution.p25],
                    median: [distribution.p50],
                    q3: [distribution.p75],
                    upperfence: [distribution.p99],
                    // The hover label's side box shows the trace name: node and owner, never cut short
                    name: ownerByNode[node] ? plotText(node) + '<br>owner: ' + plotText(ownerByNode[node]) : plotText(node),
                    hoverlabel: { namelength: -1 },
                    boxpoints: false,
                    fillcolor: color,
                    line: {
                      color: solidColor,
                      width: 2
                    },
                    quartilemethod: "linear"
                  };
                });

                const nodeTicks = durationAxis('nodeDurationHist', Object.values(data.nodeDurationHist));
                const nodeLayout = {
                  // No chart title: the section heading above the chart names it
                  xaxis: {
                    title: '',
                    tickangle: -45,
                    showticklabels: false,
                    tickfont: {
                      size: 12
                    }
                  },
                  yaxis: {
                    title: 'Duration (ms)',
                    type: 'linear',
                    rangemode: 'nonnegative', // times can't be negative: the axis starts at 0
                    range: nodeTicks.range,
                    tick0: 0,
                    dtick: nodeTicks.dtick, // the major step: minor lines skip it
                    gridcolor: '#d9d9d9'
                  },
                  shapes: nodeTicks.shapes,
                  uirevision: 'nodeDurationHist', // a zoom survives the minute refresh
                  annotations: durationOrder.map((node, index) =>
                    axisLabel(node, plotText(cutLabel(shortNode(node))), solidColors[index % solidColors.length])),
                  margin: { t: 20, b: rotatedLabelMargin(durationOrder.map(node => cutLabel(shortNode(node))), 12), l: 50, r: 25 },
                  paper_bgcolor: "white",
                  plot_bgcolor: "white",
                  font: { size: 12 },
                  showlegend: false,
                  boxgap: 0.2,
                  boxgroupgap: 0
                };

                Promise.resolve(Plotly.react('nodeDurationHist', nodeTraces, nodeLayout)).then(() => followDurationZoom('nodeDurationHist'));
              }

              // Hourly Request History (drawHistory, below)
              if (data.requestHistory) {
                drawHistory(data);
              }

              // Node timeout percentages: one chart, two bars per node (last day light, then last week solid).
              // Nodes grouped by owner like the Node Duration Distribution, in its colors (the same palette by
              // position there), so a node reads the same in both charts; nodes only here continue the palette. Bars are
              // placed by nodeId (two nodes can share a short name) and labeled like the duration chart:
              // rotated annotations in the node's color. A node missing from one period has no bar for it.
              const weekNodes = nodeTimeoutData || [];
              const dayNodes = nodeTimeoutDayData || [];
              if (weekNodes.length > 0 || dayNodes.length > 0) {
                // nodeId → { pretty, owner }
                const nodeInfo = new Map();
                [...weekNodes, ...dayNodes].forEach(node => {
                  if (!nodeInfo.has(node.nodeId)) nodeInfo.set(node.nodeId, { pretty: node.nodeIdPretty, owner: node.owner });
                });
                // Grouped by owner like the duration chart (byOwner): the same nodes in the same order
                const ids = Array.from(nodeInfo.keys()).sort(byOwner);
                // Palette position: the node's place in the duration chart; nodes not there take the next ones
                let nextIndex = durationOrder.length;
                const paletteIndex = new Map(ids.map(id => [id, durationOrder.includes(id) ? durationOrder.indexOf(id) : nextIndex++]));
                const nodeColor = (id) => solidColors[paletteIndex.get(id) % solidColors.length];

                // The day bar's lighter shade is a real color (the node color mixed with white), not opacity,
                // so its tooltip, which takes the bar color, matches it
                const lighten = (rgb, amount) => {
                  const parts = (String(rgb).match(/[0-9]+/g) || [0, 0, 0]).slice(0, 3).map(Number);
                  return 'rgb(' + parts.map(c => Math.round(c + (255 - c) * amount)).join(', ') + ')';
                };
                const periodTrace = (nodes, name, lightness) => {
                  const percent = new Map(nodes.map(node => [node.nodeId, node.percentTimeout * 100]));
                  return {
                    type: 'bar',
                    name: name,
                    x: ids,
                    y: ids.map(id => percent.has(id) ? Number(percent.get(id).toFixed(2)) : null),
                    hovertext: ids.map(id => {
                      const info = nodeInfo.get(id);
                      const value = percent.has(id) ? percent.get(id).toFixed(2) + '%' : 'no requests';
                      return 'Node: ' + plotText(info.pretty) + '<br>Owner: ' + plotText(info.owner) + '<br>' + name + ': ' + value;
                    }),
                    hovertemplate: '%{hovertext}<extra></extra>',
                    marker: {
                      color: ids.map(id => (lightness ? lighten(nodeColor(id), lightness) : nodeColor(id))),
                      line: { color: 'rgba(0,0,0,0.4)', width: 1 }
                    }
                  };
                };

                const labels = ids.map(id => cutLabel(shortNode(id)));
                const maxPercent = Math.max(0, ...[...weekNodes, ...dayNodes].map(node => node.percentTimeout * 100));
                const nodeTimeoutLayout = {
                  // No chart title or subtitle: the section heading names it and gives the light/solid key
                  barmode: 'group',
                  bargap: 0.15,
                  bargroupgap: 0.05,
                  xaxis: {
                    title: '',
                    type: 'category',
                    showticklabels: false
                  },
                  yaxis: {
                    title: 'Timeout Percentage (%)',
                    type: 'linear',
                    range: [0, maxPercent > 0 ? maxPercent * 1.1 : 1] // 10% headroom
                  },
                  // Labels in each node's color, as on the duration chart
                  annotations: ids.map((id, i) => axisLabel(id, plotText(labels[i]), nodeColor(id))),
                  margin: { t: 20, b: rotatedLabelMargin(labels, 12), l: 60, r: 25 },
                  paper_bgcolor: "white",
                  plot_bgcolor: "white",
                  font: { size: 12 },
                  showlegend: false
                };

                // Day first: in a group, the first trace is the left bar
                Plotly.react('nodeTimeoutChart', [
                  periodTrace(dayNodes, 'Last day', 0.55),
                  periodTrace(weekNodes, 'Last week', 0)
                ], nodeTimeoutLayout);
              }
            }

            // ---- Hourly Request History: completed hours (solid) and the hour in progress (dotted).
            // The window (a range button, or a range dragged by hand) is kept across refreshes.
            const HOUR_MS = 60 * 60 * 1000;
            const historyPlots = [
              { id: 'requestHistoryPlot', field: 'Success', label: 'Requests', yTitle: 'Successful Requests / Hour' },
              { id: 'warningHistoryPlot', field: 'Warning', label: 'Warnings', yTitle: 'Warning Requests / Hour' },
              { id: 'errorHistoryPlot', field: 'Error', label: 'Errors', yTitle: 'Number of Errors / Hour' },
              // Percentiles of successful pool request time per hour (ms)
              { id: 'poolTimeHistoryPlot', kind: 'poolTime', yTitle: 'Pool Request Time (ms)' }
            ];
            const poolTimePercentiles = [
              { key: 'p5', label: 'p5', color: '#9e9e9e', width: 1.5 },
              { key: 'p25', label: 'p25', color: '#6baed6', width: 1.5 },
              { key: 'p50', label: 'p50', color: '#08519c', width: 3 },
              { key: 'p75', label: 'p75', color: '#fd8d3c', width: 1.5 },
              { key: 'p95', label: 'p95', color: '#d62728', width: 1.5 }
            ];
            const historySources = [
              { key: 'Cache', color: '#9370db' },     // Purple for Cache
              { key: 'Pool', color: '#ff7f0e' },      // Orange for Pool
              { key: 'Fallback', color: '#2ca02c' }   // Green for Fallback
            ];
            let historyWindow = 1;      // days, 'all', or null once a range is dragged by hand
            let historyListening = false;
            let latestHistoryData = null;

            // Pool request time: one line per percentile, the hour in progress dotted like the counts
            function poolTimeTraces(data) {
              const hours = data.poolTimeHistory || [];
              const x = hours.map(entry => new Date(entry.hourMs).toISOString());
              const traces = poolTimePercentiles.map(p => ({
                name: p.label,
                x: x,
                y: hours.map(entry => entry[p.key]),
                customdata: hours.map(entry => entry.n),
                type: 'scatter',
                mode: 'lines',
                line: { color: p.color, width: p.width },
                hovertemplate: '%{x|%Y-%m-%d %H:%M} UTC<br>%{y:.0f} ms (%{customdata} requests)<extra>' + p.label + '</extra>'
              }));
              const current = data.poolTimeCurrentHour;
              if (current) {
                const minutes = Math.max(0, Math.floor((data.timestamp - current.hourMs) / 60000));
                const last = hours[hours.length - 1];
                poolTimePercentiles.forEach(p => {
                  const xs = [], ys = [], text = [];
                  if (last && last.hourMs === current.hourMs - HOUR_MS) {
                    xs.push(new Date(last.hourMs).toISOString());
                    ys.push(last[p.key]);
                    text.push(Math.round(last[p.key]) + ' ms (full hour, ' + last.n + ' requests)');
                  }
                  xs.push(new Date(current.hourMs).toISOString());
                  ys.push(current[p.key]);
                  text.push(Math.round(current[p.key]) + ' ms so far (' + current.n + ' requests, ' + minutes + ' min into the hour)');
                  traces.push({
                    name: p.label + ' (hour in progress)',
                    x: xs,
                    y: ys,
                    text: text,
                    type: 'scatter',
                    mode: 'lines+markers',
                    line: { color: p.color, width: p.width, dash: 'dot' },
                    marker: { size: 5, color: p.color },
                    showlegend: false,
                    hovertemplate: '%{x|%Y-%m-%d %H:%M} UTC<br>%{text}<extra>' + p.label + '</extra>'
                  });
                });
              }
              return traces;
            }

            function historyTraces(data, plot) {
              if (plot.kind === 'poolTime') return poolTimeTraces(data);
              const hours = data.requestHistory || [];
              const x = hours.map(entry => new Date(entry.hourMs).toISOString());
              const traces = historySources.map(source => ({
                name: source.key + ' ' + plot.label,
                x: x,
                y: hours.map(entry => entry['n' + source.key + 'Requests' + plot.field]),
                type: 'scatter',
                mode: 'lines',
                line: { color: source.color, width: 2 },
                marker: { size: 8 }
              }));

              // The hour in progress: a dotted line from the last completed hour to the count so far
              const current = data.requestHistoryCurrentHour;
              if (current) {
                const minutes = Math.max(0, Math.floor((data.timestamp - current.hourMs) / 60000));
                const last = hours[hours.length - 1];
                historySources.forEach(source => {
                  const field = 'n' + source.key + 'Requests' + plot.field;
                  const xs = [], ys = [], text = [];
                  if (last && last.hourMs === current.hourMs - HOUR_MS) {
                    xs.push(new Date(last.hourMs).toISOString());
                    ys.push(last[field]);
                    text.push(last[field] + ' (full hour)');
                  }
                  xs.push(new Date(current.hourMs).toISOString());
                  ys.push(current[field]);
                  text.push(current[field] + ' so far (' + minutes + ' min into the hour)');
                  traces.push({
                    name: source.key + ' ' + plot.label + ' (hour in progress)',
                    x: xs,
                    y: ys,
                    text: text,
                    type: 'scatter',
                    mode: 'lines+markers',
                    line: { color: source.color, width: 2, dash: 'dot' },
                    marker: { size: 6, color: source.color },
                    hovertemplate: '%{x|%Y-%m-%d %H:%M} UTC<br>%{text}<extra>' + source.key + '</extra>'
                  });
                });
              }
              return traces;
            }

            function historyLayout(plot, index) {
              const isLast = index === historyPlots.length - 1;
              // Tick labels like 26-10-09 00:00: two-digit year, no "UTC" (the axis title says so)
              const xaxis = { title: 'Time (UTC)', type: 'date', tickformat: '%y-%m-%d %H:%M', tickangle: -45 };
              if (!isLast) {
                Object.assign(xaxis, { showticklabels: false, ticks: '', title: '', zeroline: false, showgrid: true });
              }
              const poolTime = plot.kind === 'poolTime';
              return {
                xaxis: xaxis,
                yaxis: { title: plot.yTitle, type: 'linear' },
                margin: { t: poolTime ? 30 : 0, b: isLast ? 120 : 20, l: 50, r: 25 },
                paper_bgcolor: "white",
                plot_bgcolor: "white",
                font: { size: 12 },
                showlegend: poolTime,
                legend: { orientation: 'h', x: 0, y: 1.12 }
              };
            }

            // x range for a window in days (or 'all'), ending at the newest point (the hour in progress)
            function historyXRange(data, days) {
              const hours = data.requestHistory || [];
              const current = data.requestHistoryCurrentHour;
              const end = current ? current.hourMs : (hours.length ? hours[hours.length - 1].hourMs : Date.now());
              const start = days === 'all'
                ? (hours.length ? hours[0].hourMs : end - HOUR_MS)
                : end - days * 24 * HOUR_MS;
              return [new Date(start).toISOString(), new Date(end).toISOString()];
            }

            // y range of the points inside an x range, with 10% padding; null (autorange) if none
            function historyYRange(traces, xRange) {
              const startTime = new Date(xRange[0]).getTime();
              const endTime = new Date(xRange[1]).getTime();
              let yMin = Infinity;
              let yMax = -Infinity;
              traces.forEach(trace => {
                trace.x.forEach((x, i) => {
                  const xTime = new Date(x).getTime();
                  const y = trace.y[i];
                  if (xTime >= startTime && xTime <= endTime && y !== null && y !== undefined) {
                    yMin = Math.min(yMin, y);
                    yMax = Math.max(yMax, y);
                  }
                });
              });
              if (!isFinite(yMin)) return null;
              const yPadding = (yMax - yMin) * 0.1;
              return [Math.max(0, yMin - yPadding), yMax + yPadding || 1];
            }

            function markHistoryButtons() {
              document.querySelectorAll('.time-filter-btn').forEach(btn => {
                btn.classList.toggle('active', historyWindow !== null && btn.dataset.range === String(historyWindow));
              });
            }

            function drawHistory(data) {
              latestHistoryData = data;
              return Promise.all(historyPlots.map((plot, index) => {
                const traces = historyTraces(data, plot);
                const layout = historyLayout(plot, index);
                const gd = document.getElementById(plot.id);
                if (historyWindow !== null) {
                  layout.xaxis.range = historyXRange(data, historyWindow);
                  const yRange = historyYRange(traces, layout.xaxis.range);
                  if (yRange) Object.assign(layout.yaxis, { range: yRange, autorange: false });
                } else if (gd && gd.layout && gd.layout.xaxis) {
                  // A range dragged by hand: keep it
                  layout.xaxis.range = gd.layout.xaxis.range;
                  Object.assign(layout.yaxis, { range: gd.layout.yaxis.range, autorange: false });
                }
                return Plotly.react(plot.id, traces, layout);
              })).then(() => {
                markHistoryButtons();
                if (!historyListening) {
                  historyListening = true;
                  // Dragging a range on one chart moves the others, and ends the button window
                  historyPlots.forEach(plot => {
                    document.getElementById(plot.id).on('plotly_relayout', eventData => {
                      if (eventData['xaxis.range[0]'] !== undefined && eventData['xaxis.range[1]'] !== undefined) {
                        historyWindow = null;
                        markHistoryButtons();
                        const newRange = [eventData['xaxis.range[0]'], eventData['xaxis.range[1]']];
                        historyPlots.forEach(other => {
                          if (other.id !== plot.id) Plotly.relayout(other.id, { 'xaxis.range': newRange });
                        });
                      } else if (eventData['xaxis.autorange']) {
                        historyWindow = null;
                        markHistoryButtons();
                      }
                    });
                  });
                }
              });
            }

            document.querySelectorAll('.time-filter-btn').forEach(btn => {
              btn.addEventListener('click', () => {
                historyWindow = btn.dataset.range === 'all' ? 'all' : parseInt(btn.dataset.range);
                if (latestHistoryData) drawHistory(latestHistoryData);
              });
            });

            // ---- Refresh once a minute without a reload. A hidden tab doesn't poll; it catches up
            // when shown again. An expired login stops polling and says so.
            const REFRESH_MS = 60 * 1000;
            let refreshTimer = null;
            let sessionExpired = false;

            function utcTime(ms) {
              return new Date(ms).toISOString().slice(11, 19);
            }

            function setStatus(text, isProblem) {
              const status = document.getElementById('dashboard-status');
              status.textContent = text;
              status.classList.toggle('problem', Boolean(isProblem));
            }

            async function refreshDashboard() {
              try {
                const response = await fetch('/dashboard/data', { headers: { 'Accept': 'application/json' }, cache: 'no-store' });
                const type = response.headers.get('content-type') || '';
                if (response.redirected || !type.includes('application/json')) {
                  sessionExpired = true;
                  stopRefresh();
                  setStatus('Session expired: reload the page to log in again.', true);
                  return;
                }
                if (!response.ok) throw new Error('HTTP ' + response.status);
                render(await response.json());
              } catch (error) {
                setStatus('Update failed at ' + utcTime(Date.now()) + ' UTC (' + error.message + '), retrying every minute.', true);
              }
            }

            function startRefresh() {
              if (!refreshTimer && !sessionExpired) refreshTimer = setInterval(refreshDashboard, REFRESH_MS);
            }

            function stopRefresh() {
              clearInterval(refreshTimer);
              refreshTimer = null;
            }

            document.addEventListener('visibilitychange', () => {
              if (document.hidden) {
                stopRefresh();
              } else if (!sessionExpired) {
                refreshDashboard();
                startRefresh();
              }
            });

            render(initialPayload);
            startRefresh();
          </script>
        </body>
      </html>
    `);
  } catch (error) {
    console.error('Error fetching dashboard data:', error);
    res.status(500).send('Error loading dashboard');
  }
});

module.exports = router;