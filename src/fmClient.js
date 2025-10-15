//
//  fmClient.js
//  fm-webhooks
//
//  Created by David Morrison on 10/14/25.
//


import fetch from "node-fetch";
import dotenv from "dotenv";
dotenv.config();

export async function runFmScript(scriptParam) {
  const { FM_SERVER, FM_DB, FM_SCRIPT, FM_USER, FM_PASS } = process.env;

  const base = FM_SERVER?.replace(/\/$/, "");
  const url =
    `${base}/fmi/odata/v4/${encodeURIComponent(FM_DB)}.fmp12/${encodeURIComponent(FM_SCRIPT)}` +
    `?$fm.script.param=${encodeURIComponent(scriptParam)}`;

  const fmResp = await fetch(url, {
    method: "GET",
    headers: {
      "Authorization":
        "Basic " + Buffer.from(`${FM_USER}:${FM_PASS}`).toString("base64"),
      "Content-Type": "application/json",
    },
  });

  const fmBody = await fmResp.json();
  return { status: fmResp.status, body: fmBody };
}

