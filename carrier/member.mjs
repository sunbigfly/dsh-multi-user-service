import { createRequire } from 'node:module';
import { open, realpath, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve, relative, isAbsolute, extname, posix } from 'node:path';
import { once } from 'node:events';
import { ADMINISTRATOR_DESKTOP_FETCH } from './desktop.mjs';
import { createMemberMux } from './mux.mjs';
import { memberLoginDocument, LOGIN_CSP } from './login-document.mjs';
import { mountAdministratorEntry } from './administrator-entry.mjs';
import { assertServicePluginChange, servicePluginInventory } from './plugin-management.mjs';
import { memberBootRows, memberClientGraph, isBootRow, renderMemberIndexInjections } from './member-boot.mjs';
import { memberPath, memberSessionCwd, memberSettingsChangeAllowed } from './access.mjs';
import { createMemberWorkspace, listMemberDirectory, listMemberWorkspaces, nextSessionDirectory, readArchivedSessions, renameMemberWorkspace, setMemberSessionArchived } from './workspaces.mjs';

const AUTH_BYTES = 32 * 1024, FACADE_BYTES = 192 * 1024, REQUEST_BYTES = 1024 * 1024, RESPONSE_BYTES = 16 * 1024 * 1024;
const IO_TIMEOUT_MS = 15_000;
const PENDING_CWD_MS = 60_000;
const SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const MIME = Object.freeze({ '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.webp': 'image/webp', '.ico': 'image/x-icon', '.woff': 'font/woff', '.woff2': 'font/woff2', '.json': 'application/json', '.webmanifest': 'application/manifest+json' });
const PRIVATE_HEADERS = Object.freeze({ 'cache-control': 'no-store, private', 'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer' });
const bad = (code, message, status = 400) => { throw Object.assign(new Error(message), { name: 'MemberCarrierError', code, status }); };
const json = (result, status = 200, headers = {}) => new Response(JSON.stringify(result), { status, headers: { ...PRIVATE_HEADERS, 'content-type': 'application/json; charset=utf-8', ...headers } });
const ok = (result, headers) => json({ ok: true, result }, 200, headers);
function errorResponse(error) {
  const known = ['MemberAuthError', 'MemberCarrierError', 'LanError', 'RuntimeError'].includes(error?.name) && /^[A-Z][A-Z0-9_]{1,79}$/.test(error.code ?? '') && Number.isInteger(error.status) && error.status >= 400 && error.status <= 599;
  return json({ ok: false, error: { code: known ? error.code : 'INTERNAL_ERROR', message: known ? error.message : 'Member request failed' } }, known ? error.status : 500);
}
async function withTimeout(promise, ms = IO_TIMEOUT_MS) {
  let timer;
  try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(Object.assign(new Error('Member I/O timed out'), { name: 'MemberCarrierError', code: 'REQUEST_TIMEOUT', status: 408 })), ms); timer.unref?.(); })]); }
  finally { clearTimeout(timer); }
}
async function bodyBytes(request, max) {
  const length = request.headers.get('content-length');
  if (length !== null && (!/^\d+$/.test(length) || Number(length) > max)) bad('BODY_TOO_LARGE', 'Member request is too large', 413);
  if (!request.body) return new Uint8Array();
  const reader = request.body.getReader(), chunks = [], deadline = Date.now() + IO_TIMEOUT_MS;
  let bytes = 0;
  try {
    for (;;) {
      const next = await withTimeout(reader.read(), Math.max(1, deadline - Date.now()));
      if (next.done) break;
      bytes += next.value.byteLength;
      if (bytes > max) bad('BODY_TOO_LARGE', 'Member request is too large', 413);
      chunks.push(next.value);
    }
  } catch (error) { void reader.cancel().catch(() => {}); throw error; }
  finally { reader.releaseLock(); }
  return Buffer.concat(chunks, bytes);
}
async function authFields(request) {
  if (!/^application\/json(?:\s*;\s*charset=utf-8)?\s*$/i.test(request.headers.get('content-type') ?? '')) bad('CONTENT_TYPE', 'JSON content type required', 415);
  let fields;
  try { fields = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(await bodyBytes(request, AUTH_BYTES))); }
  catch (error) { if (error?.name === 'MemberCarrierError') throw error; bad('INVALID_JSON', 'Invalid member sign-in document'); }
  if (!fields || typeof fields !== 'object' || Array.isArray(fields)) bad('INVALID_REQUEST', 'Invalid member sign-in fields');
  const allowed = fields.action === 'login' ? ['action', 'username', 'password', 'remember'] : fields.action === 'redeem' ? ['action', 'username', 'password', 'displayName', 'inviteToken', 'remember'] : fields.action === 'logout' ? ['action'] : null;
  if (!allowed) bad('FORBIDDEN', 'Member access requires login or an administrator invitation', 403);
  if (Object.keys(fields).some(key => !allowed.includes(key))) bad('INVALID_REQUEST', 'Unexpected member sign-in field');
  return fields;
}
function pathOf(request, origin) {
  const url = new URL(request.url);
  if (url.origin !== origin || url.username || url.password) bad('HOST_DENIED', 'Untrusted member URL', 403);
  if (url.pathname !== '/lan' && !url.pathname.startsWith('/lan/')) bad('NOT_FOUND', 'Unknown member route', 404);
  if (/%|\\|\/\//.test(url.pathname) || url.pathname.split('/').some(part => part === '.' || part === '..')) bad('INVALID_PATH', 'Invalid member route');
  // Never consume an owner launch token, bearer credential, or a query CSRF token.
  for (const key of url.searchParams.keys()) if (/^(?:token|authorization|csrf|ownerToken)$/i.test(key)) bad('URL_CREDENTIAL_DENIED', 'URL credentials are not accepted', 403);
  return url;
}
function canonical(request, url, body) {
  const headers = new Headers(request.headers);
  for (const key of ['authorization', 'cookie', 'proxy-authorization', 'connection', 'upgrade', 'x-lan-owner-setup', 'x-forwarded-host', 'x-forwarded-proto', 'forwarded', 'content-length']) headers.delete(key);
  const target = new URL(url.pathname.slice('/lan'.length) + url.search, 'http://dsh.internal');
  return new Request(target, { method: request.method, headers, signal: request.signal, ...(body === undefined ? {} : { body }) });
}
async function readContained(root, name, max = RESPONSE_BYTES) {
  const lexical = resolve(root, name);
  const contained = target => { const rel = relative(root, target); return rel !== '' && rel !== '..' && !rel.startsWith('..\\') && !rel.startsWith('../') && !isAbsolute(rel); };
  if (!contained(lexical)) bad('STATIC_DENIED', 'Static resource outside frontend', 403);
  let target;
  try { target = await realpath(lexical); }
  catch (error) { if (['ENOENT', 'ENOTDIR'].includes(error.code)) bad('NOT_FOUND', 'Static resource not found', 404); throw error; }
  if (!contained(target)) bad('STATIC_DENIED', 'Static resource outside frontend', 403);
  const file = await open(target, 'r');
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.size > max) bad('STATIC_DENIED', 'Static resource unavailable', 403);
    // Bounded descriptor reads also handle a file growing after stat().
    const chunks = []; let bytes = 0;
    for (;;) {
      const chunk = Buffer.alloc(Math.min(64 * 1024, max + 1 - bytes));
      const read = await file.read(chunk, 0, chunk.length, null);
      if (!read.bytesRead) break;
      bytes += read.bytesRead;
      if (bytes > max) bad('STATIC_DENIED', 'Static resource unavailable', 403);
      chunks.push(chunk.subarray(0, read.bytesRead));
    }
    return Buffer.concat(chunks, bytes);
  } finally { await file.close(); }
}
/** True unless `candidate` exists and its real path leaves the real `home`; a
 * link inside the home must not hand out a Host file on the owner's authority. */
