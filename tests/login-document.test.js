import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { Script, createContext } from 'node:vm';
import { memberLoginDocument, LOGIN_CSP } from '../carrier/login-document.mjs';

const html = memberLoginDocument();
const script = html.match(/<script>([\s\S]*?)<\/script>/)[1];
const styles = html.match(/<style>([\s\S]*?)<\/style>/)[1];
const hash = value => createHash('sha256').update(value).digest('base64');

test('member sign-in document styles and script are hash-bound without owner boot or external resources', () => {
  assert.ok(LOGIN_CSP.includes(`script-src 'sha256-${hash(script)}'`));
  assert.ok(LOGIN_CSP.includes(`style-src 'sha256-${hash(styles)}'`));
  assert.match(LOGIN_CSP, /default-src 'none'; connect-src 'self'/);
  assert.match(LOGIN_CSP, /frame-ancestors 'self' http:\/\/127\.0\.0\.1:\* http:\/\/localhost:\*/);
  assert.doesNotMatch(LOGIN_CSP.replace(/frame-ancestors [^;]+/, '').replace(/img-src [^;]+/, ''), /unsafe-inline|https?:|\*/);
  assert.doesNotMatch(html, /__DSH_BOOT__|__DSH_REMOTE_ACCESS__|ownerToken|src=|<iframe|<link|type="module"/);
  assert.match(html, /<base href="\/lan\/">/);
  assert.match(html, /<form id="member-auth-form" method="post" action="\/lan\/auth"/);
  assert.match(styles, /width:min\(100% - 48px,400px\)/);
  assert.match(styles, /prefers-color-scheme:dark/);
  assert.match(styles, /\[hidden\]\{display:none!important\}/);
  assert.ok(styles.includes('.help:not([open]) p{display:none}'));
  assert.match(html, /class="invitation" hidden/);
  assert.equal((html.match(/<summary/g) || []).length, 1);
  assert.match(html, /autocomplete="username"/); assert.match(html, /type="password" autocomplete="current-password" required maxlength="1024"/);
});

test('both login entries directly reuse shared branding, escape text and preserve a hidden badge', () => {
  const branding = { name: 'R&D <team>', badge: '"Team"', logo: 'https://example.test/logo.png?a=1&b=2' };
  for (const administrator of [false, true]) {
    const document = memberLoginDocument({ administrator, branding });
    assert.match(document, /data-login-brand-name>R&amp;D &lt;team&gt;<\/span>/);
    assert.match(document, /<small>&quot;Team&quot;<\/small>/);
    assert.match(document, /src="https:\/\/example.test\/logo.png\?a=1&amp;b=2" alt="" referrerpolicy="no-referrer"/);
    assert.ok(document.includes(`· R&amp;D &lt;team&gt;</title>`));
    assert.ok(LOGIN_CSP.includes(`script-src 'sha256-${hash(document.match(/<script>([\s\S]*?)<\/script>/)[1])}'`));
  }
  const hidden = memberLoginDocument({ branding: { name: 'Team', badge: '', logo: null } });
  assert.doesNotMatch(hidden, /<small>|<img /);
});

