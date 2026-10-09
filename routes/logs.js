const express = require('express');
const router = express.Router();
const axios = require('axios');
const https = require('https');
const fs = require('fs');

require('dotenv').config();

const { logsPort, logItemsPerPage } = require('../config');

// Create an HTTPS agent that uses proper SSL validation
const httpsAgent = new https.Agent({
  rejectUnauthorized: true,
  cert: fs.readFileSync('/home/ubuntu/shared/server.cert'),
  key: fs.readFileSync('/home/ubuntu/shared/server.key')
});

// Filters the page offers. The logs service applies them and pages the tables (bg-rpc-logs
// logService.js), and gives each request and node entry its error class (bg-rpc-logs
// utils/errorClass.js, the one copy: bg-rpc-docs LOGS_SERVICE_OPTIMIZATION_PLAN.md, D1).
const FILTERS = ['all', 'no-client', 'success', 'warning', 'error'];
// Search limits, as the logs service enforces them
const MAX_METHOD_CHARS = 100;
const MAX_SEARCH_CHARS = 200;

// Everything in a log entry can come from outside: params, origin and status from callers,
// node IDs, owners and results from volunteer nodes. Escape every value put into the page.
function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

// One page of a table, newest first: { total, methods, entries }. total counts the entries that
// pass the filter and search; methods lists every method in the table (for the method dropdown).
// search: { method, q }, both optional.
async function fetchPage(url, page, filter, search = {}) {
  try {
    const response = await axios.get(`https://${process.env.HOST}:${logsPort}${url}`, {
      httpsAgent,
      headers: {
        'Accept': 'application/json'
      },
      params: { page, limit: logItemsPerPage, filter, method: search.method || undefined, q: search.q || undefined }
    });
    const { total, methods, entries } = response.data || {};
    return {
      total: Number.isInteger(total) ? total : 0,
      methods: Array.isArray(methods) ? methods : [],
      entries: Array.isArray(entries) ? entries : []
    };
  } catch (error) {
    console.error(`Error fetching logs from ${url}:`, error);
    return { total: 0, methods: [], entries: [] };
  }
}

async function fetchRequestLogs(url, page, filter, search) {
  const { total, methods, entries } = await fetchPage(url, page, filter, search);
  return {
    total,
    methods,
    entries: entries.map(log => ({
      timestamp: log.timestamp,
      origin: log.requester || '',
      ip: log.ip || '',
      method: log.method,
      params: log.params,
      duration: log.elapsed,
      status: log.status,
      errorClass: log.errorClass
    }))
  };
}

// A table heading bracketed by the title's emoji, drawn larger (.title-emoji) so tables are easy to
// find: 🤿 Pool Request Logs (95 total entries) 🤿
function titleHeading(title, tableId, total) {
  const [, emoji, text] = String(title).match(/^(\S+)\s+(.*)$/u) || [null, '', String(title)];
  const icon = emoji ? `<span class="title-emoji">${escapeHtml(emoji)}</span>` : '';
  const count = `(<span id="${tableId}-total">${total}</span> total entries)`;
  return `<h2>${icon ? icon + ' ' : ''}${escapeHtml(text)} ${count}${icon ? ' ' + icon : ''}</h2>`;
}

// The page's tables: the logs service endpoint behind each, and how its rows are read
const TABLES = {
  poolLogs: { title: '🤿 Pool Request Logs', fetch: (page, filter, search) => fetchRequestLogs('/poolRequests', page, filter, search) },
  fallbackLogs: { title: '🛟 Fallback Request Logs', fetch: (page, filter, search) => fetchRequestLogs('/fallbackRequests', page, filter, search) },
  cacheLogs: { title: '💾 Cache Request Logs', fetch: (page, filter, search) => fetchRequestLogs('/cacheRequests', page, filter, search) },
  poolNodeLogs: { title: '📟 Pool Node Logs', fetch: (page, filter, search) => fetchPage('/poolNodes', page, filter, search) },
  // Requests bg-rpc-proxy answered by sharing an identical request in flight (request merging). The
  // logs service gives each its own cache line's status, params and error class
  mergedLogs: { title: '🔗 Merged Request Logs', fetch: (page, filter, search) => fetchPage('/mergedRequests', page, filter, search) },
  poolCompareResults: { title: '⚖️ Pool Compare Results', fetch: (page, filter, search) => fetchPage('/poolCompareResults', page, filter, search), isCompare: true }
};

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
  // Only our failures are red; a caller's mistake answered by a node is shown plain (errorClass
  // comes from the logs service)
  if (log.errorClass === 'warning') return ' class="warning"';
  if (log.errorClass === 'error') return ' class="error"';
  return '';
}

