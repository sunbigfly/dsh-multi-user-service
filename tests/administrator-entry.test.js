import test from 'node:test';
import assert from 'node:assert/strict';
import { mountAdministratorEntry } from '../carrier/administrator-entry.mjs';

test('public root redirects every account to one service entry without relaying credentials; native owner auth stays separate', async () => {
  let route, disposed = false, ownerCalls = 0;
  const server = {
    getOrigin: () => 'http://127.0.0.1:59080',
    register(value) { route = value; return () => { disposed = true; }; },
    async fallback(_req, res) { ownerCalls++; res.writeHead(401, {}); res.end('native owner authentication required'); },
  };
  const auth = { trust(headers) { if (headers.host !== '192.168.1.7:59080') throw Object.assign(new Error('denied'), { code: 'HOST_DENIED' }); } };
  const dispose = mountAdministratorEntry(server, auth);
  const request = async (headers, method = 'GET', url = '/') => {
    const result = {};
    await route.handler({ headers, method, url }, { writeHead(status, values) { result.status = status; result.headers = values; }, end(body) { result.body = body; } });
    return result;
  };
  assert.deepEqual({ kind: route.kind, path: route.path }, { kind: 'exact', path: '/' });
  const guest = await request({ host: '192.168.1.7:59080', origin: 'https://external.example', 'sec-fetch-site': 'cross-site' }, 'GET', '/?token=not-a-credential-exchange');
  assert.equal(guest.status, 302); assert.equal(guest.headers.location, '/lan/');
  assert.equal(guest.body, undefined); assert.equal(guest.headers['set-cookie'], undefined);
  assert.equal((await request({ host: '192.168.1.7:59080' }, 'POST')).status, 405);
  const head = await request({ host: '192.168.1.7:59080' }, 'HEAD'); assert.equal(head.status, 302); assert.equal(head.body, undefined);
  assert.equal((await request({ host: 'untrusted.example:59080' })).status, 403);
  assert.equal((await request({ host: '127.0.0.1:59080' })).status, 401); assert.equal(ownerCalls, 1);
  dispose(); assert.equal(disposed, true);
});
