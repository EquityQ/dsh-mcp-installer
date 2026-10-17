#!/usr/bin/env node
/**
 * Minimal MCP stdio server used only to verify the installer end to end.
 * Newline-delimited JSON-RPC 2.0; exposes one `echo` tool.
 */
import { createInterface } from 'node:readline';

const VERSION = '2026-07-28';

function send(message) {
  process.stdout.write(JSON.stringify(message) + '\n');
}

const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
rl.on('line', (line) => {
  const text = line.trim();
  if (!text) return;
  let request;
  try {
    request = JSON.parse(text);
  } catch {
    return;
  }
  const { id, method, params } = request;
  const isNotification = id === undefined || id === null;
  if (isNotification) return;

  switch (method) {
    case 'initialize':
      send({
        jsonrpc: '2.0',
        id,
        result: {
          protocolVersion: params?.protocolVersion ?? VERSION,
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: 'demo-echo', version: '1.0.0' },
          instructions: 'Demo MCP server installed by dsh-mcp-installer.',
        },
      });
      return;
    case 'ping':
      send({ jsonrpc: '2.0', id, result: {} });
      return;
    case 'tools/list':
      send({
        jsonrpc: '2.0',
        id,
        result: {
          tools: [
            {
              name: 'echo',
              description: 'Echo the given text back. Proves the MCP bridge works.',
              inputSchema: {
                type: 'object',
                properties: { text: { type: 'string', description: 'Text to echo' } },
                required: ['text'],
              },
            },
          ],
        },
      });
      return;
    case 'tools/call':
      send({
        jsonrpc: '2.0',
        id,
        result: {
          content: [{ type: 'text', text: `echo: ${String(params?.arguments?.text ?? '')}` }],
        },
      });
      return;
    case 'resources/list':
      send({ jsonrpc: '2.0', id, result: { resources: [] } });
      return;
    case 'prompts/list':
      send({ jsonrpc: '2.0', id, result: { prompts: [] } });
      return;
    default:
      send({
        jsonrpc: '2.0',
        id,
        error: { code: -32601, message: `Method not found: ${String(method)}` },
      });
  }
});
