const express = require('express');
const router = express.Router();
const axios = require('axios');
const https = require('https');
const fs = require('fs');

require('dotenv').config();

const { logsPort, logItemsPerPage } = require('../config');
const { classifyStatus } = require('../utils/errorClass');

// Create an HTTPS agent that uses proper SSL validation
const httpsAgent = new https.Agent({
  rejectUnauthorized: true,
  cert: fs.readFileSync('/home/ubuntu/shared/server.cert'),
  key: fs.readFileSync('/home/ubuntu/shared/server.key')
});

async function fetchLogs(url) {
  try {
    const response = await axios.get(`https://${process.env.HOST}:${logsPort}${url}`, {
      httpsAgent,
      headers: {
        'Accept': 'application/json'
      }
    });
    const logs = Array.isArray(response.data) ? response.data : [];
    
    return logs
      .map(log => ({
        timestamp: log.timestamp,
        origin: log.requester || '',
        ip: log.ip || '',
        method: log.method,
        params: log.params,
        duration: log.elapsed,
        status: log.status
      }))
      .reverse(); // Reverse the order so newest entries are first
  } catch (error) {
    console.error(`Error fetching logs from ${url}:`, error);
    return [];
  }
}

async function fetchPoolNodeLogs() {
  try {
    const response = await axios.get(`https://${process.env.HOST}:${logsPort}/poolNodes`, {
      httpsAgent,
      headers: {
        'Accept': 'application/json'
      }
    });
    const logs = Array.isArray(response.data) ? response.data : [];
    return logs.reverse(); // Reverse the order so newest entries are first
  } catch (error) {
    console.error('Error fetching pool node logs:', error);
    return [];
  }
}

async function fetchPoolCompareResults() {
  try {
    const response = await axios.get(`https://${process.env.HOST}:${logsPort}/poolCompareResults`, {
      httpsAgent,
      headers: {
        'Accept': 'application/json'
      }
    });
    const logs = Array.isArray(response.data) ? response.data : [];
    return logs.reverse(); // Reverse the order so newest entries are first
  } catch (error) {
    console.error('Error fetching pool compare results:', error);
    return [];
  }
}

function renderPagination(currentPage, totalPages, baseUrl, tableId) {
  const pages = [];
  const maxVisiblePages = 5;
  let startPage = Math.max(1, currentPage - Math.floor(maxVisiblePages / 2));
  let endPage = Math.min(totalPages, startPage + maxVisiblePages - 1);

  if (endPage - startPage + 1 < maxVisiblePages) {
    startPage = Math.max(1, endPage - maxVisiblePages + 1);
  }

  return `
    <div class="pagination">
      ${currentPage > 1 ? `<a onclick="changePage('${tableId}', 1)" class="page-link">«</a>` : ''}
      ${currentPage > 1 ? `<a onclick="changePage('${tableId}', ${currentPage - 1})" class="page-link">‹</a>` : ''}
      ${Array.from({ length: endPage - startPage + 1 }, (_, i) => startPage + i)
        .map(page => `
          <a onclick="changePage('${tableId}', ${page})" 
             class="page-link ${page === currentPage ? 'active' : ''}">${page}</a>
        `).join('')}
      ${currentPage < totalPages ? `<a onclick="changePage('${tableId}', ${currentPage + 1})" class="page-link">›</a>` : ''}
      ${currentPage < totalPages ? `<a onclick="changePage('${tableId}', ${totalPages})" class="page-link">»</a>` : ''}
    </div>
  `;
}

function getRowClass(log) {
  // Only our failures are red; a caller's mistake answered by a node is shown plain (utils/errorClass.js)
  const errorClass = classifyStatus(log.status);
  if (errorClass === 'warning') return ' class="warning"';
  if (errorClass === 'error') return ' class="error"';
  return '';
}

function getCompareRowClass(log) {
  if (log.resultsMatch) {
    return '';
  }
  return ' class="error"';
}

