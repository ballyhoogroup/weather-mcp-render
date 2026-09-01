import { createServer } from "node:http";
import { pathToFileURL } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { SupportBridge } from "@supportbridge/sdk";
import { createRemoteJWKSet, jwtVerify } from "jose";
import { z } from "zod";

const PORT = Number.parseInt(process.env.PORT ?? "3000", 10);
const HOST = "0.0.0.0";

function normalizeIssuer(value) {
  return value.endsWith("/") ? value : `${value}/`;
}

export function authConfigFromEnv(env = process.env) {
  const enabled = env.AUTH_REQUIRED === "true";
  if (!enabled) return { enabled: false };

  const issuer = env.AUTH0_ISSUER_BASE_URL;
  const audience = env.AUTH0_AUDIENCE;
  const publicBaseUrl = env.PUBLIC_BASE_URL;
  if (!issuer || !audience || !publicBaseUrl) {
    throw new Error(
      "AUTH_REQUIRED=true requires AUTH0_ISSUER_BASE_URL, AUTH0_AUDIENCE, and PUBLIC_BASE_URL"
    );
  }

  return {
    enabled: true,
    issuer: normalizeIssuer(issuer),
    audience,
    publicBaseUrl: publicBaseUrl.replace(/\/$/, ""),
    requiredScope: env.AUTH0_REQUIRED_SCOPE ?? "weather:read"
  };
}

export function createAuth0Verifier(config) {
  const jwks = createRemoteJWKSet(new URL(".well-known/jwks.json", config.issuer));
  return async token => {
    const { payload } = await jwtVerify(token, jwks, {
      issuer: config.issuer,
      audience: config.audience,
      algorithms: ["RS256"]
    });
    const scopes = typeof payload.scope === "string" ? payload.scope.split(" ").filter(Boolean) : [];
    return {
      subject: payload.sub,
      clientId: payload.azp ?? payload.client_id,
      scopes,
      expiresAt: payload.exp
    };
  };
}

export function supportBridgeConfigFromEnv(env = process.env) {
  if (!env.SUPPORTBRIDGE_API_KEY) return undefined;
  return {
    apiKey: env.SUPPORTBRIDGE_API_KEY,
    baseUrl: env.SUPPORTBRIDGE_URL ?? "https://app2.getwith.in",
    source: env.SUPPORTBRIDGE_SOURCE ?? "weather-mcp",
    environment: env.NODE_ENV ?? "production",
    serviceVersion: env.RENDER_GIT_COMMIT ?? "local"
  };
}

export function protectedResourceMetadata(config) {
  return {
    resource: `${config.publicBaseUrl}/mcp`,
    authorization_servers: [config.issuer],
    scopes_supported: [config.requiredScope],
    bearer_methods_supported: ["header"]
  };
}

function json(res, status, body, headers = {}) {
  res.writeHead(status, {
    "content-type": "application/json",
    "access-control-allow-origin": "*",
    ...headers
  });
  res.end(JSON.stringify(body));
}

async function authorizeRequest(req, res, config, verifyToken) {
  if (!config.enabled) return true;

  const resourceMetadataUrl = `${config.publicBaseUrl}/.well-known/oauth-protected-resource/mcp`;
  const challenge = `Bearer resource_metadata="${resourceMetadataUrl}"`;
  const authorization = req.headers.authorization ?? "";
  const match = /^Bearer\s+(.+)$/i.exec(authorization);
  if (!match) {
    json(res, 401, { error: "invalid_token", error_description: "A bearer token is required" }, {
      "www-authenticate": challenge
    });
    return false;
  }

  try {
    const authInfo = await verifyToken(match[1]);
    if (!authInfo.expiresAt || authInfo.expiresAt <= Math.floor(Date.now() / 1000)) {
      throw new Error("Token is expired");
    }
    if (!authInfo.scopes.includes(config.requiredScope)) {
      json(res, 403, { error: "insufficient_scope", required_scope: config.requiredScope }, {
        "www-authenticate": `${challenge}, error="insufficient_scope", scope="${config.requiredScope}"`
      });
      return false;
    }
    req.auth = {
      token: match[1],
      clientId: authInfo.clientId ?? "unknown-client",
      scopes: authInfo.scopes,
      expiresAt: authInfo.expiresAt,
      ...(config.audience ? { resource: new URL(config.audience) } : {}),
      extra: { subject: authInfo.subject }
    };
    return true;
  } catch {
    json(res, 401, { error: "invalid_token", error_description: "The bearer token is invalid or expired" }, {
      "www-authenticate": `${challenge}, error="invalid_token"`
    });
    return false;
  }
}

const weatherDescriptions = {
  0: "Clear sky", 1: "Mainly clear", 2: "Partly cloudy", 3: "Overcast",
  45: "Fog", 48: "Depositing rime fog", 51: "Light drizzle",
  53: "Moderate drizzle", 55: "Dense drizzle", 56: "Light freezing drizzle",
  57: "Dense freezing drizzle", 61: "Slight rain", 63: "Moderate rain",
  65: "Heavy rain", 66: "Light freezing rain", 67: "Heavy freezing rain",
  71: "Slight snowfall", 73: "Moderate snowfall", 75: "Heavy snowfall",
  77: "Snow grains", 80: "Slight rain showers", 81: "Moderate rain showers",
  82: "Violent rain showers", 85: "Slight snow showers", 86: "Heavy snow showers",
  95: "Thunderstorm", 96: "Thunderstorm with slight hail", 99: "Thunderstorm with heavy hail"
};

async function fetchJson(url) {
  const response = await fetch(url, {
    headers: { "user-agent": "weather-mcp-render/1.0" },
    signal: AbortSignal.timeout(10_000)
  });
  if (!response.ok) throw new Error(`Weather provider returned HTTP ${response.status}`);
  return response.json();
}

