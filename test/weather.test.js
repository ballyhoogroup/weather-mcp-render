import test from "node:test";
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { buildMcpServer } from "../src/index.js";

test("the runtime provides fetch", () => {
  assert.equal(typeof fetch, "function");
});

test("SupportBridge tools and MCP App resource are registered", async () => {
  process.env.SUPPORTBRIDGE_API_KEY ||= "local-test-key";
  const { server, support } = buildMcpServer();
  const client = new Client({ name: "weather-mcp-test", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

  await server.connect(serverTransport);
  await client.connect(clientTransport);
  try {
    const tools = await client.listTools();
    assert.ok(tools.tools.some(tool => tool.name === "get_weather"));
    assert.ok(tools.tools.some(tool => tool.name === "talk_to_support"));

    const resources = await client.listResources();
    const chat = resources.resources.find(resource => resource.uri === "ui://supportbridge/chat.html");
    assert.ok(chat, "SupportBridge chat resource should be registered");
    assert.equal(chat.mimeType, "text/html;profile=mcp-app");
  } finally {
    await client.close();
    await server.close();
    await support.close();
  }
});
