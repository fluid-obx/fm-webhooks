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

// Respect MYSQL_LOGGING env flag
const mysqlLoggingEnv = (process.env.MYSQL_LOGGING || "").toString().trim().toLowerCase();
const mysqlLoggingFlag = mysqlLoggingEnv === "true" || mysqlLoggingEnv === "1" || mysqlLoggingEnv === "yes";

// Optional MySQL logging
let pool = null;
const hasMySQLConfig = !!process.env.MYSQL_HOST &&
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
    console.log("Verified webhooks table exists.");
  } catch (e) {
    console.error("Failed to verify/create webhooks table:", e.message);
  }
}

ensureWebhookTable();

// -----------------------------
// Health & Logs endpoints
// -----------------------------

app.get("/", async (req, res) => {
  const startedAt = new Date(process.uptime() ? Date.now() - process.uptime() * 1000 : Date.now());
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
      reachable: null,
      error: null,
    },
    filemaker: {
      configured: !!(process.env.FM_SERVER && process.env.FM_DB && process.env.FM_USER && process.env.FM_PASS && process.env.FM_SCRIPT),
    },
  };

  if (pool) {
    try {
      await pool.query("SELECT 1 AS ping");
      health.mysql.reachable = true;
    } catch (e) {
      health.mysql.reachable = false;
      health.mysql.error = e.message;
      health.status = "degraded";
    }
  }

  if (health.env.mysqlConfigured && !health.mysql.enabled) {
    health.status = "degraded";
  }

  res.status(200).json(health);
});

app.get("/logs", async (req, res) => {
  const token = req.headers["authorization"]?.toString().replace(/^Bearer\s+/i, "") || req.query.token;
  if (!process.env.LOGS_TOKEN || token !== process.env.LOGS_TOKEN) {
    return res.status(401).json({ error: "unauthorized" });
  }
  if (!pool) return res.status(503).json({ error: "logging disabled" });
  try {
    const [rows] = await pool.query("SELECT * FROM webhooks ORDER BY id DESC LIMIT 100");
    res.status(200).json(rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// -----------------------------
// Webhook handling
// -----------------------------

// Route: /hooks/:endpoint  (Option 1 — keep /hooks externally)
app.post("/hooks/:endpoint", async (req, res) => {
  const endpoint = req.params.endpoint;
  const queryString = req.originalUrl.split("?")[1] || "";
  const sourceHost = (req.headers["x-forwarded-host"] || req.headers["x-forwarded-for"] || req.headers["host"] || "").toString();

  const requestId = crypto.randomUUID ? crypto.randomUUID() : crypto.randomBytes(16).toString("hex");
  const userAgent = (req.headers["user-agent"] || "").toString();
  const clientIp = (req.headers["x-forwarded-for"] || req.socket.remoteAddress || "").toString();

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
    clientIp,
  };
  const scriptParam = JSON.stringify(payloadObj);

  let insertedId = null;
  if (pool) {
    try {
      const [result] = await pool.query(
        "INSERT INTO webhooks (source, endpoint, payload, request_id) VALUES (?, ?, ?, ?)",
        [sourceHost, endpoint, scriptParam, requestId]
      );
      insertedId = result.insertId || null;
    } catch (logErr) {
      console.error("MySQL pre-insert failed:", logErr.message);
    }
  }

  try {
    let finalStatus, finalResponse;
    if (endpoint === "other-hooks") {
      finalStatus = 200;
      finalResponse = { status: "ok", channel: endpoint, note: "Handled by other-hooks branch" };
    } else {
      const fm = await runFmScript(scriptParam);
      finalStatus = fm.status;
      finalResponse = fm.body;
    }

    if (pool && insertedId) {
      try {
        await pool.query(
          "UPDATE webhooks SET response = ?, http_code = ? WHERE id = ?",
          [JSON.stringify(finalResponse ?? null), finalStatus ?? null, insertedId]
        );
      } catch (logErr) {
        console.error("MySQL update failed:", logErr.message);
      }
    }

    res.set("X-Request-Id", requestId);
    const bodyOut =
      finalResponse && typeof finalResponse === "object" ?
      { ...finalResponse, requestId } :
      finalResponse ?? { status: "ok", requestId };
    res.status(finalStatus || 200).json(bodyOut);
  } catch (err) {
    console.error(err);
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

// Default route (non-/hooks): redirect to /hooks/:channel
app.post("/:endpoint", (req, res) => {
  const endpoint = req.params.endpoint;
  const query = req.originalUrl.split("?")[1];
  const redirectUrl = `/hooks/${endpoint}${query ? `?${query}` : ""}`;
  console.log(`[Redirect] ${req.originalUrl} → ${redirectUrl}`);
  return res.redirect(307, redirectUrl); // 307 preserves POST method and body
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Webhook service listening on port ${PORT}`));