function fixture({ language = 'en-US', fetcher = async () => ({ ok: true, json: async () => ({ ok: true }) }), administrator = false, pathname = '/lan/', search = '', fragment = '' } = {}) {
  const events = {}, calls = [], writes = [], redirects = [];
  const input = value => ({ value, disabled: false, required: false, addEventListener(name, fn) { this[name] = fn; } });
  const elements = { username: input(''), password: input(''), remember: { ...input('on'), checked: true }, inviteToken: input(''), displayName: input('') };
  elements.inviteToken.disabled = true; elements.displayName.disabled = true;
  const submit = {}, fieldset = { disabled: false }, status = { textContent: '', focus() { this.focused = true; } };
  const invitation = { hidden: true, querySelectorAll() { return [elements.inviteToken, elements.displayName]; } };
  const tabs = ['login', 'redeem'].map((mode, index) => ({ dataset: { mode }, attrs: { 'aria-selected': index ? 'false' : 'true' },
    setAttribute(name, value) { this.attrs[name] = value; }, getAttribute(name) { return this.attrs[name]; }, addEventListener(name, fn) { this[name] = fn; }, click() { this.clickHandler?.(); }, focus() { this.focused = true; } }));
  for (const tab of tabs) tab.addEventListener = function (name, fn) { if (name === 'click') this.clickHandler = fn; else this[name] = fn; };
  const tablist = { addEventListener(name, fn) { this[name] = fn; } };
  const form = { elements, querySelector(selector) { return selector === 'fieldset' ? fieldset : submit; }, addEventListener(name, fn) { events[name] = fn; }, setAttribute(name, value) { this[name] = value; } };
  const summary = { setAttribute(name, value) { this[name] = value; } };
  const store = new Map([['lan-workspace.member.username', 'remembered-member']]);
  const document = { documentElement: {}, querySelectorAll: selector => selector === '[data-mode]' ? tabs : [], querySelector(selector) {
    return ({ form, '.status': status, '.invitation': invitation, '.help summary': summary, '[role=tablist]': tablist, '[data-admin-login]': administrator ? {} : null })[selector];
  } };
  const cleanedUrls = [];
  const context = createContext({ document, URLSearchParams, history: { replaceState(_state, _title, url) { cleanedUrls.push(url); } }, navigator: { language }, location: { pathname, search, hash: fragment, replace(path) { redirects.push(path); } }, localStorage: {
    getItem: key => store.get(key), setItem(key, value) { store.set(key, value); writes.push([key, value]); }, removeItem(key) { store.delete(key); },
  }, fetch: async (url, options) => { calls.push({ url, ...options, fields: options.body ? JSON.parse(options.body) : undefined }); return fetcher(url, options); } });
  new Script(script).runInContext(context);
  return { events, calls, writes, redirects, cleanedUrls, elements, submit, fieldset, status, invitation, tabs, tablist, form, document, store, summary,
    submitForm: () => events.submit({ preventDefault() {} }) };
}

test('invitation fragments fill registration and are immediately removed from the address', async () => {
  const token = 'a'.repeat(43), f = fixture({ fragment: '#invite=' + token });
  assert.equal(f.invitation.hidden, false); assert.equal(f.elements.inviteToken.value, token);
  assert.deepEqual(f.cleanedUrls, ['/lan/']); assert.deepEqual(f.calls, []); assert.deepEqual(f.writes, []);
  await f.submitForm(); assert.equal(f.calls[0].fields.action, 'redeem'); assert.equal(f.calls[0].fields.inviteToken, token);
  const legacy = fixture({ administrator: true, fragment: '#invite=' + token }); assert.equal(legacy.invitation.hidden, false); assert.deepEqual(legacy.cleanedUrls, ['/lan/']);
  const invalid = fixture({ fragment: '#invite=not-valid' }); assert.equal(invalid.invitation.hidden, true); assert.equal(invalid.elements.inviteToken.value, '');
});

test('password change returns to a sign-in page with clear feedback', () => {
  const f = fixture({ search: '?passwordChanged=1' }); assert.match(f.status.textContent, /Password changed/); assert.deepEqual(f.calls, []);
});

test('sign-in uses only member fields and stores only the remembered username', async () => {
  const f = fixture();
  assert.equal(f.elements.username.value, 'remembered-member'); assert.equal(f.document.documentElement.lang, 'en');
  f.elements.username.value = 'member'; f.elements.password.value = 'never-persist-password';
  f.elements.inviteToken.value = 'irrelevant-invitation'; f.elements.displayName.value = 'ignored';
  await f.submitForm();
  assert.equal(f.calls[0].url, '/lan/auth'); assert.equal(f.calls[0].credentials, 'same-origin');
  assert.deepEqual(f.calls[0].fields, { action: 'login', username: 'member', password: 'never-persist-password', remember: true });
  assert.deepEqual(f.writes, [['lan-workspace.member.username', 'member']]); assert.deepEqual(f.redirects, ['/lan/']);
  assert.doesNotMatch(JSON.stringify(f.writes), /never-persist-password|irrelevant-invitation|csrf|token/);
  assert.equal(f.fieldset.disabled, false); assert.equal(f.form['aria-busy'], 'false');
});

