/** Local protocol bridge; business operations execute on the hosted Worker. */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';

const remote = new Client({ name: 'solo-empire-remote-bridge', version: '0.1.0' });
const server = new Server({ name: 'solo-empire-remote', version: '0.1.0' }, { capabilities: { tools: {} } });
let closing = false;
async function close() {
  if (closing) return;
  closing = true;
  await Promise.allSettled([server.close(), remote.close()]);
}

async function main() {
  const endpoint = new URL(process.env.MCP_REMOTE_URL || '');
  if (endpoint.protocol !== 'https:' || endpoint.username || endpoint.password || endpoint.pathname !== '/mcp' || endpoint.search || endpoint.hash) {
    throw new Error('invalid endpoint');
  }
  const token = process.env.SOLO_MCP_BRIDGE_TOKEN;
  if (!token) throw new Error('missing auth');
  const transport = new StreamableHTTPClientTransport(endpoint, {
    requestInit: { headers: { Authorization: `Bearer ${token}` }, redirect: 'error' },
  });
  delete process.env.SOLO_MCP_BRIDGE_TOKEN;
  await remote.connect(transport, { timeout: 30_000 });
  server.setRequestHandler(ListToolsRequestSchema, async () => remote.listTools(undefined, { timeout: 30_000 }));
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    try {
      return await remote.callTool(request.params, undefined, { timeout: 30_000 });
    } catch {
      return { isError: true, content: [{ type: 'text', text: JSON.stringify({ status: 'unavailable', error: 'remote_mcp_unavailable' }) }] };
    }
  });
  await server.connect(new StdioServerTransport());
  process.stdin.on('end', () => void close());
}
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => void close());
main().catch(async () => {
  console.error('Remote MCP connection unavailable. Check the hosted endpoint and Infisical session.');
  await close();
  process.exitCode = 1;
});
