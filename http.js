import { loginCookie, loginCookieName, readLoginCookie, publicLogin } from './runtime/login-sessions.mjs';

/** Owner-carrier bridge. This is deliberately NOT a public member ingress. */
export const API_PATH = '/api/lan-workspace';
export const MAX_BODY_BYTES = 192 * 1024;
const PUBLIC_ACTIONS = new Set(['status', 'login', 'redeem', 'bootstrap', 'owner.recoverAdministrator']);
const AUTH_ACTIONS = new Set(['bootstrap', 'login', 'redeem']);
const RESPONSE_HEADERS = Object.freeze({
  'Content-Type': 'application/json; charset=utf-8',
  'Cache-Control': 'no-store, private',
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
});

class HttpFailure extends Error {
  constructor(code, message, status) { super(message); this.code = code; this.status = status; }
}
const fail = (code, message, status) => { throw new HttpFailure(code, message, status); };
const reply = (value, status = 200, headers = {}) => new Response(JSON.stringify(value), { status, headers: { ...RESPONSE_HEADERS, ...headers } });

async function readJson(request) {
  const contentType = request.headers.get('content-type') || '';
  if (!/^application\/json(?:\s*;\s*charset=utf-8)?\s*$/i.test(contentType)) fail('CONTENT_TYPE', 'JSON 请求类型无效 / JSON content type required', 415);
  const length = request.headers.get('content-length');
  if (length !== null && (!/^\d+$/.test(length) || Number(length) > MAX_BODY_BYTES)) fail('BODY_TOO_LARGE', '请求过大 / Request too large', 413);
  if (!request.body) fail('INVALID_JSON', '缺少请求内容 / Missing request body', 400);
  const reader = request.body.getReader();
  let received = 0;
  const chunks = [];
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      received += value.byteLength;
      if (received > MAX_BODY_BYTES) {
        await reader.cancel().catch(() => {});
        fail('BODY_TOO_LARGE', '请求过大 / Request too large', 413);
      }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(received);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  let args;
  try { args = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); }
  catch { fail('INVALID_JSON', '请求内容无效 / Invalid JSON', 400); }
  if (!args || typeof args !== 'object' || Array.isArray(args) || typeof args.action !== 'string' || args.action.length > 80) fail('INVALID_REQUEST', '请求操作无效 / Invalid action', 400);
  return args;
}

/** A single bounded bucket; never trusts X-Forwarded-For or a client user ID. */
export class AuthThrottle {
  constructor({ now = Date.now, limit = 15, windowMs = 60_000 } = {}) {
    this.now = now; this.limit = limit; this.windowMs = windowMs;
    this.start = now(); this.count = 0;
  }
  admit() {
    const now = this.now();
    if (now < this.start || now - this.start >= this.windowMs) { this.start = now; this.count = 0; }
    this.count += 1;
    if (this.count > this.limit) fail('AUTH_RATE_LIMIT', '登录尝试过于频繁，请稍后重试 / Too many sign-in attempts', 429);
  }
}

/**
 * Caller MUST mount this with connection.fetch (owner-only exact-route admission).
 * Never mount it through an unauthenticated webServer.register route. No CORS.
 */
/**
 * The Desktop app renders its UI from the `dsh-app://` scheme instead of the
 * Host's http origin. That page can only reach this route through a cross-origin
 * request, so it needs the CORS handshake — and it is still admitted only with
 * the plugin's own session token, exactly like a same-origin browser page.
 */
const DESKTOP_ORIGIN = /^dsh-app:\/\/[A-Za-z0-9._-]+$/;
const corsHeaders = origin => ({
  'Access-Control-Allow-Origin': origin,
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'content-type, authorization, x-lan-csrf, x-lan-owner-setup',
  'Access-Control-Max-Age': '600',
  Vary: 'Origin',
});

