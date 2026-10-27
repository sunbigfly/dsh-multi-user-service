import test from 'node:test';
import assert from 'node:assert/strict';
import { LanService } from '../core/service.js';
import { DomainStore } from '../domain-store.js';
import { createRequestHandler } from '../http.js';

// Real bridge + real policy/KDF + real persistence adapter; only the DSH KV
// table is in-memory. No production administrator is created by these tests.
const ORIGIN = 'http://127.0.0.1:59844';
const PASSWORD = 'local integration only password';
async function fixture(t) {
  let stored;
  const table = { get: () => stored, put: async (_key, value) => { stored = structuredClone(value); } };
  const store = new DomainStore({ table: () => table });
  const service = new LanService({ store });
  await service.start();
  await service.setProviderKeys(['test-provider']);
  t.after(() => service.close());
  const handler = createRequestHandler(service, { origin: ORIGIN });
  const call = async (action, fields = {}, auth, headers = {}) => {
    const response = await handler(new Request('http://dsh.internal/api/lan-workspace', {
      method: 'POST', headers: { origin: ORIGIN, 'content-type': 'application/json',
        ...(auth ? { ...(auth.cookie ? { cookie: auth.cookie } : { authorization: `Bearer ${auth.token}` }), 'x-lan-csrf': auth.csrf } : {}), ...headers },
      body: JSON.stringify({ action, ...fields }),
    }));
    const body = await response.json();
    const setCookie = response.headers.get('set-cookie');
    if (body.result?.cookieSession && setCookie) body.result.cookie = setCookie.split(';')[0];
    return { status: response.status, body, setCookie };
  };
  const initialized = await call('bootstrap', { username: 'owner', displayName: 'Owner', password: PASSWORD }, undefined, { 'x-lan-owner-setup': 'confirm' });
  assert.equal(initialized.status, 200);
  const admin = initialized.body.result;
  return { service, store, call, admin, table };
}

test('HTTP to durable store: admin invitation, member privacy, route revocation and terminal refusal', async t => {
  const { call, store, admin } = await fixture(t);
  const routeReply = await call('admin.upsertRoute', { label: 'Authorized route', provider: 'test-provider', model: 'model-hidden-from-member', enabled: true, default: true }, admin);
  assert.equal(routeReply.status, 200);
  const route = routeReply.body.result.route;
  const inviteReply = await call('admin.createInvite', { routeIds: [route.id], defaultRouteId: route.id }, admin);
  assert.equal(inviteReply.status, 200);
  const invitation = inviteReply.body.result;
  const redeem = await call('redeem', { inviteToken: invitation.inviteToken, username: 'member', displayName: 'Member', password: PASSWORD });
  assert.equal(redeem.status, 200);
  const member = redeem.body.result;
  assert.equal(member.user.role, 'member');
  assert.equal((await call('redeem', { inviteToken: invitation.inviteToken, username: 'another', displayName: 'Another', password: PASSWORD })).status, 400);
  assert.equal((await call('admin.createInvite', { routeIds: [] }, member)).status, 403);
  const created = await call('projects.create', { title: 'Private project', routeId: route.id }, member);
  assert.equal(created.status, 200);
  const project = created.body.result.project;
  assert.equal(project.rootSessionId, null); assert.equal(project.state, 'reserved');
  assert.equal(project.relativePath, `${member.user.id}/${project.id}`);
  const own = await call('snapshot', {}, member);
  assert.equal(own.status, 200); assert.equal(own.body.result.projects.length, 1);
  assert.equal(own.body.result.admin, undefined);
  const publicRoute = own.body.result.routes[0];
  assert.deepEqual(Object.keys(publicRoute).sort(), ['default', 'enabled', 'id', 'label']);
  const usage = JSON.stringify(own.body.result.usage);
  for (const secret of [project.id, project.title, project.relativePath, 'test-provider', 'model-hidden-from-member', member.cookie]) assert.equal(usage.includes(secret), false);
  assert.equal(own.body.result.usage.users.every(row => row.calls === null), true);
  const terminal = await call('terminal.open', { projectId: project.id }, member);
  assert.equal(terminal.status, 503); assert.equal(terminal.body.error.code, 'ISOLATION_UNAVAILABLE');
  const foreign = await call('terminal.open', { projectId: project.id }, admin);
  assert.equal(foreign.status, 404);
  await call('admin.updateUser', { expectedRevision: member.user.revision, userId: member.user.id, routeIds: [], defaultRouteId: null }, admin);
  assert.equal((await call('projects.open', { projectId: project.id }, member)).status, 403);
  // Metadata remains editable after route revocation, but never executes.
  assert.equal((await call('projects.rename', { projectId: project.id, title: 'Renamed privately' }, member)).status, 200);
  const persisted = JSON.stringify(await store.load());
  for (const secret of [PASSWORD, admin.cookie.split('=')[1], admin.csrf, member.cookie.split('=')[1], member.csrf, invitation.inviteToken]) assert.equal(persisted.includes(secret), false);
});

test('HTTP and policy jointly reject body authority, absent CSRF and client usage injection', async t => {
  const { call, admin } = await fixture(t);
  assert.equal((await call('admin.createUser', { username: 'test', displayName: 'Test', password: PASSWORD, routeIds: [], role: 'admin' }, admin)).status, 400);
  assert.equal((await call('admin.createInvite', { routeIds: [] }, admin, { 'x-lan-csrf': '' })).status, 403);
  const usage = await call('recordUsage', { inputTokens: 999, calls: 999 }, admin);
  assert.equal(usage.status, 400);
  const before = await call('snapshot', {}, admin);
  assert.equal(before.body.result.usage.users[0].calls, null);
  const csrfAsToken = await call('snapshot', {}, { token: admin.csrf, csrf: admin.csrf });
  assert.equal(csrfAsToken.status, 401);
  await call('logout', {}, admin);
  assert.equal((await call('snapshot', {}, admin)).status, 401);
});
