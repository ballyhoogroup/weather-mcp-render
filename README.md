# Weather MCP server for Claude

A minimal remote MCP server using the official TypeScript/JavaScript MCP SDK and
[Open-Meteo](https://open-meteo.com/) (no API key required). It exposes:

- `get_weather`: current conditions and a 1–7 day forecast by place name
- `POST /mcp`: the Streamable HTTP MCP endpoint
- `GET /health`: a Render health check

## Run locally

Requires Node.js 20 or newer.

```bash
corepack enable
pnpm install
pnpm start
```

The MCP endpoint is `http://localhost:3000/mcp`.

## Deploy on Render

1. Put this directory in a GitHub or GitLab repository.
2. In Render, choose **New > Blueprint** and connect the repository.
3. Render reads `render.yaml` and creates the web service.
4. When deployment finishes, use `https://YOUR-SERVICE.onrender.com/mcp` as the MCP URL.

No weather API key is needed. The free Render plan may sleep when idle, so the
first request after inactivity can take longer.

## Connect Claude

For Claude clients that support remote custom connectors, add a custom connector
whose URL is:

```text
https://YOUR-SERVICE.onrender.com/mcp
```

The server is intentionally unauthenticated for simplicity. Anyone who knows the
URL can call it; add authentication before using private or paid data sources.

## Example prompt

> Use get_weather to tell me the three-day forecast for Richmond, Virginia in imperial units.

## Data source

Weather and geocoding data are supplied by Open-Meteo. Review its attribution and
commercial-use terms before using this server in a production product.