export function createRequestHandler(service, { origin, now = Date.now, onUnexpectedError = () => {}, allowOwnerRecovery = false } = {}) {
  const trustedOrigin = new URL(origin).origin;
  const throttle = new AuthThrottle({ now });
  const cookieMode = typeof service.restoreLogin === 'function';
  const cookieName = loginCookieName(trustedOrigin, 'owner');
  const handle = async request => {
    try {
      const requestOrigin = request.headers.get('origin');
      const desktop = typeof requestOrigin === 'string' && DESKTOP_ORIGIN.test(requestOrigin);
      if (request.method === 'OPTIONS') {
        if (requestOrigin !== trustedOrigin && !desktop) fail('ORIGIN_DENIED', '请求来源不受信任 / Untrusted request origin', 403);
        return new Response(null, { status: 204, headers: { ...RESPONSE_HEADERS, ...corsHeaders(requestOrigin) } });
      }
      if (request.method !== 'POST') fail('METHOD_NOT_ALLOWED', '仅支持 POST / POST required', 405);
      if (request.signal.aborted) fail('ABORTED', '请求已取消 / Request cancelled', 499);
      // Request.url uses http://dsh.internal in DSH's bridge. Compare against the
      // configured carrier origin, NOT that synthetic URL or forwarded headers.
      if (requestOrigin !== trustedOrigin && !desktop) fail('ORIGIN_DENIED', '请求来源不受信任 / Untrusted request origin', 403);
      const site = request.headers.get('sec-fetch-site');
      if (!desktop && site !== null && site !== 'same-origin') fail('ORIGIN_DENIED', '仅接受同源请求 / Same-origin request required', 403);
      const args = await readJson(request);
      // Only the original, authenticated DSH connection route opts into this.
      // The Desktop/member ingress must never derive owner authority from Origin.
      if (args.action === 'owner.recoverAdministrator' && (!allowOwnerRecovery || desktop)) fail('OWNER_REQUIRED', '请通过原生 DSH 宿主网页恢复管理员 / Use the authenticated native DSH owner page', 403);
      if (AUTH_ACTIONS.has(args.action) || args.action === 'owner.recoverAdministrator') throttle.admit();
      // A desktop window cannot keep the owner cookie (its origin is `dsh-app://`),
      // so it signs in with a bearer session returned in the body instead.
      const cookieSession = cookieMode && !desktop;
      // A desktop window keeps no cookie: it presents the bearer session it stored
      // in its own window, and the facade only revalidates it here.
      if (desktop && args.action === 'auth.restore') {
        if (Object.keys(args).length !== 1) fail('INVALID_REQUEST', 'Invalid login restoration request', 400);
        const header = request.headers.get('authorization');
        const match = header === null ? null : /^Bearer ([A-Za-z0-9_-]{32,256})$/.exec(header);
        if (!match) fail('UNAUTHENTICATED', '请先登录 / Sign in required', 401);
        const restored = await service.execute({ action: 'me' }, { token: match[1], ...(cookieMode ? { audience: 'owner' } : {}) });
        return reply({ ok: true, result: { ...restored, token: match[1], cookieSession: false } });
      }
      if (cookieSession && args.action === 'auth.restore') {
        if (Object.keys(args).length !== 1) fail('INVALID_REQUEST', 'Invalid login restoration request', 400);
        const credential = readLoginCookie(request.headers, cookieName);
        if (!credential) fail('UNAUTHENTICATED', 'Sign in required', 401);
        const result = await service.restoreLogin(credential, 'owner');
        return reply({ ok: true, result: { ...result, cookieSession: true } });
      }
      const authorization = request.headers.get('authorization');
      let token;
      if (authorization !== null) {
        const match = /^Bearer ([A-Za-z0-9_-]{32,256})$/.exec(authorization);
        if (!match) fail('UNAUTHENTICATED', '登录凭证无效 / Invalid session credential', 401);
        token = match[1];
      }
      if (cookieSession && !token) token = readLoginCookie(request.headers, cookieName) ?? undefined;
      if (!PUBLIC_ACTIONS.has(args.action) && !token) fail('UNAUTHENTICATED', '请先登录 / Sign in required', 401);
      const csrf = request.headers.get('x-lan-csrf') || undefined;
      if (csrf !== undefined && (!/^[A-Za-z0-9_-]{32,256}$/.test(csrf))) fail('CSRF_DENIED', '操作验证失败 / Invalid action verification', 403);
      const ownerSetup = ['bootstrap', 'owner.recoverAdministrator'].includes(args.action);
      if (ownerSetup && request.headers.get('x-lan-owner-setup') !== 'confirm') fail('OWNER_CONFIRMATION_REQUIRED', '请在原生 DSH 宿主界面确认此操作 / Confirm in the native DSH owner UI', 403);
      const result = await service.execute(args, { token, csrf, ownerBootstrap: ownerSetup, ...(cookieMode ? { audience: 'owner' } : {}) });
      if (cookieMode && AUTH_ACTIONS.has(args.action)) {
        if (desktop) return reply({ ok: true, result: { ...publicLogin(result), token: result.token, cookieSession: false } });
        const cookie = loginCookie({ origin: trustedOrigin, audience: 'owner', token: result.token, remember: result.remember ?? args.remember ?? true });
        return reply({ ok: true, result: publicLogin(result) }, 200, { 'set-cookie': cookie });
      }
      if (cookieMode && ['logout', 'password.change'].includes(args.action)) return reply({ ok: true, result }, 200, { 'set-cookie': loginCookie({ origin: trustedOrigin, audience: 'owner', expired: true }) });
      return reply({ ok: true, result });
    } catch (error) {
      const expected = error instanceof HttpFailure || (error?.name === 'LanError' && /^[A-Z][A-Z0-9_]{1,79}$/.test(error.code || '') && Number.isInteger(error.status) && error.status >= 400 && error.status <= 599);
      if (!expected) { try { onUnexpectedError(error); } catch {} }
      return reply({ ok: false, error: {
        code: expected ? error.code : 'INTERNAL_ERROR',
        message: expected ? error.message : '服务操作失败，请稍后重试 / Service operation failed',
      } }, expected ? error.status : 500);
    }
  };
  return async request => {
    const response = await handle(request);
    const requestOrigin = request.headers.get('origin');
    if (typeof requestOrigin !== 'string' || !DESKTOP_ORIGIN.test(requestOrigin)) return response;
    const headers = new Headers(response.headers);
    for (const [name, value] of Object.entries(corsHeaders(requestOrigin))) headers.set(name, value);
    return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
  };
}
