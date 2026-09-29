require('dotenv').config();
const https = require("https");
const express = require("express");
const fs = require("fs");
var cors = require("cors");
var bodyParser = require("body-parser");
const session = require("express-session");
const app = express();

const { webServerPort } = require('./config');

https.globalAgent.options.ca = require("ssl-root-cas").create(); // For sql connection

// Set up middleware first
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));
app.use(cors({
  origin: '*',
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization']
}));

// Session configuration
app.use(session({
  secret: process.env.SESSION_SECRET || 'your-secret-key-change-this',
  resave: false,
  saveUninitialized: false,
  cookie: { 
    secure: true, // true because we're using HTTPS
    httpOnly: true,
    maxAge: 24 * 60 * 60 * 1000 // 24 hours
  }
}));

// Login page route (not protected)
app.get('/login', (req, res) => {
  if (req.session.authenticated) {
    return res.redirect('/dashboard');
  }
  
  res.send(`
    <!DOCTYPE html>
    <html>
      <head>
        <title>Login</title>
        <style>
          body {
            font-family: Arial, sans-serif;
            display: flex;
            justify-content: center;
            align-items: center;
            height: 100vh;
            margin: 0;
            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
          }
          .login-container {
            background: white;
            padding: 40px;
            border-radius: 10px;
            box-shadow: 0 10px 25px rgba(0,0,0,0.2);
            width: 300px;
          }
          h2 {
            margin-top: 0;
            color: #333;
            text-align: center;
          }
          input[type="password"] {
            width: 100%;
            padding: 12px;
            margin: 10px 0;
            border: 1px solid #ddd;
            border-radius: 5px;
            box-sizing: border-box;
            font-size: 14px;
          }
          button {
            width: 100%;
            padding: 12px;
            background: #667eea;
            color: white;
            border: none;
            border-radius: 5px;
            cursor: pointer;
            font-size: 16px;
            margin-top: 10px;
          }
          button:hover {
            background: #5568d3;
          }
          .error {
            color: #d9534f;
            font-size: 14px;
            margin-top: 10px;
            text-align: center;
          }
        </style>
      </head>
      <body>
        <div class="login-container">
          <h2>🔒 Login Required</h2>
          <form method="POST" action="/login">
            <input type="password" name="password" placeholder="Enter password" required autofocus />
            <button type="submit">Login</button>
          </form>
          ${req.query.error ? '<p class="error">Incorrect password</p>' : ''}
        </div>
      </body>
    </html>
  `);
});

// Login POST handler
app.post('/login', (req, res) => {
  const { password } = req.body;
  
  if (password === process.env.SITE_PASSWORD) {
    req.session.authenticated = true;
    res.redirect('/dashboard');
  } else {
    res.redirect('/login?error=1');
  }
});

// Logout route
app.get('/logout', (req, res) => {
  req.session.destroy();
  res.redirect('/login');
});

// Authentication middleware - protects all routes except login, watchdog, yournodes, and rpcsitestats
app.use((req, res, next) => {
  // Allow login routes, watchdog, yournodes, and rpcsitestats endpoints without authentication
  if (req.path === '/login' || 
      (req.method === 'POST' && req.path === '/login') ||
      req.path === '/watchdog' ||
      req.path === '/yournodes' ||
      req.path === '/nodecontinents' ||
      req.path === '/rpcsitestats') {
    return next();
  }
  
  if (!req.session.authenticated) {
    return res.redirect('/login');
  }
  
  next();
});

// Add navigation bar middleware
app.use((req, res, next) => {
  // Store the original send function
  const originalSend = res.send;
  
  // Override the send function
  res.send = function (body) {
    // Only modify HTML responses
    if (typeof body === 'string' && body.includes('<html')) {
      // Create navigation bar HTML
      const navBar = `
        <div style="background-color: #f8f9fa; padding: 10px; margin-bottom: 20px; font-size: 12pt; display: flex; justify-content: space-between; align-items: center;">
          <div>
            <a href="/dashboard" style="margin-right: 15px; color: #333; text-decoration: none;">Dashboard</a>
            <a href="/logs" style="margin-right: 15px; color: #333; text-decoration: none;">Logs</a>
            <a href="/activenodes" style="margin-right: 15px; color: #333; text-decoration: none;">Active Nodes</a>
            <a href="/requestortable" style="margin-right: 15px; color: #333; text-decoration: none;">Requestor Table</a>
            <a href="/iptimeseries" style="margin-right: 15px; color: #333; text-decoration: none;">IP Timeseries</a>
            <a href="/origintimeseries" style="margin-right: 15px; color: #333; text-decoration: none;">Origin Timeseries</a>
            <a href="/cacheddata" style="margin-right: 15px; color: #333; text-decoration: none;">Cached Data</a>
            <a href="/fallbackurl" style="margin-right: 15px; color: #333; text-decoration: none;">Fallback URL</a>
            <a href="/ratelimitstatus" style="margin-right: 15px; color: #333; text-decoration: none;">Rate Limits</a>
            <a href="/blackliststatus" style="margin-right: 15px; color: #333; text-decoration: none;">Blacklist</a>
          </div>
          <a href="/logout" style="color: #d9534f; text-decoration: none; font-weight: bold;">Logout</a>
        </div>
      `;
      
      // Insert navigation bar after the body tag
      body = body.replace('<body>', '<body>' + navBar);
    }
    
    // Call the original send function
    return originalSend.call(this, body);
  };
  
  next();
});

// Then mount routes
const dashboardRouter = require('./routes/dashboard');
const logsRouter = require('./routes/logs');
const activeNodesRouter = require('./routes/activenodes');
const requestorTableRouter = require('./routes/requestortable');
const pointsRouter = require('./routes/points');
const cachedDataRouter = require('./routes/cacheddata');
const fallbackUrlRouter = require('./routes/fallbackurl');
const nodeContinentsRouter = require('./routes/nodecontinents');
const rpcSiteStatsRouter = require('./routes/rpcsitestats');
const yourNodesRouter = require('./routes/yournodes');
const watchdogRouter = require('./routes/watchdog');
const ipTableRouter = require('./routes/iptable');
const ipTimeseriesRouter = require('./routes/iptimeseries');
const originTimeseriesRouter = require('./routes/origintimeseries');
const rateLimitStatusRouter = require('./routes/ratelimitstatus');
const blacklistStatusRouter = require('./routes/blackliststatus');

app.use(dashboardRouter);
app.use(logsRouter);
app.use(activeNodesRouter);
app.use(requestorTableRouter);
app.use(pointsRouter);
app.use(cachedDataRouter);
app.use(fallbackUrlRouter);
app.use(nodeContinentsRouter);
app.use(rpcSiteStatsRouter);
app.use(yourNodesRouter);
app.use(watchdogRouter);
app.use(ipTableRouter);
app.use(ipTimeseriesRouter);
app.use(originTimeseriesRouter);
app.use(rateLimitStatusRouter);
app.use(blacklistStatusRouter);

// Add root redirect to dashboard
app.get('/', (req, res) => {
  res.redirect('/dashboard');
});

// Create the HTTPS server
const server = https.createServer(
  {
    key: fs.readFileSync("/home/ubuntu/shared/server.key"),
    cert: fs.readFileSync("/home/ubuntu/shared/server.cert"),
  },
  app
);

server.listen(webServerPort, () => {
  console.log("----------------------------------------------------------------------------------------------------------------");
  console.log("----------------------------------------------------------------------------------------------------------------");
  console.log(`HTTPS server listening on port ${webServerPort}...`);
});