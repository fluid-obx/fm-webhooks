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

// optional MySQL logging (enabled when all required env vars are set)
let pool = null;
const hasMySQLConfig =
  !!process.env.MYSQL_HOST &&
  !!process.env.MYSQL_USER &&
  !!process.env.MYSQL_PASSWORD &&
  !!process.env.MYSQL_DATABASE;

if (hasMySQLConfig) {
  pool = mysql.createPool({
    host: process.env.MYSQL_HOST,
    user: process.env.MYSQL_USER,
    password: process.env.MYSQL_PASSWORD,
    database: process.env.MYSQL_DATABASE,
  });
  console.log("MySQL logging enabled.");
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
    // optional logging
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

    const fm = await runFmScript(scriptParam);

    // relay FileMaker’s status and body directly
    res.status(fm.status).json(fm.body);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () =>
  console.log(`Webhook service listening on port ${PORT}`)
);

