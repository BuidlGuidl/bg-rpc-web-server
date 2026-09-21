# bg-rpc-web-server

Operator dashboard for the BuidlGuidl RPC stack. It is an HTTPS Express app that pulls live JSON from the logs service, the pool, and the proxy, plus a few Postgres tables, and renders HTML pages (Plotly charts, tables, log viewers).

This process does not handle Ethereum JSON-RPC. Public RPC goes through `bg-rpc-proxy`. This server is the UI and a handful of unauthenticated JSON endpoints used by the public site and the watchdog.

## How it fits

| Source | Used for |
| --- | --- |
| `bg-rpc-logs` (`:3001`) | Dashboard metrics, request/node logs, requestor table, node timeout rates |
| `bg-rpc-pool` (`:3003`) | Active nodes, your-nodes, continents, site stats |
| `bg-rpc-proxy` (`:3002` and admin routes) | Cache map, rate limits, blacklist, fallback URL |
| Postgres (RDS via AWS Secrets Manager) | IP table, IP/origin timeseries, owner points |
| `bg-rpc-watchdog` | Hits this service’s `/watchdog` |

## Auth

Password login at `/login` (`SITE_PASSWORD`), session cookie over HTTPS (24 hours). `/` redirects to `/dashboard`.

These paths skip login so the public site and watchdog can call them:

- `/watchdog`
- `/yournodes?owner=0x…`
- `/nodecontinents`
- `/rpcsitestats`

Everything else requires a session.

## Pages (logged in)

| Path | Contents |
| --- | --- |
| `/dashboard` | Last-hour volume, errors, latency histograms, hourly history, node timeout rates |
| `/logs` | Paginated fallback / cache / pool / node / compare logs |
| `/activenodes` | Live community nodes from the pool |
| `/requestortable` | Per-origin request counts |
| `/iptable` | Per-IP volume (`ip_table`) with geo lookup |
| `/iptimeseries` | Hourly IP request history |
| `/origintimeseries` | Hourly origin request history |
| `/cacheddata` | Proxy cache map |
| `/fallbackurl` | Current proxy fallback provider URL |
| `/ratelimitstatus` | Origin and IP rate-limit usage |
| `/blackliststatus` | Proxy blacklist |
| `/points` | Owner points leaderboard |

## HTTPS

Port **48547**, using `shared/server.key` and `shared/server.cert`.

## Layout

```
webServer.js              HTTPS app, session auth, nav bar, route mount
config.js                 Ports and UI constants
routes/*.js               One file per page or JSON endpoint
utils/ipLookup.js         ip-api.com lookups for the IP table
```

Needs `.env` (`HOST`, `SITE_PASSWORD`, `SESSION_SECRET`, RDS/AWS vars, `RPC_PROXY_HOST`, `RPC_PROXY_ADMIN_KEY`, `PRO_IP_KEY`). RDS CA is `shared/rds-ca-bundle.pem`.

## Run

```bash
npm install
npm start
```

On this host it runs as the PM2 process `webServer`.

## License

MIT
