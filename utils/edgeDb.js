// Read-only access to the edge proxy's Postgres (ip_table, ip_history_table) for the IP and Origin
// Timeseries pages. The edge reads and writes this database every 10 s (request counts, rate limits),
// and the edge working comes first, so this side stays small and harmless:
//   - one pool for the whole web server, at most 2 connections (the edge's own use is ~15 of 400);
//   - every session read-only, no parallel query workers, statements cut off after 10 s;
//   - the password is read from Secrets Manager once, not on every page load.
// SELECTs never block the edge's writes in Postgres. Callers also cache (utils/edgeTimeseries.js).
const { Pool } = require('pg');
const fs = require('fs');
const path = require('path');
const { SecretsManagerClient, GetSecretValueCommand } = require('@aws-sdk/client-secrets-manager');

require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const MAX_CONNECTIONS = 2;
const STATEMENT_TIMEOUT_MS = 10 * 1000;

let poolPromise = null;

async function createPool() {
  if (!process.env.RDS_SECRET_NAME || !process.env.AWS_ACCESS_KEY_ID || !process.env.AWS_SECRET_ACCESS_KEY || !process.env.DB_HOST) {
    throw new Error('Required environment variables are missing. Please check your .env file.');
  }
  const secretsClient = new SecretsManagerClient({
    region: 'us-east-1',
    credentials: {
      accessKeyId: process.env.AWS_ACCESS_KEY_ID,
      secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
    }
  });
  const data = await secretsClient.send(new GetSecretValueCommand({
    SecretId: process.env.RDS_SECRET_NAME,
    VersionStage: 'AWSCURRENT',
  }));
  const secret = JSON.parse(data.SecretString);

  const pool = new Pool({
    host: process.env.DB_HOST,
    user: secret.username,
    password: secret.password,
    database: secret.dbname || 'postgres',
    port: 5432,
    ssl: {
      rejectUnauthorized: true,
      ca: fs.readFileSync('/home/ubuntu/shared/rds-ca-bundle.pem')
    },
    max: MAX_CONNECTIONS,
    idleTimeoutMillis: 60 * 1000,
    connectionTimeoutMillis: 5 * 1000,
    application_name: 'bg-rpc-web-server',
    options: `-c default_transaction_read_only=on -c max_parallel_workers_per_gather=0 -c statement_timeout=${STATEMENT_TIMEOUT_MS}`
  });
  // An idle connection dropped by the server must not crash the web server
  pool.on('error', (error) => console.error('edge DB: idle connection error:', error.message));
  return pool;
}

async function getPool() {
  if (!poolPromise) {
    poolPromise = createPool();
    poolPromise.catch(() => { poolPromise = null; });
  }
  return poolPromise;
}

/**
 * Run one read-only query on the edge's database. A login failure (for example after the password
 * was rotated) drops the pool, so the next call reads the secret again.
 */
async function query(sql, params) {
  const pool = await getPool();
  try {
    return await pool.query(sql, params);
  } catch (error) {
    if (error.code === '28P01' || error.code === '28000') {
      poolPromise = null;
      pool.end().catch(() => {});
    }
    throw error;
  }
}

module.exports = { query, MAX_CONNECTIONS, STATEMENT_TIMEOUT_MS };
