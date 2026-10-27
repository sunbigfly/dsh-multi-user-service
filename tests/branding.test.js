import test from 'node:test';
import assert from 'node:assert/strict';
import { Branding, MAX_LOGO_BYTES } from '../carrier/branding.mjs';
import { LanService, MemoryStore } from '../core/service.js';

const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGOwLvvwHwAFMgKhcQ++BAAAAABJRU5ErkJggg==';
async function fixture(t) {
  const cap = {}, core = new LanService({ store: new MemoryStore(), hostCapability: cap }); await core.start(); await core.setModelCatalog([]); t.after(() => core.close());
  const password = 'synthetic-branding-contract-password';
  const signed = await core.execute({ action: 'bootstrap', username: 'admin', displayName: 'Admin', password }, { ownerBootstrap: true });
  const admin = { token: signed.token, csrf: signed.csrf };
  await core.execute({ action: 'admin.createUser', username: 'member', displayName: 'Member', password }, admin);
  const logged = await core.execute({ action: 'login', username: 'member', password });
  const member = { token: logged.token, csrf: logged.csrf };
  const store = new MemoryStore(), branding = await new Branding({ store, core }).start();
  return { core, admin, member, store, branding, cut: () => core.memberModels(logged.user.id, cap), request: fields => ({ action: 'admin.updateBranding', expectedRevision: branding.snapshot().revision, logo: null, slogan: null, ...fields }) };
}

test('only an authenticated administrator with CSRF can persist public branding', async t => {
  const f = await fixture(t);
  assert.deepEqual(f.branding.snapshot(), { revision: 0, logo: null, slogan: null, name: null, badge: null, showPreviewBadge: true });
  await assert.rejects(f.branding.update(f.request({ slogan: 'Shared workspace' }), f.member), { code: 'FORBIDDEN' });
  await assert.rejects(f.branding.update(f.request({ slogan: 'Shared workspace' }), { token: f.admin.token }), { code: 'CSRF_INVALID' });
  const cut = f.cut();
  const { branding } = await f.branding.update(f.request({ slogan: 'Shared workspace', logo: png }), f.admin);
  cut.assertCurrent(); cut.close();
  assert.deepEqual(branding, { revision: 1, slogan: 'Shared workspace', logo: png, name: null, badge: null, showPreviewBadge: true });
  assert.deepEqual((await new Branding({ store: f.store, core: f.core }).start()).snapshot(), branding);
  assert.equal(JSON.stringify(branding).includes('password'), false);
  branding.slogan = 'not saved'; assert.equal(f.branding.snapshot().slogan, 'Shared workspace');
  assert.deepEqual((await f.branding.update(f.request({}), f.admin)).branding, { revision: 2, slogan: null, logo: null, name: null, badge: null, showPreviewBadge: true });
});

test('legacy appearance gains optional identity fields without a rewrite; old clients retain custom identity', async t => {
  const f = await fixture(t), legacy = { version: 1, revision: 4, logo: null, slogan: 'Legacy' }, store = new MemoryStore(legacy);
  const branding = await new Branding({ store, core: f.core }).start();
  assert.deepEqual(await store.load(), legacy);
  assert.deepEqual(branding.snapshot(), { revision: 4, logo: null, slogan: 'Legacy', name: null, badge: null, showPreviewBadge: true });
  await branding.update({ action: 'admin.updateBranding', expectedRevision: 4, logo: null, slogan: 'Shared', name: 'Team', badge: '' }, f.admin);
  const result = await branding.update({ action: 'admin.updateBranding', expectedRevision: 5, logo: null, slogan: 'Updated' }, f.admin);
  assert.equal(result.branding.name, 'Team'); assert.equal(result.branding.badge, '');
  assert.deepEqual((await new Branding({ store, core: f.core }).start()).snapshot(), result.branding);
});

