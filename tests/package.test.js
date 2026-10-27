import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const text = file => fs.readFile(path.join(root, file), 'utf8');

test('bundle manifest exports shipped runtime, localized display metadata and an original icon', async () => {
  const pkg = JSON.parse(await text('package.json'));
  assert.equal(pkg.name, '@sunbigfly/dsh-multi-user-service');
  assert.equal(pkg.dsh.bundle.patch, './cordis.patch.yml');
  assert.equal(pkg.dsh.client.platform, 'web');
  assert.equal(pkg.dsh.client.immediately, true);
  for (const key of ['.', './client', './icon', './locale/*.json']) assert.equal(typeof pkg.exports[key], 'string');
  assert.equal(pkg.scripts.preinstall, undefined);
  assert.equal(pkg.scripts.postinstall, undefined);
  for (const file of ['index.js', 'http.js', 'domain-store.js', 'client.js', 'core/service.js', 'core/validation.js', 'core/errors.js', 'core/lifecycle.js', 'core/store.js', 'cordis.patch.yml', 'locale/en.json', 'locale/zh.json', 'assets/logo-icon.png', 'README.md', 'CONTRACT.md', 'LICENSE']) {
    assert.ok((await fs.stat(path.join(root, file))).isFile(), file);
    assert.ok(pkg.files.some(pattern => pattern === file || pattern === 'core/*.js' && file.startsWith('core/') || pattern === 'locale/*.json' && file.startsWith('locale/')), `not in distribution: ${file}`);
  }
  for (const locale of ['en', 'zh']) {
    const metadata = JSON.parse(await text(`locale/${locale}.json`));
    assert.ok(metadata.meta.title.length > 5);
    assert.ok(metadata.meta.description.length > 30);
    assert.equal(/decoration|blue circle/i.test(JSON.stringify(metadata)), false);
  }
  const icon = await fs.readFile(path.join(root, 'assets/logo-icon.png'));
  assert.ok(icon.byteLength < 256 * 1024);
  assert.deepEqual([...icon.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
  assert.equal(icon.readUInt32BE(16), 256);
  assert.equal(icon.readUInt32BE(20), 256);
});

test('client is a classic JavaScript bundle that parses without loading or emulating the DOM', async () => {
  const source = await text('client.js');
  assert.doesNotThrow(() => new vm.Script(source, { filename: 'client.js' }));
  assert.match(source, /@sunbigfly\/dsh-multi-user-service/);
  assert.deepEqual([...source.matchAll(/require\(['"](@deepseek-ai\/[^'"]+)/g)].map(match => match[1]), ['@deepseek-ai/dsh-client-ui-primitives']);
  assert.equal(/document\.body\.(?:append|insert)|innerHTML\s*=|dangerouslySetInnerHTML/.test(source), false);
  assert.equal(/sessionStorage|document\.cookie/.test(source), false);
  const storageWrites = [...source.matchAll(/localStorage\??\.setItem\(([^\n]+)\)/g)].map(match => match[1]);
  assert.ok(storageWrites.every(write => /username|rememberedName|accountName|DESKTOP_SESSION_KEY/i.test(write)), 'storage is limited to the remembered username and the Desktop facade session');
  assert.match(source, /const desktopWindow = !window\.__DSH_LAN_MEMBER__ && desktopEndpoint !== null/);
  assert.match(source, /const writeDesktopSession = value => \{\s*if \(!desktopWindow\) return/);
  assert.equal(/localStorage\??\.setItem\([^\n]*(?:password|bearer|auth\.current|JSON\.stringify\(result)/i.test(source), false);
});

test('bundle keeps its own entry identities and the native tool-origin startup dependency', async () => {
  const patch = await text('cordis.patch.yml');
  assert.match(patch, /- insert:/);
  assert.match(patch, /id: multi-user-service/);
  assert.match(patch, /- id: tools\n  inject:\n    - lanToolOrigins\n/);
  assert.deepEqual([...patch.matchAll(/name: '([^']+)'/g)].map(match => match[1]), [
    '@sunbigfly/dsh-multi-user-service/tool-origins', '@sunbigfly/dsh-multi-user-service',
  ]);
  assert.equal(/override:|disabled:|!!js|\binclude:/.test(patch), false);
});

test('marketplace compatibility only authorizes the verified full DSH release', async () => {
  const pkg = JSON.parse(await text('package.json'));
  assert.equal(pkg.engines.dsh, '0.2.1-rc.2');
  assert.equal(pkg.dsh.compatibility.dsh, pkg.engines.dsh);
  assert.equal(pkg.dsh.compatibility.node, pkg.engines.node);
  assert.deepEqual(pkg.dsh.compatibility.profiles, ['web']);
  assert.deepEqual(pkg.dsh.compatibility.dshReleases, {
    '0.2.1-rc.1': 'unknown', '0.2.1-rc.2': 'compatible', '0.2.1-rc.3': 'unknown',
  });
  assert.ok(pkg.files.includes('docs/store-verification.md'));
  assert.match(await text('docs/store-verification.md'), /Patch service injection requires an explicit supported additive contract/);
});

test('Host bridge does not allocate host processes, import credentials or reconfigure existing sessions', async () => {
  const source = await text('index.js');
  const accounts = await text('runtime/lan-account-runtime.mjs');
  assert.match(source, /inspectLanAccountRuntime\(selectedRuntime\)/);
  assert.match(source, /openLanAccountRuntime\(\{ storageDomain, assertCurrent: assertOwnerCurrent \}\)/);
  assert.match(accounts, /new LanService\(\{store,runtime:runtimeIdentity,sessions:row\.sessions,hostCapability\}\)/);
  assert.equal(/spawnTerminal|child_process|terminalController|process\.env|credentials\.(?:resolve|readRecord)/.test(accounts), false);
  assert.match(source, /mountMembers\(ctx,/);
  assert.match(source, /requestBody: 'streaming'/);
  assert.match(source, /ctx\.connection\.fetch\.register/);
  assert.equal(/spawnTerminal|child_process|terminalController|ctx\.configEditor\.edit|process\.env|credentials\.(?:resolve|readRecord)/.test(source), false);
  assert.match(source, /ModelCatalog/);
});
