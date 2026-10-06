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
            #time-series-section {
              height: 100vh;
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
              flex: 1;
              height: calc((100vh - 150px) / 3);
              margin-bottom: 0px;
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
          </div>

          <div class="dashboard-section">
            <h2>Request Duration Distribution</h2>
            <div id="methodDurationHist" class="hist-plot"></div>
            <div id="nodeDurationHist" class="hist-plot"></div>
          </div>

          <div class="dashboard-section">
            <h2>Node Percent Timeout Last Week</h2>
            <div id="nodeTimeoutChart" class="hist-plot"></div>
          </div>

          <div class="dashboard-section">
            <h2>Node Percent Timeout Last Day</h2>
            <div id="nodeTimeoutDayChart" class="hist-plot"></div>
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

                const methodLayout = {
                  title: {
                    text: 'Method Duration Distribution (ms)',
                    font: { size: 22 }
                  },
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
                    type: 'linear'
                  },
                  annotations: Object.keys(data.methodDurationHist).map((method, index) => ({
                    x: method,
                    y: -0.1,
                    text: method,
                    textangle: -45,
                    showarrow: false,
                    xanchor: 'right',
                    yanchor: 'middle',
                    font: {
                      size: 12,
                      color: solidColors[index % solidColors.length]
                    },
                    xref: 'x',
                    yref: 'paper'
                  })),
                  margin: { t: 50, b: 120, l: 50, r: 25 },
                  paper_bgcolor: "white",
                  plot_bgcolor: "white",
                  font: { size: 12 },
                  showlegend: false,
                  boxgap: 0.2,
                  boxgroupgap: 0
                };

                Plotly.react('methodDurationHist', methodTraces, methodLayout);
              }

              // Add Node Duration Distribution histogram
              if (data.nodeDurationHist) {
                const nodeTraces = Object.entries(data.nodeDurationHist).map(([node, distribution], index) => {
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
                    name: node,
                    boxpoints: false,
                    fillcolor: color,
                    line: {
                      color: solidColor,
                      width: 2
                    },
                    quartilemethod: "linear"
                  };
                });

                const nodeLayout = {
                  title: {
                    text: 'Node Duration Distribution (ms)',
                    font: { size: 22 }
                  },
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
                    type: 'linear'
                  },
                  annotations: Object.keys(data.nodeDurationHist).map((node, index) => ({
                    x: node,
                    y: -0.1,
                    text: node,
                    textangle: -45,
                    showarrow: false,
                    xanchor: 'right',
                    yanchor: 'middle',
                    font: {
                      size: 12,
                      color: solidColors[index % solidColors.length]
                    },
                    xref: 'x',
                    yref: 'paper'
                  })),
                  margin: { t: 50, b: 120, l: 50, r: 25 },
                  paper_bgcolor: "white",
                  plot_bgcolor: "white",
                  font: { size: 12 },
                  showlegend: false,
                  boxgap: 0.2,
                  boxgroupgap: 0
                };

                Plotly.react('nodeDurationHist', nodeTraces, nodeLayout);
              }

              // Hourly Request History (drawHistory, below)
              if (data.requestHistory) {
                drawHistory(data);
              }

              // Define a palette of 15 distinct colors for node owners
              const nodeOwnerColorPalette = [
                '#1f77b4',  // blue
                '#ff7f0e',  // orange
                '#2ca02c',  // green
                '#d62728',  // red
                '#9467bd',  // purple
                '#8c564b',  // brown
                '#e377c2',  // pink
                '#7f7f7f',  // gray
                '#bcbd22',  // yellow-green
                '#17becf',  // cyan
                '#aec7e8',  // light blue
                '#ffbb78',  // light orange
                '#98df8a',  // light green
                '#ff9896',  // light red
                '#c5b0d5'   // light purple
              ];

              // Create unified color mapping for all owners across both datasets
              const allOwners = new Set();
              if (nodeTimeoutData && nodeTimeoutData.length > 0) {
                nodeTimeoutData.forEach(node => allOwners.add(node.owner));
              }
              if (nodeTimeoutDayData && nodeTimeoutDayData.length > 0) {
                nodeTimeoutDayData.forEach(node => allOwners.add(node.owner));
              }
            
              // Sort owners alphabetically for consistent ordering
              const sortedOwners = Array.from(allOwners).sort();
              const ownerColorMapping = {};
              sortedOwners.forEach((owner, index) => {
                ownerColorMapping[owner] = nodeOwnerColorPalette[index % nodeOwnerColorPalette.length];
              });

              // Calculate shared y-axis max for both timeout charts
              let maxTimeoutPercent = 0;
              if (nodeTimeoutData && nodeTimeoutData.length > 0) {
                const maxWeek = Math.max(...nodeTimeoutData.map(node => node.percentTimeout * 100));
                maxTimeoutPercent = Math.max(maxTimeoutPercent, maxWeek);
              }
              if (nodeTimeoutDayData && nodeTimeoutDayData.length > 0) {
                const maxDay = Math.max(...nodeTimeoutDayData.map(node => node.percentTimeout * 100));
                maxTimeoutPercent = Math.max(maxTimeoutPercent, maxDay);
              }
              // Add 10% padding to the max value for better visualization
              const sharedYAxisMax = maxTimeoutPercent * 1.1;

              // Create Node Timeout Percent bar chart
              if (nodeTimeoutData && nodeTimeoutData.length > 0) {
                // Create bar chart data
                const nodeIds = nodeTimeoutData.map(node => node.nodeIdPretty);
                const percentages = nodeTimeoutData.map(node => (node.percentTimeout * 100).toFixed(2));
                const barColors = nodeTimeoutData.map(node => ownerColorMapping[node.owner]);
                const hoverText = nodeTimeoutData.map(node => 
                  \`Node: \${node.nodeIdPretty}<br>Owner: \${node.owner}<br>Timeout: \${(node.percentTimeout * 100).toFixed(2)}%\`
                );

                const nodeTimeoutTrace = {
                  type: 'bar',
                  x: nodeIds,
                  y: percentages,
                  text: percentages.map(p => \`\${p}%\`),
                  textposition: 'none',
                  hovertemplate: '%{hovertext}<extra></extra>',
                  hovertext: hoverText,
                  marker: {
                    color: barColors,
                    line: {
                      color: 'rgba(0,0,0,0.3)',
                      width: 1
                    }
                  }
                };

                const nodeTimeoutLayout = {
                  title: {
                    text: 'Node Timeout Percentage Last Week',
                    font: { size: 22 }
                  },
                  xaxis: {
                    title: 'Node ID',
                    tickangle: -45,
                    tickfont: {
                      size: 10
                    }
                  },
                  yaxis: {
                    title: 'Timeout Percentage (%)',
                    type: 'linear',
                    range: [0, sharedYAxisMax]
                  },
                  margin: { t: 50, b: 150, l: 60, r: 25 },
                  paper_bgcolor: "white",
                  plot_bgcolor: "white",
                  font: { size: 12 },
                  showlegend: false,
                  bargap: 0.05
                };

                Plotly.react('nodeTimeoutChart', [nodeTimeoutTrace], nodeTimeoutLayout);
              }

              // Create Node Timeout Percent bar chart for last day
              if (nodeTimeoutDayData && nodeTimeoutDayData.length > 0) {
                // Create bar chart data
                const nodeDayIds = nodeTimeoutDayData.map(node => node.nodeIdPretty);
                const percentagesDay = nodeTimeoutDayData.map(node => (node.percentTimeout * 100).toFixed(2));
                const barDayColors = nodeTimeoutDayData.map(node => ownerColorMapping[node.owner]);
                const hoverDayText = nodeTimeoutDayData.map(node => 
                  \`Node: \${node.nodeIdPretty}<br>Owner: \${node.owner}<br>Timeout: \${(node.percentTimeout * 100).toFixed(2)}%\`
                );

                const nodeTimeoutDayTrace = {
                  type: 'bar',
                  x: nodeDayIds,
                  y: percentagesDay,
                  text: percentagesDay.map(p => \`\${p}%\`),
                  textposition: 'none',
                  hovertemplate: '%{hovertext}<extra></extra>',
                  hovertext: hoverDayText,
                  marker: {
                    color: barDayColors,
                    line: {
                      color: 'rgba(0,0,0,0.3)',
                      width: 1
                    }
                  }
                };

                const nodeTimeoutDayLayout = {
                  title: {
                    text: 'Node Timeout Percentage Last Day',
                    font: { size: 22 }
                  },
                  xaxis: {
                    title: 'Node ID',
                    tickangle: -45,
                    tickfont: {
                      size: 10
                    }
                  },
                  yaxis: {
                    title: 'Timeout Percentage (%)',
                    type: 'linear',
                    range: [0, sharedYAxisMax]
                  },
                  margin: { t: 50, b: 150, l: 60, r: 25 },
                  paper_bgcolor: "white",
                  plot_bgcolor: "white",
                  font: { size: 12 },
                  showlegend: false,
                  bargap: 0.05
                };

                Plotly.react('nodeTimeoutDayChart', [nodeTimeoutDayTrace], nodeTimeoutDayLayout);
              }
            }

            // ---- Hourly Request History: completed hours (solid) and the hour in progress (dotted).
            // The window (a range button, or a range dragged by hand) is kept across refreshes.
            const HOUR_MS = 60 * 60 * 1000;
            const historyPlots = [
              { id: 'requestHistoryPlot', field: 'Success', label: 'Requests', yTitle: 'Successful Requests / Hour' },
              { id: 'warningHistoryPlot', field: 'Warning', label: 'Warnings', yTitle: 'Warning Requests / Hour' },
              { id: 'errorHistoryPlot', field: 'Error', label: 'Errors', yTitle: 'Number of Errors / Hour' }
            ];
            const historySources = [
              { key: 'Cache', color: '#9370db' },     // Purple for Cache
              { key: 'Pool', color: '#ff7f0e' },      // Orange for Pool
              { key: 'Fallback', color: '#2ca02c' }   // Green for Fallback
            ];
            let historyWindow = 1;      // days, 'all', or null once a range is dragged by hand
            let historyListening = false;
            let latestHistoryData = null;

            function historyTraces(data, plot) {
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
              const xaxis = { title: 'Time (UTC)', type: 'date', tickformat: '%Y-%m-%d %H:%M UTC', tickangle: -45 };
              if (!isLast) {
                Object.assign(xaxis, { showticklabels: false, ticks: '', title: '', zeroline: false, showgrid: true });
              }
              return {
                xaxis: xaxis,
                yaxis: { title: plot.yTitle, type: 'linear' },
                margin: { t: 0, b: isLast ? 120 : 20, l: 50, r: 25 },
                paper_bgcolor: "white",
                plot_bgcolor: "white",
                font: { size: 12 },
                showlegend: false
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
                  // Dragging a range on one chart moves the other two, and ends the button window
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