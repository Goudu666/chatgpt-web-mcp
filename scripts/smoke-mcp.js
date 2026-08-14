#!/usr/bin/env node

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const transport = new StdioClientTransport({
  command: process.execPath,
  args: [new URL("../src/index.js", import.meta.url).pathname],
  stderr: "pipe",
});

transport.stderr?.on("data", (chunk) => process.stderr.write(chunk));

const client = new Client({ name: "chatgpt-web-mcp-smoke", version: "0.2.0" });
try {
  await client.connect(transport);
  const tools = await client.listTools();
  console.log(`tools=${tools.tools.length}`);
  console.log(tools.tools.map((tool) => tool.name).join("\n"));
  if (process.argv.includes("--status")) {
    const status = await client.callTool({ name: "chatgpt_status", arguments: {} });
    console.log(JSON.stringify(status, null, 2));
  }
} finally {
  await client.close();
}
