const { ignoredErrorCodes } = require('../../shared/ignoredErrorCodes');

// Logs page: only OUR failures are errors (owner, 2026-09-29). Same rule as the dashboard
// (bg-rpc-logs/utils/errorClass.js) and as bg-rpc-proxy's fallback decision
// (bg-rpc-proxy/utils/fallbackPolicy.js); keep the three in step.
//
//   'ok'       success
//   'caller'   the node's answer to a bad request (ignored codes, nonce too low, OutOfFunds,
//              block/header not found, a method the client doesn't implement...): not an error
//   'warning'  our nodes lack the data or timed out: pool/proxy -69xxx, timeouts, "pruned",
//              geth "historical state ... not available" (bg-rpc-proxy sends these to the fallback)
//   'error'    ours: a node's -70000, the pool's -70001 / -70002, the proxy's -70000, a broken
//              node socket or response, or anything unreadable
//
// Statuses come in three shapes: 'success', a plain word from the pool's node log
// (timeout_error, timeout_error_heavy, socket_error, invalid_format, invalid_response), or a
// JSON error (a full JSON-RPC response or a bare { code, message }).

const MISSING_HISTORY = /pruned|history unavailable|historical state .*not available|missing trie node/i;
const NODE_TIMEOUT = /timed? ?out/i;

function classifyStatus(status) {
  if (typeof status === 'number') return ignoredErrorCodes.includes(status) ? 'caller' : 'error';
  if (typeof status !== 'string') return 'error';
  const s = status.trim();
  if (s.toLowerCase() === 'success') return 'ok';
  if (/^timeout/i.test(s)) return 'warning';
  if (/^(socket_error|invalid_format|invalid_response)$/i.test(s)) return 'error';
  if (/^-?\d+$/.test(s)) return ignoredErrorCodes.includes(Number(s)) ? 'caller' : 'error';
  let obj;
  try {
    obj = JSON.parse(s);
  } catch {
    return 'error';
  }
  const err = obj && typeof obj === 'object' ? (obj.error ?? obj) : null;
  const code = err && typeof err === 'object' ? Number(err.code) : NaN;
  if (!Number.isFinite(code)) return 'error';
  if (ignoredErrorCodes.includes(code)) return 'caller';
  if (code <= -69000) return String(code).startsWith('-69') ? 'warning' : 'error';
  const message = typeof err.message === 'string' ? err.message : '';
  if (MISSING_HISTORY.test(message) || NODE_TIMEOUT.test(message)) return 'warning';
  return 'caller';
}

module.exports = { classifyStatus };
