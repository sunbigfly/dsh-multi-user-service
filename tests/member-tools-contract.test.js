import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { memberToolAllow } from '../carrier/access.mjs';

const modules = process.env.DSH_LAN_CONTRACT_MODULES;
const load = name => import(pathToFileURL(join(modules, '@deepseek-ai', name, 'lib/index.js')).href);

test('real DSH registry: member masks preserve inherited preset tools and Agent-local delegation', { skip: !modules }, async t => {
  const [{ Context }, { ToolRuntime }, { createScope, scopeParentOf }] = await Promise.all(['cordis', 'dsh-tools', 'dsh-scope'].map(load));
  const root = new Context();
  root.provide('systemPrompt', { tools() {}, section() {} });
  const runtime = root.plugin(ToolRuntime);
  t.after(() => runtime.dispose());
  await runtime.await();
  const probe = root.plugin({ inject: ['tools'], async apply(ctx) {
    const preset = {}, member = {}, child = {};
    const presetScope = createScope(ctx, preset);
    const memberScope = createScope(ctx, member, { parent: preset });
    const childScope = createScope(ctx, child, { parent: member });
    t.after(async () => { await childScope.dispose(); await memberScope.dispose(); await presetScope.dispose(); });
    const register = (scope, name) => scope.tools.register({
      name, description: 'Registry contract fixture',
      parameters: { type: 'object', properties: {} },
      output: { schema: { type: 'string' }, render: value => [{ type: 'text', text: value }] },
      execute: () => 'fixture',
    });
    for (const name of ['read', 'write', 'bash', 'terminal']) register(presetScope.ctx, name);
    register(memberScope.ctx, 'subagent');
    const names = scope => ctx.tools.schemas(scope).map(tool => tool.name).sort();
    assert.deepEqual(names(), [], 'preset tools do not appear in the global registry');
    const inherited = memberScope.ctx.tools.schemas(scopeParentOf(member));
    assert.equal(inherited.some(tool => tool.name === 'subagent'), false, 'Agent-local tools must not be named to restrict()');
    memberScope.ctx.tools.restrict({ allow: memberToolAllow(inherited, ['read', 'write', 'bash']) });
    assert.deepEqual(names(member), ['bash', 'read', 'subagent', 'write']);
    assert.deepEqual(names(preset), ['bash', 'read', 'terminal', 'write'], 'owner preset is unchanged');
    register(childScope.ctx, 'subagent');
    childScope.ctx.tools.restrict({ allow: memberToolAllow(childScope.ctx.tools.schemas(scopeParentOf(child)), ['read', 'write', 'bash']) });
    assert.deepEqual(names(child), ['bash', 'read', 'subagent', 'write'], 'delegated scope keeps allowed inherited tools');
  } });
  t.after(() => probe.dispose());
  await probe.await();
});