function getCompareRowClass(log) {
  if (log.resultsMatch) {
    return '';
  }
  return ' class="error"';
}

function renderRequestRow(log) {
  return `
            <tr${getRowClass(log)}>
              <td>${escapeHtml(log.timestamp)}</td>
              <td>${escapeHtml(log.duration)}</td>
              <td>${formatStatus(log.status)}</td>
              <td>${escapeHtml(log.origin)}</td>
              <td>${escapeHtml(log.ip)}</td>
              <td>${escapeHtml(log.method)}</td>
              <td>${escapeHtml(log.params)}</td>
            </tr>
          `;
}

function renderNodeRow(log) {
  return `
            <tr${getRowClass(log)}>
              <td>${escapeHtml(log.timestamp)}</td>
              <td>${escapeHtml(log.nodeId)}</td>
              <td>${escapeHtml(log.owner)}</td>
              <td>${escapeHtml(log.duration)}</td>
              <td>${escapeHtml(log.status)}</td>
              <td>${escapeHtml(log.method)}</td>
              <td>${escapeHtml(log.params)}</td>
            </tr>
          `;
}

// A merged request: waited for an identical request already in flight instead of reaching a node.
// Times in the order they happened: it arrived gapMs after the first request started, then waited
// waitMs for the shared answer, so the first request took gapMs + waitMs in all (exact: the wait
// ends when the first request settles).
function renderMergedRow(log) {
  const firstTook = Number.isFinite(log.gapMs) && Number.isFinite(log.waitMs) ? log.gapMs + log.waitMs : '';
  return `
            <tr${getRowClass(log)}>
              <td>${escapeHtml(log.timestamp)}</td>
              <td>${escapeHtml(log.gapMs)}</td>
              <td>${escapeHtml(log.waitMs)}</td>
              <td>${escapeHtml(firstTook)}</td>
              <td>${formatStatus(log.status)}</td>
              <td>${escapeHtml(log.requester)}</td>
              <td>${escapeHtml(log.ip)}</td>
              <td>${escapeHtml(log.method)}</td>
              <td>${log.sameCaller ? 'yes' : 'no'}</td>
              <td>${escapeHtml(log.params)}</td>
            </tr>
          `;
}

// A link that opens the value in the modal. The value goes into onclick as a JSON literal,
// HTML-escaped (the browser unescapes the attribute before running it).
function modalLink(value, label) {
  return `<a class="view-object-link" onclick="showModal(${escapeHtml(JSON.stringify(value))})">${label}</a>`;
}

// A request's status, short: an error's code and message (its data, often a long hex string with
// no place to wrap, stretched the column), with the full JSON behind a View link. success and other
// short text as is; anything else long goes behind the link. Display only: the logs service keeps
// the full status, so search still finds text inside it.
const STATUS_INLINE_CHARS = 120;
function formatStatus(status) {
  if (typeof status !== 'string') return escapeHtml(status ?? '');
  let parsed = null;
  if (status.startsWith('{')) {
    try { parsed = JSON.parse(status); } catch { parsed = null; }
  }
  const error = parsed && typeof parsed === 'object' ? (parsed.error && typeof parsed.error === 'object' ? parsed.error : parsed) : null;
  if (error && (error.code !== undefined || error.message !== undefined)) {
    const summary = [error.code, error.message].filter(v => v !== undefined && v !== null && v !== '').join(': ');
    return `${escapeHtml(summary)} ${modalLink(parsed, 'View')}`;
  }
  if (parsed && typeof parsed === 'object') return modalLink(parsed, 'View Object');
  return status.length > STATUS_INLINE_CHARS ? `${escapeHtml(status.slice(0, STATUS_INLINE_CHARS))}… ${modalLink(status, 'View')}` : escapeHtml(status);
}

