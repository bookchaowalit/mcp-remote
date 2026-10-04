import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { handleRequest, type Env } from '../src/worker.js';

const token = 'local-test-bearer-with-sufficient-entropy';
const url = 'https://mcp.example.com/mcp';
const env: Env = { MCP_TOKEN_SHA256: createHash('sha256').update(token).digest('hex'), PUBLIC_ORIGIN: 'https://mcp.example.com' };
const rpc = { jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} };
function request(body: unknown = rpc, headers: Record<string, string> = {}, target = url): Request {
  return new Request(target, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', ...headers }, body: typeof body === 'string' ? body : JSON.stringify(body) });
}
const unavailable: typeof fetch = async () => { throw new Error('private upstream error that must not escape'); };
async function clientFor(config: Env = env, upstream: typeof fetch = unavailable) {
  const calls: Request[] = [];
  const transport = new StreamableHTTPClientTransport(new URL(url), {
    requestInit: { headers: { Authorization: `Bearer ${token}` } },
    fetch: async (input, init) => {
      const req = new Request(input, init);
      calls.push(req);
      const response = await handleRequest(req, { ...config }, upstream);
      assert.equal(response.headers.has('mcp-session-id'), false);
      assert.equal(response.headers.has('access-control-allow-origin'), false);
      return response;
    },
  });
  const client = new Client({ name: 'integration-test', version: '1.0.0' });
  await client.connect(transport);
  return { client, transport, calls };
}
async function call(name: string, config: Env = env, upstream: typeof fetch = unavailable) {
  const { client } = await clientFor(config, upstream);
  try { return await client.callTool({ name, arguments: {} }) as { isError?: boolean; structuredContent?: Record<string, unknown> }; }
  finally { await client.close(); }
}

test('health discloses only readiness of authentication configuration', async () => {
  const health = new Request('https://mcp.example.com/healthz');
  assert.equal((await handleRequest(health, {})).status, 503);
  assert.equal((await handleRequest(health, { ...env, PUBLIC_ORIGIN: undefined })).status, 503);
  const response = await handleRequest(health, env);
  assert.deepEqual(await response.json(), { status: 'ok' });
});

test('auth fails closed and uses fixed errors', async () => {
  assert.equal((await handleRequest(request(), {})).status, 503);
  assert.equal((await handleRequest(request(), { ...env, PUBLIC_ORIGIN: undefined })).status, 503);
  for (const authorization of ['', 'Bearer incorrect-test-token', 'Basic abc']) {
    const result = await handleRequest(request(rpc, { Authorization: authorization }), env);
    assert.equal(result.status, 401);
    assert.deepEqual(await result.json(), { error: 'unauthorized' });
  }
});

test('host and browser origin are validated before SDK routing', async () => {
  assert.equal((await handleRequest(request(rpc, {}, 'https://evil.example.com/mcp'), env)).status, 403);
  assert.equal((await handleRequest(request(rpc, { Host: 'evil.example.com' }), env)).status, 403);
  assert.equal((await handleRequest(request(rpc, { Origin: 'https://app.example.com' }), env)).status, 403);
  const allowed = { ...env, ALLOWED_ORIGINS: 'https://app.example.com' };
  assert.equal((await handleRequest(request(rpc, { Origin: 'https://app.example.com' }), allowed)).status, 200);
  assert.equal((await handleRequest(request(rpc, { Origin: 'null' }), allowed)).status, 403);
  assert.equal((await handleRequest(request(rpc, { Origin: 'https://app.example.com/evil' }), allowed)).status, 403);
});

test('rejects malformed JSON, SDK protocol errors, unsupported content and streamed oversized input', async () => {
  const malformed = await handleRequest(request('{'), env);
  assert.equal(malformed.status, 400);
  assert.deepEqual(await malformed.json(), { error: 'invalid_json' });
  assert.equal((await handleRequest(request('null'), env)).status, 400);
  assert.equal((await handleRequest(request(rpc, { 'Content-Type': 'text/plain' }), env)).status, 415);
  const stream = new ReadableStream<Uint8Array>({ start(controller) {
    controller.enqueue(new TextEncoder().encode(' '.repeat(32768)));
    controller.enqueue(new TextEncoder().encode(' '.repeat(32769)));
    controller.close();
  } });
  const init: RequestInit & { duplex: string } = { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' }, body: stream, duplex: 'half' };
  assert.equal((await handleRequest(new Request(url, init), env)).status, 413);
});

test('real SDK initializes, lists five read-only tools, and calls across fresh transports', async () => {
  for (let index = 0; index < 2; index++) {
    const { client, transport, calls } = await clientFor();
    try {
      assert.equal(transport.sessionId, undefined);
      const result = await client.listTools();
      assert.deepEqual(result.tools.map(tool => tool.name).sort(), ['list_remote_services', 'check_remote_services', 'get_ai_status', 'get_agency_workspace', 'get_income_workspace'].sort());
      for (const tool of result.tools) {
        assert.equal(tool.annotations?.readOnlyHint, true);
        assert.equal(tool.annotations?.destructiveHint, false);
      }
      const listed = await client.callTool({ name: 'list_remote_services', arguments: {} });
      const services = (listed.structuredContent as { services: Record<string, unknown>[] }).services;
      assert.equal(services.length, 3);
      assert.equal(services[0].availability, 'not_checked');
      assert.equal(services[0].read_token_configured, false);
      assert.ok(calls.length >= 4);
      assert.ok(calls.every(req => !req.headers.has('mcp-session-id')));
    } finally { await client.close(); }
  }
});

test('missing read tokens never calls upstream or claims connectivity', async () => {
  let calls = 0;
  const upstream: typeof fetch = async () => { calls++; return Response.json({}); };
  for (const name of ['get_ai_status', 'get_agency_workspace', 'get_income_workspace']) {
    const result = await call(name, env, upstream);
    assert.equal(result.isError, true);
    assert.equal(result.structuredContent?.status, 'not_configured');
  }
  assert.equal(calls, 0);
});

test('read paths, tokens and methods are fixed; upstream secrets are redacted', async () => {
  const config = { ...env, AI_API_READ_TOKEN: 'ai-private-test-token', AGENCY_CRM_TOKEN: 'agency-private-test-token', INCOME_CRM_TOKEN: 'income-private-test-token' };
  const observed: { url: string; auth: string | null; method?: string; redirect?: string }[] = [];
  const upstream: typeof fetch = async (input, init) => {
    observed.push({ url: String(input), auth: new Headers(init?.headers).get('authorization'), method: init?.method, redirect: init?.redirect });
    return Response.json({ ready: true, authorization: 'private', nested: { message: `echo ${config.AI_API_READ_TOKEN}` } });
  };
  for (const name of ['get_ai_status', 'get_agency_workspace', 'get_income_workspace']) {
    const result = await call(name, config, upstream);
    assert.equal(result.structuredContent?.status, 'ok');
    const serialized = JSON.stringify(result);
    for (const secret of [config.AI_API_READ_TOKEN, config.AGENCY_CRM_TOKEN, config.INCOME_CRM_TOKEN]) assert.equal(serialized.includes(secret), false);
  }
  assert.deepEqual(observed.map(item => item.url), ['https://api.bookchaowalit.com/api/ai/status', 'https://crm-api-production-a7e0.up.railway.app/api/v1/crm/agency/workspace', 'https://crm-api-production-19fd.up.railway.app/api/v1/crm/agency/workspace']);
  assert.deepEqual(observed.map(item => item.auth), [`Bearer ${config.AI_API_READ_TOKEN}`, `Bearer ${config.AGENCY_CRM_TOKEN}`, `Bearer ${config.INCOME_CRM_TOKEN}`]);
  assert.ok(observed.every(item => item.method === 'GET' && item.redirect === 'manual'));
});

test('health checks return HTTP status only without payload or tokens', async () => {
  const config = { ...env, AI_API_READ_TOKEN: 'private-ai-token' };
  const observed: string[] = [];
  const upstream: typeof fetch = async (input, init) => {
    observed.push(String(input));
    assert.equal(new Headers(init?.headers).has('authorization'), false);
    return Response.json({ private: 'do not return me' }, { status: 200 });
  };
  const result = await call('check_remote_services', config, upstream);
  assert.equal(JSON.stringify(result).includes('do not return me'), false);
  assert.deepEqual(observed, ['https://api.bookchaowalit.com/healthz', 'https://crm-api-production-a7e0.up.railway.app/health', 'https://crm-api-production-19fd.up.railway.app/health']);
  assert.ok((result.structuredContent?.services as Record<string, unknown>[]).every(item => item.http_status === 200));
});

test('rejects redirects, invalid content, oversized JSON and sanitizes fetch errors', async () => {
  const config = { ...env, AI_API_READ_TOKEN: 'private-ai-token' };
  const cases: [typeof fetch, string][] = [
    [async () => new Response('private error', { status: 302, headers: { Location: 'https://evil.example.com' } }), 'http_error'],
    [async () => new Response('private html', { headers: { 'Content-Type': 'text/html' } }), 'invalid_response'],
    [async () => Response.json({ body: 'x'.repeat(512 * 1024) }), 'response_too_large'],
    [async () => new Response('not JSON', { headers: { 'Content-Type': 'application/json' } }), 'upstream_error'],
    [unavailable, 'upstream_error'],
  ];
  for (const [upstream, expected] of cases) {
    const result = await call('get_ai_status', config, upstream);
    assert.equal(result.isError, true);
    assert.equal(result.structuredContent?.status, expected);
    assert.equal(JSON.stringify(result).includes('private'), false);
  }
});

test('invalid administrator origins cannot produce an upstream request', async () => {
  for (const origin of ['http://api.example.com', 'https://user:password@api.example.com', 'https://api.example.com/path', 'https://api.example.com?query=1', 'https://127.0.0.1', 'https://metadata.internal', 'https://[::1]']) {
    const result = await call('get_ai_status', { ...env, AI_API_READ_TOKEN: 'private-ai-token', AI_API_ORIGIN: origin }, async () => { assert.fail('must not fetch'); });
    assert.equal(result.structuredContent?.status, 'not_configured');
  }
});

test('upstream deadline cancels the request after fifteen seconds without exposing its error', async () => {
  let aborted = false;
  const upstream: typeof fetch = async (_input, init) => new Promise<Response>((_resolve, reject) => {
    init!.signal!.addEventListener('abort', () => { aborted = true; reject(new Error('private timeout details')); }, { once: true });
  });
  const result = await call('get_ai_status', { ...env, AI_API_READ_TOKEN: 'private-ai-token' }, upstream);
  assert.equal(aborted, true);
  assert.equal(result.structuredContent?.status, 'timeout');
  assert.equal(JSON.stringify(result).includes('private'), false);
});
