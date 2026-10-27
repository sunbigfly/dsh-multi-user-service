import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { Script, createContext } from 'node:vm';

// Unit contracts, not a claim of browser/visual/live-slot verification.
const source = await readFile(new URL('../native-client.js', import.meta.url), 'utf8');
const plain = value => JSON.parse(JSON.stringify(value));
const tick = async () => { for (let i = 0; i < 16; ++i) await Promise.resolve(); };
const member = { id: 'usr_member', username: 'member', displayName: 'Workspace Member', role: 'member' };
const success = result => ({ ok: true, status: 200, json: async () => ({ ok: true, result }) });
const denied = (code, status = 403) => ({ ok: false, status, json: async () => ({ ok: false, error: { code, message: 'secret owner path or implementation detail' } }) });
const snapshot = overrides => ({ user: member, home: { status: 'ready', path: '/private/root/member' }, routes: [{ id: 'private-route' }], projects: [{ id: 'private-project' }], ...overrides });
function deferred() { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
function timers() {
  let next = 0;
  const pending = new Map();
  return { pending, setTimeout(fn, delay) { pending.set(++next, { fn, delay }); return next; }, clearTimeout(id) { pending.delete(id); },
    async fire(delay) { const entry = [...pending].find(([, value]) => value.delay === delay); assert.ok(entry); pending.delete(entry[0]); entry[1].fn(); await tick(); } };
}
function reactMock() {
  const stores = new Map(), effects = [];
  let current, index = 0, active;
  const React = {
    Fragment: Symbol('Fragment'),
    createElement(type, props, ...children) { return { type, props: { ...props, children: children.flat(Infinity) } }; },
    useRef(initial) { const slot = index++; if (!current[slot]) current[slot] = { current: initial }; return current[slot]; },
    useSyncExternalStore(_subscribe, get) { return get(); },
    useEffect(fn, deps) {
      const slot = index++, owner = current, old = owner[slot];
      if (!old || deps.some((value, i) => !Object.is(value, old.deps[i]))) {
        old?.cleanup?.(); owner[slot] = { deps };
        effects.push(() => { owner[slot].cleanup = fn(); });
      }
    },
  };
  function walk(node, path) {
    if (node === null || typeof node !== 'object') return node;
    if (Array.isArray(node)) return node.map((child, i) => walk(child, `${path}.${i}`));
    if (typeof node.type === 'function') {
      const key = `${path}:${node.type.name}`;
      active.add(key); if (!stores.has(key)) stores.set(key, []);
      const saved = current, savedIndex = index; current = stores.get(key); index = 0;
      const result = node.type(node.props); current = saved; index = savedIndex;
      return walk(result, `${key}/`);
    }
    return { ...node, props: { ...node.props, children: (node.props.children || []).map((child, i) => walk(child, `${path}.${i}`)) } };
  }
  return { React, render(Component, props = {}) {
    active = new Set(); const result = walk(React.createElement(Component, props), 'root');
    for (const [key, hooks] of stores) if (!active.has(key)) { hooks.forEach(hook => hook?.cleanup?.()); stores.delete(key); }
    while (effects.length) effects.shift()();
    return result;
  }, unmount() { for (const hooks of stores.values()) hooks.forEach(hook => hook?.cleanup?.()); stores.clear(); } };
}
function load({ flag, fetcher, react = reactMock(), timer = timers() } = {}) {
  let registration;
  const requests = [], imports = [];
  const window = { ...(flag ? { __DSH_LAN_MEMBER__: flag } : {}), location: { origin: 'http://192.168.2.47:18620', assign(value) { window.redirect = value; } }, __ModuleLoader__: { load(value) { registration = value; } } };
  const context = createContext({ window, AbortController, setTimeout: timer.setTimeout, clearTimeout: timer.clearTimeout,
    fetch: async (url, options) => { const request = { url, ...options, fields: JSON.parse(options.body) }; requests.push(request); return fetcher ? fetcher(request) : success(snapshot()); } });
  new Script(source, { filename: 'native-client.js' }).runInContext(context);
  assert.equal(registration.id, '@sunbigfly/dsh-multi-user-service/member-client');
  const exports = registration.factory(name => { imports.push(name); assert.equal(name, 'react'); return react.React; });
  return { exports, requests, imports, window, timer, react };
}
function mount(options = {}) {
  const env = load({ flag: { user: member, csrf: 'member-csrf' }, ...options });
  const registrations = [], effects = [], locale = new Map(), hooks = new Map();
  let activeLocale = 'en', localeRevision = 0, registered = 0, released = 0, localeReleased = 0;
  function effect(fn) { const dispose = fn(); effects.push(dispose); return dispose; }
  const ctx = {
    effect,
    inject(names, apply) {
      assert.deepEqual(plain(names), ['sessions']);
      const sessions = options.sessions ?? { list: { getSnapshot: () => ({ ids: [], byId: {} }), subscribe: () => () => {} }, refresh() { assert.fail('no stale directories'); } };
      const dispose = apply({ get: name => { assert.equal(name, 'sessions'); return sessions; }, effect: fn => fn() });
      return { dispose };
    },
    slots: {
      inject(name, fn) { return fn(); },
      register(opts, Component) {
        if (options.failRegister === opts.name) throw new Error('registration failed');
        const entry = { options: opts, Component }; registrations.push(entry); ++registered;
        return () => { const i = registrations.indexOf(entry); if (i >= 0) { registrations.splice(i, 1); ++released; } };
      },
      installScope() { assert.fail('identity must not replace native scopes'); },
      provideRoot() { assert.fail('identity must not replace native root hooks'); },
    },
    locale: {
      register(ns, lang, dictionary) { locale.set(`${ns}:${lang}`, dictionary); return () => { ++localeReleased; locale.delete(`${ns}:${lang}`); }; },
      bind(ns) { return key => locale.get(`${ns}:${activeLocale}`)?.[key] || `MISSING:${key}`; },
      subscribe(listener) { hooks.set(listener, true); return () => hooks.delete(listener); },
      getSnapshot() { return { active: activeLocale, revision: localeRevision }; },
    },
  };
  env.exports.apply(ctx, options.admin ? {
    WorkspaceSection(props) { return env.react.React.createElement(env.react.React.Fragment, null, env.react.React.createElement(options.admin, props), env.react.React.createElement(props.AccountSection)); },
    installWorkspace(Component) { return ctx.slots.register({ name: 'workspace.window' }, Component); },
  } : undefined);
  return { ...env, ctx, registrations, locale,
    row(name, id) { const entry = registrations.find(row => row.options.name === name && (id === undefined || row.options.id === id)); assert.ok(entry, `${name}/${id}`); return entry; },
    render(name, props, id) { return env.react.render(this.row(name, id).Component, props); },
    setLocale(next) { activeLocale = next; ++localeRevision; for (const listener of hooks.keys()) listener(); },
    counts() { return { registered, released, localeReleased }; },
    dispose() { env.react.unmount(); for (const dispose of effects.slice().reverse()) dispose?.(); },
  };
}
function nodes(tree, predicate) {
  const result = [];
  function visit(node) { if (Array.isArray(node)) return node.forEach(visit); if (node === null || typeof node !== 'object') return; if (predicate(node)) result.push(node); node.props?.children?.forEach(visit); }
  visit(tree); return result;
}
function text(node) { if (Array.isArray(node)) return node.map(text).join(' '); if (node == null) return ''; if (typeof node !== 'object') return String(node); if (node.type === 'style') return ''; return (node.props.children || []).map(text).join(' '); }
function button(tree, label) { const result = nodes(tree, node => node.type === 'button' && text(node).trim() === label)[0]; assert.ok(result, `button ${label}`); return result; }
function account(env) { return env.registrations.some(row => row.options.name === 'workspace.window') ? env.render('workspace.window') : env.render('settings.section', {}, 'workspace-account'); }

test('classic factory is inert, uses only built-in React, and never replaces native shells', () => {
  const env = load();
  assert.deepEqual(env.imports, ['react']);
  assert.deepEqual(plain(env.exports.inject), ['slots', 'locale']);
  assert.equal(env.requests.length, 0); assert.equal(env.timer.pending.size, 0);
  assert.doesNotMatch(source, /ReactDOM|createRoot|document\.|localStorage|sessionStorage|__DSH_BOOT__|Authorization|Bearer|ctx\.remote|installScope|provideRoot|selectPanel/);
  assert.doesNotMatch(source, /h\(['"](?:dialog|iframe)|name:\s*['"](?:main|sidebar|sidebar\.settings|conversation[^'"]*)['"]/);
  assert.doesNotMatch(source, /require\(['"]@deepseek-ai\//);
});

test('owner pages and malformed member bootstrap are strict no-ops', () => {
  for (const flag of [undefined, {}, { user: member }, { csrf: 'x' }, { user: member, csrf: '' }, { user: { ...member, role: 'owner' }, csrf: 'x' }, { user: { ...member, disabled: true }, csrf: 'x' }]) {
    const env = load({ flag });
    env.exports.apply({ effect() { assert.fail('must not register'); } });
    assert.equal(env.requests.length, 0);
  }
});

function sessionStore(rows, refresh) {
  let state;
  const listeners = new Set();
  const set = rows => {
    state = { ids: rows.map(row => row.id), byId: Object.fromEntries(rows.map(row => [row.id, row])) };
    for (const listener of listeners) listener();
  };
  set(rows);
  return { list: { getSnapshot: () => state, subscribe: fn => { listeners.add(fn); return () => listeners.delete(fn); } }, refresh, set, listeners };
}

test('assigned session directories are fetched from the native baseline after a stale create placeholder', async () => {
  const { syncSessionDirectories } = load().exports;
  const placeholder = { id: 'new', projectionValues: { workingDirectory: '/private/member/workspace/session' } };
  const other = { id: 'other', cwd: '/private/member/older', projectionValues: { workingDirectory: '/private/member/older' } };
  let calls = 0;
  const sessions = sessionStore([other], async () => { ++calls; sessions.set([other, { ...placeholder, cwd: placeholder.projectionValues.workingDirectory }]); });
  const dispose = syncSessionDirectories(sessions);
  await tick(); assert.equal(calls, 0);
  sessions.set([other, placeholder]); await tick();
  assert.equal(calls, 1);
  assert.equal(sessions.list.getSnapshot().byId.new.cwd, '/private/member/workspace/session');
  assert.equal(sessions.list.getSnapshot().byId.other, other);
  dispose(); assert.equal(sessions.listeners.size, 0);
});

test('directory synchronization corrects a project placeholder and covers an older list pull in flight', async () => {
  const { syncSessionDirectories } = load().exports;
  const row = { id: 'new', cwd: '/private/member/workspace', projectionValues: { workingDirectory: '/private/member/workspace/session' } };
  const olderPull = deferred(); let calls = 0;
  const sessions = sessionStore([row], () => {
    if (++calls === 1) return olderPull.promise;
    sessions.set([{ ...row, cwd: row.projectionValues.workingDirectory }]);
  });
  const dispose = syncSessionDirectories(sessions);
  await tick(); assert.equal(calls, 1);
  sessions.set([row]); await tick(); assert.equal(calls, 1);
  olderPull.resolve(); await tick();
  assert.equal(calls, 2);
  assert.equal(sessions.list.getSnapshot().byId.new.cwd, row.projectionValues.workingDirectory);
  dispose();
});

test('directory synchronization bounds failures, coalesces new sessions and stops with its scope', async () => {
  const { syncSessionDirectories } = load().exports;
  const row = id => ({ id, projectionValues: { workingDirectory: `/private/member/${id}` } });
  const firstPull = deferred(); let calls = 0;
  const sessions = sessionStore([row('first')], () => ++calls === 1 ? firstPull.promise : Promise.reject(new Error('offline')));
  const dispose = syncSessionDirectories(sessions);
  await tick(); sessions.set([row('first'), row('second')]); await tick(); assert.equal(calls, 1);
  firstPull.resolve(); await tick();
  assert.equal(calls, 3);
  sessions.set([row('first'), row('second')]); await tick(); assert.equal(calls, 3);
  dispose(); sessions.set([row('third')]); await tick(); assert.equal(calls, 3);
  assert.equal(sessions.listeners.size, 0);
  const cancelled = sessionStore([row('cancelled')], () => { assert.fail('disposed before refresh'); });
  syncSessionDirectories(cancelled)(); await tick();
});

test('identity projection discards paths, owner details, routes and raw administrator payload', () => {
  const env = load();
  const value = env.exports.accountFromSnapshot(snapshot({ user: { ...member, password: 'private-password', balance: 'private-balance', routeIds: ['private-route'] }, admin: { root: '/private/admin' }, home: { status: 'ready', path: '/private/member' } }), member.id);
  assert.deepEqual(plain(value), { user: member, home: { status: 'ready' } });
  assert.ok(Object.isFrozen(value)); assert.ok(Object.isFrozen(value.user)); assert.ok(Object.isFrozen(value.home));
  assert.doesNotMatch(JSON.stringify(value), /private/);
  assert.equal(env.exports.accountFromSnapshot(snapshot({ home: { status: 'other' } }), member.id).home.status, 'unavailable');
  assert.throws(() => env.exports.accountFromSnapshot(snapshot({ user: { ...member, id: 'usr_someone_else' } }), member.id), error => error.code === 'IDENTITY_CHANGED');
  assert.throws(() => env.exports.accountFromSnapshot(snapshot({ user: { ...member, disabled: true } }), member.id), error => error.code === 'UNAUTHENTICATED');
});

test('cookie API fixes endpoints, method and CSRF and denies unrelated day-to-day actions', async () => {
  const env = load(), calls = [];
  const api = env.exports.createMemberApi({ csrf: 'member-only', fetcher: async (...args) => { calls.push(args); return success({ accepted: true }); } });
  await api.request('snapshot'); await api.request('logout');
  assert.deepEqual(calls.map(call => call[0]), ['/lan/api/lan-workspace', '/lan/auth']);
  for (const [, request] of calls) {
    assert.equal(request.method, 'POST'); assert.equal(request.credentials, 'same-origin'); assert.equal(request.cache, 'no-store'); assert.equal(request.redirect, 'error');
    assert.deepEqual(plain(request.headers), { 'Content-Type': 'application/json', 'X-Lan-CSRF': 'member-only' });
    assert.ok(request.signal instanceof AbortSignal);
  }
  for (const action of ['chat.send', 'admin.updateUser', 'model.select', 'projects.create', '/api/owner']) await assert.rejects(api.request(action), error => error.code === 'IDENTITY_ACTION_DENIED');
  await assert.rejects(api.request('snapshot', { action: 'admin.updateUser' }), error => error.code === 'IDENTITY_ACTION_DENIED');
  assert.equal(calls.length, 2); assert.equal(env.timer.pending.size, 0);
  api.dispose(); api.dispose(); await assert.rejects(api.request('snapshot'), error => error.code === 'DISPOSED');
});

test('API validates result envelopes and reports expiry without forwarding server text', async () => {
  const env = load(); let expired = 0;
  const api = env.exports.createMemberApi({ csrf: 'x', onExpired() { ++expired; }, fetcher: async () => denied('UNAUTHENTICATED', 401) });
  await assert.rejects(api.request('snapshot'), error => error.code === 'UNAUTHENTICATED' && !error.message.includes('secret'));
  assert.equal(expired, 1); api.dispose();
  for (const envelope of [{ ok: true }, { ok: false, error: { code: 'FORBIDDEN' } }, {}]) {
    const api = env.exports.createMemberApi({ csrf: 'x', fetcher: async () => ({ ok: true, status: 200, json: async () => envelope }) });
    await assert.rejects(api.request('snapshot'), error => ['INVALID_RESPONSE', 'FORBIDDEN', 'HTTP_200'].includes(error.code)); api.dispose();
  }
  const missing = env.exports.createMemberApi({ csrf: '', fetcher() { assert.fail(); } });
  await assert.rejects(missing.request('snapshot'), error => error.code === 'CSRF_REQUIRED'); missing.dispose();
});

test('API supports explicit abort, timeout and disposal with no surviving timers', async () => {
  const env = load();
  const rejectOnAbort = (_url, { signal }) => new Promise((_resolve, reject) => { signal.addEventListener('abort', () => reject(new Error('abort')), { once: true }); });
  const api = env.exports.createMemberApi({ csrf: 'x', fetcher: rejectOnAbort });
  const timed = assert.rejects(api.request('snapshot'), error => error.code === 'TIMEOUT');
  await env.timer.fire(20000); await timed; api.dispose();
  const api2 = env.exports.createMemberApi({ csrf: 'x', fetcher: rejectOnAbort });
  const controller = new AbortController(); const aborted = assert.rejects(api2.request('snapshot', {}, controller.signal), error => error.code === 'ABORTED');
  controller.abort(); await aborted; api2.dispose();
  const api3 = env.exports.createMemberApi({ csrf: 'x', fetcher: rejectOnAbort });
  const disposed = assert.rejects(api3.request('snapshot'), error => error.code === 'ABORTED'); api3.dispose(); await disposed;
  const controller2 = new AbortController(); controller2.abort();
  const api4 = env.exports.createMemberApi({ csrf: 'x', fetcher() { assert.fail(); } });
  await assert.rejects(api4.request('snapshot', {}, controller2.signal), error => error.code === 'ABORTED'); api4.dispose();
  assert.equal(env.timer.pending.size, 0);
});

test('only native settings launcher and account section are registered, never a replacement app', async () => {
  const env = mount(); await tick();
  assert.deepEqual(plain(env.registrations.map(row => ({ name: row.options.name, id: row.options.id, order: row.options.order }))), [
    { name: 'settings.launcher' }, { name: 'settings.section', id: 'workspace-account', order: -20 },
  ]);
  assert.deepEqual(env.requests.map(row => row.fields.action), ['snapshot']);
  assert.equal(env.requests[0].fields.section, 'base', 'embedded identity refresh must not wait for usage or resource catalogs');
  assert.equal(env.row('settings.section', 'workspace-account').options.label(), 'Workspace account');
  const tree = account(env);
  assert.match(text(tree), /Workspace Member/); assert.match(text(tree), /Display name/);
  assert.equal(nodes(tree, node => node.props?.['data-home-alias']).length, 0);
  assert.equal(nodes(tree, node => node.props?.['data-member-entry']).length, 0);
  assert.doesNotMatch(text(tree), /private|balance|DeepSeek account|New conversation|Model|Agent|MCP/);
  assert.equal(nodes(tree, node => ['dialog', 'main', 'aside', 'iframe', 'select', 'input', 'textarea'].includes(node.type)).length, 0);
  env.dispose(); assert.deepEqual(env.counts(), { registered: 2, released: 2, localeReleased: 2 });
});

test('launcher opens original settings, retains rail accessibility and native shortcut hints', async () => {
  const env = mount(); await tick(); let opened = 0;
  const props = { wide: true, settingsOpen: false, settingsShortcut: { keys: ['Ctrl', 'Alt', ','], aria: 'Control+Alt+,' }, openSettings() { ++opened; } };
  const tree = env.render('settings.launcher', props);
  const trigger = nodes(tree, node => node.props?.['data-member-account-launcher'])[0];
  assert.equal(trigger.props['aria-haspopup'], 'dialog'); assert.equal(trigger.props['aria-expanded'], false);
  assert.equal(trigger.props['aria-keyshortcuts'], 'Control+Alt+,'); assert.match(trigger.props['aria-label'], /Workspace Member/);
  trigger.props.onClick(); assert.equal(opened, 1);
  const rail = env.render('settings.launcher', { ...props, wide: false });
  const railButton = nodes(rail, node => node.props?.['data-member-account-launcher'])[0];
  assert.equal(railButton.props['data-collapsed'], true); assert.match(railButton.props['aria-label'], /Settings/);
  assert.ok(nodes(rail, node => node.props?.className === 'lann-sr').length); env.dispose();
});

test('opening native settings refreshes identity once per rising edge, without background polling', async () => {
  const env = mount(); await tick();
  const props = { wide: true, openSettings() {}, settingsOpen: false };
  env.render('settings.launcher', props);
  env.render('settings.launcher', { ...props, settingsOpen: true }); await tick();
  env.render('settings.launcher', { ...props, settingsOpen: true }); await tick();
  assert.equal(env.requests.length, 2);
  env.render('settings.launcher', props); env.render('settings.launcher', { ...props, settingsOpen: true }); await tick();
  assert.equal(env.requests.length, 3); assert.equal(env.timer.pending.size, 0); env.dispose();
});

test('account content and navigation label follow native locale without adding locale/theme controls', async () => {
  const env = mount(); await tick(); env.setLocale('zh');
  assert.equal(env.row('settings.section', 'workspace-account').options.label(), '工作区账号');
  const tree = account(env); assert.match(text(tree), /工作区账号/); assert.match(text(tree), /显示名/);
  assert.equal(nodes(tree, node => node.type === 'button').length, 2);
  assert.equal(nodes(tree, node => node.type === 'style')[0].props.children[0].includes('--dsw-alias-'), true);
  assert.doesNotMatch(text(tree), /语言|外观|深色|浅色/); env.dispose();
});

test('home paths are never rendered even when returned incorrectly by backend', async () => {
  for (const home of [undefined, { status: 'pending', path: '/private/pending' }, { status: 'ready', path: 'C:\\owner\\secrets' }, { status: 'error', path: '/private/error' }]) {
    const env = mount({ fetcher: async () => success(snapshot({ home })) }); await tick();
    const tree = account(env); assert.doesNotMatch(JSON.stringify(tree), /private|secrets|C:\\\\owner/);
    const aliases = nodes(tree, node => node.props?.['data-home-alias']);
    assert.equal(aliases.length, 0);
    env.dispose();
  }
});

test('administrator content is optional and never appears for members or bootstrap-only admin claims', async () => {
  const Admin = () => assert.fail('must not render');
  const blocker = deferred();
  const env = mount({ flag: { user: { ...member, role: 'admin' }, csrf: 'x' }, admin: Admin, fetcher: () => blocker.promise });
  assert.equal(env.registrations.some(row => row.options.id === 'lan-workspace-admin'), false);
  blocker.resolve(success(snapshot())); await tick();
  assert.equal(env.registrations.some(row => row.options.id === 'lan-workspace-admin'), false);
  env.dispose();
  const env2 = mount({ flag: { user: { ...member, role: 'admin' }, csrf: 'x' }, fetcher: async () => success(snapshot({ user: { ...member, role: 'admin' } })) }); await tick();
  assert.equal(env2.registrations.some(row => row.options.id === 'lan-workspace-admin'), false); env2.dispose();
});

test('workspace window receives verified identity and embedded account, and demotion replaces the role', async () => {
  let currentUser = { ...member, role: 'admin' }, received;
  const env = mount({ admin(props) { received = props; return { type: 'p', props: { children: ['Existing administrative content'] } }; }, fetcher: async () => success(snapshot({ user: currentUser })) });
  await tick(); assert.ok(env.registrations.some(row => row.options.name === 'workspace.window'));
  assert.equal(env.registrations.some(row => row.options.name === 'settings.section'), false);
  const entry = nodes(account(env), node => node.type === 'a' && node.props.href === 'http://192.168.2.47:18620/lan/');
  assert.equal(entry.length, 1, 'the shared entry retains the server LAN authority');
  const close = () => {}; env.render('workspace.window', { close });
  assert.equal(received.close, close); assert.equal(received.identity.role, 'admin'); assert.equal(typeof received.AccountSection, 'function');
  assert.equal(received.initialSnapshot.user.id, currentUser.id);
  assert.deepEqual(plain(received.initialSnapshot.projects), [{ id: 'private-project' }]);
  await tick();
  currentUser = member;
  await button(account(env), 'Refresh account').props.onClick();
  account(env); assert.equal(received.identity.role, 'member');
  env.dispose();
});

test('a failed identity refresh withdraws admin, preserves safe copy and exposes a retry', async () => {
  let shouldFail = false, renders = 0;
  const env = mount({ admin() { renders++; return null; }, fetcher: async () => shouldFail ? denied('FORBIDDEN') : success(snapshot({ user: { ...member, role: 'admin' } })) });
  await tick(); account(env); await tick(); const beforeFailure = renders;
  shouldFail = true; await button(account(env), 'Refresh account').props.onClick();
  assert.equal(env.registrations.some(row => row.options.id === 'lan-workspace-admin'), false);
  const tree = account(env); assert.match(text(tree), /could not be refreshed/); assert.doesNotMatch(text(tree), /secret|owner path|implementation detail/);
  assert.equal(button(tree, 'Refresh account').props.disabled, false);
  shouldFail = false; await button(tree, 'Refresh account').props.onClick();
  account(env); assert.ok(renders > beforeFailure); env.dispose();
});

test('identity change or 401 expires safe account and withdraws admin immediately', async () => {
  for (const next of [success(snapshot({ user: { ...member, id: 'usr_other' } })), denied('UNAUTHENTICATED', 401)]) {
    let response = success(snapshot({ user: { ...member, role: 'admin' } }));
    const env = mount({ admin() { return null; }, fetcher: async () => response }); await tick(); response = next;
    await button(account(env), 'Refresh account').props.onClick();
    const tree = account(env);
    assert.match(text(tree), /login expired/); assert.doesNotMatch(text(tree), /Workspace Member|Automatically allocated/);
    assert.equal(nodes(tree, node => node.type === 'a')[0].props.href, '/lan/');
    assert.equal(env.registrations.some(row => row.options.id === 'lan-workspace-admin'), false);
    assert.equal(nodes(tree, node => node.type === 'button').length, 0); env.dispose();
  }
});

test('refresh de-duplicates parallel clicks and disables signout until complete', async () => {
  const pending = deferred(); let count = 0;
  const env = mount({ fetcher: () => ++count === 1 ? success(snapshot()) : pending.promise }); await tick();
  const refresh = button(account(env), 'Refresh account').props.onClick;
  const first = refresh(), second = refresh();
  assert.equal(first, second); assert.equal(env.requests.length, 2);
  assert.equal(button(account(env), 'Sign out').props.disabled, true);
  pending.resolve(success(snapshot())); await first; env.dispose();
});

test('logout uses member auth endpoint once then returns to login without owner state', async () => {
  const pending = deferred();
  const env = mount({ fetcher: request => request.fields.action === 'logout' ? pending.promise : success(snapshot()) }); await tick();
  const logout = button(account(env), 'Sign out').props.onClick;
  const result = logout(); await logout();
  assert.equal(env.requests.filter(row => row.fields.action === 'logout').length, 1);
  assert.equal(env.requests.at(-1).url, '/lan/auth');
  pending.resolve(success({ loggedOut: true })); assert.equal(await result, true);
  assert.equal(env.window.redirect, '/lan/'); assert.match(text(account(env)), /login expired/); env.dispose();
});

test('opening settings during signout cannot race a new identity snapshot', async () => {
  const pending = deferred();
  const env = mount({ fetcher: request => request.fields.action === 'logout' ? pending.promise : success(snapshot()) }); await tick();
  const props = { wide: true, settingsOpen: false, openSettings() {} };
  env.render('settings.launcher', props);
  const result = button(account(env), 'Sign out').props.onClick();
  env.render('settings.launcher', { ...props, settingsOpen: true }); await tick();
  assert.deepEqual(env.requests.map(request => request.fields.action), ['snapshot', 'logout']);
  pending.resolve(success({ loggedOut: true })); await result; env.dispose();
});

test('failed signout remains retryable and never renders server failure details', async () => {
  const env = mount({ fetcher: request => request.fields.action === 'logout' ? denied('AUTH_UNAVAILABLE', 503) : success(snapshot()) }); await tick();
  assert.equal(await button(account(env), 'Sign out').props.onClick(), false);
  assert.equal(env.window.redirect, undefined); const tree = account(env);
  assert.match(text(tree), /Sign out did not complete/); assert.doesNotMatch(text(tree), /secret|owner path/);
  assert.equal(button(tree, 'Sign out').props.disabled, false); env.dispose();
});

test('disposal aborts pending account reads and ignores late successful responses', async () => {
  const pending = deferred(); const env = mount({ fetcher: () => pending.promise });
  assert.equal(env.timer.pending.size, 1); const request = env.requests[0]; env.dispose();
  assert.equal(request.signal.aborted, true); assert.equal(env.timer.pending.size, 0);
  pending.resolve(success(snapshot())); await tick();
  assert.equal(env.registrations.length, 0); assert.equal(env.window.redirect, undefined);
  assert.deepEqual(env.counts(), { registered: 2, released: 2, localeReleased: 2 });
});

test('disposal during logout cannot navigate, including transports that ignore abort', async () => {
  const pending = deferred();
  const env = mount({ fetcher: request => request.fields.action === 'logout' ? pending.promise : success(snapshot()) }); await tick();
  const result = button(account(env), 'Sign out').props.onClick(); env.dispose(); pending.resolve(success({}));
  assert.equal(await result, false); assert.equal(env.window.redirect, undefined); assert.equal(env.timer.pending.size, 0);
});

test('startup registration failure rolls back locale, account resources and prior slots', () => {
  const env = load({ flag: { user: member, csrf: 'x' } });
  let acquired = 0, released = 0;
  const ctx = { effect(fn) { return fn(); },
    inject(_names, apply) {
      ++acquired;
      const dispose = apply({ effect: fn => fn(), get: () => sessionStore([], () => {}) });
      return { dispose() { dispose(); ++released; } };
    },
    locale: { register() { ++acquired; return () => ++released; }, bind() { return key => key; } },
    slots: { inject(name, fn) { return fn(); }, register(opts) { if (opts.name === 'settings.section') throw new Error('section failed'); ++acquired; return () => ++released; } } };
  assert.throws(() => env.exports.apply(ctx), /section failed/);
  assert.equal(acquired, released); assert.equal(env.requests.length, 0); assert.equal(env.timer.pending.size, 0);
});