// A node's result in the compare table: short values inline, objects and long values behind a link
function formatResult(result) {
  // Handle string that might contain JSON
  if (typeof result === 'string' && result.startsWith('result:')) {
    const jsonStr = result.replace('result:', '').trim();
    try {
      const parsed = JSON.parse(jsonStr);
      if (typeof parsed === 'object' && parsed !== null && Object.keys(parsed).length > 0) {
        return modalLink(parsed, 'View Object');
      }
      return jsonStr.length > 48 ? modalLink(jsonStr, 'View Value') : escapeHtml(jsonStr);
    } catch (e) {
      return result.length > 48 ? modalLink(result, 'View Value') : escapeHtml(result);
    }
  }

  // Handle direct objects
  if (typeof result === 'object' && result !== null && Object.keys(result).length > 0) {
    return modalLink(result, 'View Object');
  }

  // Handle long string values
  if (typeof result === 'string' && result.length > 48) {
    return modalLink(result, 'View Value');
  }
  return escapeHtml(result);
}

function renderCompareRow(log) {
  return `
            <tr${getCompareRowClass(log)}>
              <td>${escapeHtml(log.timestamp)}</td>
              <td>${log.resultsMatch ? 'Yes' : 'No'}</td>
              <td>${escapeHtml(log.mismatchedNode || '-')}</td>
              <td>${escapeHtml(log.mismatchedOwner || '-')}</td>
              <td><span class="node-id">${escapeHtml(log.nodeId1)}</span><br>${formatResult(log.nodeResult1)}</td>
              <td><span class="node-id">${escapeHtml(log.nodeId2)}</span><br>${formatResult(log.nodeResult2)}</td>
              <td><span class="node-id">${escapeHtml(log.nodeId3)}</span><br>${formatResult(log.nodeResult3)}</td>
              <td>${log.mismatchedResults.length ? log.mismatchedResults.map(r => formatResult(r)).join('<br>') : '-'}</td>
              <td>${escapeHtml(log.method || '-')}</td>
              <td>${escapeHtml(log.params || '-')}</td>
            </tr>
          `;
}

// The method dropdown and search box above a request or node table
function renderSearchBar(tableId, methods) {
  const placeholder = tableId === 'poolNodeLogs'
    ? 'Search node, owner, params, status'
    : 'Search origin, IP, params, status';
  return `
      <div class="search-bar">
        <select id="${tableId}-method" onchange="searchLogs('${tableId}')">
          <option value="">All methods</option>
          ${methods.map(m => `<option value="${escapeHtml(m)}">${escapeHtml(m)}</option>`).join('')}
        </select>
        <input id="${tableId}-q" type="search" maxlength="${MAX_SEARCH_CHARS}" placeholder="${placeholder}" oninput="searchLogsSoon('${tableId}')">
      </div>`;
}