function renderTable(logs, title, currentPage, tableId, isAjax = false) {
  const startIndex = (currentPage - 1) * logItemsPerPage;
  const endIndex = startIndex + logItemsPerPage;
  const totalPages = Math.ceil(logs.length / logItemsPerPage);
  const pageData = logs.slice(startIndex, endIndex);

  const isPoolNodeLogs = tableId === 'poolNodeLogs';
  
  if (isAjax) {
    // For AJAX requests, only return the table body and pagination
    return {
      tbody: pageData.map(log => isPoolNodeLogs ? `
        <tr${getRowClass(log)}>
          <td>${log.timestamp}</td>
          <td>${log.nodeId}</td>
          <td>${log.owner}</td>
          <td>${log.duration}</td>
          <td>${log.status}</td>
          <td>${log.method}</td>
          <td>${log.params}</td>
        </tr>
      ` : `
        <tr${getRowClass(log)}>
          <td>${log.timestamp}</td>
          <td>${log.duration}</td>
          <td>${log.status}</td>
          <td>${log.origin}</td>
          <td>${log.ip}</td>
          <td>${log.method}</td>
          <td>${log.params}</td>
        </tr>
      `).join(''),
      pagination: logs.length > logItemsPerPage ? renderPagination(currentPage, totalPages, '', tableId) : ''
    };
  }

  // For initial render, return the full table
  return `
    <div id="${tableId}" style="margin-bottom: 40px;">
      <h2>${title} (${logs.length} total entries)</h2>
      <div class="filter-buttons" style="margin-bottom: 15px;">
        <button onclick="filterLogs('${tableId}', 'no-client')" class="filter-btn active">No Client</button>
        <button onclick="filterLogs('${tableId}', 'all')" class="filter-btn">All</button>
        <button onclick="filterLogs('${tableId}', 'success')" class="filter-btn">Success</button>
        <button onclick="filterLogs('${tableId}', 'warning')" class="filter-btn">Warning</button>
        <button onclick="filterLogs('${tableId}', 'error')" class="filter-btn">Error</button>
      </div>
      <table border="1" style="width: 100%; border-collapse: collapse; margin-bottom: 20px;">
        <thead>
          <tr style="background-color: #f2f2f2;">
            ${isPoolNodeLogs ? `
            <th>Timestamp</th>
            <th>Node ID</th>
            <th>Owner</th>
            <th>Duration (ms)</th>
            <th>Status</th>
            <th>Method</th>
            <th>Params</th>
            ` : `
            <th>Timestamp</th>
            <th>Duration (ms)</th>
            <th>Status</th>
            <th>Origin</th>
            <th>IP</th>
            <th>Method</th>
            <th>Params</th>
            `}
          </tr>
        </thead>
        <tbody id="${tableId}-body">
          ${pageData.map(log => isPoolNodeLogs ? `
            <tr${getRowClass(log)}>
              <td>${log.timestamp}</td>
              <td>${log.nodeId}</td>
              <td>${log.owner}</td>
              <td>${log.duration}</td>
              <td>${log.status}</td>
              <td>${log.method}</td>
              <td>${log.params}</td>
            </tr>
          ` : `
            <tr${getRowClass(log)}>
              <td>${log.timestamp}</td>
              <td>${log.duration}</td>
              <td>${log.status}</td>
              <td>${log.origin}</td>
              <td>${log.ip}</td>
              <td>${log.method}</td>
              <td>${log.params}</td>
            </tr>
          `).join('')}
        </tbody>
      </table>
      <div id="${tableId}-pagination">
        ${logs.length > logItemsPerPage ? renderPagination(currentPage, totalPages, '', tableId) : ''}
      </div>
    </div>
  `;
}

