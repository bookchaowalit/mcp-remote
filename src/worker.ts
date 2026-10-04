import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';

export interface Env {
  MCP_TOKEN_SHA256?: string;
  PUBLIC_ORIGIN?: string;
  ALLOWED_ORIGINS?: string;
  AI_API_ORIGIN?: string;
  AGENCY_CRM_ORIGIN?: string;
  INCOME_CRM_ORIGIN?: string;
  AI_API_READ_TOKEN?: string;
  AGENCY_CRM_TOKEN?: string;
  INCOME_CRM_TOKEN?: string;
}

type ServiceId = 'ai' | 'agency' | 'income';
interface Service { id: ServiceId; origin: string | null; token?: string; healthPath: string; readPath: string }
type Result = Record<string, unknown>;
type Fetcher = typeof fetch;
const INPUT_LIMIT = 64 * 1024;
const OUTPUT_LIMIT = 512 * 1024;
const annotations = { readOnlyHint: true, destructiveHint: false, openWorldHint: true };

// Configuration is administrator-owned; tool callers cannot supply URLs or paths.
function httpsOrigin(value?: string): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.username || url.password || url.pathname !== '/' ||
        url.search || url.hash || url.port || !url.hostname.includes('.') ||
        url.hostname.includes(':') || /^\d+(\.\d+){3}$/.test(url.hostname) ||
        /(?:^|\.)(?:localhost|local|internal|test|invalid)$/.test(url.hostname)) return null;
    return url.origin;
  } catch { return null; }
}

function services(env: Env): Service[] {
  return [
    { id: 'ai', origin: httpsOrigin(env.AI_API_ORIGIN ?? 'https://api.bookchaowalit.com'), token: env.AI_API_READ_TOKEN, healthPath: '/healthz', readPath: '/api/ai/status' },
    { id: 'agency', origin: httpsOrigin(env.AGENCY_CRM_ORIGIN ?? 'https://crm-api-production-a7e0.up.railway.app'), token: env.AGENCY_CRM_TOKEN, healthPath: '/health', readPath: '/api/v1/crm/agency/workspace' },
    { id: 'income', origin: httpsOrigin(env.INCOME_CRM_ORIGIN ?? 'https://crm-api-production-19fd.up.railway.app'), token: env.INCOME_CRM_TOKEN, healthPath: '/health', readPath: '/api/v1/crm/agency/workspace' },
  ];
}

class BodyLimitError extends Error {}
async function boundedText(body: ReadableStream<Uint8Array> | null, limit: number): Promise<string> {
  if (!body) return '';
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > limit) {
        await reader.cancel();
        throw new BodyLimitError();
      }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
}

function redact(value: unknown, secrets: string[]): unknown {
  if (typeof value === 'string') {
    for (const secret of secrets) value = (value as string).split(secret).join('[redacted]');
    return value;
  }
  if (Array.isArray(value)) return value.map(item => redact(item, secrets));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) =>
      [key, /(?:token|password|secret|authorization|cookie|api[_-]?key|credential)/i.test(key) ? '[redacted]' : redact(item, secrets)]));
  }
  return value;
}

async function upstream(service: Service, read: boolean, fetcher: Fetcher, secrets: string[]): Promise<Result> {
  if (!service.origin || (read && !service.token)) return { service: service.id, status: 'not_configured' };
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15000);
  try {
    const response = await fetcher(new URL(read ? service.readPath : service.healthPath, service.origin), {
      method: 'GET', redirect: 'manual', signal: controller.signal,
      headers: read ? { Accept: 'application/json', Authorization: `Bearer ${service.token}` } : { Accept: 'application/json' },
    });
    if (!read || !response.ok) {
      await response.body?.cancel();
      return { service: service.id, status: response.ok ? 'ok' : 'http_error', http_status: response.status };
    }
    const contentType = response.headers.get('content-type')?.split(';')[0].trim().toLowerCase();
    if (contentType !== 'application/json' && !contentType?.endsWith('+json')) {
      await response.body?.cancel();
      return { service: service.id, status: 'invalid_response' };
    }
    const data: unknown = JSON.parse(await boundedText(response.body, OUTPUT_LIMIT));
    return { service: service.id, status: 'ok', data: redact(data, secrets) };
  } catch (error) {
    return { service: service.id, status: error instanceof BodyLimitError ? 'response_too_large' : controller.signal.aborted ? 'timeout' : 'upstream_error' };
  } finally { clearTimeout(timeout); }
}

function toolResult(result: Result) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(result) }], structuredContent: result,
    ...(['not_configured', 'http_error', 'invalid_response', 'response_too_large', 'timeout', 'upstream_error'].includes(String(result.status)) ? { isError: true } : {}) };
}

