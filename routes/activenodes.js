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
function generateTable(poolNodes) {
  let tableHtml = `
    <table border="1" style="border-collapse: collapse; width: 100%; margin: 20px 0px;">
      <thead>
        <tr style="background-color: #f2f2f2;">
          <th style="padding: 12px;">Node ID</th>
          <th style="padding: 12px;">Owner</th>
          <th style="padding: 12px;">Node Version</th>
          <th style="padding: 12px;">Execution Client</th>
          <th style="padding: 12px;">Consensus Client</th>
          <th style="padding: 12px;">System Usage</th>
          <th style="padding: 12px;">Block Info</th>
          <th style="padding: 12px;">Receipt Floor</th>
          <th style="padding: 12px;">Peers</th>
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

  // Generate table rows from sorted array
  for (const data of nodesArray) {
    tableHtml += `
      <tr>
        <td style="padding: 8px;">${data.id || 'N/A'}</td>
        <td style="padding: 8px;">${data.owner || 'N/A'}</td>
        <td style="padding: 8px;">${data.node_version || 'N/A'}</td>
        <td style="padding: 8px;">${data.execution_client || 'N/A'}</td>
        <td style="padding: 8px;">${data.consensus_client || 'N/A'}</td>
        <td style="padding: 8px;">
          CPU: ${data.cpu_usage || 'N/A'}%<br>
          Memory: ${data.memory_usage || 'N/A'}%<br>
          Storage: ${data.storage_usage || 'N/A'}%
        </td>
        <td style="padding: 8px;">
          Number: ${data.block_number || 'N/A'}<br>
          Hash: <span style="font-family: monospace; font-size: 0.9em; word-break: break-all;">${data.block_hash || 'N/A'}</span>
        </td>
        <td style="padding: 8px;">
          ${Number.isFinite(data.receipt_floor) ? data.receipt_floor.toLocaleString('en-US') : 'N/A'}
        </td>
        <td style="padding: 8px;">
          Execution: ${data.execution_peers || 'N/A'}<br>
          Consensus: ${data.consensus_peers || 'N/A'}
        </td>
        <td style="padding: 8px;">
          Branch: ${data.git_branch || 'N/A'}<br>
          Last Commit: ${data.last_commit || 'N/A'}<br>
          Hash: <span style="font-family: monospace; font-size: 0.9em;"><a href="https://github.com/BuidlGuidl/buidlguidl-client/commit/${data.commit_hash || 'N/A'}" target="_blank">${data.commit_hash || 'N/A'}</a></span>
        </td>
        <td style="padding: 8px;">
          <details>
            <summary>View Details</summary>
            <div style="margin-top: 8px;">
              <strong>Enode:</strong><br>
              <span style="font-family: monospace; font-size: 0.9em; word-break: break-all;">${data.enode || 'N/A'}</span>
              <br><br>
              <strong>Peer ID:</strong><br>
              <span style="font-family: monospace; font-size: 0.9em; word-break: break-all;">${data.peerid || 'N/A'}</span>
              <br><br>
              <strong>ENR:</strong><br>
              <span style="font-family: monospace; font-size: 0.9em; word-break: break-all;">${data.enr || 'N/A'}</span>
            </div>
          </details>
        </td>
        <td style="padding: 8px;">
          EP: ${data.enode ? data.enode.split(':').pop() : 'N/A'}<br>
          CP: ${data.consensus_tcp_port || 'N/A'}, ${data.consensus_udp_port || 'N/A'}
        </td>
        <td style="padding: 8px;">
          ${data.socket_id?.id || 'N/A'}
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