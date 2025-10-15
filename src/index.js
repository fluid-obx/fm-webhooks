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
        source VARCHAR(255) NOT NULL,
        payload JSON NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
    `);
    console.log("Verified webhooks table exists.");
  } catch (e) {
    console.error("Failed to verify/create webhooks table:", e.message);
  }
}

ensureWebhookTable();

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

// Generic handler for all paths
app.post("*", async (req, res) => {
  const channelId = req.path.replace(/^\/+/, ""); // e.g., 'contact-verify' for '/contact-verify'
  const queryString = req.originalUrl.split("?")[1] || "";

  const scriptParam = JSON.stringify({
    channelId,
    source: channelId, // backward-compatible alias
    path: req.path,
    queryString,
    httpCode: res.statusCode,
    headers: req.headers,
    body: req.body,
  });

  try {
    // always attempt logging when pool is configured
    if (pool) {
      try {
        await pool.query(
          "INSERT INTO webhooks (source, payload) VALUES (?, ?)",
          [channelId, scriptParam]
        );
      } catch (logErr) {
        console.error("MySQL logging failed:", logErr.message);
      }
    }

    // Branch behavior based on channelId
    if (channelId === "other-hooks") {
      // Special handling for 'other-hooks' channel
      // Respond with 200 OK and a simple acknowledgement payload
      res.status(200).json({
        status: "ok",
        channel: channelId,
        note: "Handled by other-hooks branch",
      });
    } else {
      // Default: call FileMaker script
      const fm = await runFmScript(scriptParam);

      // relay FileMaker’s status and body directly
      res.status(fm.status).json(fm.body);
    }
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () =>
  console.log(`Webhook service listening on port ${PORT}`)
);