function serverFor(env: Env, fetcher: Fetcher): McpServer {
  const server = new McpServer({ name: 'solo-empire-mcp-remote', version: '1.0.0' });
  const configured = services(env);
  const secrets = [env.MCP_TOKEN_SHA256, ...configured.map(service => service.token)].filter((value): value is string => Boolean(value));
  server.registerTool('list_remote_services', {
    description: 'แสดงบริการ API ที่ตั้งค่าไว้ โดยไม่เปิดเผย token; การตั้งค่าไม่ยืนยันว่าบริการออนไลน์', inputSchema: {}, annotations,
  }, async () => toolResult({ services: configured.map(service => ({ id: service.id, origin: service.origin, origin_configured: Boolean(service.origin), read_token_configured: Boolean(service.token), availability: 'not_checked' })) }));
  server.registerTool('check_remote_services', {
    description: 'ตรวจ HTTP health ของบริการ API ที่ตั้งค่าไว้ และคืนสถานะโดยไม่อ่านเนื้อหาตอบกลับ', inputSchema: {}, annotations,
  }, async () => toolResult({ services: await Promise.all(configured.map(service => upstream(service, false, fetcher, secrets))) }));
  const names = { ai: 'get_ai_status', agency: 'get_agency_workspace', income: 'get_income_workspace' };
  for (const service of configured) server.registerTool(names[service.id], {
    description: `อ่านข้อมูลจากบริการ ${service.id} ผ่าน API ที่อนุญาต`, inputSchema: {}, annotations,
  }, async () => toolResult(await upstream(service, true, fetcher, secrets)));
  return server;
}

function jsonError(status: number, message: string): Response {
  return Response.json({ error: message }, { status, headers: { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' } });
}
function authConfigured(env: Env): boolean { return /^[a-f0-9]{64}$/i.test(env.MCP_TOKEN_SHA256 ?? ''); }
async function authorized(request: Request, env: Env): Promise<boolean> {
  const header = request.headers.get('authorization') ?? '';
  if (!/^Bearer [\x21-\x7E]{16,4096}$/.test(header)) return false;
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(header.slice(7)));
  const actual = [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('');
  const expected = env.MCP_TOKEN_SHA256!.toLowerCase();
  let difference = 0;
  for (let index = 0; index < 64; index++) difference |= actual.charCodeAt(index) ^ expected.charCodeAt(index);
  return difference === 0;
}

// A fresh SDK server/transport for every request avoids isolate or laptop state.
export async function handleRequest(request: Request, env: Env, fetcher: Fetcher = fetch): Promise<Response> {
  const url = new URL(request.url);
  if (url.pathname === '/healthz' && request.method === 'GET') {
    return authConfigured(env) && httpsOrigin(env.PUBLIC_ORIGIN) ? Response.json({ status: 'ok' }, { headers: { 'Cache-Control': 'no-store' } }) : jsonError(503, 'not_configured');
  }
  if (url.pathname !== '/mcp') return jsonError(404, 'not_found');
  if (!authConfigured(env)) return jsonError(503, 'not_configured');
  const publicOrigin = httpsOrigin(env.PUBLIC_ORIGIN);
  if (!publicOrigin) return jsonError(503, 'not_configured');
  if (url.origin !== publicOrigin || (request.headers.has('host') && request.headers.get('host') !== new URL(publicOrigin).host)) return jsonError(403, 'forbidden');
  const origin = request.headers.get('origin');
  const allowed = (env.ALLOWED_ORIGINS ?? '').split(',').map(value => httpsOrigin(value.trim())).filter(Boolean);
  if (origin !== null && (!httpsOrigin(origin) || !allowed.includes(origin))) return jsonError(403, 'forbidden');
  if (!(await authorized(request, env))) return jsonError(401, 'unauthorized');
  if (request.method !== 'POST') return jsonError(405, 'method_not_allowed');
  if (request.headers.get('content-type')?.split(';')[0].trim().toLowerCase() !== 'application/json') return jsonError(415, 'unsupported_media_type');
  let parsedBody: unknown;
  try { parsedBody = JSON.parse(await boundedText(request.body, INPUT_LIMIT)); }
  catch (error) { return jsonError(error instanceof BodyLimitError ? 413 : 400, error instanceof BodyLimitError ? 'body_too_large' : 'invalid_json'); }
  const server = serverFor(env, fetcher);
  const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  try {
    await server.connect(transport);
    const response = await transport.handleRequest(request, { parsedBody });
    // JSON mode resolves only once all replies exist. Consume before closing.
    const bytes = await response.arrayBuffer();
    const headers = new Headers(response.headers);
    headers.set('Cache-Control', 'no-store');
    headers.set('X-Content-Type-Options', 'nosniff');
    return new Response(bytes.byteLength ? bytes : null, { status: response.status, headers });
  } catch { return jsonError(500, 'internal_error'); }
  finally { await server.close(); }
}

export default { fetch: (request: Request, env: Env) => handleRequest(request, env) };
