import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { installMemberScheduleAdmission } from '../carrier/capabilities.mjs';

const modules = process.env.DSH_LAN_CONTRACT_MODULES;
test('real native scheduler refuses revoked reminder admission and delivers another account', { skip: !modules, timeout: 10000 }, async t => {
  const load = name => import(pathToFileURL(join(modules, '@deepseek-ai', name, 'lib/index.js')).href);
  const [{ Context }, { default: Schedule }, { default: Agents }] = await Promise.all(['cordis', 'dsh-schedule', 'dsh-agent'].map(load));
  const root = new Context(), table = new Map(), deliveries = [], resolutions = [], grants = new Map([['a', true], ['b', true]]);
  const agents = new Map(['a', 'b'].map(id => [id, { id, session: { id, header: {} }, followup(input) { deliveries.push({ id: this.id, input }); } }]));
  const restores = [...agents.values()].map(agent => installMemberScheduleAdmission(agent, { userOf: agent => agent.id, policy: id => ({ tasks: grants.get(id) }) }));
  t.after(() => restores.forEach(restore => restore()));
  const agentFiber = root.plugin(Agents); await agentFiber.await(); t.after(() => agentFiber.dispose());
  const fixture = root.plugin(ctx => {
    ctx.provide('storageDomain', { async open() { return { table: () => ({ entries: () => table.entries(), get: id => table.get(id), async put(id, value) { table.set(id, value); }, async delete(id) { table.delete(id); } }), async close() {} }; } });
    ctx.provide('sessions', { async flush() { return true; } });
    ctx.provide('sessionPersistence', {});
    ctx.provide('sessionController', { async resolveAgent(id) { resolutions.push(id); return { agent: agents.get(id) }; } });
  });
  await fixture.await(); t.after(() => fixture.dispose());
  const fiber = root.plugin(Schedule, {}); await fiber.await(); t.after(() => fiber.dispose());
  const schedule = root.get('schedule');
  const at = new Date(Date.now() + 300).toISOString();
  const a = await schedule.create('a', { title: 'Revocation fixture', prompt: 'synthetic A', at });
  const b = await schedule.create('b', { title: 'Other account fixture', prompt: 'synthetic B', at });
  grants.set('a', false);
  for (let n = 0; deliveries.length === 0; n++) { assert.ok(n < 100); await new Promise(r => setTimeout(r, 20)); }
  assert.ok(resolutions.includes('a'));
  assert.deepEqual(deliveries.map(x => x.id), ['b']);
  assert.equal(deliveries[0].input.source.kind, 'schedule');
  const catalog = await schedule.catalog();
  assert.equal(catalog.find(x => x.id === a.id).lastDelivery, undefined);
  assert.equal(catalog.find(x => x.id === b.id).status, 'inactive');
  assert.equal(table.size, 2, 'denial preserves native records and history');
});