function renderTable({ total, methods, entries: pageData }, title, currentPage, tableId, isAjax = false) {
  const totalPages = Math.ceil(total / logItemsPerPage);
  const renderRow = tableId === 'poolNodeLogs' ? renderNodeRow : tableId === 'mergedLogs' ? renderMergedRow : renderRequestRow;
  const pagination = total > logItemsPerPage ? renderPagination(currentPage, totalPages, '', tableId) : '';

  if (isAjax) {
    // For AJAX requests, only return the table body, pagination and count
    return { tbody: pageData.map(renderRow).join(''), pagination, total };
  }

  // For initial render, return the full table
  return `
    <div id="${tableId}" style="margin-bottom: 40px;">
      ${titleHeading(title, tableId, total)}
      <div class="filter-buttons" style="margin-bottom: 15px;">
        <button onclick="filterLogs('${tableId}', 'no-client')" class="filter-btn active">No Client</button>
        <button onclick="filterLogs('${tableId}', 'all')" class="filter-btn">All</button>
        <button onclick="filterLogs('${tableId}', 'success')" class="filter-btn">Success</button>
        <button onclick="filterLogs('${tableId}', 'warning')" class="filter-btn">Warning</button>
        <button onclick="filterLogs('${tableId}', 'error')" class="filter-btn">Error</button>
        ${renderSearchBar(tableId, methods)}
      </div>
      <table border="1" style="width: 100%; border-collapse: collapse; margin-bottom: 20px;">
        <thead>
          <tr style="background-color: #f2f2f2;">
            ${tableId === 'poolNodeLogs' ? `
            <th>Timestamp</th>
            <th>Node ID</th>
            <th>Owner</th>
            <th>Duration (ms)</th>
            <th>Status</th>
            <th>Method</th>
            <th>Params</th>
            ` : tableId === 'mergedLogs' ? `
            <th>Timestamp</th>
            <th title="How long after the first identical request started this one arrived">After first (ms)</th>
            <th title="How long this request then waited for the shared answer">Wait (ms)</th>
            <th title="How long the first request took in all: After first + Wait">First took (ms)</th>
            <th>Status</th>
            <th>Origin</th>
            <th>IP</th>
            <th>Method</th>
            <th title="Same origin and IP as the request it merged into">Same caller</th>
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
          ${pageData.map(renderRow).join('')}
        </tbody>
      </table>
      <div id="${tableId}-pagination">
        ${pagination}
      </div>
    </div>
  `;
}

function renderCompareTable({ total, entries: pageData }, title, currentPage, tableId, isAjax = false) {
  const totalPages = Math.ceil(total / logItemsPerPage);
  const pagination = total > logItemsPerPage ? renderPagination(currentPage, totalPages, '', tableId) : '';

  if (isAjax) {
    return { tbody: pageData.map(renderCompareRow).join(''), pagination, total };
  }

  return `
    <div id="${tableId}" style="margin-bottom: 40px;">
      ${titleHeading(title, tableId, total)}
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
          ${pageData.map(renderCompareRow).join('')}
        </tbody>
      </table>
      <div id="${tableId}-pagination">
        ${pagination}
      </div>
    </div>
  `;
}

router.get("/logs", async (req, res) => {
  try {
    const currentPage = Math.max(1, parseInt(req.query.page) || 1);
    const filter = FILTERS.includes(req.query.filter) ? req.query.filter : 'all';
    const text = (value, max) => (typeof value === 'string' ? value.trim().slice(0, max) : '');
    const search = { method: text(req.query.method, MAX_METHOD_CHARS), q: text(req.query.q, MAX_SEARCH_CHARS) };

    // If it's an AJAX request for a specific table, fetch and return only that table's page
    if (req.query.tableId) {
      const table = TABLES[req.query.tableId];
      if (!table) {
        return res.status(400).json({ error: `unknown tableId ${req.query.tableId}` });
      }
      const page = await table.fetch(currentPage, filter, search);
      const rendered = table.isCompare
        ? renderCompareTable(page, table.title, currentPage, req.query.tableId, true)
        : renderTable(page, table.title, currentPage, req.query.tableId, true);
      res.setHeader('Content-Type', 'application/json');
      return res.json(rendered);
    }

    const [poolLogs, fallbackLogs, cacheLogs, poolNodeLogs, mergedLogs, poolCompareResults] = await Promise.all(
      ['poolLogs', 'fallbackLogs', 'cacheLogs', 'poolNodeLogs', 'mergedLogs', 'poolCompareResults'].map(id => TABLES[id].fetch(currentPage, filter, search))
    );

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
            .title-emoji { font-size: 2em; vertical-align: middle; }
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
            #mergedLogs,
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
            .search-bar {
              display: flex;
              gap: 10px;
              margin-left: 20px;
            }
            .search-bar select,
            .search-bar input {
              padding: 8px;
              border: 1px solid #ddd;
              border-radius: 4px;
              font-size: 14px;
            }
            .search-bar input {
              width: 320px;
            }
          </style>
          <script>
            // Per-table state: page, filter button, method dropdown, search text
            const tableState = {
              poolLogs: { page: 1, filter: 'no-client', method: '', q: '' },
              fallbackLogs: { page: 1, filter: 'no-client', method: '', q: '' },
              cacheLogs: { page: 1, filter: 'no-client', method: '', q: '' },
              poolNodeLogs: { page: 1, filter: 'all', method: '', q: '' },
              mergedLogs: { page: 1, filter: 'no-client', method: '', q: '' },
              poolCompareResults: { page: 1, filter: 'all', method: '', q: '' }
            };
            const latestRequest = {};
            const searchTimers = {};

            // Initialize filters on page load
            window.onload = function() {
              filterLogs('cacheLogs', 'no-client');
              filterLogs('poolLogs', 'no-client');
              filterLogs('fallbackLogs', 'no-client');
              filterLogs('mergedLogs', 'no-client');
            };

            function showModal(content) {
              const modal = document.getElementById('objectModal');
              // As text: the content comes from nodes
              const pre = document.createElement('pre');
              pre.style.whiteSpace = 'pre-wrap';
              pre.style.wordBreak = 'break-all'; // long hex values wrap instead of scrolling sideways
              pre.textContent = JSON.stringify(content, null, 2);
              document.getElementById('modalContent').replaceChildren(pre);
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

            // Fetch the table's current page with its filter and search. A response that arrives
            // after a newer request for the same table was sent is dropped.
            async function loadTable(tableId) {
              const state = tableState[tableId];
              const request = (latestRequest[tableId] || 0) + 1;
              latestRequest[tableId] = request;
              const params = new URLSearchParams({ page: state.page, tableId: tableId, filter: state.filter });
              if (state.method) params.set('method', state.method);
              if (state.q) params.set('q', state.q);
              const response = await fetch('/logs?' + params.toString(), {
                headers: {
                  'Accept': 'application/json'
                }
              });
              const data = await response.json();
              if (latestRequest[tableId] !== request) return;

              // Update only the table body, pagination and count
              document.getElementById(tableId + '-body').innerHTML = data.tbody;
              document.getElementById(tableId + '-pagination').innerHTML = data.pagination;
              document.getElementById(tableId + '-total').textContent = data.total;
            }

            async function changePage(tableId, page) {
              try {
                tableState[tableId].page = page;
                await loadTable(tableId);
              } catch (error) {
                console.error('Error changing page:', error);
              }
            }

            async function filterLogs(tableId, filter) {
              try {
                // Update filter state
                tableState[tableId].filter = filter;
                tableState[tableId].page = 1;

                // Update active button state
                const buttons = document.querySelectorAll('#' + tableId + ' .filter-btn');
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

                await loadTable(tableId);
              } catch (error) {
                console.error('Error filtering logs:', error);
              }
            }

            async function searchLogs(tableId) {
              try {
                const state = tableState[tableId];
                state.method = document.getElementById(tableId + '-method').value;
                state.q = document.getElementById(tableId + '-q').value.trim();
                state.page = 1;
                await loadTable(tableId);
              } catch (error) {
                console.error('Error searching logs:', error);
              }
            }

            // Search as you type, once typing pauses
            function searchLogsSoon(tableId) {
              clearTimeout(searchTimers[tableId]);
              searchTimers[tableId] = setTimeout(function() { searchLogs(tableId); }, 300);
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
            
            ${renderTable(cacheLogs, TABLES.cacheLogs.title, currentPage, 'cacheLogs')}
            ${renderTable(poolLogs, TABLES.poolLogs.title, currentPage, 'poolLogs')}
            ${renderTable(poolNodeLogs, TABLES.poolNodeLogs.title, currentPage, 'poolNodeLogs')}
            ${renderTable(mergedLogs, TABLES.mergedLogs.title, currentPage, 'mergedLogs')}
            ${renderTable(fallbackLogs, TABLES.fallbackLogs.title, currentPage, 'fallbackLogs')}
            ${renderCompareTable(poolCompareResults, TABLES.poolCompareResults.title, currentPage, 'poolCompareResults')}
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
          <p class="error">${escapeHtml(error.message)}</p>
          <p>Please try refreshing the page.</p>
        </body>
      </html>
    `);
  }
});

module.exports = router;