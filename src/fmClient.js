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
  const url = `${base}/fmi/odata/v4/${FM_DB}/Script.${FM_SCRIPT}`;

  const fmResp = await fetch(url, {
    method: "POST",
    headers: {
      "Authorization":
        "Basic " + Buffer.from(`${FM_USER}:${FM_PASS}`).toString("base64"),
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      scriptParameterValue: scriptParam
    }),
  });

  const fmBody = await fmResp.json();
  const result =
    fmBody?.scriptResult?.resultParameter ??
    fmBody?.scriptResult ??
    fmBody; // fallback if structure differs
  return { status: fmResp.status, body: result };
}
