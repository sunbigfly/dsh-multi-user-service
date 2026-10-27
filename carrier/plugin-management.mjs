import { createRequire } from 'node:module';

const packageName = createRequire(import.meta.url)('../package.json').name;
const requiredModules = new Set([
  packageName, `${packageName}/tool-origins`,
  '@deepseek-ai/dsh-client-connection', '@deepseek-ai/dsh-host-webserver',
  '@deepseek-ai/dsh-api-remote-access', '@deepseek-ai/dsh-remote-access',
  '@deepseek-ai/dsh-api-gateway', '@deepseek-ai/dsh-typert-registry',
  '@deepseek-ai/dsh-storage-domain', '@deepseek-ai/dsh-session-persistence',
]);
const requiredBundles = new Set([packageName, '@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app']);
const protectedModule = name => requiredModules.has(name);
const protectedBundle = row => requiredBundles.has(row.name) || row.rows?.some(entry => protectedModule(entry.moduleName));
const denied = (message, status = 403) => { throw Object.assign(new Error(message), { name: 'MemberCarrierError', code: 'SECURITY_PLUGIN_REQUIRED', status }); };

/** Business administrators manage optional plugins, while authentication and
 * its native carrier remain deployment infrastructure. A URL/role field never
 * chooses a target: resolve exact identities from the live Host inventory. */
export async function assertServicePluginChange(manager, endpoint, args) {
  if (!['pluginManager/setPluginEnabled', 'pluginManager/setBundleEnabled', 'pluginManager/removeBundle'].includes(endpoint)) return;
  if (!manager || !args || typeof args !== 'object' || Array.isArray(args)) denied('安全组件状态不可用，未执行插件变更。', 503);
  let target;
  if (endpoint === 'pluginManager/setPluginEnabled') {
    const rows = await manager.listPlugins();
    target = rows.find(row => row.entryId === args.id);
    if (!target || protectedModule(target.moduleName)) denied('认证与服务入口不能在业务页面停用，请通过服务器维护入口处理。');
  } else {
    const rows = await manager.listBundles();
    target = rows.find(row => row.name === args.name);
    if (!target || protectedBundle(target)) denied('多用户认证是服务必需组件，不能在业务页面停用或卸载。');
  }
}

/** Use the native manager's existing read-only affordance so a protected
 * control is explained before a user clicks it. The API guard is authoritative. */
export function servicePluginInventory(endpoint, rows) {
  if (!Array.isArray(rows)) return rows;
  if (endpoint === 'pluginManager/listBundles') return rows.map(row => protectedBundle(row) ? { ...row, removable: false, readOnlyReason: 'management-required' } : row);
  if (endpoint === 'pluginManager/listPlugins') return rows.map(row => {
    if (!protectedModule(row.moduleName)) return row;
    const { patchId: _patchId, ...value } = row;
    return { ...value, readOnlyReason: 'management-required' };
  });
  return rows;
}
