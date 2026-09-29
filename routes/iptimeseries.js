const express = require('express');
// Counts on this page are request units from the edge proxy's rate limiter (the shared cost
// table, getLogs plan D17), not raw requests like the dashboard: most calls 1, eth_getLogs
// 2-11 by block range, blocks and block receipts 2, eth_feeHistory / eth_getProof by size
// (eth_getLogs was 100 before 2026-09-28). The edge doesn't count buidlguidl-client traffic,
// requests it rejects, or requests served by the fallback.
const router = express.Router();
const { Pool } = require('pg');
const { SecretsManagerClient, GetSecretValueCommand } = require("@aws-sdk/client-secrets-manager");
const path = require('path');
const fs = require('fs');
const { lookupIp } = require('../utils/ipLookup');

// Load .env from the project root directory
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

async function getDbConnection() {
  try {
    if (!process.env.RDS_SECRET_NAME || !process.env.AWS_ACCESS_KEY_ID || !process.env.AWS_SECRET_ACCESS_KEY || !process.env.DB_HOST) {
      throw new Error('Required environment variables are missing. Please check your .env file.');
    }

    const secret_name = process.env.RDS_SECRET_NAME;
    const secretsClient = new SecretsManagerClient({ 
      region: "us-east-1",
      credentials: {
        accessKeyId: process.env.AWS_ACCESS_KEY_ID,
        secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
      }
    });

    const command = new GetSecretValueCommand({
      SecretId: secret_name,
      VersionStage: "AWSCURRENT",
    });
    const data = await secretsClient.send(command);
    const secret = JSON.parse(data.SecretString);

    const dbConfig = {
      host: process.env.DB_HOST,
      user: secret.username,
      password: secret.password,
      database: secret.dbname || 'postgres',
      port: 5432,
      ssl: {
        rejectUnauthorized: true,
        ca: fs.readFileSync('/home/ubuntu/shared/rds-ca-bundle.pem')
      }
    };

    return new Pool(dbConfig);
  } catch (error) {
    console.error('Error setting up database connection:', error);
    throw error;
  }
}