async function realInside(home, candidate) {
  let realHome, realTarget;
  try { realHome = memberPath(await realpath(home)); } catch { return false; }
  try { realTarget = memberPath(await realpath(candidate)); } catch (error) { return ['ENOENT', 'ENOTDIR'].includes(error?.code); }
  return realHome !== null && realTarget !== null && (realTarget === realHome || realTarget.startsWith(`${realHome}/`));
}
function serialized(value) { return JSON.stringify(value).replace(/</g, '\\u003c').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029'); }
/** Member-local transport hook, before the deferred module executes. No ownsHost. */
function memberScript(user, csrf, baseline, administrator = false) {
  // The CSRF token belongs to the member session, and every sign-in rotates it.
  // A page kept open across another sign-in (a second tab, a password reset)
  // would otherwise send a stale token and every request would fail; this hook
  // refreshes the token once and replays the request.
  const hook = `(()=>{const original=window.fetch.bind(window);const refresh=async()=>{const response=await original(new Request('/lan/auth/session',{credentials:'same-origin'}));const body=await response.clone().json().catch(()=>null);const next=body?.result?.csrf;if(typeof next==='string'&&next!=='')window.__DSH_LAN_MEMBER__.csrf=next;return typeof next==='string'&&next!=='';};const send=(input,init)=>{const request=new Request(input instanceof Request?input:new URL(input,document.baseURI),init);const url=new URL(request.url);if(url.origin!==location.origin||!(url.pathname.startsWith('/lan/api/')||url.pathname==='/lan/auth'))return Promise.reject(new Error('Member transport target denied'));if(['GET','HEAD'].includes(request.method))return original(request);const headers=new Headers(request.headers);headers.set('X-Lan-CSRF',window.__DSH_LAN_MEMBER__.csrf);return original(new Request(request.clone(),{headers}));};const previous=window.__DSH_TRANSPORT__||{};window.__DSH_TRANSPORT__={...previous,fetch:async(input,init)=>{const response=await send(input,init);if(response.status!==403)return response;const body=await response.clone().json().catch(()=>null);if(body?.error?.code!=='CSRF_INVALID')return response;if(!(await refresh().catch(()=>false)))return response;return send(input,init);}};window.__DSH_FILE_UPLOAD__={fetch:(input,init)=>{const url=new URL(input,document.baseURI);if(url.origin!==location.origin||url.pathname!=='/lan/api/session/uploadFileBinary')return Promise.reject(new Error('Member upload target denied'));return window.__DSH_TRANSPORT__.fetch(url.href,init);}};const HIDE=/(添加工作区|Add workspace)/;const STYLE='.lan-member-hidden{display:none!important}.lan-member-silent{visibility:hidden!important}.lan-member-autoselect [role=menu],.lan-member-autoselect [role=listbox],.lan-member-autoselect [data-radix-popper-content-wrapper]{visibility:hidden!important}';const hide=el=>{if(el.classList.contains('lan-member-hidden'))return;el.classList.add('lan-member-hidden');el.setAttribute('aria-hidden','true');el.setAttribute('tabindex','-1');};const buttons=()=>[...document.querySelectorAll('button,[role=button]')];const workspaceTrigger=()=>buttons().find(el=>(el.textContent||'').trim().startsWith('选择工作区'));const sweep=()=>{const asking=Boolean(workspaceTrigger());for(const el of document.querySelectorAll('[role=button],button,a')){const label=el.getAttribute('aria-label')||'';const text=(el.textContent||'').trim();const chip=!asking&&el.getAttribute('aria-haspopup')==='menu'&&!/的操作/.test(label)&&text!=='选择工作区'&&text.endsWith('工作区');if(HIDE.test(label)||HIDE.test(text)||chip)hide(el);}};const press=el=>{const r=el.getBoundingClientRect();const o={bubbles:true,cancelable:true,clientX:r.left+r.width/2,clientY:r.top+r.height/2,pointerId:1,pointerType:'mouse',isPrimary:true,button:0};el.dispatchEvent(new PointerEvent('pointerdown',o));el.dispatchEvent(new MouseEvent('mousedown',o));el.dispatchEvent(new PointerEvent('pointerup',o));el.dispatchEvent(new MouseEvent('mouseup',o));el.dispatchEvent(new MouseEvent('click',o));};const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));let busy=false;const autoSelect=async()=>{if(busy||window.__DSH_LAN_ADMIN_PREVIEW__)return;const trigger=workspaceTrigger();if(!trigger||trigger.classList.contains('lan-member-hidden'))return;busy=true;const root=document.documentElement;root.classList.add('lan-member-autoselect');trigger.classList.add('lan-member-silent');try{press(trigger);await wait(500);const items=[...document.querySelectorAll('[role=menuitem]')].filter(el=>el.offsetParent!==null&&!el.classList.contains('lan-member-hidden'));if(items.length===1&&!window.__DSH_LAN_ADMIN_PREVIEW__){press(items[0]);await wait(900);}else{press(trigger);}}finally{busy=false;setTimeout(()=>{root.classList.remove('lan-member-autoselect');trigger.classList.remove('lan-member-silent');},1100);}};const start=()=>{const root=document.body||document.documentElement;if(!root)return;if(!document.getElementById('lan-member-hidden-style')){const style=document.createElement('style');style.id='lan-member-hidden-style';style.textContent=STYLE;document.head?.appendChild(style);}let queued=false;const schedule=()=>{if(queued)return;queued=true;queueMicrotask(()=>{queued=false;sweep();void autoSelect();});};new MutationObserver(schedule).observe(root,{childList:true,subtree:true,characterData:true});schedule();};if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',start,{once:true});else start();})();`;
  return `<script>window.__DSH_REMOTE_ACCESS__=${serialized(baseline)};window.__DSH_LAN_MEMBER__=${serialized({ user, csrf, ...(administrator ? { adminEntry: true } : {}) })};${hook}</script>`;
}

/**
 * Dependency-light Fetch factory. It does not listen, claim a fallback, register
 * an RPC handler, use owner admission, or mutate the owner's index injection.
 * onAction receives ONLY the exact plugin facade, never arbitrary stock paths.
 *
 * Stock RPC goes through the shared `/api` channel with the member Peer, so the
 * stock gateway and `ctx.remoteAccess` — not this transport — decide every
 * resource; this carrier only rewrites the path and pins `session/create` into
 * the member home. `memberRoot(userId)` resolves that home and `ownership`
 * records what a successful create produced.
 */
export async function createMemberCarrier(ctx, { auth, frontendDist, memberOrigin, onAction, onOwnerAction, onDesktop, memberRoot, ownership, attachmentAccess, models, capabilities, previews, streams, brandingSnapshot = () => null } = {}) {
  const origin = new URL(memberOrigin).origin;
  if (origin !== memberOrigin || auth?.origin !== origin || new URL(origin).hostname === new URL(ctx.webServer.getOrigin()).hostname) throw new TypeError('A fixed distinct member hostname is required');
  const require = createRequire(import.meta.url);
  frontendDist ??= resolve(dirname(require.resolve('@deepseek-ai/dsh-web-frontend/package.json')), 'dist');
  const root = await realpath(frontendDist);
  const rawHtml = (await readContained(root, 'index.html')).toString('utf8');
  // One stock shared-channel handler for the whole `/api` surface. The member
  // Peer is passed through; an owner principal is never published to a member.
  const api = ctx.connection.createSharedFetchHandler('/api');
  const peers = new Map(), pendingCwds = new Map();
  let closed = false;
  async function memberPeer(current, headers) {
    if (closed) bad('MEMBER_SERVICE_CLOSED', 'Member carrier stopped', 503);
    let entry = peers.get(current.key);
    if (!entry) {
      entry = Promise.resolve().then(async () => {
        const principal = { kind: 'lan-member', userId: current.user.id, sessionId: current.key };
        const peer = ctx.connection.createPeer({ principal, interactions: 'answer' });
        try {
          await auth.attachPeer(current, peer);
          const fresh = await auth.authenticate(headers);
          if (closed || fresh.key !== current.key || fresh.user.id !== principal.userId || peer.signal.aborted) bad('UNAUTHENTICATED', 'Member session expired', 401);
          return peer;
        } catch (error) { await peer.dispose(); throw error; }
      });
      peers.set(current.key, entry);
      entry.then(peer => { peer.signal.addEventListener('abort', () => { if (peers.get(current.key) === entry) peers.delete(current.key); }, { once: true }); }, () => { if (peers.get(current.key) === entry) peers.delete(current.key); });
    }
    const peer = await entry;
    if (peer.signal.aborted) bad('UNAUTHENTICATED', 'Member session expired', 401);
    return peer;
  }
  const recordOwnership = async entry => {
    if (typeof ownership?.record !== 'function') return;
    try { await ownership.record(entry); } catch { return; /* Unrecorded resources stay denied by the policy. */ }
    // The page places a Session by the Workspace row that lists it; without
    // this upsert a new conversation sits ungrouped and asks for a workspace.
    try { await announceWorkspace(entry.userId, entry.projectId); } catch { /* the next baseline carries it */ }
  };
  // Members never see the Host workspace registry: these are the member's own
  // project directories, and open follow streams learn about changes here.
  // Streams are keyed by member so one member's rows never reach another.
  const workspaceListeners = new Map();
  const memberRows = async current => listMemberWorkspaces({
    home: await memberHome(current),
    userId: current.user.id,
    sessions: typeof ownership?.entriesOf === 'function' ? ownership.entriesOf(current.user.id) : [],
  });
  const notifyWorkspaces = (userId, frame) => { for (const listener of workspaceListeners.get(userId) ?? []) { try { listener(frame); } catch { /* one dropped listener must not stop the rest */ } } };
  const disposeAdminArchive = ctx.on?.('lan-workspace/archives-changed', (userId, archivedSessionIds) => notifyWorkspaces(userId, { type: 'archived', archivedSessionIds }));
  async function announceWorkspace(userId, projectId) {
    if (!workspaceListeners.has(userId)) return;
    const current = { user: { id: userId } };
    const hidden = new Set(await readArchivedSessions({ home: await memberHome(current) }));
    const row = (await memberRows(current)).find(candidate => posix.basename(candidate.path) === projectId);
    if (row !== undefined) notifyWorkspaces(userId, { type: 'upsert', workspace: { ...row, sessionIds: row.sessionIds.filter(id => !hidden.has(id)) } });
  }
  async function memberWorkspaceStream(current) {
    // The member's archive is its own file (the Host registry is owner-scoped),
    // and the baseline carries it so archived conversations stay out of the way:
    // the archived ids are also removed from every Workspace's Session list.
    const archivedSessionIds = await readArchivedSessions({ home: await memberHome(current) });
    const hidden = new Set(archivedSessionIds);
    const items = (await memberRows(current)).map(row => ({ ...row, sessionIds: row.sessionIds.filter(id => !hidden.has(id)) }));
    const queue = [];
    let wake = null;
    const listener = frame => { queue.push(frame); const resume = wake; wake = null; resume?.(); };
    const userId = current.user.id;
    return (async function* follow() {
      if (!workspaceListeners.has(userId)) workspaceListeners.set(userId, new Set());
      workspaceListeners.get(userId).add(listener);
      try {
        yield { type: 'baseline', value: { items, archivedSessionIds, pinnedSessionIds: [] } };
        for (;;) {
          if (queue.length === 0) await new Promise(resolve => { wake = resolve; });
          const frame = queue.shift();
          if (frame !== undefined) yield frame;
        }
      } finally {
        const listeners = workspaceListeners.get(userId);
        listeners?.delete(listener);
        if (listeners?.size === 0) workspaceListeners.delete(userId);
      }
    })();
  }
  const envelopeOf = payload => {
    try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(payload ?? new Uint8Array())); } catch { return undefined; }
  };
  // One-time bootstrap: a member's first visit opens a Session in the default
  // project so the page has somewhere to type. Later visits keep the member's
  // own Sessions untouched.
  async function ensureMemberSession(current, peer) {
    if (typeof ownership?.sessionIdsOf !== 'function') return;
    // Archived conversations do not count: the page needs one Session it can
    // actually open, otherwise it starts on an empty draft that asks for a
    // workspace the member does not have to choose.
    const archived = new Set(await readArchivedSessions({ home: await memberHome(current) }));
    const visible = ownership.sessionIdsOf(current.user.id).filter(id => !archived.has(id));
    if (visible.length > 0) return;
    const decided = memberSessionCwd({ memberRoot: await memberHome(current), requested: undefined });
    if (decided === null) return;
    const target = new URL('/api/session/create', origin);
    const cwd = await nextSessionDirectory({ projectPath: decided.cwd }).catch(() => null) ?? decided.cwd;
    let agentPreset;
    try { agentPreset = await capabilities?.chooseAgentPreset?.(current.user.id); } catch { return; }
    // Claim the first conversation before DSH creates its Agent, just as the
    // normal session/create path does. Otherwise the factory cannot recognize
    // the member or retain the native handle needed for later revocation.
    if (typeof ownership.reserve !== 'function') return;
    try { ownership.reserve({ userId: current.user.id, projectId: decided.projectId, cwd }); }
    catch { return; }
    if (ownership.bindingForCwd?.(cwd)?.userId !== current.user.id) return;
    const body = JSON.stringify({ type: 'client-request', method: 'session/create', rpcId: 'lan-member-bootstrap', payload: { args: { request: { cwd, ...(agentPreset === undefined ? {} : { agentPreset }) } } } });
    const response = await api.fetch(new Request(target, { method: 'POST', headers: { 'content-type': 'application/json' }, body }), peer);
    if (!response.ok) return;
    let sessionId;
    try { sessionId = JSON.parse(await response.text())?.result?.value?.sessionId; } catch { sessionId = undefined; }
    if (typeof sessionId !== 'string' || !SESSION_ID.test(sessionId)) return;
    await recordOwnership({ userId: current.user.id, sessionId, projectId: decided.projectId, cwd });
    invalidate(peer?.principal);
  }
  const invalidate = principal => { try { ctx.remoteAccess.invalidate(principal); } catch { /* Invalidation is advisory. */ } };
  async function memberHome(current) {
    let home;
    if (typeof memberRoot === 'function') {
      try { home = await memberRoot(current.user.id); } catch { home = null; }
    }
    // The Host composes this path with `posix.join` on every platform, so a
    // Windows drive root is normal to forward slashes here instead of failing
    // the POSIX absolute check.
    const normalized = memberPath(home);
    if (normalized === null) bad('MEMBER_HOME_UNAVAILABLE', 'Member home directory is unavailable', 503);
    return normalized;
  }
  // A forwarded create is bound the moment the Host announces it, matched by
  // the cwd this carrier forced on the request. Binding only after the response
  // is too late: the live Session-list frame for the new Session is filtered by
  // the policy before then, and the page never learns the Session's directory.
  const removeSessionCreated = typeof ownership?.record === 'function' && typeof ctx.on === 'function'
    ? ctx.on('session/created', session => {
        const cwd = session?.header?.cwd;
        const pending = typeof cwd === 'string' ? pendingCwds.get(cwd) : undefined;
        if (!pending) return;
        pendingCwds.delete(cwd);
        // `record` updates the in-memory map synchronously; persistence follows.
        void recordOwnership({ userId: pending.userId, sessionId: session.id, projectId: pending.projectId, cwd });
        invalidate();
      }, { global: true })
    : undefined;
  const streamsOf = () => streams ?? ctx.typertGateway?.wireStream;
  // The native preview service permits reads outside its Session's cwd. Check
  // the wire scope and both path forms before entering that service.
  async function authorizeWorkspaceFile(userId, args, principal) {
    const entry = ownership?.entriesOf(userId).find(item => item.sessionId === args?.workspaceFileScopeId);
    const previewRoot = previews?.fileRoot(principal, args?.workspaceFileScopeId);
    // A file preview can reuse this login's current native Session. Its file
    // tree still requests that Session's cwd, while the document tab requests
    // the explicitly leased member path. Preserve both read scopes.
    const root = memberPath(entry?.cwd ?? previewRoot);
    if (!root || typeof args?.path !== 'string' || args.path.includes('\0')) bad('MEMBER_FILE_DENIED', 'Member files require an owned conversation workspace', 403);
    const roots = [root, ...(previewRoot ? [memberPath(previewRoot)] : (capabilities?.directories?.(userId) ?? []).map(row => row.path))].filter(Boolean).sort((a, b) => b.length - a.length);
    const inside = async path => {
      const normalized = path.replaceAll('\\', '/');
      if (/^[a-z][a-z\d+.-]*:/i.test(normalized) || normalized.includes('\0')) return null;
      const candidate = posix.resolve(root, normalized);
      const allowed = roots.find(path => candidate === path || candidate.startsWith(path + '/'));
      return allowed && await realInside(allowed, candidate) ? candidate : null;
    };
    let target = args.path;
    if (args.options?.baseFile !== undefined) {
      if (typeof args.options.baseFile !== 'string') bad('MEMBER_FILE_DENIED', 'Invalid member file base', 403);
      const base = await inside(args.options.baseFile);
      if (!base) bad('MEMBER_FILE_DENIED', 'Member file base is outside this conversation', 403);
      let canonicalBase;
      try { canonicalBase = await realpath(base); } catch { bad('MEMBER_FILE_DENIED', 'Member file base is unavailable', 403); }
      target = posix.resolve(posix.dirname(canonicalBase), target.replaceAll('\\', '/'));
    }
    if (!await inside(target)) bad('MEMBER_FILE_DENIED', 'Member files are limited to this conversation workspace', 403);
  }
  // Catalog reads a member legitimately needs: the model list, the provider
  // catalog, the agent presets and the permission catalog describe the Host
  // installation, never a person's data. They are answered for the member on the
  // Host's own authority; everything else still goes through the member Peer.
  const CATALOG_ENDPOINTS = new Set(['session/modelCatalog', 'agentPresets/list', 'permissionPresets/catalog', 'llm/listProviders', 'llm/listConfigurableProviders', 'llm/discoverModels', 'settings/describe']);
  // Host installation inventory: module names, versions and enabled state, no
  // configuration. Members consume it read-only; LAN administrators retain
  // the Host's actual management capability and use the native manager below.
  const INVENTORY_ENDPOINTS = new Set(['pluginInventory/list']);
  const ADMIN_PLUGIN_ENDPOINTS = new Set([
    'listBundles', 'listPlugins', 'registries', 'inspect',
    'setBundleEnabled', 'setPluginEnabled', 'installBundle',
    'waitForInstall', 'cancelInstall', 'removeBundle',
  ].map(method => `pluginManager/${method}`));
  // Scheduled tasks live in one Host table and are answered on the Host's
  // authority, but every task names the Session it prompts. A member only ever
  // reaches the tasks of its own Sessions: calls naming a Session are refused
  // unless the member owns it, and the catalog is filtered down to those
  // Sessions. An owner task would otherwise let a member rewrite the prompt an
  // owner Agent runs with the full Host toolset.
  const HOST_SURFACE_ENDPOINTS = new Set([
    'schedule/catalog', 'schedule/changed', 'schedule/delete', 'schedule/history',
    'schedule/list', 'schedule/update',
  ]);
  const SCHEDULE_SESSION_ENDPOINTS = new Set(['schedule/delete', 'schedule/history', 'schedule/list', 'schedule/update']);
  // Members consume configured providers; provider administration stays on
  // the Host. Native UI preferences remain available to the member frontend.
  const MODEL_SETTINGS_ENDPOINTS = new Set(['settings/update', 'settings/mutate']);
  const ADMIN_CONFIGURATION_ENDPOINTS = new Set(['settings/describe', 'settings/update', 'settings/mutate', 'credentials/describe', 'credentials/set', 'credentials/unset', 'llm/listProviders', 'llm/listConfigurableProviders', 'llm/discoverModels']);
  // Workspace endpoints that only touch a member's own Session (archive, pin,
  // ordering). They are forwarded to the Host, never synthesized here.
  const FORWARDED_WORKSPACE_ENDPOINTS = new Set([
    'workspace/archiveSession', 'workspace/unarchiveSession',
    'workspace/pinSession', 'workspace/unpinSession',
    'workspace/insertSessionBefore', 'workspace/insertBefore',
    'workspace/renameSession',
  ]);
  let catalogPeer;
  const catalogAuthority = async () => {
    catalogPeer ??= ctx.connection.createPeer({ principal: { kind: 'owner' }, interactions: 'answer' });
    return catalogPeer;
  };
  // The Host's current value of one settings namespace, read on its authority.
  async function hostSettingsValue(ns) {
    const body = JSON.stringify({ type: 'client-request', method: 'settings/describe', rpcId: 'lan-member-settings', payload: { args: {} } });
    const response = await api.fetch(new Request(new URL('/api/settings/describe', origin), { method: 'POST', headers: { 'content-type': 'application/json' }, body }), await catalogAuthority());
    let view;
    try { view = JSON.parse(await response.text())?.result?.value?.namespaces?.find(entry => entry?.ns === ns); } catch { view = undefined; }
    if (!response.ok || view === undefined) bad('MEMBER_SETTINGS_DENIED', 'Model settings are unavailable', 403);
    return view.value;
  }
  // A stream source that reports its failure through the protocol: the first
  // next() rejects, so the mux sends one error frame and closes the stream.
  const failedStream = error => ({
    [Symbol.asyncIterator]() {
      return {
        next: () => Promise.reject(error),
        return: () => Promise.resolve({ done: true, value: undefined }),
      };
    },
  });

