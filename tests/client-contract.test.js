import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { Script, createContext } from 'node:vm';
import { LanService, MemoryStore } from '../core/service.js';

// Static source contracts plus a minimal React-hook VM harness. These do not
// emulate a DOM, exercise the live owner carrier, or establish visual / isolation correctness.
const source = await readFile(new URL('../client.js', import.meta.url), 'utf8');
const css = source.match(/const styles = `([\s\S]*?)`;/)?.[1];
const method = name => {
  const start = source.indexOf(`function ${name}(`);
  assert.notEqual(start, -1, `${name} must be present`);
  const end = source.indexOf('\n          function ', start + 1);
  return source.slice(start, end === -1 ? source.length : end);
};

test('native sidebar context menus preserve member preview limits and allow administrator file management', () => {
  const listeners = new Map(), launched = [], clicked = [], focused = [], cleanups = [];
  const tree = { contains: entry => entry === row, addEventListener: (key, fn) => listeners.set(key, fn), removeEventListener: key => listeners.delete(key) };
  const button = { isConnected: true, focus: () => focused.push(true), click: () => clicked.push(true), getBoundingClientRect: () => ({ left: 10, bottom: 40 }) };
  const row = { querySelector: () => button, getAttribute: key => key === 'data-files-entry' ? 'file' : '/home/member/workspace/中文.md' };
  let state = null, installed = false;
  const window = {}, React = { useRef: () => ({ current: { closest: () => tree } }), useState: () => [state, value => { state = value; }], useEffect: fn => { if (!installed) { installed = true; cleanups.push(fn()); } } };
  const start = source.indexOf('        function fileMenuItems('), end = source.indexOf('        function SidebarFileOperation(', start);
  const Menu = Symbol('Menu');
  const sandbox = { React, window, Menu, Promise, nativePreview: null, ctx: { get: () => undefined }, t: key => key, useLocale() {}, isDismissKey: e => e.key === 'Escape', h: (type, props, ...children) => ({ type, props, children }) };
  const Component = new Script(source.slice(start, end) + '\nSidebarFileMenu;').runInNewContext(sandbox);
  const render = () => Component({ sessionId: 'native-session', launch: value => launched.push(value) });
  render(); assert.deepEqual([...listeners.keys()], ['contextmenu', 'keydown']);
  let prevented = false;
  listeners.get('contextmenu')({ type: 'contextmenu', target: { closest: () => row }, clientX: 200, clientY: 150, preventDefault() { prevented = true; }, stopPropagation() {} });
  assert.equal(prevented, true);
  let wrapper = render().children[0], menu = wrapper.children[0]; assert.equal(wrapper.props.style.left, 200);
  assert.deepEqual(Array.from(menu.props.items.filter(item => !item.type), item => item.id), ['view', 'edit', 'download', 'replace', 'rename', 'move', 'delete']);
  menu.props.onSelect('rename'); assert.equal(launched[0].sessionId, 'native-session'); assert.equal(launched[0].path, '/home/member/workspace/中文.md');
  window.__DSH_LAN_ADMIN_PREVIEW__ = true;
  listeners.get('keydown')({ type: 'keydown', key: 'F10', shiftKey: true, target: { closest: () => row }, preventDefault() {}, stopPropagation() {} });
  wrapper = render().children[0]; menu = wrapper.children[0]; assert.equal(wrapper.props.style.top, 40);
  assert.deepEqual(Array.from(menu.props.items, item => item.id), ['view']);
  menu.props.onSelect('delete'); assert.equal(launched.length, 1);
  menu.props.onSelect('view'); assert.equal(clicked.length, 1);
  assert.equal(focused.length, 2);
  sandbox.nativePreview = { sessionId: 'native-session', userId: 'target-account' };
  listeners.get('keydown')({ type: 'keydown', key: 'ContextMenu', target: { closest: () => row }, preventDefault() {}, stopPropagation() {} });
  menu = render().children[0].children[0];
  assert.deepEqual(Array.from(menu.props.items.filter(item => !item.type), item => item.id), ['view', 'edit', 'download', 'replace', 'rename', 'move', 'delete']);
  menu.props.onSelect('rename');
  assert.equal(launched[1].administrator, true); assert.equal(launched[1].userId, 'target-account');
  cleanups.forEach(fn => fn()); assert.equal(listeners.size, 0);
});

