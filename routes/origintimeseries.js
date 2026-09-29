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

async function getOriginTimeseriesData(days = 7) {
  let pool;
  try {
    pool = await getDbConnection();
    
    // Step 1: Get top 30 origins by total request count
    const topOriginsResult = await pool.query(
      `SELECT 
         origin_key AS origin,
         SUM((origin_value)::bigint)::bigint AS total_requests
       FROM 
         ip_history_table,
         jsonb_each_text(origins) AS origin_data(origin_key, origin_value)
       WHERE 
         hour_timestamp >= EXTRACT(EPOCH FROM NOW() - INTERVAL '${days} days')
       GROUP BY 
         origin_key
       ORDER BY 
         total_requests DESC
       LIMIT 30`
    );
    
    const topOrigins = topOriginsResult.rows.map(row => row.origin);
    
    if (topOrigins.length === 0) {
      return [];
    }
    
    // Step 2: Get timeseries data for those top 30 origins
    const timeseriesResult = await pool.query(
      `SELECT 
         hour_timestamp,
         origin_key AS origin,
         SUM((origin_value)::bigint)::bigint AS request_count
       FROM 
         ip_history_table,
         jsonb_each_text(origins) AS origin_data(origin_key, origin_value)
       WHERE 
         hour_timestamp >= EXTRACT(EPOCH FROM NOW() - INTERVAL '${days} days')
         AND origin_key = ANY($1)
       GROUP BY 
         hour_timestamp, origin_key
       ORDER BY 
         hour_timestamp ASC, origin_key`,
      [topOrigins]
    );
    
    return timeseriesResult.rows;
  } catch (error) {
    console.error('Error getting origin timeseries data:', error);
    throw error;
  } finally {
    if (pool) {
      await pool.end();
    }
  }
}

