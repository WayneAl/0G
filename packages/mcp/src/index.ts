import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { loadConfig } from "./config.js";
import { createServer } from "./server.js";

/**
 * The stdio entry point.
 *
 * stdout is the JSON-RPC channel, so nothing in this package may write to it —
 * one stray `console.log` corrupts the framing and the client sees a parse error
 * instead of an answer. Everything an operator needs to read goes to stderr,
 * which is where MCP clients show server logs.
 *
 * This module *is* the server: importing it starts one. `createServer` and
 * `loadConfig` are importable from `./server.js` and `./config.js` for anyone
 * who wants the pieces without the process.
 */
async function main(): Promise<void> {
  const config = await loadConfig(process.env);
  const server = createServer(config);
  await server.connect(new StdioServerTransport());

  const keyState = config.agentKey === null ? "no ACU_AGENT_KEY (quotes only)" : "key loaded";
  process.stderr.write(
    `acu-mcp ready · agent ${config.agentId} · auditor ${config.auditorUrl} · ` +
      `${config.directory.agents.length} agents in directory · ${keyState}\n`,
  );
}

await main().catch((err: unknown) => {
  // A misconfigured server must die loudly rather than sit on stdio answering
  // nothing: the client's log is the only place this can be seen.
  process.stderr.write(`acu-mcp failed to start: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
