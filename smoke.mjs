/** Verify protocol and upstream status without printing returned private data. */
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const expected = ['list_remote_services', 'check_remote_services', 'get_ai_status', 'get_agency_workspace', 'get_income_workspace'].sort();
async function verify(transport) {
  const client = new Client({ name: 'remote-mcp-smoke', version: '1.0.0' });
  try {
    await client.connect(transport, { timeout: 60_000 });
    const tools = await client.listTools(undefined, { timeout: 30_000 });
    assert.deepEqual(tools.tools.map(tool => tool.name).sort(), expected);
    const checks = {};
    for (const name of expected) {
      const result = await client.callTool({ name, arguments: {} }, undefined, { timeout: 30_000 });
      const data = result.structuredContent || JSON.parse(result.content[0].text);
      checks[name] = data.status || (name === 'check_remote_services'
        ? data.services.map(service => ({ service: service.service, status: service.status, http_status: service.http_status }))
        : data.services.map(service => ({ id: service.id, read_token_configured: service.read_token_configured })));
      if (name.startsWith('get_') && data.status !== 'not_configured') assert.equal(data.status, 'ok');
      if (name === 'check_remote_services') assert.ok(data.services.every(service => service.status === 'ok'));
    }
    return checks;
  } finally { await client.close(); }
}
async function main() {
  const endpoint = process.env.MCP_REMOTE_URL;
  if (process.argv.includes('--bridge')) {
    const env = Object.fromEntries(Object.entries(process.env).filter(([key, value]) => key !== 'SOLO_MCP_BRIDGE_TOKEN' && value !== undefined));
    const transport = new StdioClientTransport({ command: process.env.MCP_BRIDGE_PYTHON || 'python3', args: [new URL('./launch.py', import.meta.url).pathname], env, stderr: 'pipe' });
    const checks = await verify(transport);
    console.log(JSON.stringify({ transport: 'fresh_client_bridge', status: 'passed', tools: expected.length, checks }));
    return;
  }
  assert.ok(endpoint?.startsWith('https://'));
  const headers = { Authorization: `Bearer ${process.env.SOLO_MCP_BRIDGE_TOKEN}` };
  const noAuth = await fetch(endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }) });
  assert.equal(noAuth.status, 401);
  for (let index = 0; index < 2; index++) {
    const transport = new StreamableHTTPClientTransport(new URL(endpoint), { requestInit: { headers, redirect: 'error' } });
    const checks = await verify(transport);
    assert.equal(transport.sessionId, undefined);
    console.log(JSON.stringify({ transport: 'https', fresh_client: index + 1, status: 'passed', unauthorized_status: noAuth.status, tools: expected.length, checks }));
  }
}
main().catch(() => { console.error(JSON.stringify({ status: 'failed', error: 'remote_mcp_verification_failed' })); process.exitCode = 1; });