router.get("/origintimeseries", async (req, res) => {
  try {
    const days = parseInt(req.query.days) || 1;
    const data = await getOriginTimeseriesData(days);

    if (data.length === 0) {
      return res.send(`
        <html>
          <head>
            <title>Origin Timeseries</title>
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
            <h1>Origin Request Units Timeseries - Top 30 Origins</h1>
            <p class="message">No data found in the database for the selected time range.</p>
          </body>
        </html>
      `);
    }

    // First, collect all unique timestamps and organize data by origin
    const allTimestamps = new Set();
    const originDataMap = {};
    
    data.forEach(row => {
      const timestamp = row.hour_timestamp;
      allTimestamps.add(timestamp);
      
      if (!originDataMap[row.origin]) {
        originDataMap[row.origin] = {};
      }
      // Explicitly convert to number to avoid string concatenation issues
      // Handle both string and BigInt types from PostgreSQL
      const requestCount = typeof row.request_count === 'bigint' 
        ? Number(row.request_count) 
        : parseInt(row.request_count, 10);
      originDataMap[row.origin][timestamp] = requestCount;
    });
    
    // Sort timestamps
    const sortedTimestamps = Array.from(allTimestamps).sort((a, b) => a - b);
    
    // Fill in missing timestamps with 0 for each origin
    const originData = {};
    Object.keys(originDataMap).forEach(origin => {
      originData[origin] = {
        timestamps: [],
        counts: []
      };
      
      sortedTimestamps.forEach(timestamp => {
        // Convert epoch timestamp (seconds) to milliseconds for JavaScript Date
        originData[origin].timestamps.push(new Date(timestamp * 1000).toISOString());
        // If this origin has data for this timestamp, use it; otherwise use 0
        // Ensure the value is a number
        const count = originDataMap[origin][timestamp];
        originData[origin].counts.push(count !== undefined ? count : 0);
      });
    });

    // Escape the data for safe injection into script tag
    const safeData = JSON.stringify(originData).replace(/\//g, '\\/').replace(/</g, '\\u003c').replace(/>/g, '\\u003e');

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
          </style>
        </head>
        <body>
          <div class="header-container">
            <h1>Origin Request Units Timeseries - Top 30 Origins</h1>
            <div class="controls">
              <button class="time-filter-btn active" data-days="1">1 Day</button>
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
            const originData = ${safeData};

            // Define a color palette for the traces
            const colors = [
              '#1f77b4', '#ff7f0e', '#2ca02c', '#d62728', '#9467bd',
              '#8c564b', '#e377c2', '#7f7f7f', '#bcbd22', '#17becf',
              '#aec7e8', '#ffbb78', '#98df8a', '#ff9896', '#c5b0d5',
              '#c49c94', '#f7b6d2', '#c7c7c7', '#dbdb8d', '#9edae5',
              '#e377c2', '#7f7f7f', '#bcbd22', '#17becf', '#1f77b4',
              '#ff7f0e', '#2ca02c', '#d62728', '#9467bd', '#8c564b'
            ];

            // Create traces for each origin
            const traces = Object.entries(originData).map(([origin, data], index) => {
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
              const markerSizes = data.counts.map(count => count > 0 ? 12 : 0);
              
              return {
                name: origin,
                x: data.timestamps,
                y: data.counts,
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
                hovertemplate: '<b>' + origin + '</b><br>Request units: %{y}<extra></extra>'
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

            // Calculate y-axis max value with padding
            let maxY = 0;
            traces.forEach(trace => {
              const traceMax = Math.max(...trace.y);
              if (traceMax > maxY) maxY = traceMax;
            });
            // Add 2% padding to the top
            maxY = maxY * 1.02;

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

            Plotly.newPlot('originTimeseriesPlot', traces, layout);

            // Modal functionality
            const modal = document.getElementById('originModal');
            const modalBody = document.getElementById('modalBody');
            const originTitle = document.getElementById('originTitle');
            const closeBtn = document.querySelector('.close');

            function showOriginInfo(origin, data) {
              originTitle.textContent = origin;
              
              const totalRequests = data.counts.reduce((sum, count) => sum + count, 0);
              const avgRequests = (totalRequests / data.counts.length).toFixed(2);
              const maxRequests = Math.max(...data.counts);
              const activeHours = data.counts.filter(count => count > 0).length;
              
              let html = '<table class="origin-info-table">';
              html += \`<tr><td>Origin</td><td>\${origin}</td></tr>\`;
              html += \`<tr><td>Total Request Units</td><td>\${totalRequests.toLocaleString()}</td></tr>\`;
              html += \`<tr><td>Average Request Units/Hour</td><td>\${avgRequests}</td></tr>\`;
              html += \`<tr><td>Peak Request Units/Hour</td><td>\${maxRequests.toLocaleString()}</td></tr>\`;
              html += \`<tr><td>Active Hours</td><td>\${activeHours} / \${data.counts.length}</td></tr>\`;
              html += '</table>';
              modalBody.innerHTML = html;
              modal.style.display = 'block';
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
            const plotElement = document.getElementById('originTimeseriesPlot');
            
            plotElement.on('plotly_hover', function(data) {
              const curveNumber = data.points[0].curveNumber;
              const update = {
                'line.width': traces.map((trace, idx) => idx === curveNumber ? 6 : 3),
                'opacity': traces.map((trace, idx) => idx === curveNumber ? 1.0 : 0.3),
                'marker.size': traces.map((trace, idx) => {
                  return trace.y.map(count => {
                    if (count === 0) return 0;
                    return idx === curveNumber ? 18 : 12;
                  });
                })
              };
              Plotly.restyle('originTimeseriesPlot', update);
            });

            plotElement.on('plotly_unhover', function(data) {
              const update = {
                'line.width': traces.map(() => 3),
                'opacity': traces.map(() => 1.0),
                'marker.size': traces.map(trace => trace.y.map(count => count > 0 ? 12 : 0))
              };
              Plotly.restyle('originTimeseriesPlot', update);
            });

            // Add hover effect to legend items
            setTimeout(() => {
              // Try multiple selectors to find legend items
              let legendItems = null;
              const selectors = [
                '#originTimeseriesPlot .legend .traces .trace',
                '#originTimeseriesPlot g.traces > g.trace',
                '#originTimeseriesPlot .legend text.legendtext'
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
                  Array.from(document.querySelectorAll('#originTimeseriesPlot *'))
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
                
                // Add click handler for origin info
                targetElement.addEventListener('click', (e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  const origin = traces[index].name;
                  const data = originData[origin];
                  showOriginInfo(origin, data);
                });
                
                targetElement.addEventListener('mouseenter', () => {
                  const update = {
                    'line.width': traces.map((trace, idx) => idx === index ? 6 : 3),
                    'opacity': traces.map((trace, idx) => idx === index ? 1.0 : 0.3),
                    'marker.size': traces.map((trace, idx) => {
                      return trace.y.map(count => {
                        if (count === 0) return 0;
                        return idx === index ? 18 : 12;
                      });
                    })
                  };
                  Plotly.restyle('originTimeseriesPlot', update);
                });
                
                targetElement.addEventListener('mouseleave', () => {
                  const update = {
                    'line.width': traces.map(() => 3),
                    'opacity': traces.map(() => 1.0),
                    'marker.size': traces.map(trace => trace.y.map(count => count > 0 ? 12 : 0))
                  };
                  Plotly.restyle('originTimeseriesPlot', update);
                });
              });
            }, 200);

            // Add time filter button handlers
            document.querySelectorAll('.time-filter-btn').forEach(btn => {
              btn.addEventListener('click', () => {
                const days = btn.getAttribute('data-days');
                window.location.href = \`/origintimeseries?days=\${days}\`;
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
          <p class="error">${error.message}</p>
          <p>Please check your RDS database connection and ip_history_table schema.</p>
        </body>
      </html>
    `);
  }
});

module.exports = router;