test('preview badge visibility is durable, validates booleans and survives older client updates', async t => {
  const f = await fixture(t);
  for (const showPreviewBadge of [null, 0, 'false']) await assert.rejects(f.branding.update(f.request({ showPreviewBadge }), f.admin), { code: 'INVALID_INPUT' });
  await assert.rejects(f.branding.update(f.request({ showPreviewBadge: false }), f.member), { code: 'FORBIDDEN' });
  await assert.rejects(f.branding.update(f.request({ showPreviewBadge: false }), { token: f.admin.token }), { code: 'CSRF_INVALID' });
  await f.branding.update(f.request({ showPreviewBadge: false, logo: png, slogan: 'Shared', name: 'Team', badge: 'LAN' }), f.admin);
  const restored = await new Branding({ store: f.store, core: f.core }).start();
  assert.equal(restored.snapshot().showPreviewBadge, false);
  const hidden = await restored.update({ action: 'admin.updateBranding', expectedRevision: 1, logo: png, slogan: 'Updated' }, f.admin);
  assert.equal(hidden.branding.showPreviewBadge, false);
  assert.equal(hidden.branding.name, 'Team'); assert.equal(hidden.branding.badge, 'LAN');
  const visible = await restored.update({ action: 'admin.updateBranding', expectedRevision: 2, logo: png, slogan: 'Updated', showPreviewBadge: true }, f.admin);
  assert.equal(visible.branding.showPreviewBadge, true);
});

test('sidebar identity rejects invalid text independently of logo and slogan', async t => {
  const f = await fixture(t);
  for (const fields of [{ name: '' }, { name: 'x'.repeat(41) }, { name: ' leading' }, { badge: 'x'.repeat(17) }, { badge: 'a\nb' }, { badge: 1 }]) await assert.rejects(f.branding.update(f.request(fields), f.admin), { code: 'INVALID_INPUT' });
  const saved = await f.branding.update(f.request({ name: 'Team', badge: 'LAN' }), f.admin);
  assert.equal(saved.branding.name, 'Team'); assert.equal(saved.branding.badge, 'LAN');
  const cleared = await f.branding.update(f.request({ name: null, badge: null }), f.admin);
  assert.equal(cleared.branding.name, null); assert.equal(cleared.branding.badge, null);
});

test('branding validates image content, size and URL protocols without fetching images', async t => {
  const f = await fixture(t);
  for (const logo of ['javascript:alert(1)', 'data:image/svg+xml,<svg/>', 'data:image/png;base64,SGVsbG8=', 'http://user:password@example.test/logo.png', '/relative.png', 'https://example.test/' + 'x'.repeat(2048), 'data:image/png;base64,' + Buffer.alloc(MAX_LOGO_BYTES+1, 1).toString('base64')]) {
    await assert.rejects(f.branding.update(f.request({ logo }), f.admin), { code: 'INVALID_INPUT' });
  }
  for (const slogan of ['', ' leading space', 'line\nbreak', 'x'.repeat(81)]) await assert.rejects(f.branding.update(f.request({ slogan }), f.admin), { code: 'INVALID_INPUT' });
  await assert.rejects(f.branding.update(f.request({ extra: true }), f.admin), { code: 'INVALID_INPUT' });
  assert.equal(f.branding.snapshot().revision, 0);
  await f.branding.update(f.request({ logo: 'https://example.test/logo.png', slogan: '<script>plain text</script>' }), f.admin);
  assert.equal(f.branding.snapshot().logo, 'https://example.test/logo.png');
});

test('concurrent edits detect stale revisions and durable failure preserves the previous appearance', async t => {
  const f = await fixture(t), first = f.request({ slogan: 'First' }), second = f.request({ slogan: 'Second' });
  await f.branding.update(first, f.admin);
  await assert.rejects(f.branding.update(second, f.admin), { code: 'BRANDING_CONFLICT' });
  const before = f.branding.snapshot(); f.store.save = async () => { throw Error('storage unavailable'); };
  await assert.rejects(f.branding.update(f.request({ slogan: 'Not durable' }), f.admin), { code: 'BRANDING_STORAGE_FAILURE' });
  assert.deepEqual(f.branding.snapshot(), before);
});

test('invalid persisted branding is not silently reset or overwritten', async () => {
  const store = new MemoryStore({ version: 1, revision: 3, logo: 'javascript:bad', slogan: null });
  await assert.rejects(new Branding({ store, core: {} }).start(), { code: 'INVALID_INPUT' });
  assert.equal((await store.load()).logo, 'javascript:bad');
});
