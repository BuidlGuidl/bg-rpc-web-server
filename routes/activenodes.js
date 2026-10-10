const express = require('express');
const router = express.Router();
const https = require('https');

require('dotenv').config();

const { poolPort } = require('../config');
// Function to fetch pool nodes data
function fetchPoolNodes() {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: process.env.HOST,
      port: poolPort,
      path: '/poolNodes',
      method: 'GET',
      rejectUnauthorized: true // Enforce SSL certificate validation
    };

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => {
        data += chunk;
      });
      res.on('end', () => {
        try {
          resolve(JSON.parse(data));
        } catch (e) {
          reject(e);
        }
      });
    });

    req.on('error', (error) => {
      reject(error);
    });

    req.end();
  });
}

// Function to generate HTML table from pool nodes data
// History a reth node reports at check-in (getLogs plan 2b/2c); other clients report none.
// Floors are the oldest block the node holds; 0 is a valid floor, so no `||`
function formatFloor(floor) {
  return Number.isFinite(floor) ? `from ${floor.toLocaleString('en-US')}` : 'N/A';
}

function formatStateHistory(history) {
  if (!history || typeof history !== 'object') return 'N/A';
  if (history.mode === 'full') return 'all (archive)';
  if (history.mode === 'distance' && Number.isFinite(history.blocks)) return `last ${history.blocks.toLocaleString('en-US')} blocks`;
  if (history.mode === 'before' && Number.isFinite(history.block)) return `from ${history.block.toLocaleString('en-US')}`;
  return 'N/A';
}