async function dispatchApi(request, url, endpoint, current, peer) {
    capabilities?.assertEndpoint(current.user.id, endpoint);
    if (endpoint === 'session/prompt' && models) models.assertAvailable(current.user.id);
    let sessionExport = false;
    if (endpoint === 'session.export') {
      const id = url.searchParams.get('sessionId');
      if (!['GET', 'HEAD'].includes(request.method) || ownership?.ownerOf(id) !== current.user.id) bad('MEMBER_EXPORT_DENIED', 'Members may only export their own sessions', 403);
      const access = capabilities?.policy(current.user.id);
      if (access && (!access.files || !access.attachments)) bad('MEMBER_CAPABILITY_DENIED', 'Session archives require file and attachment access', 403);
      if (url.searchParams.get('includeDescendants') === 'true') {
        const subagents = ctx.get?.('subagents');
        if (!subagents || access?.subagents === false) bad('MEMBER_EXPORT_DENIED', 'Subagent export is not available for this account', 403);
        const descendants = await subagents.listDescendants(id, request.signal);
        if (descendants.some(row => ownership.ownerOf(row.id) !== current.user.id)) bad('MEMBER_EXPORT_DENIED', 'Every exported subagent must belong to this account', 403);
      }
      sessionExport = true;
    }
    const target = new URL(url.href);
    target.pathname = `/api${url.pathname.slice('/lan/api'.length)}`;
    const mode = api.requestBodyMode({ method: request.method, url: target });
    let payload = mode === 'streaming' ? undefined : await bodyBytes(request, REQUEST_BYTES);
    let pending;
    const adminConfiguration = current.user.role === 'admin' && ADMIN_CONFIGURATION_ENDPOINTS.has(endpoint);
    const adminPlugins = current.user.role === 'admin' && ADMIN_PLUGIN_ENDPOINTS.has(endpoint);
    if (endpoint.startsWith('pluginManager/') && !adminPlugins) bad('MEMBER_PLUGIN_MANAGEMENT_DENIED', 'Plugin management requires an administrator', 403);
    if (adminPlugins) await assertServicePluginChange(ctx.pluginManager, endpoint, envelopeOf(payload)?.payload?.args);
    if (endpoint === 'llm/discoverModels' && !adminConfiguration) bad('MEMBER_SETTINGS_DENIED', 'Provider discovery requires Host administration', 403);
    if (endpoint.startsWith('workspaceFiles/')) await authorizeWorkspaceFile(current.user.id, envelopeOf(payload)?.payload?.args, peer?.principal);
    if (endpoint === 'directoryPicker/pick') {
      // Members have a fixed project layout: the Host hands each member one
      // workspace and every new conversation gets its own folder by itself, so
      // the folder chooser has nothing to offer. Answering `null` is the stock
      // "operator cancelled" result.
      let rpcId;
      try { rpcId = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(payload ?? new Uint8Array()))?.rpcId; } catch { rpcId = undefined; }
      return json({ type: 'server-response', rpcId, result: { ok: true, value: null } });
    }
    if (endpoint.startsWith('workspace/') || endpoint === 'directoryPicker/list' || endpoint === 'directoryPicker/createDirectory') {
      const envelope = envelopeOf(payload);
      const rpcId = envelope?.rpcId;
      const args = envelope?.payload?.args;
      const request = args !== null && typeof args === 'object' && !Array.isArray(args) ? args : {};
      const currentUser = current.user.id;
      if (endpoint === 'workspace/follow') bad('MEMBER_ENDPOINT_DENIED', 'Member workspaces are streamed through the member transport', 403);
      if (endpoint === 'directoryPicker/list') {
        const listing = await listMemberDirectory({ home: await memberHome(current), requested: request.path });
        if (listing === null) bad('MEMBER_CWD_DENIED', 'Member directory listing is outside the member home', 403);
        return json({ type: 'server-response', rpcId, result: { ok: true, value: listing } });
      }
      if (endpoint === 'directoryPicker/createDirectory') {
        const target = typeof request.path === 'string' && typeof request.name === 'string' ? posix.join(request.path, request.name) : undefined;
        const listing = await listMemberDirectory({ home: await memberHome(current), requested: target });
        if (listing === null) bad('MEMBER_CWD_DENIED', 'Member directory creation is outside the member home', 403);
        return json({ type: 'server-response', rpcId, result: { ok: true, value: listing } });
      }
      if (endpoint === 'workspace/initializeDefault' || endpoint === 'workspace/create') {
        const home = await memberHome(current);
        const requested = endpoint === 'workspace/initializeDefault' ? undefined : request.path;
        const created = await createMemberWorkspace({ home, userId: currentUser, requested: requested === undefined ? posix.join(home, 'workspace') : requested, sessions: typeof ownership?.entriesOf === 'function' ? ownership.entriesOf(currentUser) : [] });
        if (created === null) bad('MEMBER_CWD_DENIED', 'Member workspace path is outside the member home', 403);
        if (created.created) notifyWorkspaces(currentUser, { type: 'upsert', workspace: created.workspace });
        return json({ type: 'server-response', rpcId, result: { ok: true, value: created } });
      }
      if (endpoint === 'workspace/rename') {
        const renamed = await renameMemberWorkspace({ home: await memberHome(current), userId: currentUser, workspaceId: request.workspaceId, title: request.title, sessions: typeof ownership?.entriesOf === 'function' ? ownership.entriesOf(currentUser) : [] });
        if (renamed === null) bad('MEMBER_CWD_DENIED', 'Member workspace rename is not available', 403);
        notifyWorkspaces(currentUser, { type: 'upsert', workspace: renamed.workspace });
        return json({ type: 'server-response', rpcId, result: { ok: true, value: renamed } });
      }
      if (endpoint === 'workspace/archiveSession' || endpoint === 'workspace/unarchiveSession') {
        // The archive set is the member's own file: the Host registry is
        // owner-scoped, and this is the only place the sidebar reads it from.
        const sessionId = request?.request?.sessionId ?? request.sessionId;
        const owner = typeof ownership?.ownerOf === 'function' ? ownership.ownerOf(sessionId) : undefined;
        if (owner !== currentUser) bad('MEMBER_SESSION_DENIED', 'Members may only archive their own sessions', 403);
        const home = await memberHome(current);
        const archivedSessionIds = await setMemberSessionArchived({ home, sessionId, archived: endpoint === 'workspace/archiveSession' });
        notifyWorkspaces(currentUser, { type: 'archived', archivedSessionIds });
        return json({ type: 'server-response', rpcId, result: { ok: true, value: { archivedSessionIds } } });
      }
      // Session bookkeeping lives in the Host registry but names a member's own
      // Session, so it is forwarded instead of answered here; the session-scoped
      // grant decides whether this member may touch that Session at all.
      if (!FORWARDED_WORKSPACE_ENDPOINTS.has(endpoint)) {
        // Registration-only operations have no member meaning: project
        // directories are the registry, so deleting one would delete files.
        bad('MEMBER_ENDPOINT_DENIED', 'This workspace operation is not available to members', 403);
      }
    }
    if (endpoint === 'session/create') {
      // Fail closed: the member home is only enforceable when this carrier can
      // read and rewrite the cwd, so a streaming or malformed body is refused
      // instead of reaching the stock gateway with an owner-chosen directory.
      if (payload === undefined) bad('MEMBER_CREATE_DENIED', 'Member session creation requires a JSON request body', 403);
      let envelope;
      try { envelope = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(payload)); } catch { envelope = undefined; }
      const args = envelope?.payload?.args;
      const field = args !== null && typeof args === 'object' && !Array.isArray(args) && Object.hasOwn(args, 'request') && args.request !== null && typeof args.request === 'object' && !Array.isArray(args.request) ? 'request' : null;
      if (field === null) bad('MEMBER_CREATE_DENIED', 'Member session creation request is not understood', 403);
      {
        const requestedId = args[field].workspaceId;
        const adopted = args[field].sessionId;
        let requested = args[field].cwd;
        if (requested === undefined && typeof requestedId === 'string') {
          // A member workspace id is derived from the member's own project
          // directory, so it resolves back to that directory and nowhere else.
          const rows = await memberRows(current);
          requested = rows.find(row => row.workspaceId === requestedId)?.path;
          if (requested === undefined) bad('MEMBER_CWD_DENIED', 'Member workspace is unknown', 403);
        }
        if (typeof adopted === 'string') {
          // Adopting a Session by id is only ever the member's own Session.
          const owner = typeof ownership?.ownerOf === 'function' ? ownership.ownerOf(adopted) : undefined;
          if (owner !== current.user.id) bad('MEMBER_CREATE_DENIED', 'Member session adoption is limited to the member own sessions', 403);
        }
        const decided = memberSessionCwd({ memberRoot: await memberHome(current), requested });
        if (decided === null) bad('MEMBER_CWD_DENIED', 'Member session directory is outside the member home', 403);
        // A brand-new conversation gets its own directory under the project, so
        // two conversations never see each other's files. Adoption of an
        // existing Session keeps that Session's own directory.
        let cwd = decided.cwd;
        if (typeof adopted === 'string') {
          const own = typeof ownership?.entriesOf === 'function'
            ? ownership.entriesOf(current.user.id).find(entry => entry.sessionId === adopted)
            : undefined;
          if (own?.cwd) cwd = own.cwd;
        } else {
          // A folder that cannot be made leaves the conversation in its project.
          cwd = await nextSessionDirectory({ projectPath: decided.cwd }).catch(() => null) ?? decided.cwd;
        }
        // `workspaceId` and `cwd` are exclusive: a member workspace is a member
        // directory, so the carrier forces the directory and drops the id the
        // Host registry has never heard of.
        const { workspaceId: _ignored, ...rest } = args[field];
        const agentPreset = await capabilities?.chooseAgentPreset?.(current.user.id, rest.agentPreset);
        args[field] = { ...rest, cwd, ...(agentPreset === undefined ? {} : { agentPreset }) };
        payload = Buffer.from(JSON.stringify(envelope), 'utf8');
        pending = { userId: current.user.id, projectId: decided.projectId, cwd };
        // The gateway may build the Agent for this create before the response
        // arrives, so the claimed directory is known to the ownership map first.
        try { ownership?.reserve?.(pending); } catch { /* Unclaimed directories stay denied. */ }
        // An adoption names an existing Session; only a fresh create is announced.
        if (typeof adopted !== 'string') pendingCwds.set(cwd, { ...pending, at: Date.now() });
      }
    }
    if (SCHEDULE_SESSION_ENDPOINTS.has(endpoint)) {
      const sessionId = envelopeOf(payload)?.payload?.args?.request?.sessionId;
      const owner = typeof ownership?.ownerOf === 'function' ? ownership.ownerOf(sessionId) : undefined;
      if (owner !== current.user.id) bad('MEMBER_SCHEDULE_DENIED', 'Members may only manage tasks of their own sessions', 403);
    }
    let modelSettings = false;
    if (MODEL_SETTINGS_ENDPOINTS.has(endpoint) && !adminConfiguration) {
      // The preview acknowledgement lives in `ui-*`; provider values and all
      // other Host configuration cannot be mutated through a member Peer.
      const envelope = envelopeOf(payload);
      const ns = envelope?.payload?.args?.ns;
      if (typeof ns !== 'string' || !/^ui(?:[-_.]|$)/.test(ns)) bad('MEMBER_SETTINGS_DENIED', 'Host settings require Host administration', 403);
      // Model settings are shared with the owner: an endpoint, header or
      // credential reference changed here would carry the Host's stored keys
      // to wherever the member points them. Those fields stay as they are.
      if (!memberSettingsChangeAllowed({ endpoint, args: envelope.payload.args, current: await hostSettingsValue(ns) })) bad('MEMBER_SETTINGS_DENIED', 'Members may not change model endpoints, headers or credentials', 403);
      modelSettings = true;
    }
    // Attachments: a member may upload and read back the files that member
    // uploaded. The Host route is owner-only, so the carrier answers on the
    // Host's authority while keeping every id in a member-scoped registry — an
    // id this member never uploaded stays invisible.
    let attachment = false;
    if (endpoint === 'session/uploadFileBinary') {
      // An upload is only ever against the member's own Session; the target URL
      // keeps its query, so the session identity is read from there.
      const sessionId = target.searchParams.get('sessionId');
      const owner = typeof ownership?.ownerOf === 'function' ? ownership.ownerOf(sessionId) : undefined;
      if (owner !== current.user.id) bad('MEMBER_UPLOAD_DENIED', 'Members may only upload into their own session', 403);
      attachment = true;
    }
    if (endpoint === 'file') {
      // `/api/file?path=<absolute>` reads through the Host filesystem. A member
      // may only read the attachment store (its own uploads live there) and its
      // own project directory — never an arbitrary Host path.
      const raw = target.searchParams.get('path');
      // The Host resolves `..` itself, so `<store>/../../secret` would pass a
      // lexical prefix check and read any Host file on the owner's authority.
      if (typeof raw !== 'string' || raw.replaceAll('\\', '/').split('/').includes('..')) bad('MEMBER_FILE_DENIED', 'Members may only read their own attachments', 403);
      const candidate = memberPath(raw);
      const home = await memberHome(current);
      const store = ctx.get?.('attachments');
      const inStore = candidate !== null && attachmentAccess?.allows(current.user.id, candidate, store?.fileHostPath?.bind(store)) === true;
      const inHome = candidate !== null && (candidate === home || candidate.startsWith(`${home}/`)) && await realInside(home, candidate);
      const shared = (capabilities?.directories?.(current.user.id) ?? []).find(row => candidate !== null && (candidate === row.path || candidate.startsWith(row.path + '/')));
      const inShared = shared && await realInside(shared.path, candidate);
      if (capabilities) {
        const access = capabilities.policy(current.user.id);
        if (inStore && !access.attachments || (inHome || inShared) && !access.files) bad('MEMBER_CAPABILITY_DENIED', 'File access is disabled for this account', 403);
      }
      if (!inStore && !inHome && !inShared) bad('MEMBER_FILE_DENIED', 'Members may only read their own attachments and authorized files', 403);
      attachment = true;
    }
    const headers = new Headers(request.headers);
    for (const key of ['host', 'content-length', 'transfer-encoding', 'connection']) headers.delete(key);
    const init = { method: request.method, headers, signal: request.signal };
    if (mode === 'streaming') { init.body = request.body; init.duplex = 'half'; }
    else if (payload !== undefined && payload.byteLength > 0 && !['GET', 'HEAD'].includes(request.method)) init.body = payload;
    const authority = adminConfiguration || adminPlugins || sessionExport || attachment || CATALOG_ENDPOINTS.has(endpoint) || modelSettings || HOST_SURFACE_ENDPOINTS.has(endpoint) || INVENTORY_ENDPOINTS.has(endpoint)
      ? await catalogAuthority()
      : peer;
    if (adminPlugins || adminConfiguration) {
      const verified = await auth.authenticate(request.headers, { mutation: true, csrf: request.headers.get('x-lan-csrf') });
      if (verified.user.id !== current.user.id || verified.user.role !== 'admin') bad('FORBIDDEN', 'Administrator authorization changed.', 403);
    }
    const response = await api.fetch(new Request(target, init), authority);
    if (adminPlugins && ['pluginManager/listBundles', 'pluginManager/listPlugins'].includes(endpoint) && response.ok) {
      const body = await response.json();
      if (body?.result?.ok) body.result.value = servicePluginInventory(endpoint, body.result.value);
      return json(body, response.status);
    }
    if (endpoint === 'agentPresets/list' && response.ok && capabilities) {
      const body = await response.json();
      if (body?.result?.ok) body.result.value = capabilities.agentPresetCatalog(current.user.id, body.result.value);
      return json(body, response.status);
    }
    if (endpoint === 'permissionPresets/catalog' && response.ok && capabilities) {
      const body = await response.json();
      if (body?.result?.ok) body.result.value = capabilities.permissionPresetCatalog(current.user.id, body.result.value);
      return json(body, response.status);
    }
    if (INVENTORY_ENDPOINTS.has(endpoint) && response.ok) {
      let body;
      try { body = JSON.parse(await response.text()); } catch { bad('MEMBER_ENDPOINT_DENIED', 'Plugin inventory is unavailable', 503); }
      if (current.user.role !== 'admin' && body?.result?.value && typeof body.result.value === 'object') delete body.result.value.managementAvailable;
      return json(body, response.status);
    }
    if (endpoint === 'session/modelCatalog' && response.ok && models) {
      const body = await response.json();
      if (body?.result?.ok) body.result.value = models.catalog(current.user.id, body.result.value);
      return json(body, response.status);
    }
    if (['llm/listProviders', 'llm/listConfigurableProviders'].includes(endpoint) && response.ok && models && !adminConfiguration) {
      const body = await response.json();
      if (body?.result?.ok) body.result.value = models.providers(current.user.id, body.result.value);
      return json(body, response.status);
    }
    if (endpoint === 'settings/describe' && response.ok && !adminConfiguration) {
      const body = await response.json();
      if (body?.result?.ok) body.result.value.namespaces = body.result.value.namespaces.filter(row => /^ui(?:[-_.]|$)/.test(row.ns));
      return json(body, response.status);
    }
    if (attachment && endpoint === 'session/uploadFileBinary' && response.ok) {
      // Publish upload success only after its server-private access receipt is
      // durable. File bytes remain in the native Host attachment store.
      const body = await response.clone().json();
      const value = body?.value ?? body?.result?.value;
      const ref = value?.file ?? value?.image;
      if (ref?.attachmentId) {
        const store = ctx.get?.('attachments');
        const path = value.file ? store?.fileHostPath(ref) : store?.imageHostPath(ref);
        if (!attachmentAccess || typeof path !== 'string') bad('MEMBER_UPLOAD_DENIED', 'Member attachment access cannot be recorded', 503);
        await attachmentAccess.record(current.user.id, ref.attachmentId, memberPath(path));
      }
    }
    if (endpoint === 'schedule/catalog' && response.ok) {
      // Fail closed: a catalog this carrier cannot filter is never passed on.
      let body;
      try { body = JSON.parse(await response.text()); } catch { body = undefined; }
      const items = body?.result?.value;
      if (body?.result?.ok === false) return json(body, response.status);
      if (!Array.isArray(items)) bad('MEMBER_SCHEDULE_DENIED', 'Scheduled tasks are unavailable', 503);
      const own = new Set(typeof ownership?.sessionIdsOf === 'function' ? ownership.sessionIdsOf(current.user.id) : []);
      body.result.value = items.filter(item => own.has(item?.sessionId));
      const headers = new Headers(response.headers);
      headers.delete('content-length'); headers.delete('etag');
      return new Response(JSON.stringify(body), { status: response.status, headers });
    }
    if (endpoint === 'session/list' && response.ok) {
      // Archived conversations are dropped here as well: the client groups the
      // raw list, and anything outside a Workspace row would resurface under
      // "ungrouped" even though the member archived it. An unreadable archive
      // leaves the list as the Host filtered it.
      let archived;
      try { archived = new Set(await readArchivedSessions({ home: await memberHome(current) })); } catch { archived = new Set(); }
      if (archived.size > 0) {
        try {
          const body = JSON.parse(await response.clone().text());
          const items = body?.result?.value?.items;
          if (Array.isArray(items)) {
            body.result.value.items = items.filter(item => !archived.has(item?.sessionId));
            const headers = new Headers(response.headers);
            headers.delete('content-length'); headers.delete('etag');
            return new Response(JSON.stringify(body), { status: response.status, headers });
          }
        } catch { /* an unexpected body passes through unchanged */ }
      }
    }
    if (pending !== undefined) {
      if (response.ok && response.body !== null) {
        let sessionId;
        try {
          const value = JSON.parse(await response.clone().text())?.result?.value;
          sessionId = typeof value?.sessionId === 'string' && SESSION_ID.test(value.sessionId) ? value.sessionId : undefined;
        } catch { sessionId = undefined; }
        if (sessionId !== undefined) {
          pendingCwds.delete(pending.cwd);
          await recordOwnership({ sessionId, ...pending });
        }
      } else pendingCwds.delete(pending.cwd);
      for (const [cwd, entry] of pendingCwds) if (Date.now() - entry.at > PENDING_CWD_MS) pendingCwds.delete(cwd);
      invalidate(peer.principal);
    }
    return response;
  }
  const handle = async request => {
    try {
      if (closed) bad('MEMBER_SERVICE_CLOSED', 'Member carrier stopped', 503);
      const url = pathOf(request, origin), path = url.pathname;
      const mutation = !['GET', 'HEAD'].includes(request.method);
      // The owner console runs inside the Desktop window, whose origin is
      // `dsh-app://` and can never be the member origin. This route answers it
      // with the plugin's own bearer session only — no member cookie, no member
      // session, so nothing here widens a member's reach.
      if (path === '/lan/owner-api') {
        if (typeof onOwnerAction !== 'function') bad('FACADE_UNAVAILABLE', 'Owner console unavailable', 503);
        const body = request.method === 'POST' ? await bodyBytes(request, FACADE_BYTES) : undefined;
        return await onOwnerAction(new Request(request.url, { method: request.method, headers: request.headers, signal: request.signal, ...(body === undefined ? {} : { body }) }));
      }
      auth.trust(request.headers, { mutation });
      if (path === '/lan') {
        if (mutation) bad('METHOD_NOT_ALLOWED', 'GET required', 405);
        return new Response(null, { status: 308, headers: { ...PRIVATE_HEADERS, location: '/lan/' } });
      }
      if (path === '/lan/admin' || path === '/lan/admin/') {
        if (mutation) bad('METHOD_NOT_ALLOWED', 'GET required', 405);
        return new Response(null, { status: 302, headers: { ...PRIVATE_HEADERS, location: '/lan/' } });
      }
      if (path === '/lan/auth' || path === '/lan/admin/auth') {
        if (request.method !== 'POST') bad('METHOD_NOT_ALLOWED', 'POST required', 405);
        const { action, ...fields } = await authFields(request);
        const administratorOnly = path === '/lan/admin/auth';
        if (administratorOnly && action !== 'login') bad('FORBIDDEN', 'Administrator sign-in required', 403);
        if (action === 'logout') {
          const current = await auth.authenticate(request.headers, { mutation: true, csrf: request.headers.get('x-lan-csrf') });
          const result = await auth.logout(current);
          return ok({ signedOut: true }, { 'set-cookie': result.cookie });
        }
        const result = await auth.login(action, fields, { administratorOnly });
        return ok({ user: result.user, csrf: result.csrf }, { 'set-cookie': result.cookie });
      }
      let current;
      const loginDocument = () => new Response(request.method === 'HEAD' ? null : memberLoginDocument({ branding: brandingSnapshot() }), { headers: { ...PRIVATE_HEADERS, 'content-type': 'text/html; charset=utf-8', 'content-security-policy': LOGIN_CSP } });
      try { current = await auth.authenticate(request.headers, { mutation, csrf: request.headers.get('x-lan-csrf') }); }
      catch (error) {
        if ((path === '/lan/' || path === '/lan/index.html') && !mutation && error?.code === 'UNAUTHENTICATED') return loginDocument();
        throw error;
      }
      if (path === '/lan/auth/session') {
        if (request.method !== 'GET') bad('METHOD_NOT_ALLOWED', 'GET required', 405);
        return ok({ user: current.user, csrf: current.session.csrf });
      }
      const peer = await memberPeer(current, request.headers);
      if (path.startsWith('/lan/open-in-app/')) {
        if (current.user.role !== 'admin' || !onDesktop) bad('MEMBER_DESKTOP_DENIED', 'Server desktop applications require an administrator', 403);
        return await onDesktop(request, current.user);
      }
      if (path === '/lan/api/lan-workspace') {
        if (request.method !== 'POST') bad('METHOD_NOT_ALLOWED', 'POST required', 405);
        if (!onAction) bad('FACADE_UNAVAILABLE', 'Member workspace unavailable', 503);
        const body = await bodyBytes(request, FACADE_BYTES);
        const response = await onAction({ request: new Request(request.url, { method: request.method, headers: request.headers, signal: request.signal, body }), auth: current });
        if (!(response instanceof Response)) bad('FACADE_UNAVAILABLE', 'Member workspace unavailable', 503);
        return response;
      }
      if (path.startsWith('/lan/api/')) {
        if (!['POST', 'GET', 'HEAD', 'PUT', 'PATCH', 'DELETE'].includes(request.method)) bad('METHOD_NOT_ALLOWED', 'Method not supported', 405);
        const endpoint = path.slice('/lan/api/'.length);
        if (!/^[A-Za-z0-9_$.:-]+(?:\/[A-Za-z0-9_$.:-]+)*$/.test(endpoint) || endpoint.split('/').some(part => part === '.' || part === '..')) bad('INVALID_PATH', 'Invalid Remote endpoint');
        if (request.signal.aborted) bad('ABORTED', 'Member request was cancelled', 499);
        return await dispatchApi(request, url, endpoint, current, peer);
      }
      if (mutation) bad('METHOD_NOT_ALLOWED', 'GET or HEAD required', 405);
      if (path === '/lan/' || path === '/lan/index.html') {
        const policy = ctx.remoteAccess.snapshotFor(peer.principal);
        if (policy?.owner !== false) bad('MEMBER_POLICY_UNAVAILABLE', 'Member access baseline unavailable', 503);
        if (typeof ctx.clientModules?.graph !== 'function') bad('MEMBER_MODULES_UNAVAILABLE', 'Member client modules are unavailable', 503);
        if (typeof ctx.webServer.collectIndexInjections !== 'function' || typeof ctx.webServer.applyIndexTaps !== 'function') bad('FRONTEND_INVALID', 'Frontend document unavailable', 503);
        // The member document is the owner document with the owner's module boot
        // rows replaced by the member client graph, every asset URL under `/lan/`,
        // and the member transport hook installed before anything boots.
        // A member with no Session yet would land on an empty page whose only
        // affordance is the workspace picker, so the first visit opens one
        // Session in the default project. It is the same create the member page
        // performs itself; nothing beyond the member home is ever touched.
        void ensureMemberSession(current, peer).catch(() => {});
        const rows = [
          { kind: 'html', placement: 'head', html: '<base href="/lan/">' },
          { kind: 'html', placement: 'head', html: memberScript(current.user, current.session.csrf, policy) },
        ];
        for (const row of ctx.webServer.collectIndexInjections()) {
          if (isBootRow(row) || (row?.kind === 'global' && row.name === '__DSH_REMOTE_ACCESS__')) continue;
          rows.push(row);
        }
        if (current.user.role === 'admin') rows.push({ kind: 'script', placement: 'head', text: ADMINISTRATOR_DESKTOP_FETCH });
        rows.push(...memberBootRows(memberClientGraph(ctx.clientModules.graph(), current.user.role === 'admin')));
        // The member document is rooted at `/lan/`, so the owner's own `<base>`
        // rows must not survive next to the member base row.
        // Manifest fetches omit cookies by default, even on the same origin.
        const rooted = rawHtml.replace(/<base\b[^>]*>/gi, '').replace(/<link\b[^>]*\brel=["']manifest["'][^>]*>/gi, tag =>
          tag.replace(/\s+crossorigin(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+))?/gi, '').replace(/^<link\b/i, '<link crossorigin="use-credentials"'));
        const html = ctx.webServer.applyIndexTaps(renderMemberIndexInjections(rooted, rows));
        if (!/<head(?:\s[^>]*)?>/i.test(html) || !/<\/head\s*>/i.test(html)) bad('FRONTEND_INVALID', 'Frontend document unavailable', 503);
        // No `x-frame-options`: the Desktop app opens the member page in its own
        // browser panel (a local frame). Only loopback pages can embed it, because
        // the login document narrows `frame-ancestors` to localhost.
        return new Response(request.method === 'HEAD' ? null : html, { headers: { ...PRIVATE_HEADERS, 'content-type': 'text/html; charset=utf-8' } });
      }
      if (path.startsWith('/lan/plugins/')) {
        const response = await ctx.clientModules.fetchBundle(canonical(request, url));
        if (response.ok && /(?:java|ecma)script/i.test(response.headers.get('content-type') || '') && request.method !== 'HEAD') {
          const source = await response.text();
          if (source.includes("id: '@sunbigfly/dsh-multi-user-service'") && !/id\s*:\s*['"]@sunbigfly\/dsh-multi-user-service\/member-client['"]/.test(source)) {
            const memberSource = await readFile(fileURLToPath(new URL('../native-client.js', import.meta.url)), 'utf8');
            const headers = new Headers(response.headers); headers.delete('content-length'); headers.delete('etag');
            headers.set('cache-control', 'no-store, private');
            return new Response(memberSource + '\n' + source, { status: response.status, headers });
          }
          return new Response(source, { status: response.status, headers: response.headers });
        }
        return response;
      }
      const name = path.slice('/lan/'.length);
      if (!(name.startsWith('assets/') || ['favicon.svg', 'favicon-dark.svg', 'manifest.webmanifest'].includes(name)) || !Object.hasOwn(MIME, extname(name))) bad('NOT_FOUND', 'Unknown member resource', 404);
      const bytes = await readContained(root, name);
      return new Response(request.method === 'HEAD' ? null : bytes, { headers: { ...PRIVATE_HEADERS, 'content-type': MIME[extname(name)] } });
    } catch (error) { return errorResponse(error); }
  };
  const admitUpgrade = async request => {
    const url = pathOf(request, origin);
    if (closed || request.method !== 'GET' || url.pathname !== '/lan/api/remote.mux' || url.search) bad('UPGRADE_DENIED', 'Unknown member upgrade', 403);
    const current = await auth.authenticate(request.headers, { websocket: true });
    const peer = await memberPeer(current, request.headers);
    return { peer, authenticate: async () => {
      const fresh = await auth.authenticate(request.headers, { websocket: true });
      if (closed || fresh.key !== current.key || fresh.user.id !== peer.principal.userId || peer.signal.aborted) bad('UNAUTHENTICATED', 'Member session expired', 401);
    } };
  };
  // The mux hands the member Peer to the stock WireStream gateway, which runs the
  // same descriptor, resource and access checks as the owner path.
  const wireStream = {
    open(endpoint, payload, uplink, peer, signal) {
      capabilities?.assertEndpoint(peer?.principal?.userId, endpoint);
      const streams = streamsOf();
      if (!streams || closed || peer?.signal?.aborted) bad('MEMBER_ENDPOINT_DENIED', 'Member native stream is unavailable', 403);
      if (endpoint === 'workspace/follow') {
        // The Host registry is owner-scoped and denies a member Peer, which left
        // the member page's workspace picker pending forever. The member's own
        // project directories answer instead, through the same frame contract.
        const userId = peer?.principal?.userId;
        if (typeof userId !== 'string') bad('MEMBER_ENDPOINT_DENIED', 'Member workspace stream requires a member principal', 403);
        return memberWorkspaceStream({ user: { id: userId } });
      }
      const openStream = async () => {
        if (endpoint.startsWith('workspaceFiles/')) await authorizeWorkspaceFile(peer?.principal?.userId, payload?.args, peer?.principal);
        return streams.open(endpoint, payload, uplink, peer, signal);
      };
      // Host builds differ: some return an async iterable, others a promise of
      // one, and a promise rejection raised outside the mux pump is fatal to the
      // Host process. Resolve the opener inside next() so every failure travels
      // the stream protocol as one error frame and the member page survives it.
      return { [Symbol.asyncIterator]() {
        let iterator;
        return {
          async next(...args) {
            capabilities?.assertEndpoint(peer?.principal?.userId, endpoint);
            if (iterator === undefined) {
              const source = await openStream();
              iterator = source[Symbol.asyncIterator]();
            }
            return iterator.next(...args);
          },
          async return(...args) {
            if (iterator === undefined) return { done: true, value: undefined };
            return iterator.return?.(...args) ?? { done: true, value: undefined };
          },
        };
      } };
    },
    failure(error) { return streamsOf()?.failure(error) ?? { code: 'gateway/forbidden', message: 'Member native stream is unavailable.', details: {} }; },
  };
  return { handle, admitUpgrade, wireStream, async close() {
    if (closed) return;
    closed = true;
    disposeAdminArchive?.();
    removeSessionCreated?.();
    await Promise.allSettled([...peers.values()].map(async promise => (await promise).dispose()));
    peers.clear();
    pendingCwds.clear();
  } };
}

