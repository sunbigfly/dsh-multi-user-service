import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { installAdministratorDesktop } from '../carrier/desktop.mjs';

const modules = process.env.DSH_LAN_CONTRACT_MODULES;
test('remote browser availability hides Host desktop controls while local access uses the native probe', async t => {
  let probes = 0;
  const exact = new Map([['/open-in-app/apps', { handler(_req, res) {
    probes++;
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ apps: ['filemanager'] }));
  } }]]);
  const connection = { requestRejection: () => 401 };
  const bridge = installAdministratorDesktop({ exact, prefixes: new Map() }, connection);
  t.after(() => bridge.dispose());
  for (const origin of ['http://192.168.1.10:18620', 'https://dsh.example.com']) {
    const response = await bridge.serve(new Request(origin + '/lan/open-in-app/apps'), { role: 'admin' });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { apps: [] });
    assert.match(response.headers.get('cache-control'), /no-store/);
    const head = await bridge.serve(new Request(origin + '/lan/open-in-app/apps', { method: 'HEAD' }), { role: 'admin' });
    assert.equal(await head.text(), '');
  }
  assert.equal(probes, 0, 'remote availability must not probe or launch the Host desktop');
  for (const origin of ['http://localhost:18620', 'http://127.0.0.1:18620', 'http://[::1]:18620']) {
    const response = await bridge.serve(new Request(origin + '/lan/open-in-app/apps'), { role: 'admin' });
    assert.deepEqual(await response.json(), { apps: ['filemanager'] });
  }
  assert.equal(probes, 3);
  assert.equal((await bridge.serve(new Request('http://localhost/lan/open-in-app/apps'), { role: 'member' })).status, 403);
  assert.equal(probes, 3, 'local access must not grant members desktop authority');
});

test('administrator desktop bridge uses native handlers and keeps native owner authentication', { skip: !modules, timeout: 15000 }, async t => {
  const load = name => import(pathToFileURL(join(modules, '@deepseek-ai', name, 'lib/index.js')).href);
  const [{ Context }, Desktop] = await Promise.all(['cordis', 'dsh-host-open-in-app'].map(load));
  const root = new Context(), exact = new Map(), prefixes = new Map();
  const reject = () => 401, connection = { requestRejection: reject };
  const webServer = { exact, prefixes, register(route) { const map = route.kind === 'exact' ? exact : prefixes; map.set(route.path, route); return () => map.delete(route.path); } };
  const setup = root.plugin(ctx => {
    ctx.provide('webServer', webServer); ctx.provide('connection', connection);
    ctx.provide('subprocess', { async resolveExecutable() { throw Error('No desktop executable in fixture'); } });
  }); await setup.await(); t.after(() => setup.dispose());
  const fiber = root.plugin(Desktop, { probeTimeoutMs: 10, iconTimeoutMs: 10, launchWatchMs: 10 }); await fiber.await(); t.after(() => fiber.dispose());
  const bridge = installAdministratorDesktop(webServer, connection); t.after(() => bridge.dispose());
  assert.equal(connection.requestRejection({}), 401);
  const request = (path, init) => new Request('http://localhost/lan/open-in-app/' + path, init);
  assert.equal((await bridge.serve(request('apps'), { role: 'member' })).status, 403);
  const apps = await bridge.serve(request('apps'), { role: 'admin' });
  assert.equal(apps.status, 200); assert.ok(Array.isArray((await apps.json()).apps));
  const invalid = await bridge.serve(request('open', { method: 'POST', body: '{}' }), { role: 'admin' });
  assert.equal(invalid.status, 415, 'native content-type validation remains active');
  const oversized = await bridge.serve(request('open', { method: 'POST', body: 'x'.repeat(65537) }), { role: 'admin' });
  assert.equal(oversized.status, 413);
  assert.equal(connection.requestRejection({}), 401, 'only exact admitted in-process requests bypass the owner cookie check');
  bridge.dispose(); assert.equal(connection.requestRejection, reject);
});