async function getIpTimeseriesData(days = 7) {
  let pool;
  try {
    pool = await getDbConnection();
    
    // Step 1: Get top 30 IPs by total request count
    const topIpsResult = await pool.query(
      `SELECT ip, SUM(request_count) as total_requests
       FROM ip_history_table
       WHERE hour_timestamp >= EXTRACT(EPOCH FROM NOW() - INTERVAL '${days} days')
       GROUP BY ip
       ORDER BY total_requests DESC
       LIMIT 30`
    );
    
    const topIps = topIpsResult.rows.map(row => row.ip);
    
    if (topIps.length === 0) {
      return [];
    }
    
    // Step 2: Get timeseries data for those top 30 IPs
    const timeseriesResult = await pool.query(
      `SELECT hour_timestamp, ip, request_count, origins
       FROM ip_history_table
       WHERE hour_timestamp >= EXTRACT(EPOCH FROM NOW() - INTERVAL '${days} days')
         AND ip = ANY($1)
       ORDER BY hour_timestamp ASC, ip`,
      [topIps]
    );
    
    return timeseriesResult.rows;
  } catch (error) {
    console.error('Error getting IP timeseries data:', error);
    throw error;
  } finally {
    if (pool) {
      await pool.end();
    }
  }
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

router.get("/iptimeseries", async (req, res) => {
  try {
    const days = parseInt(req.query.days) || 1;
    const data = await getIpTimeseriesData(days);

    if (data.length === 0) {
      return res.send(`
        <html>
          <head>
            <title>IP Timeseries</title>
            <style>
              body { 
                font-family: Arial, sans-serif;
                margin: 0px;
                padding: 0px;
              }
              .message {
                color: #666;
                font-size: 16px;
              }
            </style>
          </head>
          <body>
            <h1>IP Request Units Timeseries - Top 30 IPs</h1>
            <p class="message">No data found in the database for the selected time range.</p>
          </body>
        </html>
      `);
    }

    // First, collect all unique timestamps and organize data by IP
    const allTimestamps = new Set();
    const ipDataMap = {};
    
    data.forEach(row => {
      const timestamp = row.hour_timestamp;
      allTimestamps.add(timestamp);
      
      if (!ipDataMap[row.ip]) {
        ipDataMap[row.ip] = {};
      }
      
      // Calculate requests with origins (sum of all origin values)
      let requestsWithOrigins = 0;
      if (row.origins && typeof row.origins === 'object') {
        requestsWithOrigins = Object.values(row.origins).reduce((sum, count) => sum + count, 0);
      }
      
      // Calculate requests without origins
      const requestsWithoutOrigins = row.request_count - requestsWithOrigins;
      
      ipDataMap[row.ip][timestamp] = {
        total: row.request_count,
        withOrigin: requestsWithOrigins,
        withoutOrigin: requestsWithoutOrigins
      };
    });
    
    // Sort timestamps
    const sortedTimestamps = Array.from(allTimestamps).sort((a, b) => a - b);
    
    // Fill in missing timestamps with 0 for each IP
    const ipData = {};
    Object.keys(ipDataMap).forEach(ip => {
      ipData[ip] = {
        timestamps: [],
        countsTotal: [],
        countsWithOrigin: [],
        countsWithoutOrigin: []
      };
      
      sortedTimestamps.forEach(timestamp => {
        // Convert epoch timestamp (seconds) to milliseconds for JavaScript Date
        ipData[ip].timestamps.push(new Date(timestamp * 1000).toISOString());
        
        // If this IP has data for this timestamp, use it; otherwise use 0
        const dataPoint = ipDataMap[ip][timestamp];
        if (dataPoint) {
          ipData[ip].countsTotal.push(dataPoint.total);
          ipData[ip].countsWithOrigin.push(dataPoint.withOrigin);
          ipData[ip].countsWithoutOrigin.push(dataPoint.withoutOrigin);
        } else {
          ipData[ip].countsTotal.push(0);
          ipData[ip].countsWithOrigin.push(0);
          ipData[ip].countsWithoutOrigin.push(0);
        }
      });
    });

    // Escape the data for safe injection into script tag
    const safeData = JSON.stringify(ipData).replace(/\//g, '\\/').replace(/</g, '\\u003c').replace(/>/g, '\\u003e');

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
          </style>
        </head>
        <body>
          <div class="header-container">
            <h1>IP Request Units Timeseries - Top 30 IPs</h1>
            <div class="controls">
              <div class="filter-group">
                <span class="filter-label">Origin:</span>
                <button class="origin-filter-btn active" data-filter="all">All</button>
                <button class="origin-filter-btn" data-filter="origin">Origin</button>
                <button class="origin-filter-btn" data-filter="no-origin">No Origin</button>
              </div>
              <div class="filter-group">
                <span class="filter-label">Time:</span>
                <button class="time-filter-btn active" data-days="1">1 Day</button>
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
            const ipData = ${safeData};

            // Define a color palette for the traces
            const colors = [
              '#1f77b4', '#ff7f0e', '#2ca02c', '#d62728', '#9467bd',
              '#8c564b', '#e377c2', '#7f7f7f', '#bcbd22', '#17becf',
              '#aec7e8', '#ffbb78', '#98df8a', '#ff9896', '#c5b0d5',
              '#c49c94', '#f7b6d2', '#c7c7c7', '#dbdb8d', '#9edae5',
              '#e377c2', '#7f7f7f', '#bcbd22', '#17becf', '#1f77b4',
              '#ff7f0e', '#2ca02c', '#d62728', '#9467bd', '#8c564b'
            ];

            // Create traces for each IP
            const traces = Object.entries(ipData).map(([ip, data], index) => {
              // Determine marker symbol based on ranking
              let markerSymbol;
              if (index < 10) {
                markerSymbol = 'circle';  // Top 10
              } else if (index < 20) {
                markerSymbol = 'square';  // Middle 10
              } else {
                markerSymbol = 'diamond'; // Bottom 10
              }
              
              // Create array of marker sizes: 0 for zero requests, 12 for non-zero
              // Start with total counts (default view is "All")
              const markerSizes = data.countsTotal.map(count => count > 0 ? 12 : 0);
              
              return {
                name: ip,
                x: data.timestamps,
                y: data.countsTotal,  // Default to showing total counts
                type: 'scatter',
                mode: 'lines+markers',
                line: {
                  color: colors[index % colors.length],
                  width: 3
                },
                marker: {
                  size: markerSizes,
                  symbol: markerSymbol
                },
                hovertemplate: '<b>' + ip + '</b><br>Request units: %{y}<extra></extra>',
                // Store all count arrays for filtering
                countsTotal: data.countsTotal,
                countsWithOrigin: data.countsWithOrigin,
                countsWithoutOrigin: data.countsWithoutOrigin,
                visible: true  // Initially all traces are visible
              };
            });

            // Calculate x-axis range to eliminate blank spaces
            let minTime = null;
            let maxTime = null;
            traces.forEach(trace => {
              if (trace.x.length > 0) {
                const firstTime = trace.x[0];
                const lastTime = trace.x[trace.x.length - 1];
                if (minTime === null || firstTime < minTime) minTime = firstTime;
                if (maxTime === null || lastTime > maxTime) maxTime = lastTime;
              }
            });

            // Calculate y-axis max value with padding based on "All" filter data
            // This ensures consistent y-axis range across all origin filters
            let maxY = 0;
            traces.forEach(trace => {
              const traceMax = Math.max(...trace.countsTotal);
              if (traceMax > maxY) maxY = traceMax;
            });
            // Add 2% padding to the top
            maxY = maxY * 1.02;
            const fixedMaxY = maxY; // Store for use in filter function

            const layout = {
              xaxis: {
                title: 'Time (UTC)',
                type: 'date',
                showgrid: true,
                range: [minTime, maxTime]  // Set exact range to eliminate blank spaces
              },
              yaxis: {
                title: 'Request Units',
                showgrid: true,
                range: [0, maxY]  // Start at 0 and extend to max with padding
              },
              hovermode: 'closest',
              showlegend: true,
              legend: {
                orientation: 'v',
                x: 1.02,
                y: 1,
                xanchor: 'left',
                yanchor: 'top',
                itemclick: false,  // Disable default click behavior
                itemdoubleclick: false  // Disable default double-click behavior
              },
              margin: {
                l: 60,
                r: 200,
                t: 80,
                b: 60
              }
            };

            Plotly.newPlot('ipTimeseriesPlot', traces, layout);

            // Modal functionality
            const modal = document.getElementById('ipModal');
            const modalBody = document.getElementById('modalBody');
            const closeBtn = document.querySelector('.close');

            async function fetchIpInfo(ip) {
              try {
                modalBody.innerHTML = '<div class="loading">Loading...</div>';
                modal.style.display = 'block';
                
                const response = await fetch(\`/iptimeseries/lookup/\${ip}\`);
                if (!response.ok) {
                  throw new Error('Failed to fetch IP information');
                }
                
                const data = await response.json();
                displayIpInfo(data);
              } catch (error) {
                modalBody.innerHTML = \`<div class="loading" style="color: red;">Error: \${error.message}</div>\`;
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
                  html += \`<tr><td>\${field.label}</td><td>\${displayValue}</td></tr>\`;
                }
              });
              html += '</table>';
              modalBody.innerHTML = html;
            }

            // Close modal handlers
            closeBtn.onclick = function() {
              modal.style.display = 'none';
            };

            window.onclick = function(event) {
              if (event.target === modal) {
                modal.style.display = 'none';
              }
            };

            // ESC key to close modal
            document.addEventListener('keydown', function(event) {
              if (event.key === 'Escape' && modal.style.display === 'block') {
                modal.style.display = 'none';
              }
            });

            // Add hover effect to highlight traces
            const plotElement = document.getElementById('ipTimeseriesPlot');
            
            plotElement.on('plotly_hover', function(data) {
              const curveNumber = data.points[0].curveNumber;
              const update = {
                'line.width': traces.map((trace, idx) => idx === curveNumber ? 6 : 3),
                'opacity': traces.map((trace, idx) => idx === curveNumber ? 1.0 : 0.3),
                'marker.size': traces.map((trace, idx) => {
                  // Use the appropriate count data based on current filter
                  let countsToUse;
                  if (currentOriginFilter === 'all') {
                    countsToUse = trace.countsTotal;
                  } else if (currentOriginFilter === 'origin') {
                    countsToUse = trace.countsWithOrigin;
                  } else {
                    countsToUse = trace.countsWithoutOrigin;
                  }
                  
                  return countsToUse.map(count => {
                    if (count === 0) return 0;
                    return idx === curveNumber ? 18 : 12;
                  });
                })
              };
              Plotly.restyle('ipTimeseriesPlot', update);
            });

            plotElement.on('plotly_unhover', function(data) {
              const update = {
                'line.width': traces.map(() => 3),
                'opacity': traces.map(() => 1.0),
                'marker.size': traces.map(trace => {
                  // Use the appropriate count data based on current filter
                  let countsToUse;
                  if (currentOriginFilter === 'all') {
                    countsToUse = trace.countsTotal;
                  } else if (currentOriginFilter === 'origin') {
                    countsToUse = trace.countsWithOrigin;
                  } else {
                    countsToUse = trace.countsWithoutOrigin;
                  }
                  
                  return countsToUse.map(count => count > 0 ? 12 : 0);
                })
              };
              Plotly.restyle('ipTimeseriesPlot', update);
            });

            // Add hover effect to legend items
            setTimeout(() => {
              // Try multiple selectors to find legend items
              let legendItems = null;
              const selectors = [
                '#ipTimeseriesPlot .legend .traces .trace',
                '#ipTimeseriesPlot g.traces > g.trace',
                '#ipTimeseriesPlot .legend text.legendtext'
              ];
              
              for (const selector of selectors) {
                const elements = document.querySelectorAll(selector);
                if (elements.length > 0) {
                  console.log('Found legend items with selector:', selector, 'Count:', elements.length);
                  legendItems = elements;
                  break;
                }
              }
              
              if (!legendItems) {
                console.log('Could not find legend items. Available classes:', 
                  Array.from(document.querySelectorAll('#ipTimeseriesPlot *'))
                    .filter(el => el.classList.length > 0)
                    .map(el => el.className)
                    .slice(0, 20)
                );
                return;
              }
              
              legendItems.forEach((item, index) => {
                // Find the parent group element if we selected text elements
                const targetElement = item.tagName === 'text' ? item.closest('g.trace') || item.parentElement : item;
                targetElement.style.cursor = 'pointer';
                
                // Add click handler for IP lookup
                targetElement.addEventListener('click', (e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  const ip = traces[index].name;
                  fetchIpInfo(ip);
                });
                
                targetElement.addEventListener('mouseenter', () => {
                  const update = {
                    'line.width': traces.map((trace, idx) => idx === index ? 6 : 3),
                    'opacity': traces.map((trace, idx) => idx === index ? 1.0 : 0.3),
                    'marker.size': traces.map((trace, idx) => {
                      // Use the appropriate count data based on current filter
                      let countsToUse;
                      if (currentOriginFilter === 'all') {
                        countsToUse = trace.countsTotal;
                      } else if (currentOriginFilter === 'origin') {
                        countsToUse = trace.countsWithOrigin;
                      } else {
                        countsToUse = trace.countsWithoutOrigin;
                      }
                      
                      return countsToUse.map(count => {
                        if (count === 0) return 0;
                        return idx === index ? 18 : 12;
                      });
                    })
                  };
                  Plotly.restyle('ipTimeseriesPlot', update);
                });
                
                targetElement.addEventListener('mouseleave', () => {
                  const update = {
                    'line.width': traces.map(() => 3),
                    'opacity': traces.map(() => 1.0),
                    'marker.size': traces.map(trace => {
                      // Use the appropriate count data based on current filter
                      let countsToUse;
                      if (currentOriginFilter === 'all') {
                        countsToUse = trace.countsTotal;
                      } else if (currentOriginFilter === 'origin') {
                        countsToUse = trace.countsWithOrigin;
                      } else {
                        countsToUse = trace.countsWithoutOrigin;
                      }
                      
                      return countsToUse.map(count => count > 0 ? 12 : 0);
                    })
                  };
                  Plotly.restyle('ipTimeseriesPlot', update);
                });
              });
            }, 200);

            // Add time filter button handlers
            document.querySelectorAll('.time-filter-btn').forEach(btn => {
              btn.addEventListener('click', () => {
                const days = btn.getAttribute('data-days');
                window.location.href = \`/iptimeseries?days=\${days}\`;
              });
            });

            // Set active button based on current days parameter
            const currentDays = ${days};
            document.querySelectorAll('.time-filter-btn').forEach(btn => {
              btn.classList.remove('active');
              if (parseInt(btn.getAttribute('data-days')) === currentDays) {
                btn.classList.add('active');
              }
            });

            // Add origin filter button handlers
            let currentOriginFilter = 'all';
            let userHasAdjustedAxis = false;
            
            // Track user adjustments to the plot (zoom, pan, etc.)
            plotElement.on('plotly_relayout', function(eventData) {
              // Check if user has manually adjusted the y-axis
              if (eventData['yaxis.range[0]'] !== undefined || eventData['yaxis.range[1]'] !== undefined) {
                userHasAdjustedAxis = true;
              }
              // Check for autorange or double-click reset
              if (eventData['yaxis.autorange'] === true) {
                userHasAdjustedAxis = false;
              }
            });
            
            function applyOriginFilter(filter) {
              currentOriginFilter = filter;
              
              // Determine which data to show and update y-values
              const yData = [];
              const markerSizes = [];
              
              traces.forEach((trace, idx) => {
                let countsToUse;
                if (filter === 'all') {
                  countsToUse = trace.countsTotal;
                } else if (filter === 'origin') {
                  countsToUse = trace.countsWithOrigin;
                } else if (filter === 'no-origin') {
                  countsToUse = trace.countsWithoutOrigin;
                } else {
                  countsToUse = trace.countsTotal;
                }
                
                yData.push(countsToUse);
                markerSizes.push(countsToUse.map(count => count > 0 ? 12 : 0));
              });
              
              // Update trace y-values and marker sizes
              Plotly.restyle('ipTimeseriesPlot', {
                y: yData,
                'marker.size': markerSizes
              });
              
              // Only reset y-axis range if user hasn't manually adjusted it
              if (!userHasAdjustedAxis) {
                Plotly.relayout('ipTimeseriesPlot', {
                  'yaxis.range': [0, fixedMaxY]
                });
              }
              
              // Update active button
              document.querySelectorAll('.origin-filter-btn').forEach(btn => {
                btn.classList.remove('active');
                if (btn.getAttribute('data-filter') === filter) {
                  btn.classList.add('active');
                }
              });
            }
            
            document.querySelectorAll('.origin-filter-btn').forEach(btn => {
              btn.addEventListener('click', () => {
                const filter = btn.getAttribute('data-filter');
                applyOriginFilter(filter);
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
          <p class="error">${error.message}</p>
          <p>Please check your RDS database connection and ip_history_table schema.</p>
        </body>
      </html>
    `);
  }
});

module.exports = router;