function nodeHeaders(req) {
  // Node normalizes Host, but duplicates are never a trustworthy authority.
  const raw = req.rawHeaders ?? [];
  for (const name of ['host', 'origin', 'content-length', 'x-lan-csrf']) {
    let count = 0; for (let i = 0; i < raw.length; i += 2) if (raw[i].toLowerCase() === name) count++;
    if (count > 1) bad('HEADER_DENIED', 'Duplicate security header', 403);
  }
  const headers = new Headers();
  for (const [name, value] of Object.entries(req.headers)) if (value !== undefined) headers.set(name, Array.isArray(value) ? value.join(', ') : value);
  return headers;
}
function nodeUrl(req, origin) {
  const target = req.url ?? '/';
  if (!target.startsWith('/') || target.startsWith('//') || /[\\\x00-\x20#]/.test(target)) bad('INVALID_PATH', 'Invalid request target');
  // Check raw segments before WHATWG URL dot-segment normalization.
  if (target.split('?')[0].split('/').some(part => part === '.' || part === '..') || /%/i.test(target.split('?')[0])) bad('INVALID_PATH', 'Invalid request target');
  return new URL(target, origin);
}
async function sendNode(response, res, signal) {
  const headers = Object.fromEntries(response.headers);
  if (response.headers.getSetCookie) {
    const cookies = response.headers.getSetCookie();
    if (cookies.length) headers['set-cookie'] = cookies;
  }
  res.writeHead(response.status, headers);
  if (!response.body) { res.end(); return; }
  const reader = response.body.getReader(); let bytes = 0;
  try {
    for (;;) {
      signal.throwIfAborted();
      const next = await withTimeout(reader.read());
      if (next.done) break;
      bytes += next.value.byteLength;
      if (bytes > RESPONSE_BYTES) throw new Error('Member HTTP output exceeded bound');
      if (!res.write(next.value)) {
        const wait = new AbortController();
        try { await withTimeout(Promise.race([once(res, 'drain', { signal: wait.signal }), once(res, 'close', { signal: wait.signal }).then(() => { throw new Error('Member response closed'); })])); }
        finally { wait.abort(); }
      }
    }
    res.end();
  } catch { void reader.cancel().catch(() => {}); res.destroy(); }
  finally { reader.releaseLock(); }
}
/** Mount exclusively on the existing webServer listener. No new server/seat. */
export async function mountMemberCarrier(ctx, options = {}, dependencies = {}) {
  const carrier = await createMemberCarrier(ctx, options);
  let mux;
  try { mux = dependencies.mux ?? await createMemberMux({ ...dependencies, wireStream: carrier.wireStream }); }
  catch (error) { await carrier.close(); throw error; }
  const registrations = [];
  try {
    registrations.push(mountAdministratorEntry(ctx.webServer, options.auth, options.brandingSnapshot));
    registrations.push(ctx.webServer.register({ kind: 'prefix', path: '/lan', handler: async (req, res) => {
      const control = new AbortController();
      const aborted = () => control.abort(new Error('Member HTTP disconnected'));
      req.once('aborted', aborted); res.once('close', aborted);
      try {
        const url = nodeUrl(req, options.memberOrigin), headers = nodeHeaders(req);
        const ownerBridge = url.pathname === '/lan/owner-api';
        if (ownerBridge) {
          if (!['POST', 'OPTIONS'].includes(req.method)) bad('METHOD_NOT_ALLOWED', 'POST required', 405);
        } else if (!['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method)) bad('METHOD_NOT_ALLOWED', 'Method not supported', 405);
        const mutation = !['GET', 'HEAD'].includes(req.method);
        if (!ownerBridge) options.auth.trust(headers, { mutation });
        const length = headers.get('content-length');
        const max = ownerBridge || url.pathname === '/lan/api/lan-workspace' ? FACADE_BYTES : ['/lan/auth', '/lan/admin/auth'].includes(url.pathname) ? AUTH_BYTES : REQUEST_BYTES;
        if (length !== null && (!/^\d+$/.test(length) || Number(length) > max)) bad('BODY_TOO_LARGE', 'Member request is too large', 413);
        let body;
        if (mutation) {
          const chunks = []; let bytes = 0;
          const deadline = Date.now() + IO_TIMEOUT_MS;
          const iterator = req[Symbol.asyncIterator]();
          for (;;) {
            const next = await withTimeout(iterator.next(), Math.max(1, deadline - Date.now()));
            if (next.done) break;
            bytes += next.value.length;
            if (bytes > max) bad('BODY_TOO_LARGE', 'Member request is too large', 413);
            chunks.push(next.value);
          }
          body = Buffer.concat(chunks, bytes);
        }
        const request = new Request(url, { method: req.method, headers, signal: control.signal, ...(body === undefined ? {} : { body }) });
        await sendNode(await carrier.handle(request), res, control.signal);
      } catch (error) { if (!res.headersSent) await sendNode(errorResponse(error), res, control.signal); else res.destroy(); }
      finally { req.off('aborted', aborted); res.off('close', aborted); }
    } }));
    registrations.push(ctx.webServer.registerUpgrade({ path: '/lan/api/remote.mux', handler: async (req, socket, head) => {
      try {
        const request = new Request(nodeUrl(req, options.memberOrigin), { method: req.method, headers: nodeHeaders(req) });
        const { peer, authenticate } = await carrier.admitUpgrade(request);
        mux.handleUpgrade(req, socket, head, peer, authenticate);
      } catch (error) {
        const status = [401, 403, 429, 503].includes(error?.status) ? error.status : 403;
        const body = 'Member upgrade denied';
        socket.end(`HTTP/1.1 ${status} Member Upgrade Denied\r\nConnection: close\r\nContent-Type: text/plain; charset=utf-8\r\nContent-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`);
      }
    } }));
  } catch (error) { for (const dispose of registrations.reverse()) dispose(); await mux.close(); await carrier.close(); throw error; }
  let disposed = false;
  return async () => {
    if (disposed) return;
    disposed = true;
    for (const dispose of registrations.reverse()) dispose();
    await mux.close(); await carrier.close();
  };
}
