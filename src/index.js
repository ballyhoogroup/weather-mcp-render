import { createServer } from "node:http";
import { createMcpHandler, McpServer } from "@modelcontextprotocol/server";
import { toNodeHandler } from "@modelcontextprotocol/node";
import * as z from "zod/v4";

const PORT = Number.parseInt(process.env.PORT ?? "3000", 10);
const HOST = "0.0.0.0";

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

function buildMcpServer() {
  const server = new McpServer({ name: "weather-mcp-render", version: "1.0.0" });
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
    async ({ location, units, forecastDays }) => {
      try {
        const weather = await getWeather(location, units, forecastDays);
        return { content: [{ type: "text", text: JSON.stringify(weather, null, 2) }], structuredContent: weather };
      } catch (error) {
        const message = error instanceof Error ? error.message : "Unknown weather error";
        return { isError: true, content: [{ type: "text", text: message }] };
      }
    }
  );
  return server;
}

const mcp = createMcpHandler(buildMcpServer);
const handleMcp = toNodeHandler(mcp);

const httpServer = createServer(async (req, res) => {
  const pathname = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`).pathname;
  if (req.method === "GET" && pathname === "/health") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true, service: "weather-mcp-render" }));
    return;
  }
  if (pathname === "/mcp") {
    await handleMcp(req, res);
    return;
  }
  res.writeHead(404, { "content-type": "application/json" });
  res.end(JSON.stringify({ error: "Not found", mcpEndpoint: "/mcp", healthEndpoint: "/health" }));
});

httpServer.listen(PORT, HOST, () => console.log(`Weather MCP server listening on ${HOST}:${PORT}`));

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => httpServer.close(() => process.exit(0)));
}
