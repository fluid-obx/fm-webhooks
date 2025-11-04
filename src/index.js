//
//  index.js
//  fm-webhooks
//
//  Created by David Morrison on 10/14/25.
//

import express from "express";
import bodyParser from "body-parser";
import mysql from "mysql2/promise";
import dotenv from "dotenv";
import { runFmScript } from "./fmClient.js";
import crypto from "crypto";

dotenv.config();
const app = express();
app.use(bodyParser.json());

// Respect MYSQL_LOGGING env flag (defaults to true when MySQL is fully configured and flag is absent)
const mysqlLoggingEnv = (process.env.MYSQL_LOGGING || "").toString().trim().toLowerCase();
const mysqlLoggingFlag = mysqlLoggingEnv === "true" || mysqlLoggingEnv === "1" || mysqlLoggingEnv === "yes";

// Optional MySQL logging (requires config and MYSQL_LOGGING=true)
let pool = null;
const hasMySQLConfig =
  !!process.env.MYSQL_HOST &&
  !!process.env.MYSQL_USER &&
  !!process.env.MYSQL_PASSWORD &&
  !!process.env.MYSQL_DATABASE;

if (hasMySQLConfig && mysqlLoggingFlag) {
  pool = mysql.createPool({
    host: process.env.MYSQL_HOST,
    user: process.env.MYSQL_USER,
    password: process.env.MYSQL_PASSWORD,
    database: process.env.MYSQL_DATABASE,
  });
  console.log("MySQL logging enabled (MYSQL_LOGGING=true).");
} else if (hasMySQLConfig && !mysqlLoggingFlag) {
  console.warn("MySQL logging disabled by flag: set MYSQL_LOGGING=true to enable.");
} else {
  console.warn(
    "MySQL logging disabled: set MYSQL_HOST, MYSQL_USER, MYSQL_PASSWORD, and MYSQL_DATABASE to enable."
  );
}

