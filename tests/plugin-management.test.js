import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { assertServicePluginChange, servicePluginInventory } from '../carrier/plugin-management.mjs';

const name = createRequire(import.meta.url)('../package.json').name;
const bundles = [{ name, rows: [{ moduleName: name }] }, { name: 'dsh-office', rows: [{ moduleName: 'dsh-office' }], removable: true }, { name: 'renamed-security-bundle', rows: [{ moduleName: '@deepseek-ai/dsh-client-connection' }] }];
const plugins = [{ entryId: 'include:multi-user-service', moduleName: name, patchId: 'multi-user-service' }, { entryId: 'include:office', moduleName: 'dsh-office', patchId: 'office' }];
const manager = { listBundles: async () => bundles, listPlugins: async () => plugins };
test('service management cannot disable or remove its authentication bundle or renamed native carrier bundles', async () => {
  for (const bundle of [name, 'renamed-security-bundle']) {
    for (const endpoint of ['pluginManager/setBundleEnabled', 'pluginManager/removeBundle']) await assert.rejects(assertServicePluginChange(manager, endpoint, { name: bundle, enabled: false }), error => error.code === 'SECURITY_PLUGIN_REQUIRED');
  }
  await assert.rejects(assertServicePluginChange(manager, 'pluginManager/setPluginEnabled', { id: 'include:multi-user-service', enabled: false }), error => error.status === 403);
});
test('optional business plugins can still be managed, while unknown identities and unavailable inventories fail closed', async () => {
  await assertServicePluginChange(manager, 'pluginManager/setBundleEnabled', { name: 'dsh-office', enabled: false });
  await assertServicePluginChange(manager, 'pluginManager/removeBundle', { name: 'dsh-office' });
  await assertServicePluginChange(manager, 'pluginManager/setPluginEnabled', { id: 'include:office', enabled: true });
  await assert.rejects(assertServicePluginChange(manager, 'pluginManager/setPluginEnabled', { id: 'include' }), error => error.status === 403);
  await assert.rejects(assertServicePluginChange(null, 'pluginManager/removeBundle', { name }), error => error.status === 503);
});
test('native inventory presents security controls read-only and retains optional plugin controls', () => {
  const bundleView = servicePluginInventory('pluginManager/listBundles', bundles), pluginView = servicePluginInventory('pluginManager/listPlugins', plugins);
  assert.equal(bundleView[0].removable, false); assert.equal(bundleView[0].readOnlyReason, 'management-required');
  assert.equal(bundleView[1], bundles[1]); assert.equal(pluginView[0].patchId, undefined); assert.equal(pluginView[0].readOnlyReason, 'management-required');
  assert.equal(pluginView[1], plugins[1]); assert.equal(bundles[0].readOnlyReason, undefined); assert.equal(plugins[0].patchId, 'multi-user-service');
});