// RPC namespaces the node serves on 8545 (rpc_modules at check-in). Not reported (older client, or
// not probed yet) → the pool routes as if eth, net (bg-rpc-docs NAMESPACE_ROUTING_PLAN.md D1).
// Reported by the node, so escaped
function formatNamespaces(modules) {
  if (!Array.isArray(modules)) return '<span style="color: #888;" title="Not reported; the pool routes as if eth, net">eth, net (assumed)</span>';
  const escape = (v) => String(v).replace(/[&<>"']/g, (ch) => `&#${ch.charCodeAt(0)};`);
  return modules.map(escape).join(', ') || 'none';
}

const MAX_BLOCKS_BEHIND = 2;

// Everything in a row comes from the nodes' check-ins (owner, IDs, client names, git info, enode...):
// escape every value put into the page, so a node can't inject markup or script
function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

// An owner given as a raw address (0x… hex), not an ENS name: its cell may break anywhere, so the long
// hex string wraps instead of widening the column
function isRawAddress(owner) {
  return typeof owner === 'string' && /^0x[0-9a-fA-F]+$/.test(owner);
}

// A block number with thousands separators (26150300 → 26,150,300); anything else (SUSPICIOUS, empty) as is
function formatBlockNumber(value) {
  const text = String(value ?? '');
  if (/^\d+$/.test(text)) return Number(text).toLocaleString('en-US');
  return text || 'N/A';
}

function generateTable(poolNodes) {
  let tableHtml = `
    <table border="1" style="border-collapse: collapse; width: 100%; margin: 20px 0px;">
      <thead>
        <tr style="background-color: #f2f2f2;">
          <th style="padding: 12px;">Node ID</th>
          <th style="padding: 12px;">Owner</th>
          <th style="padding: 12px;">Block #</th>
          <th style="padding: 12px;">Execution Client</th>
          <th style="padding: 12px;">Consensus Client</th>
          <th style="padding: 12px;">Peers</th>
          <th style="padding: 12px;">System Usage</th>
          <th style="padding: 12px;">History</th>
          <th style="padding: 12px;">RPC Namespaces</th>
          <th style="padding: 12px;">Node Version</th>
          <th style="padding: 12px;">Git Info</th>
          <th style="padding: 12px;">Peer Details</th>
          <th style="padding: 12px;">Ports</th>
          <th style="padding: 12px;">Socket ID</th>
        </tr>
      </thead>
      <tbody>
  `;

  // Convert the object to an array and sort by owner
  const nodesArray = Object.entries(poolNodes).map(([_, data]) => data);
  nodesArray.sort((a, b) => {
    const ownerA = (a.owner || 'N/A').toLowerCase();
    const ownerB = (b.owner || 'N/A').toLowerCase();
    return ownerA.localeCompare(ownerB);
  });

  // Row colours: light orange for a node more than MAX_BLOCKS_BEHIND blocks behind the highest block any
  // node reports; light red for a node with no block number: suspicious (the pool replaces its block
  // number with 'SUSPICIOUS') or not reporting one. Only numeric block numbers count toward the highest
  const blockOf = (node) => (/^\d+$/.test(String(node.block_number ?? '')) ? Number(node.block_number) : null);
  const highestBlock = Math.max(-Infinity, ...nodesArray.map(blockOf).filter((b) => b !== null));

  // Generate table rows from sorted array
  for (const data of nodesArray) {
    const block = blockOf(data);
    const behind = block !== null && Number.isFinite(highestBlock) ? highestBlock - block : 0;
    let rowAttrs = '';
    if (block === null) {
      const why = data.block_number === 'SUSPICIOUS' ? 'Suspicious node: the pool withholds its block number' : 'No block number reported';
      rowAttrs = ` class="no-block" title="${why}"`;
    } else if (behind > MAX_BLOCKS_BEHIND) {
      rowAttrs = ` class="behind" title="${behind} blocks behind the highest block (${highestBlock})"`;
    }
    tableHtml += `
      <tr${rowAttrs}>
        <td style="padding: 8px;">${escapeHtml(data.id || 'N/A')}</td>
        <td style="padding: 8px;${isRawAddress(data.owner) ? ' overflow-wrap: anywhere;' : ''}">${escapeHtml(data.owner || 'N/A')}</td>
        <td style="padding: 8px;">
          ${escapeHtml(formatBlockNumber(data.block_number))}
        </td>
        <td style="padding: 8px;">${escapeHtml(data.execution_client || 'N/A')}</td>
        <td style="padding: 8px;">${escapeHtml(data.consensus_client || 'N/A')}</td>
        <td style="padding: 8px;">
          Execution: ${escapeHtml(data.execution_peers || 'N/A')}<br>
          Consensus: ${escapeHtml(data.consensus_peers || 'N/A')}
        </td>
        <td style="padding: 8px;">
          CPU: ${escapeHtml(data.cpu_usage || 'N/A')}%<br>
          Memory: ${escapeHtml(data.memory_usage || 'N/A')}%<br>
          Storage: ${escapeHtml(data.storage_usage || 'N/A')}%
        </td>
        <td style="padding: 8px; white-space: nowrap;">
          Receipts: ${formatFloor(data.receipt_floor)}<br>
          Bodies: ${formatFloor(data.body_floor)}<br>
          State: ${formatStateHistory(data.state_history)}
        </td>
        <td style="padding: 8px;">${formatNamespaces(data.rpc_modules)}</td>
        <td style="padding: 8px;">${escapeHtml(data.node_version || 'N/A')}</td>
        <td style="padding: 8px;">
          Branch: ${escapeHtml(data.git_branch || 'N/A')}<br>
          Last Commit: ${escapeHtml(data.last_commit || 'N/A')}<br>
          Hash: <span style="font-family: monospace; font-size: 0.9em;"><a href="https://github.com/BuidlGuidl/buidlguidl-client/commit/${escapeHtml(encodeURIComponent(data.commit_hash || 'N/A'))}" target="_blank">${escapeHtml(data.commit_hash || 'N/A')}</a></span>
        </td>
        <td style="padding: 8px;">
          <details>
            <summary>View Details</summary>
            <div style="margin-top: 8px;">
              <strong>Enode:</strong><br>
              <span style="font-family: monospace; font-size: 0.9em; word-break: break-all;">${escapeHtml(data.enode || 'N/A')}</span>
              <br><br>
              <strong>Peer ID:</strong><br>
              <span style="font-family: monospace; font-size: 0.9em; word-break: break-all;">${escapeHtml(data.peerid || 'N/A')}</span>
              <br><br>
              <strong>ENR:</strong><br>
              <span style="font-family: monospace; font-size: 0.9em; word-break: break-all;">${escapeHtml(data.enr || 'N/A')}</span>
            </div>
          </details>
        </td>
        <td style="padding: 8px;">
          EP: ${escapeHtml(data.enode ? String(data.enode).split(':').pop() : 'N/A')}<br>
          CP: ${escapeHtml(data.consensus_tcp_port || 'N/A')}, ${escapeHtml(data.consensus_udp_port || 'N/A')}
        </td>
        <td style="padding: 8px;">
          ${escapeHtml(data.socket_id?.id || 'N/A')}
        </td>
      </tr>
    `;
  }

  tableHtml += `
      </tbody>
    </table>
  `;
  return tableHtml;
}

router.get("/activenodes", async (req, res) => {
  try {
    const poolNodes = await fetchPoolNodes();
    const tableHtml = generateTable(poolNodes);
    
    res.send(`
      <html>
        <head>
          <title>Active Nodes</title>
          <style>
            body { 
              font-family: Arial, sans-serif; 
              margin: 0;
            }
            h1 { 
              color: #333;
              margin-bottom: 20px;
            }
            .container { 
              max-width: 100%;
              margin: 0 auto;
              background-color: white;
              padding: 0px;
              margin: 0px 10px;
            }
            .error { 
              color: red; 
            }
            table {
              background-color: white;
            }
            th {
              background-color: #f2f2f2;
              position: sticky;
              top: 0;
              z-index: 1;
            }
            tr:nth-child(even) {
              background-color: #f9f9f9;
            }
            tr:hover {
              background-color:rgb(227, 227, 227);
            }
            /* more than MAX_BLOCKS_BEHIND blocks behind the highest node (after the even/hover rules so it wins) */
            tr.behind {
              background-color: #ffe0b2;
            }
            tr.behind:hover {
              background-color: #ffcc80;
            }
            /* suspicious or not reporting a block number */
            tr.no-block {
              background-color: #f8d7da;
            }
            tr.no-block:hover {
              background-color: #f1b0b7;
            }
            details summary {
              cursor: pointer;
              color: #0066cc;
            }
            details summary:hover {
              text-decoration: underline;
            }
          </style>
        </head>
        <body>
          <div class="container">
            <h1>Active Nodes (${poolNodes.length})</h1>
            ${tableHtml}
          </div>
        </body>
      </html>
    `);
  } catch (error) {
    res.status(500).send(`
      <html>
        <head>
          <title>Error</title>
          <style>
            body { font-family: Arial, sans-serif; padding: 20px; }
            .error { color: red; }
          </style>
        </head>
        <body>
          <div class="error">
            <h1>Error fetching active nodes</h1>
            <p>${error.message}</p>
          </div>
        </body>
      </html>
    `);
  }
});

module.exports = router;