async function ensureWebhookTable() {
  if (!pool) return;
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS webhooks (
        id BIGINT AUTO_INCREMENT PRIMARY KEY,
        request_id VARCHAR(64) NOT NULL,
        source VARCHAR(255) NOT NULL,
        endpoint VARCHAR(255) NOT NULL,
        payload JSON NOT NULL,
        response JSON NULL,
        http_code INT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        INDEX idx_webhooks_endpoint_created_at (endpoint, created_at),
        INDEX idx_webhooks_request_id (request_id)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
    `);
    try { await pool.query("CREATE INDEX idx_webhooks_endpoint_created_at ON webhooks (endpoint, created_at)"); } catch (_) {}
    try { await pool.query("CREATE INDEX idx_webhooks_request_id ON webhooks (request_id)"); } catch (_) {}

    console.log("Verified webhooks table exists.");
  } catch (e) {
    console.error("Failed to verify/create webhooks table:", e.message);
  }
}

ensureWebhookTable();

// Simple Prometheus-compatible metrics (no external deps)
const metrics = {
  requestCount: 0,
  fmCallCount: 0,
  fmErrorCount: 0,
  httpStatusCounts: {},
  latencyBuckets: [0.01, 0.05, 0.1, 0.25, 0.5, 1, 2, 5, 10], // seconds
  latencyHistogram: Array(9).fill(0),
};

function observeLatency(seconds) {
  for (let i = 0; i < metrics.latencyBuckets.length; i++) {
    if (seconds <= metrics.latencyBuckets[i]) { metrics.latencyHistogram[i]++; return; }
  }
  // overflow bucket not declared; extend array
  metrics.latencyHistogram[metrics.latencyHistogram.length - 1]++;
}

function renderPromMetrics() {
  const lines = [];
  lines.push('# HELP webhook_requests_total Total number of webhook POST requests');
  lines.push('# TYPE webhook_requests_total counter');
  lines.push(`webhook_requests_total ${metrics.requestCount}`);

  lines.push('# HELP webhook_filemaker_calls_total Total number of FileMaker calls');
  lines.push('# TYPE webhook_filemaker_calls_total counter');
  lines.push(`webhook_filemaker_calls_total ${metrics.fmCallCount}`);

  lines.push('# HELP webhook_filemaker_errors_total Total number of FileMaker errors');
  lines.push('# TYPE webhook_filemaker_errors_total counter');
  lines.push(`webhook_filemaker_errors_total ${metrics.fmErrorCount}`);

  lines.push('# HELP webhook_http_status_total Count of responses by HTTP status');
  lines.push('# TYPE webhook_http_status_total counter');
  for (const [code, count] of Object.entries(metrics.httpStatusCounts)) {
    lines.push(`webhook_http_status_total{code="${code}"} ${count}`);
  }

  lines.push('# HELP webhook_latency_seconds Histogram of end-to-end request latency');
  lines.push('# TYPE webhook_latency_seconds histogram');
  let cumulative = 0;
  for (let i = 0; i < metrics.latencyBuckets.length; i++) {
    cumulative += metrics.latencyHistogram[i];
    lines.push(`webhook_latency_seconds_bucket{le="${metrics.latencyBuckets[i]}"} ${cumulative}`);
  }
  const total = metrics.latencyHistogram.reduce((a,b)=>a+b,0);
  lines.push(`webhook_latency_seconds_bucket{le="+Inf"} ${total}`);
  lines.push(`webhook_latency_seconds_count ${total}`);
  // sum not tracked precisely; omit to keep simple
  return lines.join('\n') + '\n';
}

app.get("/", async (req, res) => {
  const startedAt = new Date(process.uptime() ? Date.now() - process.uptime() * 1000 : Date.now());

  // Prepare health payload
  const health = {
    service: "fm-webhooks",
    status: "ok",
    message: "aloha. i am computer. how are you being?",
    time: new Date().toISOString(),
    uptimeSeconds: Math.round(process.uptime()),
    startedAt: startedAt.toISOString(),
    nodeVersion: process.version,
    pid: process.pid,
    env: {
      port: process.env.PORT || "3000",
      mysqlConfigured: !!(process.env.MYSQL_HOST && process.env.MYSQL_USER && process.env.MYSQL_PASSWORD && process.env.MYSQL_DATABASE),
      mysqlLoggingFlag: mysqlLoggingFlag,
      fmConfigured: !!(process.env.FM_SERVER && process.env.FM_DB && process.env.FM_USER && process.env.FM_PASS && process.env.FM_SCRIPT),
    },
    mysql: {
      enabled: !!pool,
      intendedByFlag: mysqlLoggingFlag,
      reachable: null,
      error: null,
    },
    filemaker: {
      configured: !!(process.env.FM_SERVER && process.env.FM_DB && process.env.FM_USER && process.env.FM_PASS && process.env.FM_SCRIPT),
    },
  };

  // MySQL ping if enabled
  if (pool) {
    try {
      // Using a lightweight ping query
      await pool.query("SELECT 1 AS ping");
      health.mysql.reachable = true;
    } catch (e) {
      health.mysql.reachable = false;
      health.mysql.error = e.message;
      health.status = "degraded";
    }
  }

  // If anything is clearly wrong, mark status
  if (health.env.mysqlConfigured && !health.mysql.enabled) {
    health.status = "degraded";
  }

  res.status(200).json(health);
});

// Protected logs endpoint (use LOGS_TOKEN)
app.get('/logs', async (req, res) => {
  const token = req.headers['authorization']?.toString().replace(/^Bearer\s+/i, '') || req.query.token;
  if (!process.env.LOGS_TOKEN || token !== process.env.LOGS_TOKEN) {
    return res.status(401).json({ error: 'unauthorized' });
  }
  if (!pool) return res.status(503).json({ error: 'logging disabled' });
  try {
    const [rows] = await pool.query('SELECT * FROM webhooks ORDER BY id DESC LIMIT 100');
    res.status(200).json(rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Prometheus metrics endpoint
app.get('/metrics', (req, res) => {
  res.set('Content-Type', 'text/plain; version=0.0.4');
  res.send(renderPromMetrics());
});

// Generic handler for all paths
app.post("*", async (req, res) => {
  const endpoint = req.path.replace(/^\/+/, ""); // e.g., 'contact-verify' for '/contact-verify'
  const queryString = req.originalUrl.split("?")[1] || "";
  const sourceHost = (req.headers["x-forwarded-host"] || req.headers["x-forwarded-for"] || req.headers["host"] || "").toString();

  const requestId = crypto.randomUUID ? crypto.randomUUID() : crypto.randomBytes(16).toString('hex');
  const userAgent = (req.headers['user-agent'] || '').toString();
  const clientIp = (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').toString();
  const startedAtHr = process.hrtime.bigint();
  metrics.requestCount++;

  const payloadObj = {
    requestId,
    endpoint,
    path: req.path,
    queryString,
    httpCode: res.statusCode,
    headers: req.headers,
    body: req.body,
    source: sourceHost,
    userAgent,
    clientIp
  };
  const scriptParam = JSON.stringify(payloadObj);

  // Universal pre-insert for diagnostics
  let insertedId = null;
  if (pool) {
    try {
      const [result] = await pool.query(
        "INSERT INTO webhooks (source, endpoint, payload, request_id) VALUES (?, ?, ?, ?)",
        [sourceHost, endpoint, scriptParam, requestId]
      );
      insertedId = result.insertId || (result[0] && result[0].insertId) || null;
    } catch (logErr) {
      console.error("MySQL pre-insert failed:", logErr.message);
    }
  }

  try {
    // Branch behavior based on endpoint
    let finalStatus = null;
    let finalResponse = null;

    if (endpoint === "other-hooks") {
      // Special handling for 'other-hooks' channel
      finalStatus = 200;
      finalResponse = { status: "ok", channel: endpoint, note: "Handled by other-hooks branch" };
    } else {
      // Default: call FileMaker script first
      metrics.fmCallCount++; // FileMaker call
      const fm = await runFmScript(scriptParam);
      finalStatus = fm.status;
      finalResponse = fm.body;
    }

    const endedAtHr = process.hrtime.bigint();
    const durationSec = Number(endedAtHr - startedAtHr) / 1e9;
    observeLatency(durationSec);
    metrics.httpStatusCounts[finalStatus] = (metrics.httpStatusCounts[finalStatus] || 0) + 1;

    // Universal post-update for diagnostics (includes duration)
    if (pool && insertedId) {
      try {
        const durationMs = Math.round(durationSec * 1000);
        await pool.query(
          "UPDATE webhooks SET response = ?, http_code = ?, duration = ? WHERE id = ?",
          [JSON.stringify(finalResponse ?? null), finalStatus ?? null, durationMs, insertedId]
        );
      } catch (logErr) {
        console.error("MySQL update failed:", logErr.message);
      }
    }

    // Send HTTP response with request id
    res.set('X-Request-Id', requestId);
    const bodyOut = (finalResponse && typeof finalResponse === 'object') ? { ...finalResponse, requestId } : finalResponse ?? { status: 'ok', requestId };
    res.status(finalStatus || 200).json(bodyOut);
  } catch (err) {
    console.error(err);
    metrics.fmErrorCount++;
    if (pool && insertedId) {
      try {
        await pool.query(
          "UPDATE webhooks SET response = ?, http_code = ? WHERE id = ?",
          [JSON.stringify({ error: err.message }), 500, insertedId]
        );
      } catch (_) {}
    }
    return res.status(500).json({ error: err.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () =>
  console.log(`Webhook service listening on port ${PORT}`)
);

