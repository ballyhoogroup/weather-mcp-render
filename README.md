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

## Auth0 OAuth

The server can operate as an OAuth-protected MCP resource server. Create an
Auth0 API with identifier `https://weather-mcp-render-ss69.onrender.com/mcp`, add
the `weather:read` permission, and configure these environment variables:

```text
AUTH_REQUIRED=true
PUBLIC_BASE_URL=https://weather-mcp-render-ss69.onrender.com
AUTH0_ISSUER_BASE_URL=https://YOUR_AUTH0_DOMAIN/
AUTH0_AUDIENCE=https://weather-mcp-render-ss69.onrender.com/mcp
AUTH0_REQUIRED_SCOPE=weather:read
```

When enabled, `/mcp` requires an Auth0 RS256 access token containing the
`weather:read` scope. The health route stays public. OAuth protected-resource
metadata is published at `/.well-known/oauth-protected-resource/mcp`.

## SupportBridge

Set `SUPPORTBRIDGE_API_KEY` to enable the SupportBridge tools, MCP App resources,
policy synchronization, and `get_weather` telemetry. The hosted control plane is
configured with `SUPPORTBRIDGE_URL=https://app2.getwith.in`, and the source name
defaults to `weather-mcp`. The SDK remains disabled when no API key is configured.

## Example prompt

> Use get_weather to tell me the three-day forecast for Richmond, Virginia in imperial units.

## Data source

Weather and geocoding data are supplied by Open-Meteo. Review its attribution and
commercial-use terms before using this server in a production product.