function renderCompareTable(logs, title, currentPage, tableId, isAjax = false) {
  const startIndex = (currentPage - 1) * logItemsPerPage;
  const endIndex = startIndex + logItemsPerPage;
  const totalPages = Math.ceil(logs.length / logItemsPerPage);
  const pageData = logs.slice(startIndex, endIndex);

  const formatResult = (result, index) => {
    // Handle string that might contain JSON
    if (typeof result === 'string' && result.startsWith('result:')) {
      try {
        const jsonStr = result.replace('result:', '').trim();
        const parsed = JSON.parse(jsonStr);
        if (typeof parsed === 'object' && parsed !== null && Object.keys(parsed).length > 0) {
          const resultStr = JSON.stringify(parsed);
          return `<a class="view-object-link" onclick='showModal(${resultStr.replace(/'/g, "\\'")})'>View Object</a>`;
        }
        return jsonStr.length > 48 ? 
          `<a class="view-object-link" onclick='showModal("${jsonStr.replace(/"/g, '\\"')}")'>View Value</a>` : 
          jsonStr;
      } catch (e) {
        return result.length > 48 ? 
          `<a class="view-object-link" onclick='showModal("${result.replace(/"/g, '\\"')}")'>View Value</a>` : 
          result;
      }
    }
    
    // Handle direct objects
    if (typeof result === 'object' && result !== null && Object.keys(result).length > 0) {
      const resultStr = JSON.stringify(result);
      return `<a class="view-object-link" onclick='showModal(${resultStr.replace(/'/g, "\\'")})'>View Object</a>`;
    }
    
    // Handle long string values
    if (typeof result === 'string' && result.length > 48) {
      return `<a class="view-object-link" onclick='showModal("${result.replace(/"/g, '\\"')}")'>View Value</a>`;
    }
    return result;
  };

  if (isAjax) {
    return {
      tbody: pageData.map((log, index) => `
        <tr${getCompareRowClass(log)}>
          <td>${log.timestamp}</td>
          <td>${log.resultsMatch ? 'Yes' : 'No'}</td>
          <td>${log.mismatchedNode || '-'}</td>
          <td>${log.mismatchedOwner || '-'}</td>
          <td><span class="node-id">${log.nodeId1}</span><br>${formatResult(log.nodeResult1, index)}</td>
          <td><span class="node-id">${log.nodeId2}</span><br>${formatResult(log.nodeResult2, index)}</td>
          <td><span class="node-id">${log.nodeId3}</span><br>${formatResult(log.nodeResult3, index)}</td>
          <td>${log.mismatchedResults.length ? log.mismatchedResults.map(r => formatResult(r, index)).join('<br>') : '-'}</td>
          <td>${log.method || '-'}</td>
          <td>${log.params || '-'}</td>
        </tr>
      `).join(''),
      pagination: logs.length > logItemsPerPage ? renderPagination(currentPage, totalPages, '', tableId) : ''
    };
  }

  return `
    <div id="${tableId}" style="margin-bottom: 40px;">
      <h2>${title} (${logs.length} total entries)</h2>
      <div class="filter-buttons hidden" style="margin-bottom: 15px;">
        <button onclick="filterLogs('${tableId}', 'no-client')" class="filter-btn active">No Client</button>
        <button onclick="filterLogs('${tableId}', 'all')" class="filter-btn">All</button>
        <button onclick="filterLogs('${tableId}', 'success')" class="filter-btn">Match</button>
        <button onclick="filterLogs('${tableId}', 'error')" class="filter-btn">Mismatch</button>
      </div>
      <table border="1" style="width: 100%; border-collapse: collapse; margin-bottom: 20px;">
        <thead>
          <tr style="background-color: #f2f2f2;">
            <th>Timestamp</th>
            <th>Results Match</th>
            <th>Mismatched Node</th>
            <th>Mismatched Owner</th>
            <th>Node 1</th>
            <th>Node 2</th>
            <th>Node 3</th>
            <th>Mismatched Results</th>
            <th>Method</th>
            <th>Params</th>
          </tr>
        </thead>
        <tbody id="${tableId}-body">
          ${pageData.map((log, index) => `
            <tr${getCompareRowClass(log)}>
              <td>${log.timestamp}</td>
              <td>${log.resultsMatch ? 'Yes' : 'No'}</td>
              <td>${log.mismatchedNode || '-'}</td>
              <td>${log.mismatchedOwner || '-'}</td>
              <td><span class="node-id">${log.nodeId1}</span><br>${formatResult(log.nodeResult1, index)}</td>
              <td><span class="node-id">${log.nodeId2}</span><br>${formatResult(log.nodeResult2, index)}</td>
              <td><span class="node-id">${log.nodeId3}</span><br>${formatResult(log.nodeResult3, index)}</td>
              <td>${log.mismatchedResults.length ? log.mismatchedResults.map(r => formatResult(r, index)).join('<br>') : '-'}</td>
              <td>${log.method || '-'}</td>
              <td>${log.params || '-'}</td>
            </tr>
          `).join('')}
        </tbody>
      </table>
      <div id="${tableId}-pagination">
        ${logs.length > logItemsPerPage ? renderPagination(currentPage, totalPages, '', tableId) : ''}
      </div>
    </div>
  `;
}