export async function getWeather(location, units = "metric", forecastDays = 3) {
  const geocodeUrl = new URL("https://geocoding-api.open-meteo.com/v1/search");
  geocodeUrl.search = new URLSearchParams({ name: location, count: "1", language: "en", format: "json" });
  const geocode = await fetchJson(geocodeUrl);
  const place = geocode.results?.[0];
  if (!place) throw new Error(`No location found for “${location}”`);

  const forecastUrl = new URL("https://api.open-meteo.com/v1/forecast");
  forecastUrl.search = new URLSearchParams({
    latitude: String(place.latitude), longitude: String(place.longitude),
    timezone: "auto", forecast_days: String(forecastDays),
    temperature_unit: units === "imperial" ? "fahrenheit" : "celsius",
    wind_speed_unit: units === "imperial" ? "mph" : "kmh",
    precipitation_unit: units === "imperial" ? "inch" : "mm",
    current: "temperature_2m,apparent_temperature,relative_humidity_2m,precipitation,weather_code,wind_speed_10m",
    daily: "weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max"
  });
  const data = await fetchJson(forecastUrl);
  const current = data.current;
  const daily = data.daily.time.map((date, index) => ({
    date,
    conditions: weatherDescriptions[data.daily.weather_code[index]] ?? `Weather code ${data.daily.weather_code[index]}`,
    high: `${data.daily.temperature_2m_max[index]} ${data.daily_units.temperature_2m_max}`,
    low: `${data.daily.temperature_2m_min[index]} ${data.daily_units.temperature_2m_min}`,
    precipitationChance: `${data.daily.precipitation_probability_max[index]}%`
  }));

  return {
    location: [place.name, place.admin1, place.country].filter(Boolean).join(", "),
    coordinates: { latitude: place.latitude, longitude: place.longitude },
    timezone: data.timezone,
    current: {
      observedAt: current.time,
      conditions: weatherDescriptions[current.weather_code] ?? `Weather code ${current.weather_code}`,
      temperature: `${current.temperature_2m} ${data.current_units.temperature_2m}`,
      feelsLike: `${current.apparent_temperature} ${data.current_units.apparent_temperature}`,
      humidity: `${current.relative_humidity_2m}%`,
      precipitation: `${current.precipitation} ${data.current_units.precipitation}`,
      windSpeed: `${current.wind_speed_10m} ${data.current_units.wind_speed_10m}`
    },
    forecast: daily,
    source: "Open-Meteo"
  };
}

export function buildMcpServer({
  weatherProvider = getWeather,
  supportBridgeConfig = supportBridgeConfigFromEnv()
} = {}) {
  const server = new McpServer({ name: "weather-mcp-render", version: "1.0.0" });

  const support = supportBridgeConfig
    ? SupportBridge.install(server, {
        ...supportBridgeConfig,
        identify: context => {
          const authInfo = context?.authInfo;
          const subject = authInfo?.extra?.subject;
          return {
            userId: typeof subject === "string" ? subject : authInfo?.clientId ?? "weather-user",
            workspaceId: "weather-mcp"
          };
        }
      })
    : undefined;

  const weatherHandler = async ({ location, units, forecastDays }) => {
    try {
      const weather = await weatherProvider(location, units, forecastDays);
      return { content: [{ type: "text", text: JSON.stringify(weather, null, 2) }], structuredContent: weather };
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown weather error";
      return { isError: true, content: [{ type: "text", text: message }] };
    }
  };

  server.registerTool(
    "get_weather",
    {
      title: "Get weather",
      description: "Get current weather and a 1–7 day forecast for a city or place name.",
      inputSchema: z.object({
        location: z.string().min(2).max(200).describe("City or place, such as Boston, MA"),
        units: z.enum(["metric", "imperial"]).default("metric"),
        forecastDays: z.number().int().min(1).max(7).default(3)
      })
    },
    support ? support.instrumentTool("get_weather", weatherHandler) : weatherHandler
  );
  return { server, support };
}

export async function startServer({
  port = PORT,
  host = HOST,
  auth = authConfigFromEnv(),
  tokenVerifier = auth.enabled ? createAuth0Verifier(auth) : undefined
} = {}) {
  const httpServer = createServer(async (req, res) => {
    const pathname = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`).pathname;
    if (req.method === "GET" && pathname === "/health") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, service: "weather-mcp-render" }));
      return;
    }
    if (
      auth.enabled &&
      req.method === "GET" &&
      (pathname === "/.well-known/oauth-protected-resource/mcp" ||
        pathname === "/.well-known/oauth-protected-resource")
    ) {
      json(res, 200, protectedResourceMetadata(auth));
      return;
    }
    if (pathname === "/mcp") {
      if (!(await authorizeRequest(req, res, auth, tokenVerifier))) return;
      const { server, support } = buildMcpServer();
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
      try {
        await server.connect(transport);
        await transport.handleRequest(req, res);
      } finally {
        await server.close();
        await support?.close();
      }
      return;
    }
    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "Not found", mcpEndpoint: "/mcp", healthEndpoint: "/health" }));
  });

  await new Promise(resolve => httpServer.listen(port, host, resolve));
  console.log(`Weather MCP server listening on ${host}:${port}`);

  return {
    httpServer,
    close: async () => {
      await new Promise((resolve, reject) => httpServer.close(error => error ? reject(error) : resolve()));
    }
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const running = await startServer();
  for (const signal of ["SIGINT", "SIGTERM"]) {
    process.once(signal, () => void running.close().finally(() => process.exit(0)));
  }
}
