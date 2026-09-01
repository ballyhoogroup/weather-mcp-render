import test from "node:test";
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { buildMcpServer, protectedResourceMetadata, startServer } from "../src/index.js";

const weatherResult = {
  location: "Richmond, Virginia, United States",
  current: { conditions: "Clear sky", temperature: "72 °F" },
  forecast: [],
  source: "Open-Meteo"
};

async function connectTestClient(options = {}) {
  const { server, support } = buildMcpServer({
    weatherProvider: async () => weatherResult,
    supportBridgeConfig: undefined,
    ...options
  });
  const client = new Client({ name: "weather-mcp-test", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return {
    server,
    client,
    close: async () => {
      await client.close();
      await server.close();
      await support?.close();
    }
  };
}

test("the runtime provides fetch", () => {
  assert.equal(typeof fetch, "function");
});

test("the raw MCP exposes only get_weather", async () => {
  const connection = await connectTestClient();
  try {
    const tools = await connection.client.listTools();
    assert.deepEqual(tools.tools.map(tool => tool.name), ["get_weather"]);
    await assert.rejects(
      connection.client.listResources(),
      /Method not found/
    );
  } finally {
    await connection.close();
  }
});

test("get_weather preserves its structured result", async () => {
  const connection = await connectTestClient();
  try {
    const result = await connection.client.callTool({
      name: "get_weather",
      arguments: { location: "Richmond, Virginia", units: "imperial", forecastDays: 1 }
    });
    assert.equal(result.isError, undefined);
    assert.deepEqual(result.structuredContent, weatherResult);
  } finally {
    await connection.close();
  }
});

test("SupportBridge installs its tools and instruments get_weather", async () => {
  const requests = [];
  const supportFetch = async (url, init = {}) => {
    requests.push({ url: String(url), method: init.method ?? "GET", body: init.body });
    if (String(url).endsWith("/v1/config")) {
      return new Response(JSON.stringify({ triggers: [] }), {
        status: 200,
        headers: { "content-type": "application/json" }
      });
    }
    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { "content-type": "application/json" }
    });
  };
  const connection = await connectTestClient({
    supportBridgeConfig: {
      apiKey: "test-key",
      baseUrl: "https://support.example",
      source: "weather-mcp",
      fetch: supportFetch,
      client: { http: { fetch: supportFetch }, buffer: { batchSize: 1 } },
      policyApp: { enabled: false }
    }
  });
  try {
    const tools = await connection.client.listTools();
    assert.ok(tools.tools.some(tool => tool.name === "get_weather"));
    assert.ok(tools.tools.some(tool => tool.name === "talk_to_support"));

    const result = await connection.client.callTool({
      name: "get_weather",
      arguments: { location: "Richmond, Virginia", units: "imperial", forecastDays: 1 }
    });
    assert.deepEqual(result.structuredContent, weatherResult);
  } finally {
    await connection.close();
  }
  assert.ok(requests.some(request => request.url.endsWith("/v1/events")));
});

const testAuth = {
  enabled: true,
  issuer: "https://example.auth0.com/",
  audience: "https://weather.example/mcp",
  publicBaseUrl: "http://127.0.0.1",
  requiredScope: "weather:read"
};

async function startAuthTestServer(tokenVerifier) {
  const running = await startServer({ port: 0, host: "127.0.0.1", auth: testAuth, tokenVerifier });
  const address = running.httpServer.address();
  return { ...running, baseUrl: `http://127.0.0.1:${address.port}` };
}

test("OAuth protected-resource metadata advertises Auth0", () => {
  assert.deepEqual(protectedResourceMetadata(testAuth), {
    resource: "http://127.0.0.1/mcp",
    authorization_servers: ["https://example.auth0.com/"],
    scopes_supported: ["weather:read"],
    bearer_methods_supported: ["header"]
  });
});

test("the MCP endpoint challenges unauthenticated callers", async () => {
  const running = await startAuthTestServer(async () => assert.fail("verifier should not run"));
  try {
    const response = await fetch(`${running.baseUrl}/mcp`, { method: "POST" });
    assert.equal(response.status, 401);
    assert.match(response.headers.get("www-authenticate"), /oauth-protected-resource\/mcp/);
  } finally {
    await running.close();
  }
});

test("a valid scoped token can use the original weather tool", async () => {
  const running = await startAuthTestServer(async token => ({
    subject: token === "valid-token" ? "auth0|test-user" : undefined,
    scopes: ["weather:read"],
    expiresAt: Math.floor(Date.now() / 1000) + 60
  }));
  const client = new Client({ name: "oauth-weather-test", version: "1.0.0" });
  const transport = new (await import("@modelcontextprotocol/sdk/client/streamableHttp.js")).StreamableHTTPClientTransport(
    new URL(`${running.baseUrl}/mcp`),
    { requestInit: { headers: { authorization: "Bearer valid-token" } } }
  );
  try {
    await client.connect(transport);
    const tools = await client.listTools();
    assert.deepEqual(tools.tools.map(tool => tool.name), ["get_weather"]);
  } finally {
    await client.close();
    await running.close();
  }
});

test("a token without weather:read is rejected", async () => {
  const running = await startAuthTestServer(async () => ({
    subject: "auth0|test-user",
    scopes: [],
    expiresAt: Math.floor(Date.now() / 1000) + 60
  }));
  try {
    const response = await fetch(`${running.baseUrl}/mcp`, {
      method: "POST",
      headers: { authorization: "Bearer wrong-scope" }
    });
    assert.equal(response.status, 403);
    assert.match(response.headers.get("www-authenticate"), /insufficient_scope/);
  } finally {
    await running.close();
  }
});
