# FileMaker Webhook Service

A lightweight Express-based service that receives incoming webhooks and forwards them to FileMaker Server's OData API. The full inbound request (including headers, method, path, body and query) is serialized and sent as the script parameter to a FileMaker script. The service then relays the script result back to the webhook caller.

## Features
- Accepts arbitrary webhook POST/GET requests
- Forwards payloads to FileMaker Server via OData
- Sends the entire request as a FileMaker script parameter
- Returns the script result to the caller (equivalent to `Get ( ScriptResult )`)
- Docker-ready for easy deployment

## Prerequisites
- Node.js 18+ and npm
- Access to FileMaker Server with OData enabled and a target script to receive parameters
- (Optional) Docker and Docker Compose for containerized deployment

## Quick Start

### Run locally (Node)
```bash
npm install
node src/index.js