test('legacy administrator options use the same service login, identity memory and destination', async () => {
  const document = memberLoginDocument({ administrator: true });
  assert.doesNotMatch(document, /data-admin-login|class="tabs" hidden|action="\/lan\/admin\/auth"/);
  assert.match(document, /<h1 data-copy="title">登录多用户服务/); assert.match(document, /action="\/lan\/auth"/);
  assert.ok(LOGIN_CSP.includes(`script-src 'sha256-${hash(document.match(/<script>([\s\S]*?)<\/script>/)[1])}'`));
  const f = fixture({ administrator: true });
  f.elements.username.value = 'administrator'; f.elements.password.value = 'synthetic-administrator-password';
  await f.submitForm();
  assert.equal(f.calls[0].url, '/lan/auth'); assert.equal(f.calls[0].fields.action, 'login');
  assert.equal(f.calls[0].fields.inviteToken, undefined); assert.deepEqual(f.redirects, ['/lan/']);
  assert.deepEqual(f.writes, [['lan-workspace.member.username', 'administrator']]);
});

test('both verified account roles resume the same service session; unauthenticated results cannot resume', async () => {
  for (const role of ['admin', 'member', null]) {
    const f = fixture({ administrator: true, pathname: '/', fetcher: async () => ({ ok: role !== null, json: async () => ({ ok: true, result: { user: { role } } }) }) });
    for (let i = 0; i < 10; i++) await Promise.resolve();
    assert.equal(f.calls[0].url, '/lan/auth/session'); assert.equal(f.calls[0].credentials, 'same-origin');
    assert.deepEqual(f.redirects, role ? ['/lan/'] : []);
  }
});

test('invitation is an explicit separate mode with new-password autofill and required invite fields', async () => {
  const f = fixture({ language: 'zh-CN' }); f.tabs[1].click();
  assert.equal(f.document.documentElement.lang, 'zh-CN'); assert.equal(f.invitation.hidden, false);
  assert.equal(f.elements.inviteToken.disabled, false); assert.equal(f.elements.inviteToken.required, true);
  assert.equal(f.elements.displayName.required, true); assert.equal(f.elements.password.autocomplete, 'new-password'); assert.equal(f.elements.password.minLength, 16);
  f.elements.username.value = 'invited'; f.elements.password.value = 'long-invited-password'; f.elements.inviteToken.value = 'invite-only'; f.elements.displayName.value = 'Member';
  await f.submitForm(); assert.equal(f.calls[0].fields.action, 'redeem'); assert.equal(f.calls[0].fields.inviteToken, 'invite-only');
  f.tabs[0].click(); assert.equal(f.invitation.hidden, true); assert.equal(f.elements.inviteToken.disabled, true); assert.equal(f.elements.password.autocomplete, 'current-password');
});

test('unchecked remember removes only the username and never persists passwords', async () => {
  const f = fixture(); f.elements.remember.checked = false; f.elements.remember.change();
  assert.equal(f.store.size, 0); f.elements.password.value = 'secret-password'; await f.submitForm();
  assert.equal(f.calls[0].fields.remember, false); assert.equal(f.store.size, 0); assert.deepEqual(f.writes, []);
});

test('pending blocks duplicate sign-in and failure remains text-only, focused and recoverable', async () => {
  let release; const deferred = new Promise(resolve => { release = resolve; });
  const f = fixture({ fetcher: () => deferred }); const first = f.submitForm();
  assert.equal(f.fieldset.disabled, true); assert.equal(f.form['aria-busy'], 'true'); assert.ok(f.tabs.every(tab => tab.disabled));
  await f.submitForm(); assert.equal(f.calls.length, 1); f.tabs[1].click(); assert.equal(f.invitation.hidden, true);
  release({ ok: false, json: async () => ({ ok: false, error: { message: '<img src=x onerror=bad()>' } }) }); await first;
  assert.equal(f.status.textContent, '<img src=x onerror=bad()>'); assert.equal(f.status.focused, true); assert.equal(f.fieldset.disabled, false); assert.equal(f.form['aria-busy'], 'false'); assert.deepEqual(f.redirects, []);
  assert.doesNotMatch(script, /innerHTML|document\.cookie|setItem\([^,]*(?:password|token)/i);
});

test('member login tabs support keyboard switching without submitting a request', () => {
  const f = fixture(); f.tablist.keydown({ key: 'ArrowRight', preventDefault() {} });
  assert.equal(f.tabs[1].attrs['aria-selected'], 'true'); assert.equal(f.tabs[1].focused, true);
  f.tablist.keydown({ key: 'Home', preventDefault() {} }); assert.equal(f.invitation.hidden, true); assert.equal(f.calls.length, 0);
});