test('plain ModuleLoader client compiles without executing the factory', () => {
  assert.doesNotThrow(() => new Script(source, { filename: 'client.js' }));
  assert.match(source, /window\.__ModuleLoader__\.load\(\{/);
  assert.match(source, /id: '@sunbigfly\/dsh-multi-user-service'/);
  assert.deepEqual([...source.matchAll(/require\('([^']+)'\)/g)].map(match => match[1]), ['react', '@deepseek-ai/dsh-client-ui-primitives', '@sunbigfly/dsh-multi-user-service/member-client']);
  assert.match(source, /inject: \['slots', 'locale', 'layout'\]/);
  assert.doesNotMatch(source, /^\s*import\s/m);
});

test('preview files use the native tree with a separate store and target directory, preserving the real session cwd', () => {
  const opened = [], handle = { create: key => ({ key, byTab: {} }) }, native = { options: { key: '@deepseek-ai/dsh-client-ui-sidebar-files' }, store: handle,
    component: Symbol('native-files'), inject: () => ({}), children: { 'sidebar.right.tab.files.actions': { kind: 'list', scope: 'session' } }, locale: 'sidebarFiles' };
  let registration, disposed = false;
  const ctx = { get: () => undefined, slots: { entries: name => name === 'sidebar.right.pane.tab' ? [native] : [], register(options, component) { registration = { options, component }; return () => { disposed = true; }; } } };
  const start = source.indexOf('        function previewFileAddress('), end = source.indexOf('        function releaseNativePreview(', start);
  const mount = new Script(source.slice(start, end) + '\nmountPreviewFileTree;').runInNewContext({ ctx, AbortController, AbortSignal, React: { useCallback: fn => fn, useMemo: fn => fn() }, h: (component, props) => ({ component, props }), failure: (code, message) => Object.assign(Error(message), { code }), t: key => key });
  const snapshot = Object.freeze({ byId: Object.freeze({ admin: Object.freeze({ cwd: '/members/admin/empty' }), other: Object.freeze({ cwd: '/members/other' }) }) });
  const close = mount({ sessionId: 'admin', fileDirectory: '/members/alice/报告' });
  assert.notEqual(registration.options.store, handle);
  assert.deepEqual(Object.keys(registration.options.store.create('scope').byTab), []);
  assert.equal(registration.options.inject, native.inject); assert.equal(registration.options.children['multi-user.preview.files.actions'], native.children['sidebar.right.tab.files.actions']);
  assert.equal(registration.options.key, native.options.key);
  const sessionLifetime = new AbortController();
  const props = { sessionId: 'admin', useSessions: selector => selector(snapshot), useTabInfo: () => ({ tab: { signal: sessionLifetime.signal, actions: { openResource: address => opened.push(address) } } }) };
  const view = registration.component(props); assert.equal(view.component, native.component);
  assert.equal(view.props.useSessions(s => s.byId.admin.cwd), '/members/alice/报告');
  view.props.useTabInfo().tab.actions.openResource('dsh-resource://file/session/admin/%E6%80%BB%E7%BB%93.md');
  assert.equal(opened[0], 'dsh-resource://file/session/admin//members/alice/%E6%8A%A5%E5%91%8A/%E6%80%BB%E7%BB%93.md');
  assert.equal(snapshot.byId.admin.cwd, '/members/admin/empty');
  const other = registration.component({ ...props, sessionId: 'other' });
  assert.equal(other.props.useSessions(s => s.byId.other.cwd), '/members/other');
  assert.equal(mount({ sessionId: 'admin' }), undefined);
  const previewSignal = view.props.useTabInfo().tab.signal;
  close(); assert.equal(disposed, true); assert.equal(previewSignal.aborted, true); assert.equal(sessionLifetime.signal.aborted, false);
});

test('workspace has one additive sidebar launcher and its own native modal, leaving Settings and conversations intact', () => {
  const registrations = [...source.matchAll(/ctx\.slots\.register\(\{([^}]+)\}/g)].map(match => match[1]);
  assert.equal(registrations.length, 10);
  assert.ok(registrations.some(value => /name: 'sidebar\.right\.tab\.files\.actions'/.test(value)));
  assert.ok(registrations.some(value => /name: 'sidebar\.panellist', id, order: 20/.test(value)));
  assert.ok(registrations.some(value => /name: 'shell\.overlay', id/.test(value)));
  assert.doesNotMatch(source, /name: 'settings\.section'/);
  assert.ok(registrations.some(value => /name: 'conversation\.hero\.brand\.mark'/.test(value)));
  assert.ok(registrations.some(value => /name: 'sidebar\.brand\.mark'/.test(value)));
  assert.ok(registrations.some(value => /name: 'sidebar\.brand\.name'/.test(value)));
  assert.ok(registrations.some(value => /name: 'conversation\.composer'/.test(value)));
  assert.match(source, /function Workspace\(\{ close, AccountSection, identity, initialSnapshot, fileAction \} = \{\}\)/);
  assert.match(source, /ctx\.layout\.selectPanel\(previousPanel\); openWorkspaceWindow\(\)/);
  assert.doesNotMatch(source, /createRoot|ReactDOM|document\.(?:body|documentElement|querySelector|getElementById|write)\b|\.innerHTML/);
});

test('localized text uses registered zh/en resources and reacts to locale changes', () => {
  assert.match(source, /zh: \{/);
  assert.match(source, /en: \{/);
  assert.match(source, /ctx\.locale\.register\(NS, locale, dictionary\)/);
  assert.match(source, /ctx\.locale\.bind\(NS\)/);
  assert.match(source, /React\.useSyncExternalStore\(/);
  assert.match(source, /ctx\.locale\.subscribe\(notify\)/);
  assert.match(source, /ctx\.locale\.getSnapshot\(\)/);
  assert.match(source, /disposers\.reverse\(\)\.forEach\(dispose => dispose\(\)\)/);
  const zh = source.match(/zh: \{([\s\S]*?)\n      \},/)?.[1];
  const en = source.match(/en: \{([\s\S]*?)\n      \},/)?.[1];
  const keys = dictionary => [...dictionary.matchAll(/(?:^|[,\n])\s*([A-Za-z][A-Za-z0-9]*):/g)].map(match => match[1]).sort();
  assert.deepEqual(keys(zh), keys(en), 'all locale dictionary keys must agree');
});

test('scoped CSS depends only on inspected DSH theme and navigation tokens', () => {
  assert.ok(css, 'component-local CSS must be present');
  const allowed = new Set([
    '--dsw-alias-bg-base', '--dsw-alias-bg-layer-1', '--dsw-alias-bg-layer-2',
    '--dsw-alias-bg-overlay', '--dsw-alias-border-l1', '--dsw-alias-border-l2',
    '--dsw-alias-brand-primary', '--dsw-alias-label-primary', '--dsw-alias-label-secondary',
    '--dsw-alias-state-error-primary', '--dsw-alias-state-idle-primary',
    '--dsw-alias-state-success-primary', '--dsw-alias-state-warn-primary',
    '--dsw-alias-interactive-bg-hover', '--dsw-alias-state-business-tertiary', '--dsw-alias-label-primary-bluish',
    '--dsw-radius-md', '--dsw-specific-sidebar-nav-item-hover', '--dsw-specific-sidebar-nav-item-active', '--dsh-frame-overlay-top',
  ]);
  for (const [, token] of css.matchAll(/var\((--[\w-]+)/g)) assert.ok(allowed.has(token), token);
  assert.doesNotMatch(css, /#[0-9a-f]{3,8}\b|rgba?\(|hsla?\(/i);
  assert.match(css, /\.lanw\{/);
  assert.match(css, /:focus-visible/);
  assert.match(css, /@media\(max-width:620px\)/);
});

test('transport uses same-origin JSON POST with bearer only in its header', () => {
  assert.match(source, /const ENDPOINT = window\.__DSH_LAN_MEMBER__ \? '\/lan\/api\/lan-workspace' : '\/api\/lan-workspace'/);
  assert.match(source, /const response = await send\(\{/);
  assert.match(source, /method: 'POST', credentials: 'same-origin', headers/);
  assert.match(source, /'Content-Type': 'application\/json'/);
  assert.match(source, /headers\.Authorization = `Bearer \$\{session\.token\}`/);
  assert.match(source, /headers\['X-Lan-CSRF'\] = session\.csrf/);
  assert.match(source, /body: JSON\.stringify\(\{ action, \.\.\.fields \}\)/);
  assert.doesNotMatch(source, /sessionStorage|indexedDB|console\.|document\.cookie|__DSH_BOOT__|URLSearchParams|WebSocket|EventSource/);
  assert.doesNotMatch(source, /headers\[['"]Origin['"]\]/);
});

test('first administrator initialization is explicit owner-confirmed form only', () => {
  assert.match(source, /if \(\['bootstrap', 'owner.recoverAdministrator'\]\.includes\(action\) && ownerSetup === true\) headers\['X-Lan-Owner-Setup'\] = 'confirm'/);
  assert.match(source, /mode === 'bootstrap' && h\(Check, \{ label: t\('setupConsent'\), name: 'confirmOwner', required: true \}\)/);
  assert.match(source, /ownerSetup: mode === 'bootstrap'/);
  assert.doesNotMatch(source, /request\('bootstrap'|run\('bootstrap'|ownerBootstrap:/);
  const mountEffect = source.slice(source.indexOf('React.useEffect(() => {'), source.indexOf('async function run('));
  assert.match(mountEffect, /request\('status'\)/);
  assert.match(mountEffect, /request\('auth\.restore'\)/);
  assert.doesNotMatch(mountEffect, /request\('bootstrap'|request\('login'|request\('redeem'/);
});

test('sessions, cancellation and timeout resources are scoped to component lifetime', () => {
  assert.match(source, /const auth = React\.useRef\(null\)/);
  assert.match(source, /new AbortController\(\)/);
  assert.match(source, /setTimeout\(\(\) => controller\.abort\(\), action === 'admin\.checkIsolation' \? 60000 : 20000\)/);
  assert.match(source, /signal: controller\.signal/);
  assert.match(source, /controllers\.current\.forEach\(controller => controller\.abort\(\)\)/);
  assert.match(source, /timers\.current\.forEach\(timer => clearTimeout\(timer\)\)/);
  assert.match(source, /if \(response\.status === 401\)/);
  assert.match(source, /if \(action === 'logout'\) clearSession\(\)/);
  assert.match(source, /auth\.current = null/);
  assert.doesNotMatch(source, /setInterval\(|heartbeat|projects\.activity/);
});

test('implemented metadata forms use the coordinated action names and field allowlists', () => {
  for (const action of [
    'admin.createUser', 'admin.createInvite',
    'admin.updateUser', 'admin.resetPassword',
  ]) assert.ok(source.includes(`form('${action}'`), action);
  assert.match(source, /routeIds: data\.getAll\('routeIds'\), defaultRouteId: data\.get\('defaultRouteId'\) \|\| null/);
  assert.doesNotMatch(source, /form\('projects\.(create|rename)'/);
  assert.doesNotMatch(source, /admin\.publishEnvironment|admin\.upsertRoute|resourceIds\(|h\('textarea', \{ name: key|name: 'provider'|name: 'model'/);
  assert.match(source, /const adminRoutes = list\(admin\?\.modelCatalog\)/);
  assert.match(source, /function ModelPolicy\(/);
  assert.match(source, /catalog\.filter\(item => allowed\.includes\(item\.id\)\)/);
  assert.match(source, /variant\.effortName \|\| variant\.reasoningEffort/);
  assert.match(source, /plugins: \['pluginCatalog',/);
  assert.doesNotMatch(source, /entriesText\(admin\.environment/);
  assert.doesNotMatch(source, /ownerId:|rootSessionId:|relativePath:|usageCount:|lastActivityAt:|defaultRouteId: data\.get\('provider'\)/);
});

test('administrator model groups sort provider and model names naturally with stable exact-key and effort order', async () => {
  const helper = input => input.slice(input.indexOf('    function modelGroups('), input.indexOf('\n    function ', input.indexOf('    function modelGroups(') + 1));
  const group = new Script(`const list = value => value; ${helper(source)}; modelGroups;`).runInNewContext();
  const rows = [
    { provider: 'b', providerName: 'Provider 10', model: 'm', modelName: 'Model 1', reasoningEffort: 'high' },
    ...['high', 'strange-a', 'off', 'low', 'medium', 'xhigh', 'max', 'strange-b'].map(reasoningEffort => ({ provider: 'a', providerName: 'Provider 2', model: 'm10', modelName: 'Model 10', reasoningEffort })),
    { provider: 'a', providerName: 'Provider 2', model: 'm2', modelName: 'Model 2', reasoningEffort: null },
    { provider: 'a2', providerName: 'Provider 2', model: 'm2', modelName: 'Model 2', reasoningEffort: null },
  ];
  const actual = JSON.parse(JSON.stringify(group(rows)));
  assert.deepEqual(actual.map(item => item.key), ['a2\u0000m2', 'a\u0000m2', 'a\u0000m10', 'b\u0000m']);
  assert.deepEqual(actual[2].variants.map(item => item.reasoningEffort), ['off', 'low', 'medium', 'high', 'xhigh', 'max', 'strange-a', 'strange-b']);
});

test('members have no management tab, foreign project view or route secret display', () => {
  assert.match(source, /const admin = user\?\.role === 'admin' \? snapshot\?\.admin : null/);
  assert.match(source, /user\?\.role === 'admin' \? \[\['management', 'navigationManagement'/);
  assert.match(source, /const projects = list\(snapshot\?\.projects\)/);
  assert.match(source, /list\(snapshot\?\.routes\)\.filter\(route => route\.enabled === true\)/);
  const workspace = method('workspaceView');
  assert.doesNotMatch(workspace, /\.provider|\.model|relativePath|rootSessionId|adminUsers|adminRoutes/);
});

test('owner reservations stay metadata-only without claiming member runtime is unimplemented', () => {
  assert.match(source, /所有者管理入口 · 成员使用独立入口/);
  assert.match(source, /此所有者 API 仅保存项目预留/);
  assert.match(source, /首次打开项目时检查；检查失败不会在宿主执行/);
  assert.match(source, /status\?\.capabilities\?\.isolatedExecution/);
  assert.doesNotMatch(source, /尚未启用局域网共享\/隔离执行|运行后端尚未就绪|runtime backend is unavailable|t\('isolationCode'\)/);
  assert.doesNotMatch(source, /className: 'lanw-terminal'|data-project-reservations|form\('projects\.(?:create|rename)'/);
  assert.doesNotMatch(source, /ctx\.terminal|ctx\.remote|terminal\.open|projects\.open|commands\.execute|child_process|iframe|automation|browser\.open|Office|quota|queue/i);
});

test('member entry only links a server-provided credential-free URL on a distinct hostname', () => {
  const start = source.indexOf('    function memberEntryUrl(');
  const end = source.indexOf('\n\n    return {', start);
  assert.ok(start > 0 && end > start);
  const context = createContext({ URL, window: { location: { href: 'http://127.0.0.1:59844/' } } });
  const validate = new Script(`${source.slice(start, end)}\nmemberEntryUrl;`).runInContext(context);
  assert.equal(validate('http://localhost:59844/lan/'), 'http://localhost:59844/lan/');
  assert.equal(validate('https://members.example.test/lan/'), 'https://members.example.test/lan/');
  for (const value of [null, '', '/lan/', 'javascript:alert(1)', 'file:///lan/', 'http://127.0.0.1:59844/lan/', 'http://127.0.0.1:9999/lan/', 'http://admin:secret@localhost:59844/lan/', 'http://localhost:59844/lan/?token=secret', 'http://localhost:59844/lan/#credential', 'http://localhost:59844/api/', 'http://localhost:59844/lan']) assert.equal(validate(value), null, String(value));
  assert.equal(validate('https://MEMBERS.example.test/lan/', 'https://members.example.test/owner'), null);
  assert.match(source, /const memberUrl = memberEntryUrl\(snapshot\?\.memberUrl \?\? status\?\.memberUrl\)/);
  assert.match(source, /href: memberUrl, target: '_blank', rel: 'noopener noreferrer', referrerPolicy: 'no-referrer'/);
  assert.doesNotMatch(source, /window\.location\.hostname\s*=/);
  context.window.__DSH_LAN_MEMBER__ = true;
  assert.equal(validate('http://127.0.0.1:59844/lan/'), 'http://127.0.0.1:59844/lan/');
  assert.equal(validate('http://admin:secret@127.0.0.1:59844/lan/'), null);
  assert.match(source, /run\('status'\) && user\) await run\('snapshot'\)/);
});

test('usage board displays server aggregates without synthetic zeros or periods', () => {
  const usage = method('usageView');
  assert.match(usage, /const usage = usageValue/);
  assert.match(usage, /const rows = list\(usage\?\.users\)/);
  assert.match(usage, /t\('allTime'\)/);
  assert.match(usage, /'usageEmpty'/);
  assert.match(usage, /t\('usageUnknown'\)/);
  assert.match(source, /typeof value === 'number' && Number\.isFinite\(value\) && value >= 0 \? value\.toLocaleString\(\) : t\('unknown'\)/);
  assert.doesNotMatch(usage, /Math\.random|relativePath|project\.title|provider|prompt|daily|monthly/);
});

function ownerHarness(fetcher, { memberFlag, mountBranding = false, browser = {}, services = {}, rootProps = {}, slotEntries = {}, serverPages = false } = {}) {
  const stores = new Map(), registrations = [], requests = [], storage = new Map(), writes = [], effects = [], cleanups = [];
  let current, index, active, panel = null, firstRender = true;
  const panelListeners = new Set();
  const layout = { panelInfo: { getSnapshot: () => ({ activePanelId: panel }), subscribe(fn) { panelListeners.add(fn); return () => panelListeners.delete(fn); } }, selectPanel(id) { panel = id; for (const fn of panelListeners) fn(); } };
  const React = {
    Fragment: Symbol('Fragment'),
    createElement(type, props, ...children) { return { type, props: { ...(props || {}), children: children.length ? children.flat(Infinity) : undefined } }; },
    useState(initial) { const slot = index++, owner = current; if (!(slot in owner)) owner[slot] = typeof initial === 'function' ? initial() : initial; return [owner[slot], value => { owner[slot] = typeof value === 'function' ? value(owner[slot]) : value; }]; },
    useRef(initial) { const slot = index++; return current[slot] ||= { current: initial }; },
    useCallback(fn, deps) { const slot = index++, old = current[slot]; if (!old || deps.some((value, i) => !Object.is(value, old.deps[i]))) current[slot] = { fn, deps }; return current[slot].fn; },
    useSyncExternalStore(_subscribe, get) { return get(); },
    useEffect(fn, deps) { const slot = index++, owner = current, old = owner[slot]; if (!old || deps.some((value, i) => !Object.is(value, old.deps[i]))) { old?.cleanup?.(); owner[slot] = { deps }; effects.push(() => { owner[slot].cleanup = fn(); }); } },
  };
  function walk(node, path) {
    if (node == null || typeof node !== 'object') return node;
    if (Array.isArray(node)) return node.map((child, i) => walk(child, `${path}.${i}`));
    if (typeof node.type === 'function') {
      const key = `${path}:${node.type.name}:${node.props.key ?? ''}`; active.add(key);
      if (!stores.has(key)) stores.set(key, []);
      const saved = current, savedIndex = index; current = stores.get(key); index = 0;
      const output = node.type(node.props); current = saved; index = savedIndex;
      return walk(output, `${key}/`);
    }
    return { ...node, props: { ...node.props, children: (node.props.children || []).map((child, i) => walk(child, `${path}.${child?.props?.key != null ? `key:${child.props.key}` : i}`)) } };
  }
  let registration;
  let fixtureUsers;
  const userPage = (users, fields = {}) => {
    const rows = users.filter(user => `${user.displayName} ${user.username}`.toLowerCase().includes((fields.query || '').toLowerCase()) && (fields.status === 'archived' ? user.archivedAt != null : fields.includeHistory || user.archivedAt == null) && (!fields.status || ['all', 'archived'].includes(fields.status) || user.disabled === (fields.status === 'disabled')));
    const pageSize = fields.pageSize ?? 10, pages = Math.max(1, Math.ceil(rows.length / pageSize)), page = Math.min(fields.page ?? 0, pages - 1);
    return { items: rows.slice(page * pageSize, (page + 1) * pageSize), page, pages, pageSize, total: rows.length, query: fields.query ?? '', status: fields.status ?? 'all' };
  };
  const window = { location: { href: 'http://127.0.0.1:59072/' }, __ModuleLoader__: { load(value) { registration = value; } }, localStorage: { getItem(key) { return storage.get(key); }, setItem(key, value) { storage.set(key, value); writes.push({ key, value }); }, removeItem(key) { storage.delete(key); } } };
  if (memberFlag !== undefined) window.__DSH_LAN_MEMBER__ = memberFlag;
  const context = createContext({ window, URL, AbortController, setTimeout, clearTimeout, ...browser,
    FormData: class { constructor(form) { this.values = form.values || {}; } get(key) { return this.values[key] ?? null; } getAll(key) { return this.values[key] || []; } has(key) { return key in this.values; } },
    fetch: async (url, options) => {
      const request = { url, ...options, fields: JSON.parse(options.body) }; requests.push(request);
      if (!serverPages && request.fields.action === 'admin.listUsers' && fixtureUsers) return ownerSuccess(userPage(fixtureUsers, request.fields));
      const response = await fetcher(request), envelope = await response.json();
      if (envelope.result?.admin?.users && !envelope.result.admin.userPage) {
        fixtureUsers = envelope.result.admin.users;
        const { items, ...metadata } = userPage(fixtureUsers);
        return { ...response, json: async () => ({ ...envelope, result: { ...envelope.result, admin: { ...envelope.result.admin, users: items, userPage: metadata } } }) };
      }
      return { ...response, json: async () => envelope };
    },
  });
  new Script(source).runInContext(context);
  const locales = new Map();
  if (mountBranding) {
    registrations.push({ options: { name: 'sidebar.brand.mark', priority: 0 }, Component: () => React.createElement('svg', { 'data-native-brand': true }) });
    registrations.push({ options: { name: 'sidebar.brand.name', priority: 0 }, Component: () => React.createElement('span', { 'data-native-brand-name': true }, 'deepseek HARNESS') });
  }
  registration.factory(name => {
    if (name === 'react') return React;
    if (name === '@deepseek-ai/dsh-client-ui-primitives') return {
      Tooltip: ({ children }) => children[0],
      IconInfoOutlineRegular: () => React.createElement('svg', { 'data-native-info-icon': true }),
      Switch: ({ label, checked, disabled = false, onChange }) => React.createElement('button', { type: 'button', role: 'switch', disabled, 'aria-label': label, 'aria-checked': checked, onClick: () => onChange(!checked) }),
      Modal: ({ open, children, onClose, ...props }) => open ? React.createElement('div', { ...props, role: 'dialog', 'data-workspace-window': true }, children.map(child => ({ ...child, props: { ...child.props, close() { onClose(); rootProps.close?.(); } } }))) : null,
      IconSettingsOutlineRegular: () => React.createElement('svg'), IconCloseOutlineRegular: () => React.createElement('svg'),
      Menu: ({ anchor, open, items, onSelect, onClose, ...props }) => React.createElement(React.Fragment, null, anchor, open && React.createElement('div', { ...props, role: 'menu', 'data-native-menu': true, onClose }, items.filter(item => !item.type).map(item => React.createElement('button', { key: item.id, role: 'menuitem', disabled: item.disabled, onClick: () => onSelect(item.id) }, item.label)))),
      IconRefreshOutlineRegular: () => React.createElement('svg', { 'data-native-refresh-icon': true }), FISH_LOGO_VIEWBOX: { width: 24, height: 18 }, FISH_LOGO_PATH: 'M0 0',
    };
    assert.equal(name, '@sunbigfly/dsh-multi-user-service/member-client');
    return { apply(_ctx, { WorkspaceSection, installWorkspace }) {
      const SeededWorkspace = props => React.createElement(WorkspaceSection, { ...props, identity: rootProps.identity, initialSnapshot: rootProps.initialSnapshot });
      cleanups.push(installWorkspace(rootProps.initialSnapshot ? SeededWorkspace : WorkspaceSection));
    } };
  }).apply({
    get(name) { return services[name]; },
    layout,
    effect(fn) { cleanups.push(fn()); },
    locale: { register(_ns, locale, dictionary) { locales.set(locale, dictionary); return () => {}; }, bind() { return key => locales.get('en')[key]; }, subscribe() { return () => {}; }, getSnapshot() { return { active: 'en' }; } },
    slots: { entries(name) { return slotEntries[name] ?? []; }, inject(name, fn) { return !mountBranding && (name === 'conversation.hero.brand.mark' || name.startsWith('sidebar.brand.')) ? () => {} : fn(); }, register(options, Component) { registrations.push({ options, Component }); return () => { const at = registrations.findIndex(row => row.Component === Component && row.options === options); if (at >= 0) registrations.splice(at, 1); }; } },
  });
  return { requests, writes, storage, registrations, layout, render(slot = 'shell.overlay', props = rootProps) {
    if (slot === 'shell.overlay' && firstRender) { firstRender = false; layout.selectPanel('lan-workspace-window'); }
    const entry = registrations.filter(item => item.options.name === slot).sort((a, b) => (a.options.priority ?? 0) - (b.options.priority ?? 0))[0]; if (!entry) return null;
    active = new Set(); const tree = walk(React.createElement(entry.Component, props), 'root');
    for (const [key, hooks] of stores) if (!active.has(key)) { hooks.forEach(hook => hook?.cleanup?.()); stores.delete(key); }
    while (effects.length) effects.shift()(); return tree;
  }, remount(reopen = true) { for (const hooks of stores.values()) hooks.forEach(hook => hook?.cleanup?.()); stores.clear(); firstRender = reopen; }, dispose() { for (const hooks of stores.values()) hooks.forEach(hook => hook?.cleanup?.()); cleanups.reverse().forEach(fn => fn?.()); } };
}
const ownerNodes = (tree, predicate) => {
  const result = []; const visit = node => { if (Array.isArray(node)) return node.forEach(visit); if (!node || typeof node !== 'object') return; if (predicate(node)) result.push(node); node.props?.children?.forEach(visit); }; visit(tree); return result;
};
const ownerText = tree => tree == null ? '' : Array.isArray(tree) ? tree.map(ownerText).filter(Boolean).join(' ') : typeof tree === 'object' ? ownerText(tree.props?.children || []) : String(tree);
const ownerTick = async () => { for (let i = 0; i < 30; ++i) await Promise.resolve(); };
const ownerPageTick = async () => { await new Promise(resolve => setTimeout(resolve, 175)); await ownerTick(); };
function ownerAccountAction(env, tree, id, action = 'edit') {
  const anchor = ownerNodes(tree, node => node.props?.['data-account-manage'] && (id === undefined || node.props['data-account-manage'] === id))[0];
  assert.ok(anchor, 'account management anchor is available'); anchor.props.onClick(); tree = env.render();
  const labels = { edit: 'Edit', archive: 'Archive account', restore: 'Restore account', delete: 'Delete account permanently' };
  const item = ownerNodes(tree, node => node.props?.role === 'menuitem' && ownerText(node) === labels[action])[0];
  assert.ok(item && !item.props.disabled, `account action ${action} is available`); item.props.onClick(); return env.render();
}
function ownerChooseMember(env, tree, attribute, id) {
  ownerNodes(tree, node => node.props?.[attribute])[0].props.onFocus(); tree = env.render();
  const option = ownerNodes(tree, node => node.props?.['data-member-option'] === id)[0]; assert.ok(option, `member ${id} is available`);
  option.props.onClick(); return env.render();
}
const ownerSuccess = result => ({ ok: true, status: 200, json: async () => ({ ok: true, result }) });
const ownerUser = { id: 'usr_owner', username: 'admin', displayName: 'Administrator', role: 'admin' };
function serviceAdminHarness(fetcher) { return ownerHarness(fetcher, { memberFlag: { user: ownerUser, csrf: 'c'.repeat(43) } }); }

test('configured host entry leads to the one service account login without restoring another business identity or minting admin authority', async () => {
  const env = ownerHarness(async ({ fields }) => {
    if (fields.action === 'status') return ownerSuccess({ initialized: true, memberUrl: 'http://team.local:59072/lan/' });
    throw new Error('Host entry must not sign in or load member data');
  });
  env.layout.selectPanel('lan-workspace-window');
  let tree = env.render(); await ownerTick(); tree = env.render(); await ownerTick(); tree = env.render();
  const entry = ownerNodes(tree, node => node.props?.['data-service-entry'])[0];
  assert.ok(entry, ownerText(tree));
  const link = ownerNodes(entry, node => node.props?.['data-service-entry-link'])[0];
  assert.equal(link.props.href, 'http://team.local:59072/lan/'); assert.equal(link.props.rel, 'noopener noreferrer');
  assert.equal(ownerNodes(entry, node => node.type === 'input' && node.props?.type === 'password').length, 0);
  assert.equal(env.requests.some(row => ['auth.restore', 'login', 'bootstrap', 'snapshot'].includes(row.fields.action)), false);
});
const ownerSnapshot = () => ({ user: ownerUser, projects: [], routes: [], admin: { users: [ownerUser], modelCatalog: [], routes: [] } });

test('one account management menu supports archive, restore and confirmed deletion while preserving historical content selection', async t => {
  const core = new LanService({ store: new MemoryStore() }); await core.start(); t.after(() => core.close());
  const password = 'synthetic account lifecycle ui password';
  const admin = await core.execute({ action: 'bootstrap', username: 'admin', displayName: 'Admin', password }, { ownerBootstrap: true });
  const context = { token: admin.token, csrf: admin.csrf };
  const member = (await core.execute({ action: 'admin.createUser', username: 'archive-member', displayName: 'Archive member', password }, context)).user;
  const env = ownerHarness(async ({ fields }) => {
    if (fields.action === 'auth.restore') return ownerSuccess({ user: admin.user, csrf: admin.csrf, cookieSession: true });
    if (fields.action === 'admin.content') return ownerSuccess({ items: [], total: 0 });
    try { return ownerSuccess(await core.execute(fields, context)); }
    catch (error) { return { ok: false, status: error.status || 500, json: async () => ({ ok: false, error: { code: error.code, message: error.message } }) }; }
  }, { serverPages: true });
  t.after(() => env.dispose());
  env.render(); await ownerTick(); let tree = env.render();
  const row = () => ownerNodes(tree, node => node.props?.['data-account-row'] === member.id)[0];
  for (let i = 0; i < 12 && !row(); i++) { await ownerTick(); tree = env.render(); }
  assert.ok(row(), ownerText(tree));
  assert.equal(ownerNodes(row(), node => node.type === 'button').length, 1, 'one compact button fits the existing action column');
  assert.equal(ownerText(ownerNodes(row(), node => node.type === 'button')[0]), 'Manage');
  const submit = async () => {
    ownerNodes(tree, node => node.props?.id === 'lanw-account-operation-form')[0].props.onSubmit({ preventDefault() {} });
    for (let i = 0; i < 4; i++) { tree = env.render(); await ownerTick(); }
    tree = env.render(); await ownerPageTick(); tree = env.render();
  };
  const filter = async status => { ownerNodes(tree, node => node.props?.['data-account-filter'] === status)[0].props.onClick(); tree = env.render(); await ownerPageTick(); tree = env.render(); };
  tree = ownerAccountAction(env, tree, member.id, 'archive'); assert.match(ownerText(tree), /Revoke sign-ins/);
  await submit(); assert.equal(row(), undefined);
  await filter('archived'); assert.ok(row());
  tree = ownerAccountAction(env, tree, member.id, 'restore'); await submit(); assert.equal(row(), undefined);
  await filter('all'); assert.ok(row());
  tree = ownerAccountAction(env, tree, member.id, 'archive'); await submit(); await filter('archived');
  tree = ownerAccountAction(env, tree, member.id, 'delete'); assert.match(ownerText(tree), /Keep conversations, personal files/);
  const confirmButton = () => ownerNodes(tree, node => node.type === 'button' && node.props?.form === 'lanw-account-operation-form')[0];
  assert.equal(confirmButton().props.disabled, true);
  const writes = env.requests.filter(row => row.fields.action === 'admin.deleteUser').length;
  await submit(); assert.equal(env.requests.filter(row => row.fields.action === 'admin.deleteUser').length, writes);
  ownerNodes(tree, node => node.props?.name === 'confirmUsername')[0].props.onChange({ target: { value: 'archive-member' } }); tree = env.render();
  assert.equal(confirmButton().props.disabled, false); await submit(); assert.equal(row(), undefined);
  const deleted = env.requests.find(row => row.fields.action === 'admin.deleteUser');
  assert.equal(deleted.fields.confirmUsername, 'archive-member'); assert.equal(deleted.fields.expectedRevision, 3); assert.equal(deleted.headers['X-Lan-CSRF'], admin.csrf);
  ownerNodes(tree, node => node.props?.['data-admin-tab'] === 'sessions')[0].props.onClick(); tree = env.render(); await ownerPageTick(); tree = env.render();
  ownerNodes(tree, node => node.props?.['data-content-member'])[0].props.onFocus(); tree = env.render(); await ownerPageTick(); tree = env.render();
  const historical = ownerNodes(tree, node => node.props?.['data-member-option'] === member.id)[0];
  assert.match(ownerText(historical), /Deleted account/); historical.props.onClick(); tree = env.render();
  assert.equal(ownerNodes(tree, node => node.props?.['data-content-member'])[0].props['data-member-value'], member.id);
  assert.ok(env.requests.some(row => row.fields.action === 'admin.listUsers' && row.fields.includeHistory === true));
});

test('sidebar workspace opens one modal without changing the underlying selected panel, then restores its opener', async () => {
  const env = ownerHarness(async ({ fields }) => ownerSuccess(fields.action === 'status' ? { initialized: true } : fields.action === 'auth.restore' ? { user: ownerUser, csrf: 'csrf', cookieSession: true } : ownerSnapshot()));
  env.layout.selectPanel('plugins'); env.render(); await ownerTick(); let tree = env.render();
  assert.equal(env.layout.panelInfo.getSnapshot().activePanelId, 'plugins');
  assert.equal(ownerNodes(tree, node => node.props?.['data-workspace-window']).length, 1);
  assert.deepEqual(ownerNodes(tree, node => node.type === 'button' && node.props?.['data-workspace-page']).map(node => node.props['data-workspace-page']), ['account', 'preferences', 'sessions', 'files', 'accounts', 'models', 'sharing', 'branding', 'usage']);
  assert.deepEqual(ownerNodes(tree, node => node.props?.['data-navigation-group']).map(node => node.props['data-navigation-group']), ['personal', 'workspace', 'management']);
  assert.equal(env.registrations.some(row => row.options.name === 'settings.section'), false);
  ownerNodes(tree, node => node.props?.className === 'lanw-window-close')[0].props.onClick();
  assert.equal(ownerNodes(env.render(), node => node.props?.['data-workspace-window']).length, 0);
  assert.equal(env.layout.panelInfo.getSnapshot().activePanelId, 'plugins');
  env.layout.selectPanel(null); env.layout.selectPanel('lan-workspace-window');
  assert.equal(env.layout.panelInfo.getSnapshot().activePanelId, null);
  assert.equal(ownerNodes(env.render(), node => node.props?.['data-workspace-window']).length, 1);
  env.dispose();
});

test('member workspace exposes personal capabilities and own content, even when a snapshot includes admin fields', async () => {
  const user = { ...ownerUser, role: 'member' };
  const env = ownerHarness(async () => ownerSuccess({ ...ownerSnapshot(), user }), { memberFlag: { user, csrf: 'member-csrf' } });
  env.render(); await ownerTick(); const tree = env.render();
  assert.deepEqual(ownerNodes(tree, node => node.type === 'button' && node.props?.['data-workspace-page']).map(node => node.props['data-workspace-page']), ['account', 'preferences', 'usage', 'sessions', 'files']);
  assert.deepEqual(ownerNodes(tree, node => node.props?.['data-navigation-group']).map(node => node.props['data-navigation-group']), ['personal', 'workspace']);
  const personalNavigation = ownerNodes(tree, node => node.props?.['data-navigation-group'] === 'personal')[0];
  assert.deepEqual(ownerNodes(personalNavigation, node => node.props?.['data-workspace-page']).map(node => node.props['data-workspace-page']), ['account', 'preferences', 'usage']);
  assert.equal(ownerNodes(tree, node => node.props?.['data-admin-console']).length, 0);
  assert.equal(ownerNodes(tree, node => node.type === 'button' && node.props?.['aria-current'] === 'page')[0].props['data-workspace-page'], 'account');
  env.dispose();
});

test('every account authorization page uses the same heading, explanation and one visible content panel', async () => {
  const env = ownerHarness(async ({ fields }) => ownerSuccess(fields.action === 'status' ? { initialized: true } : fields.action === 'auth.restore' ? { user: ownerUser, csrf: 'csrf', cookieSession: true } : ownerSnapshot()));
  env.render(); await ownerTick(); let tree = env.render();
  tree = ownerAccountAction(env, tree);
  for (const page of ['models', 'capabilities', 'limits', 'directories', 'status', 'security']) {
    const nav = ownerNodes(tree, node => node.props?.['data-access-section'] === page)[0];
    nav.props.onClick(); tree = env.render();
    const body = ownerNodes(tree, node => node.props?.className === 'lanw-edit-body')[0];
    const headers = ownerNodes(body, node => node.props?.className === 'lanw-page-heading');
    assert.equal(headers.length, 1, page);
    assert.equal(ownerText(ownerNodes(headers[0], node => node.type === 'h2')[0]), ownerText(nav));
    assert.ok(ownerText(ownerNodes(headers[0], node => node.type === 'p')[0]).length > 10, page);
    assert.deepEqual(ownerNodes(body, node => node.props?.['data-access-panel'] && !node.props.hidden).map(node => node.props['data-access-panel']), [page]);
    assert.equal(ownerNodes(body, node => node.props?.id === 'lanw-account-access-form')[0].props.hidden, ['limits', 'security'].includes(page), 'inactive forms keep their drafts without reserving blank space');
  }
  env.dispose();
});

test('native feature switches retain submitted checkbox values and the existing unsaved-change guard', async () => {
  const env = ownerHarness(async ({ fields }) => ownerSuccess(fields.action === 'status' ? { initialized: true } : fields.action === 'auth.restore' ? { user: ownerUser, csrf: 'csrf', cookieSession: true } : ownerSnapshot()));
  env.render(); await ownerTick(); let tree = env.render();
  tree = ownerAccountAction(env, tree);
  ownerNodes(tree, node => node.props?.['data-access-section'] === 'capabilities')[0].props.onClick(); tree = env.render();
  const toggle = ownerNodes(tree, node => node.props?.role === 'switch')[0];
  ownerNodes(tree, node => node.props?.className === 'lanw-edit-body')[0].props.onClickCapture({ target: { closest: () => ({}) } });
  toggle.props.onClick(); tree = env.render();
  assert.equal(ownerNodes(tree, node => node.props?.name === 'access.terminal')[0].props.checked, false);
  ownerNodes(tree, node => node.props?.['data-access-section'] === 'models')[0].props.onClick(); tree = env.render();
  ownerNodes(tree, node => node.props?.['data-access-section'] === 'capabilities')[0].props.onClick(); tree = env.render();
  assert.equal(ownerNodes(tree, node => node.props?.name === 'access.terminal')[0].props.checked, false);
  ownerNodes(tree, node => node.props?.['data-close-editor'])[0].props.onClick(); tree = env.render();
  assert.equal(ownerNodes(tree, node => node.props?.['data-discard-edit']).length, 1);
  assert.equal(env.requests.some(row => row.fields.action === 'admin.updateUser'), false);
  env.dispose();
});

test('create and invite open independent dialogs without shrinking the list and protect unsaved input', async () => {
  const env = ownerHarness(async () => ownerSuccess(ownerSnapshot()), { memberFlag: { user: ownerUser, csrf: 'm'.repeat(43) } });
  env.render(); await ownerTick(); let tree = env.render();
  for (const kind of ['create', 'invite']) {
    ownerNodes(tree, node => node.props?.['data-account-action'] === kind)[0].props.onClick(); tree = env.render();
    const dialog = ownerNodes(tree, node => node.type === 'dialog' && node.props?.['data-account-editor'] === kind)[0];
    assert.ok(dialog); assert.equal(ownerNodes(tree, node => node.props?.className?.includes('has-panel')).length, 0);
    assert.equal(ownerNodes(tree, node => node.props?.['data-account-row']).length, 1);
    assert.equal(ownerNodes(dialog, node => node.type === 'form')[0].props.id, `lanw-account-${kind}-form`);
    assert.ok(ownerNodes(dialog, node => node.type === 'button' && node.props?.form === `lanw-account-${kind}-form`).length);
    assert.equal(ownerNodes(dialog, node => node.props?.['data-modal-autofocus']).length, 1);
    ownerNodes(dialog, node => node.props?.className === 'lanw-edit-body')[0].props.onChangeCapture(); tree = env.render();
    ownerNodes(tree, node => node.props?.['data-close-editor'])[0].props.onClick(); tree = env.render();
    const warning = ownerNodes(tree, node => node.props?.['data-discard-edit'])[0]; assert.ok(warning);
    ownerNodes(warning, node => node.type === 'button' && ownerText(node) === 'Discard changes')[0].props.onClick(); tree = env.render();
    assert.equal(ownerNodes(tree, node => node.type === 'dialog').length, 0);
  }
  assert.equal(env.requests.some(row => ['admin.createUser', 'admin.createInvite'].includes(row.fields.action)), false); env.dispose();
});

test('invitation uses the shared two-step flow, submits once after permissions, and shows a completed result without an unsaved-change warning', async () => {
  const env = ownerHarness(async ({ fields }) => ownerSuccess(fields.action === 'admin.createInvite' ? { inviteToken: 'synthetic-one-time-invitation', expiresAt: 20000 } : ownerSnapshot()),
    { memberFlag: { user: ownerUser, csrf: 'm'.repeat(43) } });
  env.render(); await ownerTick(); let tree = env.render();
  ownerNodes(tree, node => node.props?.['data-account-action'] === 'invite')[0].props.onClick(); tree = env.render();
  ownerNodes(tree, node => node.props?.className === 'lanw-edit-body')[0].props.onChangeCapture(); tree = env.render();
  const form = () => ownerNodes(tree, node => node.type === 'form' && node.props.id === 'lanw-account-invite-form')[0];
  const submit = () => form().props.onSubmit({ preventDefault() {}, currentTarget: { values: { displayName: 'Synthetic invitation', modelAccess: 'inherit', toolAccess: 'custom', toolNames: ['read'], 'access.files': 'on' }, reset() {} } });
  await submit(); tree = env.render();
  assert.equal(env.requests.some(row => row.fields.action === 'admin.createInvite'), false);
  assert.equal(ownerNodes(tree, node => node.props?.['data-account-step'] === 1)[0].props.hidden, false);
  ownerNodes(tree, node => node.props?.['data-account-previous'])[0].props.onClick(); tree = env.render();
  assert.equal(ownerNodes(tree, node => node.props?.['data-account-step'] === 0)[0].props.hidden, false);
  await submit(); tree = env.render();
  await submit();
  await ownerTick(); tree = env.render();
  assert.equal(ownerNodes(tree, node => node.type === 'dialog' && node.props['data-account-editor'] === 'invite').length, 1);
  assert.equal(ownerNodes(tree, node => node.props?.readOnly && node.props.value?.endsWith('/lan/#invite=synthetic-one-time-invitation')).length, 1);
  const calls = env.requests.filter(row => row.fields.action === 'admin.createInvite');
  assert.equal(calls.length, 1); assert.equal(calls[0].fields.displayName, 'Synthetic invitation');
  assert.equal(calls[0].fields.access.files, true); assert.deepEqual(calls[0].fields.access.tools, ['read']);
  assert.equal(calls[0].fields.password, undefined); assert.equal(calls[0].fields.username, undefined);
  assert.equal(form().props.hidden, true);
  const footer = ownerNodes(tree, node => node.props?.className === 'lanw-edit-footer')[0];
  assert.equal(ownerNodes(footer, node => node.type === 'button' && node.props.type === 'submit').length, 0);
  assert.equal(ownerNodes(footer, node => node.type === 'button' && ownerText(node) === 'Done').length, 1);
  tree = env.render(); // Flush the successful-save effect before exercising close.
  ownerNodes(tree, node => node.props?.['data-close-editor'])[0].props.onClick(); tree = env.render();
  assert.equal(ownerNodes(tree, node => node.props?.['data-discard-edit']).length, 0); assert.equal(ownerNodes(tree, node => node.type === 'dialog').length, 0); env.dispose();
});

test('account setup advances without creating, supports returning to details, and submits identity and permissions together only at the final step', async () => {
  const env = ownerHarness(async () => ownerSuccess(ownerSnapshot()), { memberFlag: { user: ownerUser, csrf: 'm'.repeat(43) } });
  env.render(); await ownerTick(); let tree = env.render();
  ownerNodes(tree, node => node.props?.['data-account-action'] === 'create')[0].props.onClick(); tree = env.render();
  const section = step => ownerNodes(tree, node => node.props?.['data-account-step'] === step)[0];
  const form = () => ownerNodes(tree, node => node.type === 'form' && node.props.id === 'lanw-account-create-form')[0];
  const submitted = { username: 'wizard-synthetic', displayName: 'Synthetic wizard member', password: 'synthetic-wizard-password', modelAccess: 'custom', routeIds: ['route-a'], defaultRouteId: 'route-a', 'access.files': 'on', toolAccess: 'custom', toolNames: ['read'], skillsMode: 'custom', skillNames: ['skill-a'] };
  const event = () => ({ preventDefault() {}, currentTarget: { values: submitted, reset() {} } });
  assert.equal(section(0).props.hidden, false); assert.equal(section(1).props.hidden, true);
  assert.equal(ownerNodes(tree, node => node.props?.['aria-current'] === 'step').length, 1);
  await form().props.onSubmit(event()); tree = env.render();
  assert.equal(env.requests.some(row => row.fields.action === 'admin.createUser'), false);
  assert.equal(section(0).props.hidden, true); assert.equal(section(1).props.hidden, false);
  assert.equal(ownerNodes(section(0), node => node.type === 'input' && node.props.name === 'password').length, 1, 'identity inputs remain mounted');
  ownerNodes(tree, node => node.props?.['data-account-previous'])[0].props.onClick(); tree = env.render();
  assert.equal(section(0).props.hidden, false); assert.equal(section(1).props.hidden, true);
  await form().props.onSubmit(event()); tree = env.render();
  await form().props.onSubmit(event()); await ownerTick(); tree = env.render();
  const calls = env.requests.filter(row => row.fields.action === 'admin.createUser');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].fields.username, submitted.username); assert.equal(calls[0].fields.displayName, submitted.displayName); assert.equal(calls[0].fields.password, submitted.password);
  assert.deepEqual(calls[0].fields.routeIds, ['route-a']); assert.equal(calls[0].fields.defaultRouteId, 'route-a');
  assert.equal(calls[0].fields.access.files, true); assert.equal(calls[0].fields.access.terminal, false);
  assert.deepEqual(calls[0].fields.access.tools, ['read']); assert.deepEqual(calls[0].fields.access.skills, ['skill-a']);
  assert.equal(ownerNodes(tree, node => node.type === 'dialog').length, 0); env.dispose();
});

test('personal capability drafts survive category changes, save only own preferences and respect administrator locks', async () => {
  const user = { ...ownerUser, role: 'member' }, selection = { terminal: true, files: true, attachments: true, tasks: true, subagents: true, interactions: true, tools: null, skills: null, agentPresets: null, permissionPresets: null, plugins: null, mcpServers: null };
  let revision = 0, saved = { ...selection };
  const snapshot = () => ({ ...ownerSnapshot(), user, preferences: { revision, selection: saved, granted: { ...selection, terminal: false }, effective: { ...saved, terminal: false }, catalog: { skills: [{ id: 'a', label: 'Skill A' }, { id: 'b', label: 'Skill B' }], plugins: [], mcpServers: [], agentPresets: [], permissionPresets: [] } } });
  const env = ownerHarness(async ({ fields }) => {
    if (fields.action === 'preferences.update') { saved = { ...fields.access }; revision++; return ownerSuccess({ user, preferences: snapshot().preferences }); }
    if (fields.action === 'member.content') return ownerSuccess({ items: [], total: 0 });
    return ownerSuccess(snapshot());
  }, { memberFlag: { user, csrf: 'c'.repeat(43) } });
  env.render(); await ownerTick(); let tree = env.render();
  const personal = () => ownerNodes(tree, node => node.props?.['data-personal-capabilities'])[0];
  let switches = ownerNodes(personal(), node => node.props?.role === 'switch');
  assert.equal(switches[0].props.disabled, true); assert.equal(switches[0].props['aria-checked'], false);
  switches[1].props.onClick(); tree = env.render();
  ownerNodes(personal(), node => node.props?.['data-personal-section'] === 'skills')[0].props.onClick(); tree = env.render();
  ownerNodes(personal(), node => node.props?.value === 'a')[0].props.onChange({ target: { checked: false } }); tree = env.render();
  ownerNodes(personal(), node => node.props?.['data-personal-section'] === 'features')[0].props.onClick(); tree = env.render();
  assert.equal(ownerNodes(personal(), node => node.props?.role === 'switch')[1].props['aria-checked'], false);
  await personal().props.onSubmit({ preventDefault() {} }); await ownerTick(); tree = env.render();
  const request = env.requests.find(row => row.fields.action === 'preferences.update');
  assert.equal(request.fields.access.files, false); assert.deepEqual(request.fields.access.skills, ['b']); assert.equal(request.fields.expectedRevision, 0);
  assert.equal(request.headers['X-Lan-CSRF'], 'c'.repeat(43)); assert.equal(Object.hasOwn(request.fields, 'userId'), false);
  assert.equal(ownerNodes(personal(), node => node.props?.['data-save-personal'])[0].props.disabled, true);
  assert.equal(ownerNodes(tree, node => node.props?.['data-workspace-page'] === 'files')[0].props.disabled, true);
  assert.equal(env.requests.some(row => row.fields.action.startsWith('admin.')), false); env.dispose();
});

test('member content uses own endpoints and opens the owned conversation natively without an admin preview', async () => {
  const user = { ...ownerUser, role: 'member' }, opened = []; let closed = 0;
  const env = ownerHarness(async ({ fields }) => {
    if (fields.action === 'member.content') {
      if (fields.operation === 'sessions.list') return ownerSuccess({ items: [{ sessionId: 'own-session', userId: user.id, title: 'My conversation', filePath: 'workspace/own', running: false }], total: 1 });
      if (fields.operation === 'session.preview') return ownerSuccess({ self: true, sessionId: 'own-session' });
      throw Error('Unexpected own content operation');
    }
    return ownerSuccess({ ...ownerSnapshot(), user });
  }, { memberFlag: { user, csrf: 'c'.repeat(43) }, services: { uiWorkspace: { openSession: id => opened.push(id) } }, rootProps: { close() { closed++; } } });
  env.render(); await ownerTick(); let tree = env.render();
  ownerNodes(tree, node => node.props?.['data-workspace-page'] === 'sessions')[0].props.onClick(); env.render();
  await new Promise(resolve => setTimeout(resolve, 180)); await ownerTick(); tree = env.render();
  assert.equal(ownerNodes(tree, node => node.props?.['data-content-member']).length, 0);
  assert.equal(ownerNodes(tree, node => node.props?.['data-member-content']).length, 1);
  await ownerNodes(tree, node => node.props?.['data-content-entry'] === 'own-session')[0].props.onClick(); await ownerTick();
  assert.deepEqual(opened, ['own-session']); assert.equal(closed, 1);
  assert.equal(env.registrations.some(row => row.options.name === 'conversation.composer'), false);
  assert.ok(env.requests.filter(row => row.fields.action === 'member.content').every(row => row.fields.userId === user.id));
  assert.equal(env.requests.some(row => row.fields.action === 'admin.content'), false); env.dispose();
});

test('owner HttpOnly cookie restore loads a snapshot without a bearer and signs out with CSRF', async () => {
  const env = ownerHarness(async request => {
    if (request.fields.action === 'status') return ownerSuccess({ initialized: true });
    if (request.fields.action === 'auth.restore') return ownerSuccess({ user: ownerUser, csrf: 'cookie-csrf', cookieSession: true, remember: true });
    return ownerSuccess(request.fields.action === 'snapshot' ? ownerSnapshot() : {});
  });
  env.render(); await ownerTick(); let tree = env.render();
  assert.deepEqual(env.requests.map(request => request.fields.action), ['status', 'auth.restore', 'snapshot']);
  assert.match(ownerText(tree), /Administrator/); assert.ok(env.requests.every(request => !request.headers.Authorization));
  ownerNodes(tree, node => node.type === 'button' && ownerText(node) === 'Sign out')[0].props.onClick(); await ownerTick(); tree = env.render();
  assert.equal(env.requests.at(-1).headers['X-Lan-CSRF'], 'cookie-csrf'); assert.ok(ownerNodes(tree, node => node.props?.name === 'password').length); env.dispose();
});

test('owner unauthenticated restore is quiet and explicit login remembers username only', async () => {
  const env = ownerHarness(async request => {
    if (request.fields.action === 'status') return ownerSuccess({ initialized: true });
    if (request.fields.action === 'auth.restore') return { ok: false, status: 401, json: async () => ({ ok: false, error: { code: 'UNAUTHENTICATED', message: 'Sign in required' } }) };
    if (request.fields.action === 'login') return ownerSuccess({ user: ownerUser, csrf: 'cookie-csrf', cookieSession: true, remember: true });
    return ownerSuccess(ownerSnapshot());
  });
  env.render(); await ownerTick(); const tree = env.render();
  assert.equal(ownerNodes(tree, node => node.props?.role === 'alert').length, 0);
  const checkbox = ownerNodes(tree, node => node.props?.name === 'remember')[0]; assert.equal(checkbox.props.checked, true);
  assert.equal(ownerNodes(tree, node => node.props?.name === 'username')[0].props.autoComplete, 'username');
  assert.equal(ownerNodes(tree, node => node.props?.name === 'password')[0].props.autoComplete, 'current-password');
  const form = ownerNodes(tree, node => node.type === 'form')[0];
  await form.props.onSubmit({ preventDefault() {}, currentTarget: { values: { username: 'remembered_admin', password: 'NEVER_PERSIST_THIS_PASSWORD', remember: 'on' }, reset() {} } }); await ownerTick();
  const login = env.requests.find(request => request.fields.action === 'login'); assert.equal(login.fields.remember, true);
  assert.deepEqual(env.writes, [{ key: 'lan-workspace.owner.username', value: 'remembered_admin' }]);
  assert.doesNotMatch(JSON.stringify(env.writes), /NEVER_PERSIST|cookie-csrf|token/); env.dispose();
});

test('owner unchecked remember removes only the username and legacy bearer stays memory-only', async () => {
  const env = ownerHarness(async request => {
    if (request.fields.action === 'status') return ownerSuccess({ initialized: true });
    if (request.fields.action === 'auth.restore') return { ok: false, status: 401, json: async () => ({ ok: false, error: { code: 'UNAUTHENTICATED' } }) };
    if (request.fields.action === 'login') return ownerSuccess({ user: ownerUser, csrf: 'legacy-csrf', token: 'legacy-memory-bearer' });
    return ownerSuccess(ownerSnapshot());
  });
  env.storage.set('lan-workspace.owner.username', 'previous_admin'); env.render(); await ownerTick(); let tree = env.render();
  assert.equal(ownerNodes(tree, node => node.props?.name === 'username')[0].props.defaultValue, 'previous_admin');
  ownerNodes(tree, node => node.props?.name === 'remember')[0].props.onChange({ target: { checked: false } }); tree = env.render();
  assert.equal(env.storage.has('lan-workspace.owner.username'), false);
  await ownerNodes(tree, node => node.type === 'form')[0].props.onSubmit({ preventDefault() {}, currentTarget: { values: { username: 'temporary_admin', password: 'NOT_IN_STORAGE' }, reset() {} } }); await ownerTick();
  assert.equal(env.requests.find(request => request.fields.action === 'login').fields.remember, false);
  assert.equal(env.requests.at(-1).headers.Authorization, 'Bearer legacy-memory-bearer');
  assert.equal(env.writes.length, 0); assert.equal(env.storage.size, 0); env.dispose();
});

test('owner model authorization survives navigation to the native sharing summary', async () => {
  const catalog = Array.from({ length: 11 }, (_, index) => ({ id: `rte_${index}`, label: `Provider · Model ${index} · High`, provider: index === 10 ? 'second-provider' : 'provider', providerName: index === 10 ? 'Second provider' : 'Provider', model: `model${index}`, modelName: `Model ${index}`, reasoningEffort: 'high', effortName: 'High' }));
  const skills = Array.from({ length: 12 }, (_, index) => ({ id: `skill${index}`, label: `Skill ${index}`, status: index === 11 ? 'unavailable' : 'ready', shared: true, reason: 'Incompatible adapter' }));
  const env = ownerHarness(async request => {
    if (request.fields.action === 'status') return ownerSuccess({ initialized: true });
    if (request.fields.action === 'auth.restore') return ownerSuccess({ user: ownerUser, csrf: 'cookie-csrf', cookieSession: true });
    if (request.fields.action === 'snapshot') return ownerSuccess({ ...ownerSnapshot(), sharedHostEnvironment: { status: 'partial', skills, mcp: [], agents: [] }, admin: { users: [ownerUser], modelCatalog: catalog, hostSharing: { revision: 4, defaultShared: true, disabled: {} } } });
    return ownerSuccess({});
  });
  env.render(); await ownerTick(); let tree = env.render();
  const click = (root, label) => ownerNodes(root, node => node.type === 'button' && ownerText(node) === label)[0].props.onClick();
  click(tree, 'Members'); tree = env.render();
  assert.equal(ownerNodes(tree, node => node.props?.['data-model-row'] || node.props?.['data-resource-row']).length, 0);
  assert.equal(ownerNodes(tree, node => node.type === 'form').length, 0, 'accounts list must not mount account forms before an explicit action');
  assert.equal(ownerNodes(tree, node => node.props?.['data-account-editor']).length, 0);
  click(tree, 'New account'); tree = env.render();
  const getForm = () => ownerNodes(tree, node => node.type === 'form' && ownerNodes(node, child => child.props?.name === 'username').length)[0];
  const mode = ownerNodes(getForm(), node => node.props?.name === 'modelAccess')[0];
  assert.equal(mode.props.value, 'inherit');
  assert.equal(ownerNodes(getForm(), node => node.type === 'fieldset' && node.props.hidden)[0].props.disabled, true);
  mode.props.onChange({ target: { value: 'custom' } }); tree = env.render();
  ownerNodes(getForm(), node => node.props?.['data-model-policy'])[0].props.onToggle({ currentTarget: { open: true } }); tree = env.render();
  assert.equal(ownerNodes(getForm(), node => node.props?.['data-model-row']).length, 5);
  assert.deepEqual(ownerNodes(getForm(), node => node.props?.['data-model-provider']).map(ownerText), ['Provider'], 'provider appears once per visible group, not on every model row');
  assert.equal(ownerNodes(getForm(), node => node.type === 'input' && node.props.type === 'search')[0].props['aria-label'], 'Search provider or model');
  assert.equal(ownerNodes(getForm(), node => node.props?.className === 'lanw-model-count')[0].props.children[0], '0 / 1');
  ownerNodes(getForm(), node => node.props?.['data-model-row'])[0].props.onToggle({ currentTarget: { open: true } }); tree = env.render();
  ownerNodes(getForm(), node => node.props?.['data-variant'] === 'rte_0')[0].props.onChange({ target: { checked: true } }); tree = env.render(); click(getForm(), 'Next page'); tree = env.render();
  assert.deepEqual(ownerNodes(getForm(), node => node.props?.name === 'routeIds').map(node => node.props.value), ['rte_0']);
  ownerNodes(tree, node => node.props?.['data-admin-tab'] === 'models')[0].props.onClick(); tree = env.render();
  assert.equal(ownerNodes(tree, node => node.props?.['data-model-catalog'])[0].props.open, true);
  ownerNodes(tree, node => node.props?.['data-admin-tab'] === 'sharing')[0].props.onClick(); tree = env.render();
  const summary = ownerNodes(tree, node => node.props?.['data-native-sharing'])[0];
  assert.ok(summary); assert.match(ownerText(summary), /Members inherit existing host capabilities/);
  assert.equal(ownerNodes(tree, node => node.props?.['data-plugin-sharing'] || node.props?.['data-startup-environment']).length, 0);
  ownerNodes(tree, node => node.props?.['data-admin-tab'] === 'accounts')[0].props.onClick(); tree = env.render();
  assert.deepEqual(ownerNodes(getForm(), node => node.props?.name === 'routeIds').map(node => node.props.value), ['rte_0']);
  assert.equal(env.requests.filter(request => request.fields.action.startsWith('admin.')).length, 0);
  env.dispose();
});

test('owner native management page starts with searchable account rows and explicit inline actions without metrics', async () => {
  const member = { id: 'usr_member', username: 'mei', displayName: 'Mei Chen', role: 'member', disabled: true, routeIds: ['rte_a', 'rte_b'] };
  const snapshot = { ...ownerSnapshot(), sharedHostEnvironment: { status: 'partial', skills: [{ id: 'ready', status: 'ready', shared: true }, { id: 'private', status: 'ready', shared: false }, { id: 'bad', status: 'unavailable', shared: true }], mcp: [], agents: [] }, admin: { users: [ownerUser, member], modelCatalog: [{ id: 'rte_a', provider: 'p', model: 'm', providerName: 'Provider', modelName: 'Model' }, { id: 'rte_b', provider: 'p', model: 'm', providerName: 'Provider', modelName: 'Model', reasoningEffort: 'high' }] } };
  const env = serviceAdminHarness(async request => request.fields.action === 'status' ? ownerSuccess({ initialized: true, memberUrl: 'http://localhost:59072/lan/' }) : request.fields.action === 'auth.restore' ? ownerSuccess({ user: ownerUser, csrf: 'csrf', cookieSession: true }) : ownerSuccess(snapshot));
  env.render(); await ownerTick(); let tree = env.render();
  assert.equal(ownerNodes(tree, node => node.type === 'form').length, 0);
  assert.equal(ownerNodes(tree, node => node.props?.['data-admin-tab'] === 'accounts')[0].props['aria-current'], 'page');
  assert.equal(ownerNodes(tree, node => node.props?.['data-admin-metric']).length, 0, 'native page has no dashboard metrics');
  assert.doesNotMatch(source, /lanw-metrics|data-admin-metric|const metrics =/);
  assert.equal(ownerNodes(tree, node => node.type === 'h1').length, 1);
  assert.ok(ownerNodes(tree, node => node.type === 'button' && node.props?.['aria-label'] === 'Refresh').length);
  assert.equal(ownerNodes(tree, node => node.type === 'a' && ownerText(node) === 'Separate member entry').length, 0);
  assert.equal(ownerNodes(tree, node => node.props?.['data-workspace-info']).length, 1);
  const row = ownerNodes(tree, node => node.props?.['data-account-row'] === member.id)[0];
  assert.match(ownerText(row), /Mei Chen @mei Member Disabled Custom · 2 Manage/);
  assert.ok(ownerNodes(row, node => node.props?.className === 'lanw-status is-disabled').length);
  ownerNodes(tree, node => node.props?.['data-account-search'])[0].props.onChange({ target: { value: 'MEI' } }); tree = env.render(); await ownerPageTick(); tree = env.render();
  assert.equal(ownerNodes(tree, node => node.props?.['data-account-row']).length, 1);
  tree = ownerAccountAction(env, tree);
  assert.equal(ownerNodes(tree, node => node.props?.['data-account-editor'])[0].props['data-account-editor'], 'edit');
  assert.equal(ownerNodes(tree, node => node.props?.name === 'disabled')[0].props.defaultChecked, true);
  assert.equal(ownerNodes(tree, node => node.props?.['data-password-danger'])[0].props.open, undefined, 'password reset is folded by default');
  assert.equal(ownerNodes(tree, node => node.props?.['data-model-policy'])[0].props.open, false);
  ownerNodes(tree, node => node.props?.['data-close-editor'])[0].props.onClick(); tree = env.render();
  assert.equal(ownerNodes(tree, node => node.type === 'form').length, 0);
  ownerNodes(tree, node => node.props?.['data-account-search'])[0].props.onChange({ target: { value: 'not-found' } }); tree = env.render(); await ownerPageTick(); tree = env.render();
  assert.match(ownerText(tree), /No matching accounts/); env.dispose();
});

test('account pagination follows filtering and search, with inherited model access explicit', async () => {
  const users = Array.from({ length: 23 }, (_, i) => ({ id: `usr_${i}`, username: `member${i}`, displayName: `Member ${i}`, role: 'member', disabled: i % 2 === 0, modelAccess: 'inherit', routeIds: [] }));
  const snapshot = { ...ownerSnapshot(), admin: { users, modelCatalog: [] } };
  const env = ownerHarness(async request => request.fields.action === 'status' ? ownerSuccess({ initialized: true }) : request.fields.action === 'auth.restore' ? ownerSuccess({ user: ownerUser, csrf: 'csrf', cookieSession: true }) : ownerSuccess(snapshot));
  env.render(); await ownerTick(); let tree = env.render();
  const rows = () => ownerNodes(tree, node => node.props?.['data-account-row']);
  const pagination = () => ownerNodes(tree, node => node.props?.['data-account-pagination'])[0];
  const next = () => ownerNodes(pagination(), node => node.type === 'button' && ownerText(node) === 'Next page')[0];
  assert.equal(rows().length, 10); assert.match(ownerText(rows()[0]), /Inherit host/);
  next().props.onClick(); tree = env.render(); await ownerPageTick(); tree = env.render(); assert.equal(rows()[0].props['data-account-row'], 'usr_10');
  next().props.onClick(); tree = env.render(); await ownerPageTick(); tree = env.render(); assert.equal(rows().length, 3); assert.equal(next().props.disabled, true);
  ownerNodes(tree, node => node.props?.['data-account-filter'] === 'enabled')[0].props.onClick(); tree = env.render(); await ownerPageTick(); tree = env.render();
  assert.equal(rows().length, 10); assert.equal(rows()[0].props['data-account-row'], 'usr_1');
  ownerNodes(tree, node => node.props?.['data-account-search'])[0].props.onChange({ target: { value: 'member21' } }); tree = env.render(); await ownerPageTick(); tree = env.render();
  assert.equal(rows().length, 1); assert.equal(rows()[0].props['data-account-row'], 'usr_21');
  assert.match(ownerText(pagination()), /1 \/ 1/); assert.equal(next().props.disabled, true);
  env.dispose();
});

test('server member queries ignore stale replies, retain filters after a save and recover from errors', async () => {
  const outside = { ...ownerUser, id: 'usr_outside', username: 'outside', displayName: 'Server result', role: 'member', revision: 4 };
  const page = items => ({ items, total: items.length, page: 0, pageSize: 10, pages: 1 });
  let oldReply, newReply, newRequests = 0, fail = true;
  const env = ownerHarness(async ({ fields }) => {
    if (fields.action === 'status') return ownerSuccess({ initialized: true });
    if (fields.action === 'auth.restore') return ownerSuccess({ user: ownerUser, csrf: 'csrf', cookieSession: true });
    if (fields.action === 'snapshot') return ownerSuccess(ownerSnapshot());
    if (fields.action === 'admin.updateUser') return ownerSuccess({ user: outside });
    assert.equal(fields.action, 'admin.listUsers');
    if (fields.query === 'old') return new Promise(resolve => { oldReply = () => resolve(ownerSuccess(page([{ ...outside, displayName: 'Obsolete result' }]))); });
    if (fields.query === 'new' && newRequests++ === 0) return new Promise(resolve => { newReply = () => resolve(ownerSuccess(page([outside]))); });
    if (fields.query === 'error' && fail) return { ok: false, status: 503, json: async () => ({ ok: false, error: { code: 'STORAGE_FAILURE', message: 'Synthetic list failure' } }) };
    return ownerSuccess(page(fields.query === 'empty' ? [] : [outside]));
  }, { serverPages: true });
  env.render(); await ownerTick(); let tree = env.render();
  const search = value => { ownerNodes(tree, node => node.props?.['data-account-search'])[0].props.onChange({ target: { value } }); tree = env.render(); };
  const settle = async () => { await ownerPageTick(); tree = env.render(); };
  search('old'); await settle(); assert.equal(typeof oldReply, 'function');
  search('new'); await settle(); assert.equal(typeof newReply, 'function'); newReply(); await ownerTick(); tree = env.render();
  assert.ok(ownerNodes(tree, node => node.props?.['data-account-row'] === outside.id).length);
  oldReply(); await ownerTick(); tree = env.render(); assert.doesNotMatch(ownerText(tree), /Obsolete result/);
  tree = ownerAccountAction(env, tree);
  const form = ownerNodes(tree, node => node.props?.id === 'lanw-account-access-form')[0];
  await form.props.onSubmit({ preventDefault() {}, currentTarget: { values: { modelAccess: 'inherit' }, reset() {} } }); await ownerTick(); tree = env.render(); await settle();
  assert.equal(env.requests.find(row => row.fields.action === 'admin.updateUser').fields.expectedRevision, 4);
  assert.equal(ownerNodes(tree, node => node.props?.['data-account-search'])[0].props.value, 'new');
  assert.ok(newRequests >= 2, 'a save refreshes the current server query');
  search('error'); await settle(); assert.match(ownerText(tree), /Synthetic list failure/); fail = false;
  ownerNodes(tree, node => node.type === 'button' && ownerText(node) === 'Retry')[0].props.onClick(); tree = env.render(); await settle();
  assert.equal(ownerNodes(tree, node => node.props?.['data-account-row']).length, 1);
  search('empty'); await settle(); assert.equal(ownerNodes(tree, node => node.props?.['data-account-row']).length, 0);
  assert.match(ownerText(ownerNodes(tree, node => node.props?.['data-account-pagination'])[0]), /1 \/ 1/);
  env.dispose();
});

test('content member search finds an account outside the first page and keeps it when the search clears', async () => {
  const users = Array.from({ length: 23 }, (_, i) => ({ ...ownerUser, id: `usr_page_${i}`, username: `member${i}`, displayName: `Member ${i}`, role: 'member' }));
  const snapshot = { ...ownerSnapshot(), admin: { ...ownerSnapshot().admin, users } };
  const env = ownerHarness(async ({ fields }) => fields.action === 'status' ? ownerSuccess({ initialized: true }) : fields.action === 'auth.restore' ? ownerSuccess({ user: ownerUser, csrf: 'csrf', cookieSession: true }) : fields.action === 'admin.content' ? ownerSuccess({ items: [], total: 0, page: 0 }) : ownerSuccess(snapshot));
  env.render(); await ownerTick(); let tree = env.render();
  ownerNodes(tree, node => node.props?.['data-workspace-page'] === 'sessions')[0].props.onClick(); tree = env.render(); await ownerPageTick(); tree = env.render();
  ownerNodes(tree, node => node.props?.['data-member-picker-search'])[0].props.onChange({ target: { value: 'member22' } }); tree = env.render(); await ownerPageTick(); tree = env.render();
  const select = () => ownerNodes(tree, node => node.props?.['data-content-member'])[0];
  assert.ok(ownerNodes(tree, node => node.props?.['data-member-option'] === users[22].id).length);
  ownerNodes(tree, node => node.props?.['data-member-option'] === users[22].id)[0].props.onClick(); tree = env.render();
  ownerNodes(tree, node => node.props?.['data-member-picker-search'])[0].props.onChange({ target: { value: '' } }); tree = env.render();
  assert.equal(select().props['data-member-value'], users[22].id);
  assert.ok(ownerNodes(tree, node => node.props?.['data-member-option'] === users[22].id).length, 'selected metadata stays available outside the initial choices');
  ownerNodes(tree, node => node.props?.['data-workspace-page'] === 'files')[0].props.onClick(); tree = env.render(); await ownerPageTick(); tree = env.render();
  assert.equal(env.requests.findLast(row => row.fields.operation === 'files.list').fields.userId, users[22].id);
  assert.ok(env.requests.some(row => row.fields.action === 'admin.listUsers' && row.fields.summary === true)); env.dispose();
});

test('usage board abbreviates large values without changing exact accessible totals or unknown bounds', async () => {
  const snapshot = { ...ownerSnapshot(), usage: { unknown: true, users: [{ displayName: 'Sample', calls: 1234, inputTokens: 1200000, outputTokens: 2500000000, totalTokens: 2501200000, unknownCalls: 1, incomplete: true }] } };
  const env = ownerHarness(async request => request.fields.action === 'status' ? ownerSuccess({ initialized: true }) : request.fields.action === 'auth.restore' ? ownerSuccess({ user: ownerUser, csrf: 'csrf', cookieSession: true }) : ownerSuccess(snapshot));
  env.render(); await ownerTick(); let tree = env.render();
  ownerNodes(tree, node => node.type === 'button' && node.props?.['data-workspace-page'] === 'usage')[0].props.onClick(); tree = env.render();
  const cells = ownerNodes(tree, node => node.type === 'td' && node.props['aria-label'] !== undefined);
  assert.deepEqual(cells.map(ownerText), ['1.2K', '≥ 1.2M', '≥ 2.5B', '≥ 2.5B', '1']);
  assert.equal(cells[3].props['aria-label'], '≥ 2,501,200,000'); env.dispose();
});

test('usage searches and filters server pages, resets page and rejects stale results with retry', async () => {
  const users = Array.from({ length: 23 }, (_, i) => ({ displayName: `Usage ${i}`, calls: i, inputTokens: null, outputTokens: null, totalTokens: null, unknownCalls: null, incomplete: true }));
  const page = fields => {
    const selected = fields.query ? users.filter(row => row.displayName.toLowerCase().includes(fields.query)) : fields.status === 'disabled' ? users.slice(20) : users;
    const size = fields.pageSize ?? 10, pages = Math.max(1, Math.ceil(selected.length / size)), index = Math.min(fields.page ?? 0, pages - 1);
    return { users: selected.slice(index * size, (index + 1) * size), total: selected.length, page: index, pageSize: size, pages, unknown: true };
  };
  const snapshot = { ...ownerSnapshot(), usage: page({}) };
  let releaseOld, fail = true;
  const env = ownerHarness(async ({ fields }) => {
    if (fields.action === 'status') return ownerSuccess({ initialized: true });
    if (fields.action === 'auth.restore') return ownerSuccess({ user: ownerUser, csrf: 'csrf', cookieSession: true });
    if (fields.action === 'snapshot') return ownerSuccess(snapshot);
    assert.equal(fields.action, 'usage.list');
    if (fields.query === 'old') return new Promise(resolve => { releaseOld = () => resolve(ownerSuccess({ ...page({}), users: [{ displayName: 'Stale usage' }] })); });
    if (fields.query === 'error' && fail) return { status: 503, ok: false, json: async () => ({ ok: false, error: { code: 'USAGE_UNAVAILABLE', message: 'Synthetic usage failure' } }) };
    return ownerSuccess(page(fields));
  }, { serverPages: true });
  env.render(); await ownerTick(); let tree = env.render();
  ownerNodes(tree, node => node.props?.['data-workspace-page'] === 'usage')[0].props.onClick(); tree = env.render();
  const rows = () => ownerNodes(ownerNodes(tree, node => node.props?.className?.split(' ').includes('lanw-usage'))[0], node => node.type === 'tbody')[0]?.props.children ?? [];
  const pager = () => ownerNodes(tree, node => node.props?.['data-usage-pagination'])[0];
  const next = () => ownerNodes(pager(), node => node.type === 'button' && ownerText(node) === 'Next page')[0];
  const settle = async () => { await ownerPageTick(); tree = env.render(); };
  const search = value => { ownerNodes(tree, node => node.props?.['data-usage-search'])[0].props.onChange({ target: { value } }); tree = env.render(); };
  assert.equal(rows().length, 10);
  next().props.onClick(); tree = env.render(); await settle(); assert.match(ownerText(rows()[0]), /Usage 10/);
  next().props.onClick(); tree = env.render(); await settle(); assert.equal(rows().length, 3); assert.equal(next().props.disabled, true);
  ownerNodes(tree, node => node.props?.['data-usage-filter'] === 'disabled')[0].props.onClick(); tree = env.render(); await settle();
  assert.equal(rows().length, 3); assert.match(ownerText(pager()), /1 \/ 1/);
  search('old'); await settle(); assert.equal(typeof releaseOld, 'function');
  search('usage 22'); await settle(); assert.equal(rows().length, 1); assert.match(ownerText(rows()[0]), /Usage 22/);
  releaseOld(); await ownerTick(); tree = env.render(); assert.doesNotMatch(ownerText(tree), /Stale usage/);
  search('error'); await settle(); assert.match(ownerText(tree), /Synthetic usage failure/); fail = false;
  ownerNodes(tree, node => node.type === 'button' && ownerText(node) === 'Retry')[0].props.onClick(); tree = env.render(); await settle();
  assert.doesNotMatch(ownerText(tree), /Synthetic usage failure/); assert.match(ownerText(tree), /No matching accounts/);
  search(''); await settle();
  ownerNodes(tree, node => node.props?.['data-usage-page-size'])[0].props.onChange({ target: { value: '20' } }); tree = env.render(); await settle();
  assert.equal(env.requests.filter(row => row.fields.action === 'usage.list').at(-1).fields.pageSize, 20);
  assert.equal(env.requests.filter(row => row.fields.action === 'usage.list').at(-1).fields.status, 'disabled');
  env.dispose();
});

test('member management remount retains the authenticated snapshot while refreshing', async () => {
  let hold = false, release;
  const env = ownerHarness(async () => hold ? new Promise(resolve => { release = () => resolve(ownerSuccess(ownerSnapshot())); }) : ownerSuccess(ownerSnapshot()), { memberFlag: { user: ownerUser, csrf: 'm'.repeat(43) } });
  env.render(); await ownerTick(); let tree = env.render();
  assert.equal(ownerNodes(tree, node => node.props?.['data-account-row']).length, 1);
  hold = true; env.remount(); tree = env.render(); await ownerTick(); tree = env.render();
  assert.equal(ownerNodes(tree, node => node.props?.['data-account-row']).length, 1);
  assert.doesNotMatch(ownerText(tree), /snapshot is unavailable|Sign in/);
  assert.equal(ownerNodes(tree, node => node.props?.['data-admin-tab'] === 'sharing')[0].props.disabled, false);
  release(); await ownerTick(); env.dispose();
});

test('account access categories keep all fields mounted and preserve unsaved choices', async () => {
  const snapshot = { ...ownerSnapshot(), admin: { ...ownerSnapshot().admin, pluginCatalog: [{ id: 'synthetic-plugin', label: 'Synthetic plugin' }] } };
  const env = ownerHarness(async request => request.fields.action === 'status' ? ownerSuccess({ initialized: true }) : request.fields.action === 'auth.restore' ? ownerSuccess({ user: ownerUser, csrf: 'csrf', cookieSession: true }) : ownerSuccess(snapshot));
  env.render(); await ownerTick(); let tree = env.render();
  tree = ownerAccountAction(env, tree);
  const selectSection = id => { ownerNodes(tree, node => node.props?.['data-access-section'] === id)[0].props.onClick(); tree = env.render(); };
  const selectCapability = id => { ownerNodes(tree, node => node.props?.['data-capability-section'] === id)[0].props.onClick(); tree = env.render(); };
  const mode = () => ownerNodes(tree, node => node.props?.name === 'pluginsMode')[0];
  selectSection('capabilities'); selectCapability('plugins'); mode().props.onChange({ target: { value: 'custom' } }); tree = env.render();
  selectCapability('features'); assert.equal(ownerNodes(tree, node => node.props?.name === 'modelAccess').length, 1);
  selectSection('models'); selectSection('capabilities'); selectCapability('plugins'); assert.equal(mode().props.value, 'custom');
  assert.deepEqual(ownerNodes(tree, node => node.props?.['data-capability-panel'] && !node.props.hidden).map(node => node.props['data-capability-panel']), ['plugins']);
  assert.equal(ownerNodes(tree, node => node.props?.['data-capability-tabs'] === 'administrator').length, 1);
  assert.equal(ownerNodes(tree, node => node.props?.['data-access-panel'] === 'capabilities')[0].props.hidden, false);
  assert.equal(ownerNodes(tree, node => node.props?.['data-access-panel'] === 'models')[0].props.hidden, true);
  assert.equal(ownerNodes(tree, node => node.props?.['data-plugin-policy'])[0].type, 'section'); env.dispose();
});

test('saved branding uses both native logo surfaces and replaces the wrapped native headline', async () => {
  const branding = { revision: 1, logo: 'https://example.test/logo.png', slogan: 'Shared home', name: 'Team', badge: 'LAN' };
  const env = ownerHarness(async () => ownerSuccess({ initialized: true, branding }), { mountBranding: true });
  await ownerTick();
  const hero = env.render('conversation.hero.brand.mark');
  assert.equal(ownerNodes(hero, node => node.props?.['data-lanw-brand-slogan'])[0].props.children[0], 'Shared home');
  assert.equal(ownerNodes(hero, node => node.type === 'img')[0].props.src, branding.logo);
  const style = ownerNodes(hero, node => node.type === 'style')[0].props.children[0];
  assert.match(style, /span:has\(\[data-lanw-brand-mark\]\[data-custom-slogan=true\]\)\+span>span:first-child/);
  const sidebar = env.render('sidebar.brand.mark');
  assert.equal(ownerNodes(sidebar, node => node.type === 'img')[0].props.src, branding.logo);
  assert.equal(sidebar.props.style.width, 24); assert.equal(sidebar.props.style.height, 24);
  assert.equal(ownerNodes(sidebar, node => node.type === 'img')[0].props.style.objectFit, 'contain');
  assert.equal(ownerNodes(hero, node => node.type === 'img')[0].props.style.maxWidth, 120);
  assert.match(ownerText(env.render('sidebar.brand.name')), /Team LAN/); env.dispose();
  const defaults = ownerHarness(async () => ownerSuccess({ initialized: true, branding: { revision: 0, logo: null, slogan: null } }), { mountBranding: true });
  await ownerTick(); assert.equal(defaults.render('conversation.hero.brand.mark'), null); assert.equal(defaults.render('sidebar.brand.mark').props['data-native-brand'], true); defaults.dispose();
});

test('administrator branding previews drafts, persists exact fields and restores defaults', async () => {
  let branding = { revision: 0, logo: null, slogan: null, name: null, badge: null, showPreviewBadge: true };
  const env = ownerHarness(async request => {
    if (request.fields.action === 'status') return ownerSuccess({ initialized: true, branding });
    if (request.fields.action === 'auth.restore') return ownerSuccess({ user: ownerUser, csrf: 'brand-csrf', cookieSession: true });
    if (request.fields.action === 'admin.updateBranding') {
      const { logo, slogan, name, badge, showPreviewBadge, expectedRevision } = request.fields; assert.equal(expectedRevision, branding.revision);
      branding = { revision: expectedRevision + 1, logo, slogan, name, badge, showPreviewBadge }; return ownerSuccess({ branding });
    }
    return ownerSuccess({ ...ownerSnapshot(), branding });
  });
  env.render(); await ownerTick(); let tree = env.render();
  ownerNodes(tree, node => node.props?.['data-admin-tab'] === 'branding')[0].props.onClick(); tree = env.render();
  const slogan = () => ownerNodes(tree, node => node.props?.name === 'brandSlogan')[0];
  slogan().props.onChange({ target: { value: 'Build together' } }); tree = env.render();
  ownerNodes(tree, node => node.props?.name === 'brandName')[0].props.onChange({ target: { value: 'Team' } }); tree = env.render();
  ownerNodes(tree, node => node.props?.name === 'brandBadge')[0].props.onChange({ target: { value: 'LAN' } }); tree = env.render();
  assert.equal(ownerNodes(tree, node => node.props?.name === 'showPreviewBadge')[0].props.checked, true);
  assert.equal(ownerNodes(tree, node => node.props?.['data-brand-preview-badge'])[0].type, 'span');
  ownerNodes(tree, node => node.props?.name === 'showPreviewBadge')[0].props.onChange({ target: { checked: false } }); tree = env.render();
  assert.equal(ownerNodes(tree, node => node.props?.['data-brand-preview-badge']).length, 0);
  assert.match(ownerText(ownerNodes(tree, node => node.props?.['data-brand-preview'])[0]), /Build together/);
  ownerNodes(tree, node => node.props?.['data-admin-tab'] === 'accounts')[0].props.onClick(); tree = env.render();
  ownerNodes(tree, node => node.props?.['data-admin-tab'] === 'branding')[0].props.onClick(); tree = env.render();
  assert.equal(slogan().props.value, 'Build together');
  await ownerNodes(tree, node => node.props?.['data-branding-form'])[0].props.onSubmit({ preventDefault() {} }); await ownerTick(); tree = env.render();
  assert.deepEqual(branding, { revision: 1, logo: null, slogan: 'Build together', name: 'Team', badge: 'LAN', showPreviewBadge: false });
  const saved = env.requests.find(x => x.fields.action === 'admin.updateBranding'); assert.equal(saved.headers['X-Lan-CSRF'], 'brand-csrf');
  ownerNodes(tree, node => node.type === 'button' && ownerText(node) === 'Use default appearance')[0].props.onClick(); tree = env.render();
  await ownerNodes(tree, node => node.props?.['data-branding-form'])[0].props.onSubmit({ preventDefault() {} }); await ownerTick(); tree = env.render();
  assert.deepEqual(branding, { revision: 2, logo: null, slogan: null, name: null, badge: null, showPreviewBadge: true }); env.dispose();
});

test('preview badge can be hidden with native logo and headline left at their defaults', async () => {
  const branding = { revision: 1, logo: null, slogan: null, showPreviewBadge: false };
  const env = ownerHarness(async () => ownerSuccess({ initialized: true, branding }), { mountBranding: true });
  await ownerTick(); const hero = env.render('conversation.hero.brand.mark');
  assert.equal(hero.props['data-show-preview-badge'], false);
  assert.equal(hero.props['data-custom-slogan'], false);
  assert.equal(ownerNodes(hero, node => node.props?.['data-lanw-brand-slogan']).length, 0);
  assert.match(ownerText(ownerNodes(hero, node => node.type === 'style')[0]), /data-show-preview-badge=false\]\)\+span>span:nth-child\(2\)/);
  assert.equal(env.render('sidebar.brand.mark').props['data-native-brand'], true);
  env.dispose();
});

test('administrator content entry opens the selected member in the native conversation with a read-only block and CSRF', async () => {
  const member = { id: 'usr_member', username: 'alice', displayName: 'Alice', role: 'member', disabled: true };
  const snapshot = ownerSnapshot(); snapshot.admin.users.push(member);
  const blocks = new Map(), opened = [], settingsOpened = []; let mounted = 'session-admin', listener, closed = 0, released = 0;
  const services = {
    sessions: { refresh: async () => {}, retain: id => ({ ready: Promise.resolve(), release() { released++; } }) },
    uiWorkspace: { openSession(id) { opened.push(id); mounted = id; listener?.(); } },
    sidebarRight: { mounted: { getSnapshot: () => mounted, subscribe(fn) { listener = fn; return () => { listener = null; }; } } },
    conversation: { blocks: { set(id, value) { blocks.set(id, value); }, storeFor: id => ({ getSnapshot: () => blocks.get(id) }) } },
  };
  const env = ownerHarness(async request => {
    if (request.fields.action === 'status') return ownerSuccess({ initialized: true });
    if (request.fields.action === 'auth.restore') return ownerSuccess({ user: ownerUser, csrf: 'content-csrf', cookieSession: true });
    if (request.fields.action === 'admin.content') {
      if (request.fields.operation === 'sessions.list') return ownerSuccess({ items: [{ sessionId: 'session-alice', userId: member.id, displayName: 'Alice', title: 'Alice conversation', running: false, filePath: 'workspace/alice' }], total: 1 });
      if (request.fields.operation === 'session.preview') return ownerSuccess({ previewId: 'preview-a', sessionId: 'session-alice', displayName: 'Alice' });
      if (request.fields.operation === 'preview.close') return ownerSuccess({ closed: true });
      throw Error('Unexpected content operation');
    }
    return ownerSuccess(snapshot);
  }, { services, rootProps: { close() { closed++; } }, browser: { requestAnimationFrame: fn => fn(), cancelAnimationFrame() {} }, slotEntries: { 'sidebar.settings': [{ store: { create: () => ({ actions: { openSection: id => settingsOpened.push(id) } }) } }] } });
  assert.equal(env.registrations.some(row => row.options.name === 'conversation.composer'), false, 'blank native home keeps its original composer');
  env.render(); await ownerTick(); let tree = env.render();
  assert.equal(env.requests.some(row => row.fields.action === 'admin.content'), false);
  ownerNodes(tree, node => node.props?.['data-admin-tab'] === 'sessions')[0].props.onClick(); tree = env.render();
  await new Promise(resolve => setTimeout(resolve, 180)); await ownerTick(); tree = env.render();
  assert.ok(ownerNodes(tree, node => node.props?.['data-admin-content']).length);
  assert.match(ownerText(tree), /Alice conversation/);
  ownerNodes(tree, node => node.props?.['data-content-member'])[0].props.onFocus(); tree = env.render();
  assert.match(ownerText(ownerNodes(tree, node => node.props?.['data-member-option'] === member.id)[0]), /Alice/);
  ownerNodes(tree, node => node.props?.['data-content-member'])[0].props.onKeyDown({ key: 'Escape', preventDefault() {}, stopPropagation() {} }); tree = env.render();
  await ownerNodes(tree, node => node.type === 'button' && ownerText(node) === 'Alice conversation')[0].props.onClick(); await ownerTick(); tree = env.render();
  assert.deepEqual(opened, ['session-alice']); assert.equal(closed, 1); assert.equal(released, 1);
  assert.match(blocks.get('session-alice').reason, /Read-only/);
  const previewSeat = env.registrations.find(row => row.options.name === 'conversation.composer');
  assert.ok(previewSeat.options.select({ sessionId: 'session-alice' }));
  assert.equal(previewSeat.options.select({ sessionId: 'session-admin' }), null);
  assert.equal(env.requests.some(row => row.fields.operation === 'session.read'), false);
  const read = env.requests.find(row => row.fields.operation === 'session.preview');
  assert.equal(read.fields.userId, member.id); assert.equal(read.headers['X-Lan-CSRF'], 'content-csrf');
  env.remount();
  env.render(); await ownerTick(); tree = env.render();
  ownerNodes(tree, node => node.props?.['data-admin-tab'] === 'sessions')[0].props.onClick(); env.render();
  await new Promise(resolve => setTimeout(resolve, 180)); await ownerTick(); tree = env.render();
  tree = ownerChooseMember(env, tree, 'data-content-member', member.id);
  ownerNodes(tree, node => node.type === 'input' && node.props.maxLength === 200)[0].props.onChange({ target: { value: 'Alice' } });
  ownerNodes(tree, node => node.props?.['data-content-advanced'] === 'sessions')[0].props.onClick(); tree = env.render();
  ownerNodes(tree, node => node.props?.['data-filter-field'] === 'archive')[0].props.onChange({ target: { value: 'all' } }); tree = env.render();
  ownerNodes(tree, node => node.props?.['data-content-filter-form'] === 'sessions')[0].props.onSubmit({ preventDefault() {} });
  env.render(); await new Promise(resolve => setTimeout(resolve, 180)); await ownerTick(); tree = env.render();
  await ownerNodes(tree, node => node.type === 'button' && ownerText(node) === 'Alice conversation')[0].props.onClick(); await ownerTick();
  assert.deepEqual(opened, ['session-alice', 'session-alice']);
  env.remount();
  const preview = env.render('conversation.composer', { sessionId: 'session-alice' });
  ownerNodes(preview, node => node.type === 'button' && ownerText(node) === 'End preview')[0].props.onClick();
  await ownerTick();
  assert.equal(ownerNodes(env.render(), node => node.props?.['data-workspace-window']).length, 1, 'End preview reopens the workspace window');
  assert.equal(opened.at(-1), 'session-admin', 'successive previews keep the original return conversation');
  assert.equal(env.requests.find(row => row.fields.operation === 'preview.close').headers['X-Lan-CSRF'], 'content-csrf', 'native preview releases after settings unmount clears its authentication ref');
  env.render(); await ownerTick(); tree = env.render();
  assert.equal(ownerNodes(tree, node => node.props?.['data-admin-tab'] === 'sessions')[0].props['aria-current'], 'page');
  assert.equal(ownerNodes(tree, node => node.props?.['data-content-member'])[0].props['data-member-value'], member.id);
  assert.equal(ownerNodes(tree, node => node.type === 'input' && node.props.maxLength === 200)[0].props.value, 'Alice');
  ownerNodes(tree, node => node.props?.['data-content-advanced'] === 'sessions')[0].props.onClick(); tree = env.render();
  assert.equal(ownerNodes(tree, node => node.props?.['data-filter-field'] === 'archive')[0].props.value, 'all');
  env.dispose();
  assert.equal(blocks.get('session-alice'), undefined);
  assert.equal(env.registrations.some(row => row.options.name === 'conversation.composer'), false);
});

test('native previews navigate before slow history is ready, reuse known metadata and remain read-only on failure or cancellation', async () => {
  for (const outcome of ['ready', 'failed', 'cancelled']) {
    const member = { id: 'usr_member', username: 'alice', displayName: 'Alice', role: 'member' };
    const snapshot = ownerSnapshot(); snapshot.admin.users.push(member);
    const opening = Promise.withResolvers(), blocks = new Map(), opened = [];
    let mounted = 'session-admin', listener, refreshes = 0, released = 0, closed = 0;
    const services = {
      sessions: { list: { getSnapshot: () => ({ byId: { 'session-alice': {} } }) }, refresh: async () => { refreshes++; }, retain: () => ({ ready: opening.promise, release() { released++; opening.reject(Error('cancelled')); } }) },
      uiWorkspace: { openSession(id) { opened.push(id); mounted = id; listener?.(); } },
      sidebarRight: { mounted: { getSnapshot: () => mounted, subscribe(fn) { listener = fn; return () => { listener = null; }; } } },
      conversation: { blocks: { set(id, value) { blocks.set(id, value); }, storeFor: id => ({ getSnapshot: () => blocks.get(id) }) } },
    };
    const env = ownerHarness(async ({ fields }) => {
      if (fields.action === 'status') return ownerSuccess({ initialized: true });
      if (fields.action === 'auth.restore') return ownerSuccess({ user: ownerUser, csrf: 'preview-csrf', cookieSession: true });
      if (fields.action !== 'admin.content') return ownerSuccess(snapshot);
      if (fields.operation === 'sessions.list') return ownerSuccess({ items: [{ sessionId: 'session-alice', userId: member.id, displayName: 'Alice', title: 'Alice conversation' }], total: 1 });
      if (fields.operation === 'session.preview') return ownerSuccess({ previewId: 'preview-a', sessionId: 'session-alice', displayName: 'Alice' });
      if (fields.operation === 'preview.close') return ownerSuccess({ closed: true });
      throw Error(fields.operation);
    }, { services, rootProps: { close() { closed++; } }, browser: { requestAnimationFrame: fn => fn(), cancelAnimationFrame() {} } });
    env.render(); await ownerTick(); let tree = env.render();
    ownerNodes(tree, node => node.props?.['data-admin-tab'] === 'sessions')[0].props.onClick(); env.render(); await ownerPageTick(); tree = env.render();
    const started = ownerNodes(tree, node => node.props?.['data-content-entry'] === 'session-alice')[0].props.onClick(); await ownerTick();
    assert.deepEqual(opened, ['session-alice'], 'the original native view opens before its history promise settles');
    assert.equal(closed, 1); assert.equal(refreshes, 0, 'known native metadata does not need a full catalog refresh');
    assert.equal(released, 0, 'keep the opening reference until the main view can safely take over');
    assert.match(blocks.get('session-alice').reason, /Read-only/);
    let notice = env.render('conversation.composer', { sessionId: 'session-alice' });
    assert.match(ownerText(notice), /Loading preview/);
    if (outcome === 'ready') {
      opening.resolve(); await started;
      notice = env.render('conversation.composer', { sessionId: 'session-alice' });
      assert.doesNotMatch(ownerText(notice), /Loading preview/); assert.match(ownerText(notice), /Read-only/); assert.equal(released, 1);
    } else if (outcome === 'failed') {
      opening.reject(Error('history failed')); await started;
      notice = env.render('conversation.composer', { sessionId: 'session-alice' });
      assert.match(ownerText(notice), /Preview could not load/); assert.match(blocks.get('session-alice').reason, /Read-only/);
    }
    await ownerNodes(notice, node => node.type === 'button' && ownerText(node) === 'End preview')[0].props.onClick();
    await started; await ownerTick();
    assert.equal(opened.at(-1), 'session-admin'); assert.equal(blocks.get('session-alice'), undefined);
    assert.equal(released, 1); assert.doesNotMatch(ownerText(env.render('conversation.composer', { sessionId: 'session-alice' })), /Preview could not load/);
    env.dispose();
  }
});

test('ending a native file preview restores cached rows and position without waiting for slow cleanup or session refresh', async () => {
  const member = { id: 'usr_member', username: 'alice', displayName: 'Alice', role: 'member' };
  const snapshot = ownerSnapshot(); snapshot.admin.users.push(member);
  const settingsOpened = [], frames = [], blocks = new Map(); let mounted = 'session-admin', listener, deferReturn = false, finishRelease, finishRefresh, commitReturn;
  let shell = { actions: { openSection: id => settingsOpened.push(`stale:${id}`) } };
  const services = {
    sessions: { refresh: async () => { if (deferReturn) await new Promise(resolve => { finishRefresh = resolve; }); }, retain: () => ({ ready: Promise.resolve(), release() {} }) },
    uiWorkspace: { openSession(id) { if (deferReturn && id === 'session-admin') commitReturn = () => { mounted = id; listener?.(); }; else { mounted = id; listener?.(); } } },
    sidebarRight: { mounted: { getSnapshot: () => mounted, subscribe(fn) { listener = fn; return () => { listener = null; }; } }, tabsIn: () => [], openResource() {}, closeIn() {} },
    conversation: { blocks: { set(id, value) { blocks.set(id, value); }, storeFor: id => ({ getSnapshot: () => blocks.get(id) }) } },
  };
  const env = ownerHarness(async ({ fields }) => {
    if (fields.action === 'status') return ownerSuccess({ initialized: true });
    if (fields.action === 'auth.restore') return ownerSuccess({ user: ownerUser, csrf: 'content-csrf', cookieSession: true });
    if (fields.action !== 'admin.content') return ownerSuccess(snapshot);
    if (fields.operation === 'sessions.list') return ownerSuccess({ items: [], total: 0 });
    if (fields.operation === 'files.list') return ownerSuccess(fields.path ? { items: [{ name: 'proof.md', path: 'workspace/proof.md', kind: 'file', size: 5 }], total: 26 } : { items: [{ name: 'workspace', path: 'workspace', kind: 'directory' }], total: 1 });
    if (fields.operation === 'files.preview') return ownerSuccess({ previewId: 'preview-file', sessionId: 'session-file', fileAddress: 'proof.md', displayName: 'Alice' });
    if (fields.operation === 'preview.close') { if (deferReturn) await new Promise(resolve => { finishRelease = resolve; }); return ownerSuccess({ closed: true }); }
    throw Error(`Unexpected content operation: ${fields.operation}`);
  }, { services, rootProps: { close() { env.remount(false); } }, browser: { requestAnimationFrame: fn => (frames.push(fn), frames.length), cancelAnimationFrame() {} } });
  const settle = async () => { env.render(); await new Promise(resolve => setTimeout(resolve, 180)); await ownerTick(); return env.render(); };
  env.render(); await ownerTick(); let tree = env.render();
  ownerNodes(tree, node => node.props?.['data-admin-tab'] === 'sessions')[0].props.onClick();
  tree = await settle();
  ownerNodes(tree, node => node.props?.['data-workspace-page'] === 'files')[0].props.onClick();
  tree = await settle();
  tree = ownerChooseMember(env, tree, 'data-content-member', member.id);
  tree = await settle();
  ownerNodes(tree, node => node.props?.['data-content-entry'] === 'workspace')[0].props.onClick();
  tree = await settle();
  ownerNodes(tree, node => node.props?.['data-content-advanced'] === 'files')[0].props.onClick(); tree = env.render();
  ownerNodes(tree, node => node.props?.['data-filter-field'] === 'emptyFolders')[0].props.onChange({ target: { value: 'exclude' } }); tree = env.render();
  ownerNodes(tree, node => node.props?.['data-content-filter-form'] === 'files')[0].props.onSubmit({ preventDefault() {} }); tree = await settle();
  ownerNodes(tree, node => node.type === 'button' && ownerText(node) === 'Next')[0].props.onClick();
  tree = await settle();
  const scroller = { scrollTop: 416, scrollLeft: 12, parentElement: null };
  ownerNodes(tree, node => node.props?.['data-admin-content'])[0].props.ref.current = { parentElement: scroller };
  ownerNodes(tree, node => node.props?.['data-content-manage'] === 'workspace/proof.md')[0].props.onClick(); tree = env.render();
  await ownerNodes(tree, node => node.props?.role === 'menuitem' && ownerText(node) === 'View file')[0].props.onClick();
  await ownerTick();
  while (frames.length) frames.shift()();
  const preview = env.render('conversation.composer', { sessionId: 'session-file' });
  deferReturn = true;
  const end = ownerNodes(preview, node => node.type === 'button' && ownerText(node) === 'End preview')[0];
  const returning = end.props.onClick(); await ownerTick();
  assert.equal(ownerNodes(env.render(), node => node.props?.['data-workspace-window']).length, 0, 'workspace waits only for the native navigation commit');
  assert.equal(mounted, 'session-file');
  await end.props.onClick();
  assert.equal(typeof commitReturn, 'function');
  assert.equal(finishRefresh, undefined, 'no list refresh navigates away from the selected foreign preview');
  assert.equal(ownerNodes(env.render(), node => node.props?.['data-workspace-window']).length, 0, 'navigation must commit before reopening');
  shell = { actions: { openSection: id => settingsOpened.push(id) } };
  commitReturn(); await ownerTick();
  assert.equal(ownerNodes(env.render(), node => node.props?.['data-workspace-window']).length, 0, 'the returning page must render before reopening');
  while (frames.length) frames.shift()();
  await returning;
  assert.equal(ownerNodes(env.render(), node => node.props?.['data-workspace-window']).length, 1);
  assert.equal(mounted, 'session-admin');
  env.render(); await ownerTick(); tree = env.render();
  assert.equal(ownerNodes(tree, node => node.props?.['data-content-entry'] === 'workspace/proof.md').length, 1, 'the previous authorized page is visible before reloading it');
  assert.equal(typeof finishRelease, 'function', 'lease cleanup is still in flight while the window and cached rows are usable');
  finishRelease(); await ownerTick();
  assert.equal(typeof finishRefresh, 'function', 'session refresh starts after lease cleanup and does not block the restored window');
  finishRefresh(); await ownerTick();
  assert.equal(ownerNodes(tree, node => node.props?.['data-workspace-page'] === 'files')[0].props['aria-current'], 'page');
  assert.equal(ownerNodes(tree, node => node.props?.['data-content-member'])[0].props['data-member-value'], member.id);
  assert.ok(frames.length > 0, 'cached rows can restore position before the background listing refresh');
  scroller.scrollTop = 0; scroller.scrollLeft = 0;
  let focused, focusSelector;
  ownerNodes(tree, node => node.props?.['data-admin-content'])[0].props.ref.current = { parentElement: scroller, querySelectorAll: selector => { focusSelector = selector; return [{ getAttribute: () => 'workspace/proof.md', focus: options => { focused = options; } }]; } };
  tree = await settle();
  const restored = env.requests.filter(row => row.fields.operation === 'files.list').at(-1).fields;
  assert.equal(restored.userId, member.id); assert.equal(restored.path, 'workspace'); assert.equal(restored.offset, 25);
  assert.equal(restored.emptyFolders, 'exclude', 'native preview return retains the empty-folder selection');
  while (frames.length) frames.shift()();
  assert.equal(scroller.scrollTop, 416); assert.equal(scroller.scrollLeft, 12);
  assert.deepEqual({ ...focused }, { preventScroll: true });
  assert.equal(focusSelector, '[data-content-manage]', 'menu previews return focus to their Manage button');
  // This is a one-preview return point, not a persistent settings preference.
  env.remount(); env.render(); await ownerTick(); tree = env.render();
  assert.equal(ownerNodes(tree, node => node.props?.['data-admin-tab'] === 'accounts')[0].props['aria-current'], 'page');
  env.dispose();
});

test('advanced list filters apply as a draft, reset pagination and share folder management actions', async () => {
  const env = ownerHarness(async ({ fields }) => {
    if (fields.action === 'status') return ownerSuccess({ initialized: true });
    if (fields.action === 'auth.restore') return ownerSuccess({ user: ownerUser, csrf: 'filter-csrf', cookieSession: true });
    if (fields.action !== 'admin.content') return ownerSuccess(ownerSnapshot());
    if (fields.operation === 'sessions.list') return ownerSuccess({ items: [{ sessionId: 'session-1', userId: ownerUser.id, title: 'Conversation', displayName: 'Admin' }], total: 25 });
    if (fields.operation === 'files.list') return ownerSuccess({ items: fields.path ? [] : [{ path: 'reports', name: 'reports', kind: 'directory', bound: false, modifiedAt: 1, revision: 'revision' }], total: fields.path ? 0 : 1 });
    throw Error(`Unexpected operation: ${fields.operation}`);
  });
  const settle = async () => { env.render(); await new Promise(resolve => setTimeout(resolve, 180)); await ownerTick(); return env.render(); };
  const advanced = (tree, mode) => ownerNodes(tree, node => node.props?.['data-content-advanced'] === mode)[0];
  const field = (tree, key) => ownerNodes(tree, node => node.props?.['data-filter-field'] === key)[0];
  env.render(); await ownerTick(); let tree = env.render();
  ownerNodes(tree, node => node.props?.['data-admin-tab'] === 'sessions')[0].props.onClick(); tree = await settle();
  assert.equal(env.requests.filter(row => row.fields.operation === 'sessions.list').at(-1).fields.content, 'messages');
  ownerNodes(tree, node => node.type === 'button' && ownerText(node) === 'Next')[0].props.onClick(); tree = await settle();
  assert.equal(env.requests.filter(row => row.fields.operation === 'sessions.list').at(-1).fields.offset, 10);
  advanced(tree, 'sessions').props.onClick(); tree = env.render();
  field(tree, 'content').props.onChange({ target: { value: 'all' } }); tree = env.render();
  const count = env.requests.length;
  ownerNodes(tree, node => node.props?.['data-close-editor'])[0].props.onClick(); tree = env.render(); await ownerTick();
  assert.equal(env.requests.length, count, 'closing a draft does not apply filters or send a request');
  advanced(tree, 'sessions').props.onClick(); tree = env.render();
  assert.equal(field(tree, 'content').props.value, 'messages');
  for (const [key, value] of [['content', 'empty'], ['status', 'idle'], ['archive', 'all'], ['searchScope', 'id'], ['sort', 'updated-asc'], ['from', '2026-10-01'], ['to', '2026-10-24']]) { field(tree, key).props.onChange({ target: { value } }); tree = env.render(); }
  ownerNodes(tree, node => node.props?.['data-content-filter-form'] === 'sessions')[0].props.onSubmit({ preventDefault() {} }); tree = await settle();
  const applied = env.requests.filter(row => row.fields.operation === 'sessions.list').at(-1).fields;
  assert.equal(applied.offset, 0); assert.equal(applied.content, 'empty'); assert.equal(applied.status, 'idle'); assert.equal(applied.archive, 'all'); assert.equal(applied.searchScope, 'id');
  assert.equal(applied.updatedFrom, new Date('2026-10-01T00:00:00').getTime());
  assert.equal(applied.updatedBefore, new Date('2026-10-25T00:00:00').getTime());
  ownerNodes(tree, node => node.props?.['data-content-clear'])[0].props.onClick(); tree = await settle();
  assert.equal(env.requests.filter(row => row.fields.operation === 'sessions.list').at(-1).fields.content, 'messages');
  ownerNodes(tree, node => node.props?.['data-workspace-page'] === 'files')[0].props.onClick(); tree = await settle();
  advanced(tree, 'files').props.onClick(); tree = env.render();
  field(tree, 'extensions').props.onChange({ target: { value: 'md' } }); tree = env.render();
  field(tree, 'kind').props.onChange({ target: { value: 'directory' } }); tree = env.render();
  assert.equal(field(tree, 'extensions').props.value, ''); assert.equal(field(tree, 'extensions').props.disabled, true);
  field(tree, 'emptyFolders').props.onChange({ target: { value: 'only' } }); tree = env.render();
  assert.equal(field(tree, 'kind').props.value, 'directory');
  field(tree, 'kind').props.onChange({ target: { value: 'file' } }); tree = env.render();
  assert.equal(field(tree, 'emptyFolders').props.value, 'all'); assert.equal(field(tree, 'emptyFolders').props.disabled, true);
  field(tree, 'kind').props.onChange({ target: { value: 'all' } }); tree = env.render();
  field(tree, 'emptyFolders').props.onChange({ target: { value: 'only' } }); tree = env.render();
  ownerNodes(tree, node => node.props?.['data-content-filter-form'] === 'files')[0].props.onSubmit({ preventDefault() {} }); tree = await settle();
  assert.equal(env.requests.filter(row => row.fields.operation === 'files.list').at(-1).fields.kind, 'directory');
  assert.equal(env.requests.filter(row => row.fields.operation === 'files.list').at(-1).fields.emptyFolders, 'only');
  ownerNodes(tree, node => node.props?.['aria-label'] === 'Manage reports')[0].props.onClick(); tree = env.render();
  assert.equal(ownerNodes(tree, node => node.props?.['data-edit-dialog']).length, 0, 'quick actions do not mount an editor dialog');
  assert.equal(ownerNodes(tree, node => node.props?.['data-native-menu'])[0].props.portal, true);
  for (const text of ['Open folder', 'Rename', 'Move', 'Delete']) assert.equal(ownerNodes(tree, node => node.type === 'button' && ownerText(node) === text)[0].props.disabled, false);
  ownerNodes(tree, node => node.type === 'button' && ownerText(node) === 'Open folder')[0].props.onClick(); tree = await settle();
  const folder = env.requests.filter(row => row.fields.operation === 'files.list').at(-1).fields;
  assert.equal(folder.path, 'reports'); assert.equal(folder.kind, 'all'); assert.equal(folder.search, '');
  assert.equal(folder.emptyFolders, 'exclude');
  env.dispose();
});

test('native management menus expose relevant actions, protect bound folders and open compact single-field forms', async () => {
  const env = ownerHarness(async ({ fields }) => {
    if (fields.action === 'status') return ownerSuccess({ initialized: true });
    if (fields.action === 'auth.restore') return ownerSuccess({ user: ownerUser, csrf: 'menu-csrf', cookieSession: true });
    if (fields.action !== 'admin.content') return ownerSuccess(ownerSnapshot());
    if (fields.operation === 'sessions.list') return ownerSuccess({ items: [{ sessionId: 'session-1', userId: ownerUser.id, title: 'Conversation', displayName: 'Admin', running: false, filePath: '' }], total: 1 });
    if (fields.operation === 'files.list') return ownerSuccess({ items: [{ path: 'workspace', name: 'workspace', kind: 'directory', bound: true }, { path: 'proof.txt', name: 'proof.txt', kind: 'file', size: 1 }], total: 2 });
    throw Error(`Unexpected operation: ${fields.operation}`);
  });
  const settle = async () => { env.render(); await new Promise(resolve => setTimeout(resolve, 180)); await ownerTick(); return env.render(); };
  const menu = tree => ownerNodes(tree, node => node.props?.['data-native-menu'])[0];
  const action = (tree, label) => ownerNodes(tree, node => node.props?.role === 'menuitem' && ownerText(node) === label)[0];
  env.render(); await ownerTick(); let tree = env.render();
  ownerNodes(tree, node => node.props?.['data-admin-tab'] === 'sessions')[0].props.onClick(); tree = await settle();
  ownerNodes(tree, node => node.props?.['data-content-manage'] === 'session-1')[0].props.onClick(); tree = env.render();
  assert.equal(action(tree, 'Stop running').props.disabled, true);
  assert.ok(action(tree, 'View history')); assert.ok(action(tree, 'Manage files'));
  let menuEscapeStopped = 0, menuEscapePrevented = 0;
  ownerNodes(tree, node => node.props?.className === 'lanw-content-menu-host')[0].props.onKeyDownCapture({ key: 'Escape', stopPropagation() { menuEscapeStopped++; }, preventDefault() { menuEscapePrevented++; } }); tree = env.render();
  assert.equal(menuEscapeStopped, 1); assert.equal(menuEscapePrevented, 1);
  assert.equal(menu(tree), undefined);
  assert.equal(ownerNodes(tree, node => node.props?.['data-workspace-window']).length, 1, 'Escape closes the management menu without closing the workspace');
  assert.equal(ownerNodes(tree, node => node.props?.['data-content-manage'] === 'session-1')[0].props['aria-expanded'], false);
  ownerNodes(tree, node => node.props?.['data-workspace-page'] === 'files')[0].props.onClick(); tree = await settle();
  ownerNodes(tree, node => node.props?.['data-content-manage'] === 'workspace')[0].props.onClick(); tree = env.render();
  assert.equal(action(tree, 'Open folder').props.disabled, false);
  for (const label of ['Rename', 'Move', 'Delete']) assert.equal(action(tree, label).props.disabled, true);
  action(tree, 'Rename').props.onClick(); tree = env.render();
  assert.equal(ownerNodes(tree, node => node.props?.['data-edit-dialog']).length, 0, 'a disabled action cannot open a form');
  menu(tree).props.onClose(); tree = env.render();
  ownerNodes(tree, node => node.props?.['data-content-manage'] === 'proof.txt')[0].props.onClick(); tree = env.render();
  for (const label of ['View file', 'Edit text', 'Download', 'Replace file', 'Rename', 'Move', 'Delete']) assert.ok(action(tree, label));
  action(tree, 'Rename').props.onClick(); tree = env.render();
  assert.equal(ownerNodes(tree, node => node.props?.['data-native-menu']).length, 0, 'selecting an action closes the menu');
  assert.match(ownerNodes(tree, node => node.props?.['data-edit-dialog'])[0].props.className, /lanw-content-action-dialog/);
  const input = ownerNodes(tree, node => node.props?.['data-content-name'])[0];
  assert.equal(input.props.value, 'proof.txt'); assert.equal(input.props['data-modal-autofocus'], true);
  input.props.onChange({ target: { value: 'draft.txt' } }); tree = env.render();
  ownerNodes(tree, node => node.type === 'button' && ownerText(node) === 'Cancel')[0].props.onClick(); tree = env.render();
  assert.equal(ownerNodes(tree, node => node.props?.['data-edit-dialog']).length, 0);
  assert.equal(ownerNodes(tree, node => node.props?.['data-discard-edit']).length, 0);
  assert.equal(env.requests.some(row => row.fields.operation === 'files.rename'), false, 'canceling a short form does not mutate the file');
  env.dispose();
});

test('large raster and SVG logos are normalized before saving and superseded uploads release their object URLs', async () => {
  const images = [], revoked = [], canvases = [];
  let allocated = 0, encoded = 0, saved;
  const logo = 'data:image/webp;base64,UklGRg==';
  const browser = {
    URL: class extends URL { static createObjectURL() { return `blob:${++allocated}`; } static revokeObjectURL(url) { revoked.push(url); } },
    Image: class { naturalWidth = 8000; naturalHeight = 2000; constructor() { images.push(this); } },
    OffscreenCanvas: class { constructor(width, height) { this.width = width; this.height = height; canvases.push(this); } getContext() { return { drawImage() {} }; } async convertToBlob() { return { size: ++encoded === 1 ? 140000 : 1000 }; } },
    FileReader: class { readAsDataURL() { this.result = logo; this.onload(); } abort() {} },
  };
  const env = ownerHarness(async request => {
    if (request.fields.action === 'status') return ownerSuccess({ initialized: true });
    if (request.fields.action === 'auth.restore') return ownerSuccess({ user: ownerUser, csrf: 'brand-csrf', cookieSession: true });
    if (request.fields.action === 'admin.updateBranding') { saved = request.fields.logo; return ownerSuccess({ branding: { revision: 1, logo: saved } }); }
    return ownerSuccess(ownerSnapshot());
  }, { browser });
  env.render(); await ownerTick(); let tree = env.render();
  ownerNodes(tree, node => node.props?.['data-admin-tab'] === 'branding')[0].props.onClick(); tree = env.render();
  const upload = () => ownerNodes(tree, node => node.props?.['data-brand-logo-upload'])[0];
  upload().props.onChange({ target: { files: [{ type: 'image/png', size: 20 * 1024 * 1024 }] } });
  upload().props.onChange({ target: { files: [{ type: 'image/svg+xml', size: 40 * 1024 * 1024 }] } });
  await images[0].onload(); assert.equal(canvases.length, 0);
  await images[1].onload(); tree = env.render();
  assert.ok(canvases[0].width <= 480 && canvases[0].height <= 136);
  assert.equal(encoded, 2); assert.deepEqual(revoked, ['blob:1', 'blob:2']);
  assert.equal(ownerNodes(tree, node => node.type === 'img')[0].props.src, logo);
  await ownerNodes(tree, node => node.props?.['data-branding-form'])[0].props.onSubmit({ preventDefault() {} });
  assert.equal(saved, logo);
  tree = env.render(); upload().props.onChange({ target: { files: [{ type: 'image/webp', size: 50 * 1024 * 1024 }] } });
  env.dispose(); await images[2].onload(); assert.deepEqual(revoked, ['blob:1', 'blob:2', 'blob:3']);
});

test('owner explicit create, invite, access and password forms retain exact API fields and CSRF', async () => {
  const member = { id: 'usr_member', username: 'mei', displayName: 'Mei', role: 'member', routeIds: ['rte_a'], defaultRouteId: 'rte_a' };
  const snapshot = { ...ownerSnapshot(), admin: { users: [ownerUser, member], modelCatalog: [] } };
  const env = ownerHarness(async request => {
    if (request.fields.action === 'status') return ownerSuccess({ initialized: true });
    if (request.fields.action === 'auth.restore') return ownerSuccess({ user: ownerUser, csrf: 'csrf', cookieSession: true });
    if (request.fields.action === 'snapshot') return ownerSuccess(snapshot);
    return ownerSuccess(request.fields.action === 'admin.createInvite' ? { inviteToken: 'one-time-token', expiresAt: 1790000000000 } : {});
  });
  env.render(); await ownerTick(); let tree = env.render();
  const clickAction = value => { ownerNodes(tree, node => node.props?.['data-account-action'] === value)[0].props.onClick(); tree = env.render(); };
  const submit = async (form, values) => { await form.props.onSubmit({ preventDefault() {}, currentTarget: { values, reset() {} } }); await ownerTick(); tree = env.render(); };
  const accessValues = { 'access.files': 'on', 'access.attachments': 'on', 'access.subagents': 'on', 'access.interactions': 'on', toolAccess: 'whitelist', toolNames: ['read'], skillsMode: 'custom', skillNames: ['alpha'] };
  const access = { terminal: false, files: true, attachments: true, tasks: false, subagents: true, interactions: true, toolMode: 'whitelist', tools: ['read'], skills: ['alpha'] };
  clickAction('create');
  assert.equal(ownerNodes(tree, node => node.props?.name === 'password')[0].props.minLength, 16);
  const createValues = { username: 'new-member', displayName: 'New member', password: 'long-enough-password', modelAccess: 'custom', routeIds: ['rte_a', 'rte_b'], defaultRouteId: 'rte_b', ...accessValues };
  await submit(ownerNodes(tree, node => node.type === 'form')[0], createValues);
  assert.equal(env.requests.some(request => request.fields.action === 'admin.createUser'), false);
  await submit(ownerNodes(tree, node => node.type === 'form')[0], createValues);
  const created = env.requests.find(request => request.fields.action === 'admin.createUser');
  assert.deepEqual(created.fields, { action: 'admin.createUser', username: 'new-member', displayName: 'New member', password: 'long-enough-password', modelAccess: 'custom', routeIds: ['rte_a', 'rte_b'], defaultRouteId: 'rte_b', access });
  clickAction('invite');
  await submit(ownerNodes(tree, node => node.type === 'form')[0], { displayName: 'Invited member', modelAccess: 'inherit', routeIds: ['rte_a'], defaultRouteId: '', ...accessValues });
  await submit(ownerNodes(tree, node => node.type === 'form')[0], { displayName: 'Invited member', modelAccess: 'inherit', routeIds: ['rte_a'], defaultRouteId: '', ...accessValues });
  assert.deepEqual(env.requests.find(request => request.fields.action === 'admin.createInvite').fields, { action: 'admin.createInvite', displayName: 'Invited member', modelAccess: 'inherit', access });
  assert.ok(ownerNodes(tree, node => node.type === 'input' && node.props.readOnly && node.props.value === 'one-time-token').length);
  tree = ownerAccountAction(env, tree, member.id);
  const forms = ownerNodes(tree, node => node.type === 'form');
  await submit(forms[0], { modelAccess: 'custom', routeIds: ['rte_b'], defaultRouteId: 'rte_b', disabled: 'on', ...accessValues });
  assert.deepEqual(env.requests.find(request => request.fields.action === 'admin.updateUser').fields, { action: 'admin.updateUser', expectedRevision: 0, userId: member.id, disabled: true, modelAccess: 'custom', routeIds: ['rte_b'], defaultRouteId: 'rte_b', access });
  assert.equal(ownerNodes(tree, node => node.props?.['data-edit-dialog']).length, 0, 'successful save returns to the original list');
  tree = ownerAccountAction(env, tree, member.id);
  ownerNodes(tree, node => node.props?.['data-access-section'] === 'security')[0].props.onClick(); tree = env.render();
  const reset = ownerNodes(tree, node => node.type === 'form' && ownerNodes(node, child => child.props?.name === 'confirmReset').length)[0];
  assert.equal(reset.props.id, 'lanw-reset-password-form');
  assert.equal(ownerNodes(ownerNodes(tree, node => node.props?.className === 'lanw-edit-footer')[0], node => node.type === 'button' && node.props?.form === reset.props.id).length, 1, 'the footer action submits the reset form');
  assert.equal(ownerNodes(reset, node => node.props?.name === 'confirmReset')[0].props.required, true);
  await submit(reset, { password: 'new-long-password', confirmReset: 'on' });
  assert.deepEqual(env.requests.find(request => request.fields.action === 'admin.resetPassword').fields, { action: 'admin.resetPassword', userId: member.id, password: 'new-long-password' });
  assert.ok(env.requests.filter(request => request.fields.action.startsWith('admin.')).every(request => request.headers['X-Lan-CSRF'] === 'csrf'));
  assert.ok(env.requests.every(request => !Object.hasOwn(request.fields, 'role'))); env.dispose();
});

test('owner pending edits cannot dismiss the panel and logout clears console view state', async () => {
  let release;
  const env = ownerHarness(async request => {
    if (request.fields.action === 'status') return ownerSuccess({ initialized: true });
    if (['auth.restore', 'login'].includes(request.fields.action)) return ownerSuccess({ user: ownerUser, csrf: 'csrf', cookieSession: true });
    if (request.fields.action === 'admin.updateUser') await new Promise(resolve => { release = resolve; });
    return ownerSuccess(request.fields.action === 'snapshot' ? ownerSnapshot() : {});
  });
  env.render(); await ownerTick(); let tree = env.render();
  ownerNodes(tree, node => node.props?.['data-account-search'])[0].props.onChange({ target: { value: 'admin' } });
  tree = env.render(); await ownerPageTick(); tree = env.render();
  tree = ownerAccountAction(env, tree);
  const pending = ownerNodes(tree, node => node.type === 'form')[0].props.onSubmit({ preventDefault() {}, currentTarget: { values: { routeIds: [] }, reset() {} } });
  await ownerTick(); tree = env.render();
  assert.equal(ownerNodes(tree, node => node.props?.['data-close-editor'])[0].props.disabled, true);
  assert.ok(ownerNodes(tree, node => node.type === 'fieldset').every(node => node.props.disabled));
  release(); await pending; await ownerTick(); tree = env.render();
  ownerNodes(tree, node => node.props?.['data-admin-tab'] === 'models')[0].props.onClick(); tree = env.render();
  ownerNodes(tree, node => node.type === 'button' && ownerText(node) === 'Sign out')[0].props.onClick(); await ownerTick(); tree = env.render();
  await ownerNodes(tree, node => node.type === 'form')[0].props.onSubmit({ preventDefault() {}, currentTarget: { values: { username: 'admin', password: 'long-enough-password' }, reset() {} } }); await ownerTick(); tree = env.render();
  assert.equal(ownerNodes(tree, node => node.props?.['data-admin-tab'] === 'accounts')[0].props['aria-current'], 'page');
  assert.equal(ownerNodes(tree, node => node.props?.['data-account-search'])[0].props.value, '');
  assert.equal(ownerNodes(tree, node => node.props?.['data-account-editor']).length, 0);
  assert.equal(ownerNodes(tree, node => node.props?.['data-admin-section'] === 'models').length, 0); env.dispose();
});



test('compact model browser uses 12px regular list rows, small controls and no card-per-model', () => {
  assert.match(css, /\.lanw-model-browser\{[^}]*gap:8px[^}]*font-size:12px;line-height:18px/);
  assert.match(css, /\.lanw-model-browser \[data-model-row\]\{[^}]*border-bottom:1px solid var\(--dsw-alias-border-l1\);border-radius:0;min-height:36px/);
  assert.match(css, /\[data-model-row\]>summary\{[^}]*font-size:12px;font-weight:400;line-height:20px/);
  assert.match(css, /\.lanw-model-tools input,[^}]*height:30px/);
  assert.match(css, /\.lanw-model-provider\{[^}]*font-size:11px/);
  assert.match(source, /pages > 1 && h\(Pager/);
  assert.match(source, /className: 'lanw-model-efforts'/);
});

test('owner page matches native Plugins spacing, type, segmented navigation and flat rows', () => {
  assert.match(css, /\.lanw>\*\{width:100%;max-width:960px;flex-shrink:0\}/);
  assert.match(css, /gap:24px;padding:0 0 24px/);
  assert.match(css, /\.lanw-header\{[^}]*padding-top:0/);
  assert.match(css, /\.lanw h1\{font-size:20px;font-weight:500;line-height:28px/);
  assert.match(css, /\.lanw h2,\.lanw h3\{font-size:14px;font-weight:500;line-height:22px/);
  assert.match(css, /\.lanw \.lanw-btn\{[^}]*width:auto[^}]*height:32px[^}]*padding:0 12px/);
  assert.match(css, /\.lanw-nav\{display:flex;flex-wrap:wrap;justify-content:space-between/);
  assert.match(css, /\.lanw-tabs\{[^}]*padding:4px;border-radius:16px;background:color-mix\(in srgb,var\(--dsw-alias-label-primary\) 4%,var\(--dsw-alias-bg-base\)\)/, 'derive a visible tray from inspected tokens even when all layer colors are equal');
  assert.match(css, /\.lanw-tabs \.lanw-btn\[aria-selected="true"\]\{background:var\(--dsw-alias-bg-base\)/);
  assert.match(css, /\.lanw-accountlist\{min-width:0;border:0;background:transparent/);
  assert.match(css, /\.lanw-accountlist tbody tr\{height:72px/);
  assert.doesNotMatch(css, /lanw-metric|grid-template-columns:208px/);
  assert.match(css, /\.lanw \.lanw-field input,\.lanw \.lanw-field select\{height:36px/);
  assert.match(css, /\.lanw-actionpanel\{max-width:440px/); assert.match(css, /\.lanw-adminpanel\[hidden\]\{display:none!important/);
  assert.match(source, /function ModelCatalog\(\{ catalog, initiallyOpen = false \}\)/);
  assert.doesNotMatch(source, /function (?:StartupEnvironment|PluginSharing)\(/);
  assert.doesNotMatch(source, /focusTrap|createPortal/);
  assert.match(source, /node\.showModal\(\)/);
  assert.match(source, /return h\('dialog'/);
});

test('current account is one subtle inline card with preserved identity and sign-out authority', async () => {
  const user = { ...ownerUser, displayName: 'Administrator with a deliberately long display name' };
  const env = ownerHarness(async request => request.fields.action === 'status' ? ownerSuccess({ initialized: true }) : request.fields.action === 'auth.restore' ? ownerSuccess({ user, csrf: 'csrf', cookieSession: true }) : ownerSuccess({ ...ownerSnapshot(), user }));
  env.render(); await ownerTick(); let tree = env.render();
  const cards = ownerNodes(tree, node => node.props?.['data-current-account']); assert.equal(cards.length, 1);
  const card = cards[0]; assert.equal(card.props.role, 'group'); assert.equal(card.props['aria-label'], 'Current account');
  assert.match(ownerText(card), /Administrator with a deliberately long display name/); assert.match(ownerText(card), /@admin · Administrator/);
  assert.equal(ownerNodes(card, node => node.type === 'p').length, 0);
  assert.equal(ownerNodes(card, node => node.type === 'strong')[0].props.title, user.displayName);
  assert.equal(ownerNodes(card, node => node.props?.className === 'lanw-user-divider')[0].props['aria-hidden'], true);
  assert.match(css, /\.lanw-user\{display:inline-flex;[^}]*flex-wrap:nowrap[^}]*max-width:100%[^}]*border:1px solid var\(--dsw-alias-border-l1\)[^}]*box-shadow:none/);
  assert.match(css, /\.lanw-user-info\{display:flex;align-items:center;[^}]*min-width:0;overflow:hidden/);
  assert.doesNotMatch(css, /\.lanw-user\{[^}]*flex-wrap:wrap/);
  await ownerNodes(card, node => node.type === 'button' && ownerText(node) === 'Sign out')[0].props.onClick(); await ownerTick(); tree = env.render();
  assert.equal(ownerNodes(tree, node => node.props?.['data-current-account']).length, 0);
  const logout = env.requests.find(request => request.fields.action === 'logout'); assert.equal(logout.headers['X-Lan-CSRF'], 'csrf'); env.dispose();
});

test('owner tab switches reserve symmetric scrollbar space and do not change font metrics', () => {
  assert.match(css, /\.lanw\{[^}]*overflow-x:clip;scrollbar-gutter:stable both-edges/);
  const normal = css.match(/\.lanw-tabs \.lanw-btn\{([^}]+)\}/)[1];
  const selected = css.match(/\.lanw-tabs \.lanw-btn\[aria-selected="true"\]\{([^}]+)\}/)[1];
  assert.match(normal, /font-weight:500/); assert.doesNotMatch(selected, /font|padding|width|letter-spacing/);
  assert.match(css, /\.lanw\{[^}]*width:100%;max-width:100%[^}]*contain:inline-size/);
  assert.match(css, /\.lanw>\*\{[^}]*flex-shrink:0/);
  assert.match(css, /\.lanw-tabs\{display:inline-flex[^}]*width:max-content;min-width:0;max-width:100%/);
  assert.match(normal, /width:auto;flex:none;min-width:0/);
  assert.doesNotMatch(css, /(?:^|\n)(?:html|body|:root)\s*\{/);
});

test('owner management uses native member workspaces and exposes no old reservation console', async () => {
  const home = { userId: ownerUser.id, relativePath: ownerUser.id, root: '/srv/homes', path: '/srv/homes/usr_owner', status: 'ready', automatic: true };
  const env = ownerHarness(async request => request.fields.action === 'status' ? ownerSuccess({ initialized: true }) : request.fields.action === 'auth.restore' ? ownerSuccess({ user: ownerUser, csrf: 'csrf', cookieSession: true }) : ownerSuccess({ ...ownerSnapshot(), home }));
  env.render(); await ownerTick(); let tree = env.render();
  assert.equal(ownerNodes(tree, node => node.props?.['data-user-home']).length, 0);
  assert.equal(ownerNodes(tree, node => node.type === 'button' && ownerText(node) === 'Workspace').length, 0);
  assert.doesNotMatch(ownerText(tree), /\/srv\/homes|usr_owner/);
  assert.deepEqual(env.requests.map(request => request.fields.action), ['status', 'auth.restore', 'snapshot']);
  assert.equal(ownerNodes(tree, node => node.props?.['data-project-reservations']).length, 0); assert.doesNotMatch(ownerText(tree), /Project terminal|Create reservation|My project reservations/); env.dispose();
});

test('owner home root conflict preserves draft and explicit reload renews its CAS revision', async () => {
  let revision = 3, root = '/srv/original', fail = true;
  const env = ownerHarness(async request => {
    if (request.fields.action === 'status') return ownerSuccess({ initialized: true });
    if (request.fields.action === 'auth.restore') return ownerSuccess({ user: ownerUser, csrf: 'csrf', cookieSession: true });
    if (request.fields.action === 'admin.updateHomeDirectory') { if (fail) { revision = 4; root = '/srv/other'; return { ok: false, status: 409, json: async () => ({ ok: false, error: { code: 'HOME_DIRECTORY_REVISION_MISMATCH' } }) }; } root = request.fields.root; ++revision; return ownerSuccess({ revision, root }); }
    return ownerSuccess({ ...ownerSnapshot(), admin: { ...ownerSnapshot().admin, homeDirectory: { revision, root, configuredRoot: root, defaultRoot: '/srv/default', allocation: 'system', existingHomesPreserved: true } } });
  });
  env.render(); await ownerTick(); let tree = env.render();
  ownerNodes(tree, node => node.props?.['data-admin-tab'] === 'sharing')[0].props.onClick(); tree = env.render();
  const editor = () => ownerNodes(tree, node => node.props?.['data-home-directory'])[0];
  const change = value => { ownerNodes(editor(), node => node.props?.name === 'root')[0].props.onChange({ target: { value } }); tree = env.render(); };
  change('/srv/draft'); await ownerNodes(editor(), node => node.type === 'form')[0].props.onSubmit({ preventDefault() {} }); await ownerTick(); tree = env.render();
  assert.equal(ownerNodes(editor(), node => node.props?.name === 'root')[0].props.value, '/srv/draft'); assert.match(ownerText(editor()), /draft is preserved/);
  ownerNodes(tree, node => node.props?.['data-admin-tab'] === 'models')[0].props.onClick(); tree = env.render(); ownerNodes(tree, node => node.props?.['data-admin-tab'] === 'sharing')[0].props.onClick(); tree = env.render();
  assert.equal(ownerNodes(editor(), node => node.props?.name === 'root')[0].props.value, '/srv/draft');
  await ownerNodes(editor(), node => node.type === 'button' && ownerText(node) === 'Reload and discard directory draft')[0].props.onClick(); await ownerTick(); tree = env.render();
  assert.equal(ownerNodes(editor(), node => node.props?.name === 'root')[0].props.value, '/srv/other'); fail = false;
  change('/srv/final'); await ownerNodes(editor(), node => node.type === 'form')[0].props.onSubmit({ preventDefault() {} }); await ownerTick(); tree = env.render();
  const saves = env.requests.filter(request => request.fields.action === 'admin.updateHomeDirectory');
  assert.deepEqual(saves.map(request => request.fields), [{ action: 'admin.updateHomeDirectory', root: '/srv/draft', expectedRevision: 3 }, { action: 'admin.updateHomeDirectory', root: '/srv/final', expectedRevision: 4 }]);
  assert.ok(saves.every(request => request.headers['X-Lan-CSRF'] === 'csrf')); assert.match(ownerText(editor()), /not migrated/);
  ownerNodes(tree, node => node.props?.['data-workspace-info'])[0].props.onClick({ currentTarget: {} }); tree = env.render();
  assert.doesNotMatch(ownerText(ownerNodes(tree, node => node.props?.['data-workspace-info-dialog'])[0]), /not migrated|Current root|Startup default root|\/srv\//); env.dispose();
});

test('owner info icon is the sole default help entry and preserves root drafts without requests', async () => {
  const directory = { root: '/srv/saved', defaultRoot: '/srv/startup', configuredRoot: '/srv/saved', revision: 3 };
  const env = serviceAdminHarness(async request => request.fields.action === 'status' ? ownerSuccess({ initialized: true, memberUrl: 'http://localhost:59072/lan/', capabilities: { isolatedExecution: false } }) : request.fields.action === 'auth.restore' ? ownerSuccess({ user: ownerUser, csrf: 'csrf', cookieSession: true }) : ownerSuccess({ ...ownerSnapshot(), home: { status: 'ready', path: '/srv/saved/usr_one' }, admin: { users: [ownerUser], modelCatalog: [], homeDirectory: directory } }));
  env.render(); await ownerTick(); let tree = env.render();
  const info = () => ownerNodes(tree, node => node.props?.['data-workspace-info'])[0], dialog = () => ownerNodes(tree, node => node.props?.['data-workspace-info-dialog'])[0];
  assert.equal(ownerNodes(tree, node => node.props?.['data-workspace-info']).length, 1); assert.equal(dialog(), undefined);
  assert.equal(info().props['aria-label'], 'Workspace guide'); assert.equal(info().props['aria-haspopup'], 'dialog'); assert.equal(info().props['aria-expanded'], false);
  assert.equal(ownerNodes(tree, node => node.props?.className === 'lanw-boundary').length, 0);
  assert.doesNotMatch(ownerText(tree), /Each account gets|not migrated|Checked when|Separate member entry/);
  ownerNodes(tree, node => node.props?.['data-admin-tab'] === 'sharing')[0].props.onClick(); tree = env.render();
  ownerNodes(tree, node => node.props?.name === 'root')[0].props.onChange({ target: { value: '/srv/unsaved' } }); tree = env.render();
  const requests = env.requests.length;
  info().props.onClick({ currentTarget: { isConnected: true, focus() {} } }); tree = env.render();
  assert.equal(info().props['aria-controls'], dialog().props.id); assert.equal(info().props['aria-expanded'], true);
  assert.match(ownerText(dialog()), /Conversations and managed files|Native DSH providers/); assert.doesNotMatch(JSON.stringify(dialog()), /\/srv\/|Current root|Startup default root|not migrated|"directory":/);
  assert.equal(ownerNodes(dialog(), node => node.type === 'a').length, 1);
  dialog().props.onCancel({ preventDefault() {} }); tree = env.render();
  assert.equal(dialog(), undefined); assert.equal(info().props['aria-expanded'], false);
  assert.equal(ownerNodes(tree, node => node.props?.name === 'root')[0].props.value, '/srv/unsaved'); assert.equal(env.requests.length, requests);
  info().props.onClick({ currentTarget: {} }); tree = env.render(); ownerNodes(dialog(), node => node.props?.['data-close-info'])[0].props.onClick(); tree = env.render(); assert.equal(dialog(), undefined); env.dispose();
});

test('member choices have one search dropdown without pagination and Escape closes it before the editor', async () => {
  const env = ownerHarness(async ({ fields }) => fields.action === 'status' ? ownerSuccess({ initialized: true }) : fields.action === 'auth.restore' ? ownerSuccess({ user: ownerUser, csrf: 'csrf', cookieSession: true }) : ownerSuccess(ownerSnapshot()));
  env.render(); await ownerTick(); let tree = env.render();
  ownerNodes(tree, node => node.props?.['data-account-action'] === 'create')[0].props.onClick(); tree = env.render();
  const editor = () => ownerNodes(tree, node => node.type === 'dialog')[0];
  const picker = () => ownerNodes(editor(), node => node.props?.['data-grant-copy'])[0];
  const input = () => ownerNodes(picker(), node => node.props?.role === 'combobox')[0];
  input().props.onFocus(); tree = env.render();
  assert.equal(input().props['aria-expanded'], true); assert.equal(ownerNodes(picker(), node => node.type === 'select' || node.type === 'details' || node.props?.className?.includes('lanw-pager')).length, 0);
  assert.equal(ownerNodes(picker(), node => node.props?.role === 'listbox').length, 1);
  let stopped = 0, prevented = 0;
  input().props.onKeyDown({ key: 'Escape', preventDefault() { prevented++; }, stopPropagation() { stopped++; } }); tree = env.render();
  assert.equal(stopped, 1); assert.equal(prevented, 1); assert.ok(editor()); assert.equal(input().props['aria-expanded'], false);
  const body = ownerNodes(editor(), node => node.props?.className === 'lanw-edit-body')[0];
  body.props.onChangeCapture({ target: { closest(selector) { return selector === '[data-member-picker]' ? {} : null; } } }); tree = env.render();
  editor().props.onCancel({ preventDefault() {} }); tree = env.render();
  assert.equal(ownerNodes(tree, node => node.type === 'dialog').length, 0, 'searching without applying grants is not an unsaved permission edit');
  env.dispose();
});

test('applied member grants mark the editor dirty and require an explicit save or discard', async () => {
  const target = { ...ownerUser, id: 'usr_target', role: 'member', routeIds: [], access: { files: true } };
  const source = { ...ownerUser, modelAccess: 'inherit', routeIds: [], access: { files: false } };
  const env = ownerHarness(async ({ fields }) => fields.action === 'status' ? ownerSuccess({ initialized: true }) : fields.action === 'auth.restore' ? ownerSuccess({ user: ownerUser, csrf: 'csrf', cookieSession: true }) : fields.action === 'admin.getUser' ? ownerSuccess({ user: source }) : ownerSuccess({ ...ownerSnapshot(), admin: { ...ownerSnapshot().admin, users: [ownerUser, target] } }));
  env.render(); await ownerTick(); let tree = env.render();
  tree = ownerAccountAction(env, tree, target.id);
  tree = ownerChooseMember(env, tree, 'data-member-picker-select', ownerUser.id);
  const picker = ownerNodes(tree, node => node.props?.['data-grant-copy'])[0];
  await ownerNodes(picker, node => node.type === 'button' && ownerText(node) === 'Apply grants')[0].props.onClick(); await ownerTick(); env.render(); tree = env.render();
  const editor = () => ownerNodes(tree, node => node.type === 'dialog')[0];
  editor().props.onCancel({ preventDefault() {} }); tree = env.render();
  assert.ok(ownerNodes(editor(), node => node.props?.['data-discard-edit']).length);
  assert.equal(env.requests.some(row => row.fields.action === 'admin.updateUser'), false); env.dispose();
});

test('grant copy fills only permission drafts in create, invite and edit flows', async () => {
  for (const mode of ['create', 'invite', 'edit']) {
    const target = { id: 'usr_target', username: 'target', displayName: 'Target name', role: 'member', revision: 3, disabled: false, modelAccess: 'inherit', routeIds: [], defaultRouteId: null, access: { terminal: true, files: true }, limits: { revision: 8, maxConcurrent: 2 } };
    const sourceAccount = { ...ownerUser, modelAccess: 'custom', routeIds: ['rte_a'], defaultRouteId: 'rte_a', access: { terminal: false, files: false, tools: [], sharedDirectories: [] }, password: 'NEVER_COPY_PASSWORD', disabled: true, role: 'admin', revision: 12 };
    const snapshot = { ...ownerSnapshot(), admin: { ...ownerSnapshot().admin, users: [ownerUser, target] } };
    const env = ownerHarness(async ({ fields }) => fields.action === 'status' ? ownerSuccess({ initialized: true }) : fields.action === 'auth.restore' ? ownerSuccess({ user: ownerUser, csrf: 'csrf', cookieSession: true }) : fields.action === 'admin.getUser' ? ownerSuccess({ user: sourceAccount }) : ownerSuccess(snapshot));
    env.render(); await ownerTick(); let tree = env.render();
    if (mode === 'edit') tree = ownerAccountAction(env, tree, target.id);
    else { ownerNodes(tree, node => node.props?.['data-account-action'] === mode)[0].props.onClick(); tree = env.render(); }
    let picker = ownerNodes(tree, node => node.props?.['data-grant-copy'])[0];
    tree = ownerChooseMember(env, tree, 'data-member-picker-select', ownerUser.id); picker = ownerNodes(tree, node => node.props?.['data-grant-copy'])[0];
    await ownerNodes(picker, node => node.type === 'button')[0].props.onClick(); await ownerTick(); tree = env.render();
    const dialog = ownerNodes(tree, node => node.type === 'dialog')[0];
    assert.match(ownerText(dialog), /Grants applied to this form/);
    assert.equal(ownerNodes(dialog, node => node.props?.name === 'access.files')[0].props.checked, false);
    assert.equal(ownerNodes(dialog, node => node.props?.name === 'access.terminal')[0].props.checked, false);
    assert.doesNotMatch(ownerText(dialog), /NEVER_COPY_PASSWORD/);
    assert.equal(env.requests.some(row => ['admin.updateUser', 'admin.createUser', 'admin.createInvite'].includes(row.fields.action)), false, 'copying never saves or changes identity');
    if (mode === 'edit') {
      assert.equal(ownerNodes(dialog, node => node.props?.name === 'displayName')[0].props.defaultValue, target.displayName);
      assert.equal(ownerNodes(dialog, node => node.props?.name === 'role')[0].props.defaultValue, 'member');
      assert.equal(ownerNodes(dialog, node => node.props?.name === 'disabled')[0].props.defaultChecked, false);
    }
    env.dispose();
  }
});

test('saved effective access explains administrator limits and personal reductions', async () => {
  const preferences = { granted: { terminal: true, files: false, skills: ['one', 'two'] }, selection: { terminal: false, files: true, skills: ['one'] }, effective: { terminal: false, files: false, skills: ['one'] } };
  const env = ownerHarness(async ({ fields }) => fields.action === 'status' ? ownerSuccess({ initialized: true }) : fields.action === 'auth.restore' ? ownerSuccess({ user: ownerUser, csrf: 'csrf', cookieSession: true }) : fields.action === 'admin.getUser' ? ownerSuccess({ user: ownerUser, preferences, routes: [] }) : ownerSuccess(ownerSnapshot()));
  env.render(); await ownerTick(); let tree = env.render(); tree = ownerAccountAction(env, tree);
  ownerNodes(tree, node => node.props?.['data-access-section'] === 'capabilities')[0].props.onClick(); tree = env.render();
  const effective = () => ownerNodes(tree, node => node.props?.['data-effective-access'])[0];
  effective().props.onToggle({ currentTarget: { open: true } }); tree = env.render(); await ownerTick(); tree = env.render();
  assert.match(ownerText(effective()), /Administrator grant/); assert.match(ownerText(effective()), /Personal choice/); assert.match(ownerText(effective()), /Effective access/);
  assert.match(ownerText(effective()), /Limited by administrator grant/); assert.match(ownerText(effective()), /Reduced by personal choice/);
  assert.equal(env.requests.filter(row => row.fields.action === 'admin.getUser').length, 1); env.dispose();
});

test('native owner recovery is an explicit confirmed form and never auto-signs in', async () => {
  const env = ownerHarness(async ({ fields }) => fields.action === 'status' ? ownerSuccess({ initialized: true }) : fields.action === 'auth.restore' ? { ok: false, status: 401, json: async () => ({ ok: false, error: { code: 'UNAUTHENTICATED' } }) } : ownerSuccess({ ok: true }));
  env.render(); await ownerTick(); let tree = env.render();
  ownerNodes(tree, node => node.props?.['data-recover-administrator'])[0].props.onClick(); tree = env.render();
  assert.match(ownerText(tree), /native DSH owner page/);
  const form = ownerNodes(tree, node => node.type === 'form')[0];
  assert.equal(ownerNodes(form, node => node.props?.name === 'confirmRecovery')[0].props.required, true);
  assert.equal(ownerNodes(form, node => node.props?.name === 'displayName').length, 0);
  await form.props.onSubmit({ preventDefault() {}, currentTarget: { values: { username: 'admin', password: 'synthetic-recovered-password', confirmRecovery: 'on' }, reset() {} } }); await ownerTick(); tree = env.render();
  const request = env.requests.find(row => row.fields.action === 'owner.recoverAdministrator');
  assert.deepEqual(request.fields, { action: 'owner.recoverAdministrator', username: 'admin', password: 'synthetic-recovered-password' });
  assert.equal(request.headers['X-Lan-Owner-Setup'], 'confirm'); assert.match(ownerText(tree), /Administrator recovered/);
  assert.equal(env.requests.some(row => row.fields.action === 'login'), false); env.dispose();
});

test('invitation history loads on demand, mutates current revisions and shows reissued links', async () => {
  const pending = { id: 'inv_pending', displayName: 'Guest', status: 'pending', revision: 2, expiresAt: 20000 };
  let rows = [pending], selected = 0;
  const env = serviceAdminHarness(async ({ fields }) => fields.action === 'status' ? ownerSuccess({ initialized: true, memberUrl: 'http://192.168.2.5:18620/lan/' }) : fields.action === 'auth.restore' ? ownerSuccess({ user: ownerUser, csrf: 'csrf', cookieSession: true }) : fields.action === 'admin.listInvites' ? ownerSuccess({ items: rows, total: rows.length, page: 0, pages: 1 }) : fields.action === 'admin.revokeInvite' ? (rows = [{ ...pending, status: 'revoked', revision: 3 }], ownerSuccess({ ok: true })) : fields.action === 'admin.reissueInvite' ? ownerSuccess({ id: 'inv_new', inviteToken: 'x'.repeat(43), expiresAt: 30000 }) : ownerSuccess({ ...ownerSnapshot(), memberUrl: 'http://192.168.2.5:18620/lan/' }));
  env.render(); await ownerTick(); let tree = env.render();
  assert.equal(env.requests.some(row => row.fields.action === 'admin.listInvites'), false);
  ownerNodes(tree, node => node.props?.['data-invitation-history'])[0].props.onToggle({ currentTarget: { open: true } }); tree = env.render(); await ownerTick(); tree = env.render();
  assert.match(ownerText(tree), /Guest/);
  await ownerNodes(tree, node => node.type === 'button' && ownerText(node) === 'Revoke')[0].props.onClick(); await ownerTick(); tree = env.render();
  assert.deepEqual(env.requests.find(row => row.fields.action === 'admin.revokeInvite').fields, { action: 'admin.revokeInvite', inviteId: 'inv_pending', expectedRevision: 2 });
  await ownerNodes(tree, node => node.type === 'button' && ownerText(node) === 'Reissue')[0].props.onClick(); await ownerTick(); tree = env.render();
  assert.deepEqual(env.requests.find(row => row.fields.action === 'admin.reissueInvite').fields, { action: 'admin.reissueInvite', inviteId: 'inv_pending', expectedRevision: 3 });
  const result = ownerNodes(tree, node => node.props?.['data-invite-link'])[0], input = ownerNodes(result, node => node.type === 'input')[0];
  assert.equal(input.props.value, 'http://192.168.2.5:18620/lan/#invite=' + 'x'.repeat(43));
  input.props.ref.current = { select() { selected++; } };
  await ownerNodes(result, node => node.type === 'button')[0].props.onClick({ currentTarget: { ownerDocument: { execCommand(command) { assert.equal(command, 'copy'); return true; } } } }); tree = env.render();
  assert.equal(selected, 1); assert.match(ownerText(ownerNodes(tree, node => node.props?.['data-invite-link'])[0]), /Copied/);
  env.dispose();
});

test('self password form keeps mismatched and rejected drafts and returns to sign-in after success', async () => {
  let accept = false, resets = 0;
  const env = ownerHarness(async request => request.fields.action === 'status' ? ownerSuccess({ initialized: true }) : request.fields.action === 'auth.restore' ? ownerSuccess({ user: ownerUser, csrf: 'csrf', cookieSession: true }) : request.fields.action === 'password.change' ? accept ? ownerSuccess({ ok: true, signedOut: true }) : { ok: false, status: 403, json: async () => ({ ok: false, error: { code: 'CURRENT_PASSWORD_INVALID' } }) } : ownerSuccess(ownerSnapshot()));
  env.render(); await ownerTick(); let tree = env.render();
  ownerNodes(tree, node => node.props?.['data-workspace-page'] === 'account')[0].props.onClick(); tree = env.render();
  const submit = async values => { const section = ownerNodes(tree, node => node.props?.['data-self-password'])[0]; await ownerNodes(section, node => node.type === 'form')[0].props.onSubmit({ preventDefault() {}, currentTarget: { values, reset() { resets++; } } }); await ownerTick(); tree = env.render(); };
  const values = { currentPassword: 'original-password', password: 'a-new-long-password', confirmPassword: 'different-password' };
  await submit(values); assert.match(ownerText(tree), /passwords do not match/); assert.equal(env.requests.some(row => row.fields.action === 'password.change'), false);
  values.confirmPassword = values.password;
  await submit(values); assert.match(ownerText(tree), /current password is incorrect/); assert.equal(resets, 0);
  assert.deepEqual(env.requests.findLast(row => row.fields.action === 'password.change').fields, { action: 'password.change', currentPassword: values.currentPassword, password: values.password });
  accept = true; await submit(values); assert.equal(resets, 1); assert.match(ownerText(tree), /Password changed/);
  assert.equal(ownerNodes(tree, node => node.props?.['data-self-password']).length, 0); env.dispose();
});

test('account conflict preserves the captured revision and reload is an explicit draft replacement', async () => {
  let current = ownerSnapshot();
  const env = ownerHarness(async request => request.fields.action === 'status' ? ownerSuccess({ initialized: true }) : request.fields.action === 'auth.restore' ? ownerSuccess({ user: ownerUser, csrf: 'csrf', cookieSession: true }) : request.fields.action === 'admin.updateUser' ? { ok: false, status: 409, json: async () => ({ ok: false, error: { code: 'ACCOUNT_CONFLICT', message: 'Reload before saving' } }) } : request.fields.action === 'admin.getUser' ? ownerSuccess({ user: current.admin.users[0] }) : ownerSuccess(current));
  env.render(); await ownerTick(); let tree = env.render();
  tree = ownerAccountAction(env, tree);
  const dialog = () => ownerNodes(tree, node => node.type === 'dialog')[0];
  const submit = async () => { await ownerNodes(dialog(), node => node.type === 'form')[0].props.onSubmit({ preventDefault() {}, currentTarget: { values: { routeIds: [] }, reset() { assert.fail('A rejected draft must remain'); } } }); await ownerTick(); tree = env.render(); };
  await submit();
  assert.ok(dialog()); assert.match(ownerText(dialog()), /draft is kept/);
  assert.equal(env.requests.findLast(row => row.fields.action === 'admin.updateUser').fields.expectedRevision, 0);
  current = ownerSnapshot(); current.admin.users[0] = { ...current.admin.users[0], revision: 7, disabled: true };
  await ownerNodes(dialog(), node => node.type === 'button' && ownerText(node) === 'Discard draft and reload account')[0].props.onClick(); await ownerTick(); tree = env.render();
  await submit();
  assert.equal(env.requests.findLast(row => row.fields.action === 'admin.updateUser').fields.expectedRevision, 7);
  env.dispose();
});

test('owner native edit dialog confirms dirty Escape and renders submit errors inside', async () => {
  const env = ownerHarness(async request => request.fields.action === 'status' ? ownerSuccess({ initialized: true }) : request.fields.action === 'auth.restore' ? ownerSuccess({ user: ownerUser, csrf: 'csrf', cookieSession: true }) : request.fields.action === 'admin.updateUser' ? { ok: false, status: 403, json: async () => ({ ok: false, error: { code: 'FORBIDDEN', message: 'Account update denied' } }) } : ownerSuccess(ownerSnapshot()));
  env.render(); await ownerTick(); let tree = env.render(); tree = ownerAccountAction(env, tree);
  const dialog = () => ownerNodes(tree, node => node.type === 'dialog')[0]; assert.ok(dialog());
  let escapeStopped = 0, repeatPrevented = 0;
  dialog().props.onKeyDown({ key: 'Escape', stopPropagation() { escapeStopped++; }, preventDefault() { repeatPrevented++; } });
  assert.equal(escapeStopped, 1); assert.equal(repeatPrevented, 0, 'the browser can deliver cancel to this dialog');
  dialog().props.onKeyDown({ key: 'Escape', repeat: true, stopPropagation() { escapeStopped++; }, preventDefault() { repeatPrevented++; } });
  assert.equal(repeatPrevented, 1, 'holding Escape cannot close the next layer');
  dialog().props.onKeyDown({ key: 'Escape', nativeEvent: { isComposing: true }, stopPropagation() { assert.fail('IME Escape must remain native'); } });
  ownerNodes(dialog(), node => node.props?.onChangeCapture)[0].props.onChangeCapture(); tree = env.render();
  dialog().props.onCancel({ preventDefault() {} }); tree = env.render(); assert.ok(ownerNodes(dialog(), node => node.props?.['data-discard-edit']).length);
  dialog().props.onCancel({ preventDefault() {} }); tree = env.render();
  assert.equal(ownerNodes(dialog(), node => node.props?.['data-discard-edit']).length, 0, 'the next Escape dismisses only the discard prompt');
  assert.equal(ownerNodes(tree, node => node.props?.['data-workspace-window']).length, 1);
  dialog().props.onCancel({ preventDefault() {} }); tree = env.render();
  ownerNodes(dialog(), node => node.type === 'button' && ownerText(node) === 'Keep editing')[0].props.onClick(); tree = env.render(); assert.ok(dialog());
  await ownerNodes(dialog(), node => node.type === 'form')[0].props.onSubmit({ preventDefault() {}, currentTarget: { values: { routeIds: [] }, reset() {} } }); await ownerTick(); tree = env.render();
  assert.match(ownerText(dialog()), /Account update denied/);
  dialog().props.onCancel({ preventDefault() {} }); tree = env.render(); ownerNodes(dialog(), node => node.type === 'button' && ownerText(node) === 'Discard changes')[0].props.onClick(); tree = env.render(); assert.equal(dialog(), undefined); env.dispose();
});

test('owner edit dialog restores connected opener focus after close without scrolling', async () => {
  const dialogSource = source.slice(source.indexOf('        function EditDialog('), source.indexOf('        function Icon('));
  const body = dialogSource.match(/React\.useEffect\(\(\) => \{\n            const node([\s\S]*?)\n          \}, \[\]\);/)[1];
  const effect = new Script(`(function(dialog, returnFocusTo) { const node${body} })`).runInNewContext();
  const calls = [], opener = { isConnected: true, focus(options) { calls.push(['focus', options.preventScroll]); } };
  const node = { open: false, ownerDocument: { activeElement: opener }, querySelector() { return null; }, showModal() { this.open = true; calls.push(['open']); }, close() { this.open = false; calls.push(['close']); } };
  const cleanup = effect({ current: node }); cleanup(); assert.deepEqual(calls, [['open'], ['close']]); await ownerTick();
  assert.deepEqual(calls, [['open'], ['close'], ['focus', true]]);
  opener.isConnected = false; effect({ current: node })(); await ownerTick(); assert.equal(calls.filter(call => call[0] === 'focus').length, 1);
  const menuAnchor = { isConnected: true, focus(options) { calls.push(['menu focus', options.preventScroll]); } };
  node.querySelector = () => ({ focus(options) { assert.equal(node.open, true, 'the input is focused after the dialog becomes visible'); calls.push(['input focus', options.preventScroll]); } });
  effect({ current: node }, menuAnchor)(); await ownerTick(); assert.deepEqual(calls.at(-1), ['menu focus', true]);
  assert.deepEqual(calls.at(-3), ['input focus', true]);
  assert.doesNotMatch(dialogSource, /autoFocus: true/);
});

test('administrator information dialog restores opener focus after native close', async () => {
  for (const code of [source]) {
    const help = code.slice(code.indexOf('        function WorkspaceInfo('), code.indexOf('        function UserHome('));
    const body = help.match(/React\.useEffect\(\(\) => \{([\s\S]*?)\n          \}, \[open\]\);/)[1];
    const effect = new Script(`(function(open, dialog, opener) { ${body} })`).runInNewContext();
    const calls = [], trigger = { isConnected: true, focus(options) { calls.push(['focus', options.preventScroll]); } };
    const node = { open: false, showModal() { this.open = true; calls.push(['open']); }, close() { this.open = false; calls.push(['close']); } };
    assert.equal(effect(false, { current: node }, { current: trigger }), undefined);
    effect(true, { current: node }, { current: trigger })(); await ownerTick();
    assert.deepEqual(calls, [['open'], ['close'], ['focus', true]]);
  }
});

test('owner help checks actual isolation only on explicit admin click and renders refreshed result', async () => {
  let checked = false;
  const env = serviceAdminHarness(async request => {
    if (request.fields.action === 'status') return ownerSuccess({ initialized: true, memberUrl: 'http://localhost:59072/lan/', capabilities: { isolatedExecution: checked } });
    if (request.fields.action === 'auth.restore') return ownerSuccess({ user: ownerUser, csrf: 'csrf', cookieSession: true });
    if (request.fields.action === 'admin.checkIsolation') { checked = true; return ownerSuccess({ status: 'ready' }); }
    return ownerSuccess({ ...ownerSnapshot(), capabilities: { isolatedExecution: checked }, admin: { users: [ownerUser], modelCatalog: [], isolationCheck: { status: checked ? 'ready' : 'unchecked', checks: checked ? ['private-pid'] : [] } } });
  });
  env.render(); await ownerTick(); let tree = env.render(); assert.equal(checked, false);
  ownerNodes(tree, node => node.props?.['data-workspace-info'])[0].props.onClick({ currentTarget: {} }); tree = env.render();
  await ownerNodes(tree, node => node.props?.['data-isolation-check'])[0].props.onClick(); await ownerTick(); tree = env.render();
  const sent = env.requests.filter(request => request.fields.action === 'admin.checkIsolation'); assert.equal(sent.length, 1); assert.deepEqual(sent[0].fields, { action: 'admin.checkIsolation' }); assert.equal(sent[0].headers['X-Lan-CSRF'], 'c'.repeat(43));
  assert.match(ownerText(ownerNodes(tree, node => node.props?.['data-isolation-result'])[0]), /Checks passed/);
  ownerNodes(tree, node => node.props?.['data-close-info'])[0].props.onClick(); tree = env.render(); ownerNodes(tree, node => node.props?.['data-main-tab'] === 'workspace')[0]?.props.onClick(); env.dispose();
});

test('owner uninitialized entry never restores or initializes automatically', async () => {
  const env = ownerHarness(async () => ownerSuccess({ initialized: false })); env.render(); await ownerTick(); const tree = env.render();
  assert.deepEqual(env.requests.map(request => request.fields.action), ['status']);
  assert.equal(ownerNodes(tree, node => node.props?.name === 'confirmOwner')[0].props.required, true); env.dispose();
});

const pluginSection = tree => ownerNodes(tree, node => node.props?.['data-plugin-sharing'])[0];

test('member admin saves per-account plugin and MCP grants with CSRF on every request', async () => {
  const csrf = 'm'.repeat(43); let access = { plugins: null, mcpServers: null };
  const member = { id: 'usr_resources', username: 'resource_member', displayName: 'Resource member', role: 'member', routeIds: [] };
  const snapshot = () => ({ ...ownerSnapshot(), admin: { ...ownerSnapshot().admin, users: [ownerUser, { ...member, access }], pluginCatalog: [{ id: 'plugin-one', label: 'Plugin one' }], mcpCatalog: [] } });
  const env = ownerHarness(async request => {
    assert.equal(request.url, '/lan/api/lan-workspace'); assert.equal(request.headers['X-Lan-CSRF'], csrf); assert.equal(request.headers.Authorization, undefined);
    if (request.fields.action === 'snapshot') return ownerSuccess(snapshot());
    assert.equal(request.fields.action, 'admin.updateUser'); assert.equal(request.fields.userId, member.id);
    access = request.fields.access; return ownerSuccess({});
  }, { memberFlag: { user: ownerUser, csrf } });
  env.render(); await ownerTick(); let tree = env.render();
  const open = () => { tree = ownerAccountAction(env, tree, member.id); };
  open();
  const field = name => ownerNodes(tree, node => node.props?.name === name)[0];
  assert.equal(field('pluginsMode').props.value, 'inherit');
  field('pluginsMode').props.onChange({ target: { value: 'custom' } }); tree = env.render();
  field('pluginNames').props.onChange({ target: { checked: true } }); tree = env.render();
  field('mcpServersMode').props.onChange({ target: { value: 'custom' } }); tree = env.render();
  assert.match(ownerText(tree), /The host has no registered MCP servers/);
  const form = ownerNodes(tree, node => node.type === 'form' && ownerNodes(node, child => child.props?.name === 'pluginsMode').length)[0];
  await form.props.onSubmit({ preventDefault() {}, currentTarget: { values: { modelAccess: 'inherit', toolAccess: 'inherit', pluginsMode: 'custom', pluginNames: ['plugin-one'], mcpServersMode: 'custom', mcpServerNames: [] }, reset() {} } });
  await ownerTick(); tree = env.render();
  assert.deepEqual(env.requests.map(row => row.fields.action), ['snapshot', 'admin.updateUser', 'snapshot']);
  assert.deepEqual(access.plugins, ['plugin-one']); assert.deepEqual(access.mcpServers, []);
  open(); assert.equal(field('pluginsMode').props.value, 'custom'); assert.equal(field('pluginNames').props.checked, true);
  assert.equal(field('mcpServersMode').props.value, 'custom'); env.dispose();
});

test('administrator CLI permissions list configured commands and persist selected grants', async () => {
  const csrf = 'c'.repeat(43); let access = { cliTools: null };
  const member = { id: 'usr_cli', username: 'cli_member', displayName: 'CLI member', role: 'member', routeIds: [] };
  const snapshot = () => ({ ...ownerSnapshot(), admin: { ...ownerSnapshot().admin, users: [ownerUser, { ...member, access }], cliCatalog: [{ id: 'research-cli', label: 'Research CLI' }] } });
  const env = ownerHarness(async request => {
    assert.equal(request.headers['X-Lan-CSRF'], csrf);
    if (request.fields.action === 'snapshot') return ownerSuccess(snapshot());
    assert.equal(request.fields.action, 'admin.updateUser'); access = request.fields.access;
    return ownerSuccess({});
  }, { memberFlag: { user: ownerUser, csrf } });
  env.render(); await ownerTick(); let tree = env.render();
  tree = ownerAccountAction(env, tree, member.id);
  const field = name => ownerNodes(tree, node => node.props?.name === name)[0];
  assert.equal(field('cliToolsMode').props.value, 'inherit');
  field('cliToolsMode').props.onChange({ target: { value: 'custom' } }); tree = env.render();
  field('cliNames').props.onChange({ target: { checked: true } }); tree = env.render();
  const form = ownerNodes(tree, node => node.type === 'form' && ownerNodes(node, child => child.props?.name === 'cliToolsMode').length)[0];
  await form.props.onSubmit({ preventDefault() {}, currentTarget: { values: { modelAccess: 'inherit', toolAccess: 'inherit', cliToolsMode: 'custom', cliNames: ['research-cli'] }, reset() {} } });
  await ownerTick(); tree = env.render();
  assert.deepEqual(access.cliTools, ['research-cli']);
  tree = ownerAccountAction(env, tree, member.id);
  assert.equal(field('cliToolsMode').props.value, 'custom');
  assert.equal(field('cliNames').props.checked, true); env.dispose();
});

test('invalid member bootstrap CSRF never fetches a snapshot or falls back to owner authentication', async () => {
  for (const csrf of [undefined, '', 17, {}, 'x'.repeat(42), 'x'.repeat(44), 'x'.repeat(42) + '\\n']) {
    const env = ownerHarness(() => { throw new Error('No network allowed'); }, { memberFlag: { user: ownerUser, csrf } });
    env.render(); await ownerTick(); const tree = env.render();
    assert.deepEqual(env.requests, []); assert.match(ownerText(tree), /INVALID_RESPONSE/); assert.equal(pluginSection(tree), undefined); env.dispose();
  }
});

test('member snapshot has no administrator plugin selection controls for a member role', async () => {
  const user = { ...ownerUser, role: 'member' }, csrf = 'm'.repeat(43);
  const env = ownerHarness(async request => { assert.equal(request.headers['X-Lan-CSRF'], csrf); return ownerSuccess({ user, projects: [], routes: [] }); }, { memberFlag: { user, csrf } });
  env.render(); await ownerTick(); const tree = env.render();
  assert.deepEqual(env.requests.map(row => [row.fields.action, row.fields.section]), [['snapshot', 'base'], ['snapshot', 'usage']]);
  assert.equal(pluginSection(tree), undefined); assert.equal(ownerNodes(tree, node => node.props?.['data-admin-tab']).length, 0); env.dispose();
});

test('native verified account data renders immediately without a second serial snapshot read', async () => {
  const rootProps = { identity: ownerUser, initialSnapshot: ownerSnapshot() };
  rootProps.initialSnapshot.admin.userPage = { total: 1, pages: 1, page: 0, pageSize: 10, query: '', status: 'all' };
  const env = ownerHarness(async () => ownerSuccess({ ...ownerSnapshot(), user: { ...ownerUser, displayName: 'Manual refresh' } }),
    { rootProps, memberFlag: { user: ownerUser, csrf: 'm'.repeat(43) } });
  let tree = env.render();
  assert.equal(ownerNodes(tree, node => node.props?.['data-account-row']).length, 1, 'verified data is in the first render');
  await ownerTick(); tree = env.render(); assert.equal(env.requests.length, 0);
  rootProps.initialSnapshot = { ...ownerSnapshot(), admin: { ...ownerSnapshot().admin, users: [{ ...ownerUser, displayName: 'Native refresh' }] } };
  rootProps.initialSnapshot.admin.userPage = { total: 1, pages: 1, page: 0, pageSize: 10, query: '', status: 'all' };
  env.render(); await ownerTick(); tree = env.render(); assert.match(ownerText(tree), /Native refresh/);
  ownerNodes(tree, node => node.props?.['data-refresh-account'])[0].props.onClick(); await ownerTick(); tree = env.render();
  assert.equal(env.requests.length, 1); assert.equal(env.requests[0].fields.section, 'base');
  rootProps.initialSnapshot = { ...ownerSnapshot(), user: { ...ownerUser, displayName: 'Obsolete native refresh' } };
  env.render(); await ownerTick(); tree = env.render(); assert.doesNotMatch(ownerText(tree), /Obsolete native refresh/);
  env.dispose();
});

test('an unmatched seed is ignored and a pending first account read shows loading instead of a retry instruction', async () => {
  let release;
  const env = ownerHarness(async () => new Promise(resolve => { release = () => resolve(ownerSuccess(ownerSnapshot())); }), {
    rootProps: { identity: ownerUser, initialSnapshot: { ...ownerSnapshot(), user: { ...ownerUser, id: 'someone-else' } } },
    memberFlag: { user: ownerUser, csrf: 'm'.repeat(43) },
  });
  env.render(); await ownerTick(); let tree = env.render();
  assert.equal(ownerNodes(tree, node => node.props?.['data-account-row']).length, 0);
  assert.match(ownerText(tree), /Loading…/); assert.doesNotMatch(ownerText(tree), /Account state is not available yet/);
  release(); await ownerTick(); tree = env.render();
  assert.equal(ownerNodes(tree, node => node.props?.['data-account-row']).length, 1); env.dispose();
});

test('account rows and saved permissions render before a delayed catalog, keeping drafts and one request per window', async () => {
  let release;
  const env = ownerHarness(async ({ fields }) => fields.section === 'catalog'
    ? new Promise(resolve => { release = () => resolve(ownerSuccess({ ...ownerSnapshot(), admin: { ...ownerSnapshot().admin, skillCatalog: [{ id: 'new-skill', label: 'New skill' }] } })); })
    : ownerSuccess(ownerSnapshot()), { memberFlag: { user: ownerUser, csrf: 'm'.repeat(43) } });
  env.render(); await ownerTick(); let tree = env.render();
  assert.equal(ownerNodes(tree, node => node.props?.['data-account-row']).length, 1);
  assert.deepEqual(env.requests.map(row => row.fields.section), ['base']);
  tree = ownerAccountAction(env, tree);
  assert.equal(env.requests.length, 1, 'model grants require no resource scan');
  ownerNodes(tree, node => node.props?.['data-access-section'] === 'capabilities')[0].props.onClick(); tree = env.render();
  await ownerTick(); tree = env.render();
  assert.equal(typeof release, 'function');
  assert.equal(ownerNodes(tree, node => node.props?.['data-loading-section'] === 'catalog').length, 1);
  ownerNodes(tree, node => node.props?.role === 'switch')[0].props.onClick(); tree = env.render();
  release(); await ownerTick(); tree = env.render();
  assert.equal(ownerNodes(tree, node => node.props?.name === 'access.terminal')[0].props.checked, false, 'catalog arrival must retain the unsaved flag');
  ownerNodes(tree, node => node.props?.['data-access-section'] === 'models')[0].props.onClick(); tree = env.render();
  ownerNodes(tree, node => node.props?.['data-access-section'] === 'capabilities')[0].props.onClick(); env.render(); await ownerTick();
  assert.deepEqual(env.requests.map(row => row.fields.section), ['base', 'catalog']);
  env.dispose();
});

test('refresh discards an old slow catalog and a failed detail request can retry without blocking accounts', async () => {
  let releaseOld, fail = true, attempts = 0;
  const env = ownerHarness(async ({ fields }) => {
    if (fields.section !== 'catalog') return ownerSuccess(ownerSnapshot());
    if (++attempts === 1) return new Promise(resolve => { releaseOld = () => resolve(ownerSuccess({ ...ownerSnapshot(), user: { ...ownerUser, displayName: 'Obsolete response' } })); });
    if (fail) throw new Error('Catalog temporarily unavailable');
    return ownerSuccess(ownerSnapshot());
  }, { memberFlag: { user: ownerUser, csrf: 'm'.repeat(43) } });
  env.render(); await ownerTick(); let tree = env.render();
  ownerNodes(tree, node => node.props?.['data-workspace-page'] === 'preferences')[0].props.onClick(); env.render(); await ownerTick(); tree = env.render();
  ownerNodes(tree, node => node.props?.['data-refresh-account'])[0].props.onClick(); await ownerTick(); tree = env.render(); await ownerTick(); tree = env.render();
  releaseOld(); await ownerTick(); tree = env.render();
  assert.doesNotMatch(ownerText(tree), /Obsolete response/);
  const notice = ownerNodes(tree, node => node.props?.['data-loading-section'] === 'catalog')[0];
  assert.equal(notice.props.role, 'alert');
  fail = false; ownerNodes(notice, node => node.type === 'button')[0].props.onClick(); await ownerTick(); tree = env.render();
  assert.equal(attempts, 3);
  assert.equal(ownerNodes(tree, node => node.props?.['data-loading-section'] === 'catalog').length, 0);
  ownerNodes(tree, node => node.props?.['data-workspace-page'] === 'accounts')[0].props.onClick(); tree = env.render();
  assert.equal(ownerNodes(tree, node => node.props?.['data-account-row']).length, 1);
  env.dispose();
});

test('a refreshed narrower grant removes cached personal choices before the new catalog finishes', async () => {
  const user = { ...ownerUser, role: 'member' };
  let narrowed = false, release;
  const value = () => ({ user, projects: [], routes: [], preferences: {
    revision: 0, selection: { skills: null }, granted: { skills: narrowed ? ['one'] : ['one', 'two'] }, effective: {},
  } });
  const env = ownerHarness(async ({ fields }) => {
    if (fields.section !== 'catalog') return ownerSuccess(value());
    if (narrowed) return new Promise(resolve => { release = () => resolve(ownerSuccess(value())); });
    return ownerSuccess({ ...value(), preferences: { ...value().preferences, catalog: { skills: [{ id: 'one', label: 'Allowed one' }, { id: 'two', label: 'Revoked two' }] } } });
  }, { memberFlag: { user, csrf: 'm'.repeat(43) } });
  env.render(); await ownerTick(); let tree = env.render();
  ownerNodes(tree, node => node.props?.['data-workspace-page'] === 'preferences')[0].props.onClick(); env.render(); await ownerTick(); tree = env.render();
  ownerNodes(tree, node => node.props?.['data-personal-section'] === 'skills')[0].props.onClick(); tree = env.render();
  assert.match(ownerText(tree), /Revoked two/);
  narrowed = true; ownerNodes(tree, node => node.props?.['data-refresh-account'])[0].props.onClick(); await ownerTick(); tree = env.render(); await ownerTick(); tree = env.render();
  assert.equal(typeof release, 'function');
  assert.match(ownerText(tree), /Allowed one/); assert.doesNotMatch(ownerText(tree), /Revoked two/);
  release(); await ownerTick(); env.dispose();
});

test('forms have accessible labels, native confirmation and disabled pending controls', () => {
  assert.match(source, /return h\('label', \{ className: 'lanw-field' \}/);
  assert.match(source, /return h\('label', \{ className: 'lanw-check' \}/);
  assert.match(source, /h\('fieldset', \{ className: 'lanw-fieldset', disabled: isBusy \}/);
  assert.match(source, /const actionButton = \(label, props = \{\}\) => h\(Button, \{ disabled: isBusy/);
  assert.match(source, /role: 'alert'/);
  assert.match(source, /role: 'status'/);
  assert.match(source, /minLength: 16, maxLength: 1024/);
  assert.match(source, /autoComplete: 'current-password'/);
  assert.match(source, /'aria-current': currentPage === value \? 'page' : undefined/);
  assert.doesNotMatch(source, /'aria-pressed': selected\?\.id === project\.id/);
});