router.get("/logs", async (req, res) => {
  try {
    const currentPage = parseInt(req.query.page) || 1;
    const filter = req.query.filter || 'all';
    let [poolLogs, fallbackLogs, cacheLogs, poolNodeLogs, poolCompareResults] = await Promise.all([
      fetchLogs('/poolRequests'),
      fetchLogs('/fallbackRequests'),
      fetchLogs('/cacheRequests'),
      fetchPoolNodeLogs(),
      fetchPoolCompareResults()
    ]);

    // Apply filters if needed
    if (filter !== 'all') {
      const isSuccess = filter === 'success';
      const isWarning = filter === 'warning';
      const isNoClient = filter === 'no-client';
      const filterFn = log => {
        if (isNoClient) return log.origin !== 'buidlguidl-client';
        
        // Same classes as the row colours: Warning = our nodes lacked data or timed out,
        // Error = our failures only; a caller's mistake is neither (utils/errorClass.js)
        const errorClass = classifyStatus(log.status);
        if (isSuccess) return errorClass === 'ok';
        if (isWarning) return errorClass === 'warning';
        return errorClass === 'error';
      };
      
      poolLogs = poolLogs.filter(filterFn);
      fallbackLogs = fallbackLogs.filter(filterFn);
      cacheLogs = cacheLogs.filter(filterFn);
      poolNodeLogs = poolNodeLogs.filter(filterFn);
      poolCompareResults = poolCompareResults.filter(log => 
        isSuccess ? log.resultsMatch : !log.resultsMatch
      );
    }

    // If it's an AJAX request for a specific table, return only the updated parts
    if (req.query.tableId) {
      let logs;
      let title;
      let isCompareTable = false;
      
      switch(req.query.tableId) {
        case 'poolLogs':
          logs = poolLogs;
          title = 'Pool Request Logs';
          break;
        case 'fallbackLogs':
          logs = fallbackLogs;
          title = 'Fallback Request Logs';
          break;
        case 'cacheLogs':
          logs = cacheLogs;
          title = 'Cache Request Logs';
          break;
        case 'poolNodeLogs':
          logs = poolNodeLogs;
          title = 'Pool Node Logs';
          break;
        case 'poolCompareResults':
          logs = poolCompareResults;
          title = 'Pool Compare Results';
          isCompareTable = true;
          break;
      }
      
      const rendered = isCompareTable 
        ? renderCompareTable(logs, title, currentPage, req.query.tableId, true)
        : renderTable(logs, title, currentPage, req.query.tableId, true);
      res.setHeader('Content-Type', 'application/json');
      return res.json(rendered);
    }

    res.send(`
      <html>
        <head>
          <title>RPC Logs</title>
          <style>
            body { font-family: Arial, sans-serif; margin: 0px; }
            .container { margin: 0px 10px; }
            table { font-size: 14px; width: 100%; }
            th, td { padding: 8px; text-align: left; vertical-align: top; font-family: monospace; white-space: pre-wrap; }
            h1 { margin-bottom: 30px; }
            h2 { color: #333; margin-bottom: 15px; }
            tr:nth-child(even) { background-color: #f9f9f9; }
            tr:hover { background-color:rgb(227, 227, 227); }
            tr.error { background-color: #ffe5e8; }
            tr.error:hover { background-color:rgb(251, 210, 215); }
            tr.warning { background-color:rgb(254, 236, 214); }
            tr.warning:hover { background-color:rgb(252, 231, 204); }
            .pagination { 
              display: flex;
              justify-content: center;
              align-items: center;
              gap: 5px;
              margin-top: 20px;
            }
            .page-link {
              padding: 8px 12px;
              text-decoration: none;
              color: #333;
              border: 1px solid #ddd;
              border-radius: 4px;
              cursor: pointer;
            }
            .page-link:hover {
              background-color: #f5f5f5;
            }
            .page-link.active {
              background-color: #007bff;
              color: white;
              border-color: #007bff;
            }
            .filter-buttons {
              display: flex;
              gap: 10px;
            }
            .filter-btn {
              padding: 8px 16px;
              border: 1px solid #ddd;
              background: white;
              border-radius: 4px;
              cursor: pointer;
              font-size: 14px;
            }
            .filter-btn:hover {
              background-color: #f5f5f5;
            }
            .filter-btn.active {
              background-color: #007bff;
              color: white;
              border-color: #007bff;
            }
            #poolLogs,
            #fallbackLogs,
            #cacheLogs,
            #poolNodeLogs,
            #poolCompareResults {
              min-height: 1187px;
            }
            /* Modal styles */
            .modal {
              display: none;
              position: fixed;
              top: 0;
              left: 0;
              width: 100%;
              height: 100%;
              background-color: rgba(0,0,0,0.5);
              z-index: 1000;
            }
            .modal-content {
              position: relative;
              background-color: #fefefe;
              margin: 5% auto;
              padding: 20px;
              border: 1px solid #888;
              max-width: 80%;
              max-height: 80vh;
              overflow-y: auto;
              border-radius: 5px;
            }
            .close-modal {
              position: absolute;
              right: 10px;
              top: 5px;
              color: #aaa;
              font-size: 28px;
              font-weight: bold;
              cursor: pointer;
            }
            .close-modal:hover {
              color: #000;
            }
            .view-object-link {
              color: #007bff;
              text-decoration: underline;
              cursor: pointer;
            }
            .view-object-link:hover {
              color: #0056b3;
            }
            .node-id {
              font-weight: bold;
            }
            .hidden {
              display: none !important;
            }
          </style>
          <script>
            let poolCurrentPage = 1;
            let fallbackCurrentPage = 1;
            let cacheCurrentPage = 1;
            let poolNodeCurrentPage = 1;
            let poolCompareCurrentPage = 1;
            let poolCurrentFilter = 'no-client';
            let fallbackCurrentFilter = 'no-client';
            let cacheCurrentFilter = 'no-client';
            let poolNodeCurrentFilter = 'all';
            let poolCompareCurrentFilter = 'all';

            // Initialize filters on page load
            window.onload = function() {
              filterLogs('cacheLogs', 'no-client');
              filterLogs('poolLogs', 'no-client');
              filterLogs('fallbackLogs', 'no-client');
            };

            function showModal(content) {
              const modal = document.getElementById('objectModal');
              const modalContent = document.getElementById('modalContent');
              modalContent.innerHTML = '<pre>' + JSON.stringify(content, null, 2) + '</pre>';
              modal.style.display = 'block';
            }

            function closeModal() {
              const modal = document.getElementById('objectModal');
              modal.style.display = 'none';
            }

            // Close modal when clicking outside
            window.onclick = function(event) {
              const modal = document.getElementById('objectModal');
              if (event.target === modal) {
                modal.style.display = 'none';
              }
            }

            async function changePage(tableId, page) {
              try {
                if (tableId === 'poolLogs') {
                  poolCurrentPage = page;
                } else if (tableId === 'fallbackLogs') {
                  fallbackCurrentPage = page;
                } else if (tableId === 'cacheLogs') {
                  cacheCurrentPage = page;
                } else if (tableId === 'poolNodeLogs') {
                  poolNodeCurrentPage = page;
                } else if (tableId === 'poolCompareResults') {
                  poolCompareCurrentPage = page;
                }

                const filter = tableId === 'poolLogs' ? poolCurrentFilter : 
                             tableId === 'fallbackLogs' ? fallbackCurrentFilter : 
                             tableId === 'cacheLogs' ? cacheCurrentFilter :
                             tableId === 'poolNodeLogs' ? poolNodeCurrentFilter :
                             poolCompareCurrentFilter;
                const response = await fetch(\`/logs?page=\${page}&tableId=\${tableId}&filter=\${filter}\`, {
                  headers: {
                    'Accept': 'application/json'
                  }
                });
                const data = await response.json();
                
                // Update only the table body and pagination
                document.getElementById(\`\${tableId}-body\`).innerHTML = data.tbody;
                document.getElementById(\`\${tableId}-pagination\`).innerHTML = data.pagination;
              } catch (error) {
                console.error('Error changing page:', error);
              }
            }

            async function filterLogs(tableId, filter) {
              try {
                // Update filter state
                if (tableId === 'poolLogs') {
                  poolCurrentFilter = filter;
                  poolCurrentPage = 1;
                } else if (tableId === 'fallbackLogs') {
                  fallbackCurrentFilter = filter;
                  fallbackCurrentPage = 1;
                } else if (tableId === 'cacheLogs') {
                  cacheCurrentFilter = filter;
                  cacheCurrentPage = 1;
                } else if (tableId === 'poolNodeLogs') {
                  poolNodeCurrentFilter = filter;
                  poolNodeCurrentPage = 1;
                } else if (tableId === 'poolCompareResults') {
                  poolCompareCurrentFilter = filter;
                  poolCompareCurrentPage = 1;
                }

                // Update active button state
                const buttons = document.querySelectorAll(\`#\${tableId} .filter-btn\`);
                buttons.forEach(btn => {
                  btn.classList.remove('active');
                  const btnText = btn.textContent.toLowerCase();
                  const shouldBeActive = (
                    (filter === 'no-client' && btnText === 'no client') ||
                    (filter === 'all' && btnText === 'all') ||
                    (filter === 'success' && (btnText === 'success' || btnText === 'match')) ||
                    (filter === 'warning' && btnText === 'warning') ||
                    (filter === 'error' && (btnText === 'error' || btnText === 'mismatch'))
                  );
                  if (shouldBeActive) {
                    btn.classList.add('active');
                  }
                });

                // Fetch filtered data
                const response = await fetch(\`/logs?page=1&tableId=\${tableId}&filter=\${filter}\`, {
                  headers: {
                    'Accept': 'application/json'
                  }
                });
                const data = await response.json();
                
                // Update the table
                document.getElementById(\`\${tableId}-body\`).innerHTML = data.tbody;
                document.getElementById(\`\${tableId}-pagination\`).innerHTML = data.pagination;
              } catch (error) {
                console.error('Error filtering logs:', error);
              }
            }
          </script>
        </head>
        <body>
          <div class="container">
            <!-- Modal -->
            <div id="objectModal" class="modal">
              <div class="modal-content">
                <span class="close-modal" onclick="closeModal()">&times;</span>
                <div id="modalContent"></div>
              </div>
            </div>
            
            <h1>Proxy Logs</h1>
            ${renderTable(cacheLogs, 'Cache Request Logs', currentPage, 'cacheLogs')}
            ${renderTable(poolLogs, 'Pool Request Logs', currentPage, 'poolLogs')}
            ${renderTable(fallbackLogs, 'Fallback Request Logs', currentPage, 'fallbackLogs')}
            <h1>Pool Node Logs</h1>
            ${renderTable(poolNodeLogs, 'Pool Node Logs', currentPage, 'poolNodeLogs')}
            ${renderCompareTable(poolCompareResults, 'Pool Compare Results', currentPage, 'poolCompareResults')}
          </div>
          </body>
      </html>
    `);
  } catch (error) {
    console.error('Error fetching logs:', error);
    res.status(500).send(`
      <html>
        <head>
          <title>Error - RPC Logs</title>
          <style>
            body { padding: 20px; font-family: Arial, sans-serif; }
            .error { color: red; }
          </style>
        </head>
        <body>
          <h1>Error Fetching Logs</h1>
          <p class="error">${error.message}</p>
          <p>Please try refreshing the page.</p>
        </body>
      </html>
    `);
  }
});

module.exports = router;