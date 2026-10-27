import { updateAccount } from './helpers/account-update.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { mkdir, writeFile, readFile, symlink } from 'node:fs/promises';
import { LanService, MemoryStore } from '../core/service.js';
import { MemberOwnership } from '../carrier/access.mjs';
import { MemberModels } from '../carrier/models.mjs';
import { MemberCapabilities } from '../carrier/capabilities.mjs';
import { installMemberSkills } from '../carrier/skills.mjs';
import { memberExecutionFixture } from '../verification/member-execution-fixture.mjs';

const modules = process.env.DSH_LAN_CONTRACT_MODULES;
async function fixture(t, resourceBases = {}) {
  const cap = {}, store = new MemoryStore(), core = new LanService({ store, hostCapability: cap });
  await core.start(); await core.setModelCatalog([]); t.after(() => core.close());
  const password = 'synthetic-skill-policy-password';
  const login = await core.execute({ action: 'bootstrap', username: 'admin', displayName: 'Admin', password }, { ownerBootstrap: true, audience: 'owner' });
  const admin = { token: login.token, csrf: login.csrf, audience: 'owner' }, users = {}, agents = new Map();
  const ownership = await new MemberOwnership({ store: new MemoryStore() }).start();
  for (const name of ['alice', 'bob']) {
    users[name] = (await core.execute({ action: 'admin.createUser', username: name, displayName: name, password }, admin)).user.id;
    const agent = { id: 'session-' + name, session: { header: { cwd: '/synthetic/' + name } } };
    agents.set(agent.id, agent); await ownership.record({ userId: users[name], sessionId: agent.id, projectId: 'workspace', cwd: agent.session.header.cwd });
  }
  const ctx = { agents: { get: id => agents.get(id), currentInitiator: () => undefined } };
  const models = new MemberModels({ core, hostCapability: cap, ownership, ctx });
  const capabilities = new MemberCapabilities({ core, hostCapability: cap, ownership, ctx });
  const load = name => import(pathToFileURL(join(modules, '@deepseek-ai', name, 'lib/index.js')).href);
  const [{ Context }, { default: SkillRegistry }] = await Promise.all([load('cordis'), load('dsh-skill')]);
  const root = new Context(), registry = root.plugin(SkillRegistry); await registry.await(); t.after(() => registry.dispose());
  let skills, reads = 0, hold, ready, release;
  const registrations = {};
  const binding = root.plugin({ inject: ['skills'], apply(child) {
    skills = child.skills;
    for (const name of ['alpha', 'beta']) registrations[name] = skills.register({ name, description: 'Synthetic ' + name, source: 'contract', content: name.toUpperCase() + '_BODY', ...(resourceBases[name] ? { resourceBase: { kind: 'directory', path: resourceBases[name] } } : {}) });
    const raw = skills[Symbol.for('cordis.original')] ?? skills, original = raw.get;
    raw.get = async function(...args) {
      reads++; const value = await original.apply(this, args);
      if (hold && args[0] === 'alpha') { ready(); await hold; }
      return value;
    };
    const restore = installMemberSkills(skills, { models, capabilities, ownership });
    child.effect(() => () => { restore(); raw.get = original; });
  } });
  await binding.await(); t.after(() => binding.dispose());
  return { core, cap, store, users, models, skills, capabilities, registrations,
    update: (name, access) => updateAccount(core, { action: 'admin.updateUser', userId: users[name], access }, admin),
    options: name => ({ scope: agents.get('session-' + name), cwd: '/synthetic/' + name }),
    get reads() { return reads; },
    holdNext() { const entered = new Promise(resolve => { ready = resolve; }); hold = new Promise(resolve => { release = resolve; }); return { entered, release: () => { release(); hold = undefined; } }; },
  };
}

test('real native skill catalogs and content apply account grants without changing owner discovery', { skip: !modules }, async t => {
  const f = await fixture(t);
  await f.update('alice', { skills: ['alpha'] }); await f.update('bob', { skills: ['beta'] });
  assert.deepEqual((await f.skills.list(f.options('alice'))).map(x => x.name), ['alpha']);
  assert.deepEqual((await f.skills.snapshot(f.options('bob'))).skills.map(x => x.name), ['beta']);
  assert.deepEqual((await f.skills.list()).map(x => x.name), ['alpha', 'beta']);
  const before = f.reads;
  await assert.rejects(f.skills.get('beta', f.options('alice')), { code: 'MEMBER_SKILL_DENIED' });
  assert.equal(f.reads, before, 'unauthorized content never enters the native getter');
  assert.equal((await f.skills.get('alpha', f.options('alice'))).content, 'ALPHA_BODY');
  await assert.rejects(f.skills.get('alpha', { ...f.options('alice'), cwd: '/synthetic/bob' }), { code: 'MEMBER_SKILL_DENIED' });
  await assert.rejects(f.models.forTool(f.options('alice').scope, () => f.skills.get('beta', f.options('bob'))), { code: 'MEMBER_MODEL_DENIED' });
});

test('a stale native skill result is withheld after revoke and regrant while another member continues', { skip: !modules }, async t => {
  const f = await fixture(t); await f.update('alice', { skills: ['alpha'] });
  const gate = f.holdNext(), pending = f.skills.get('alpha', f.options('alice'));
  const rejected = assert.rejects(pending, { code: 'MODEL_DENIED' });
  await gate.entered;
  await f.update('alice', { skills: [] });
  assert.equal((await f.skills.get('beta', f.options('bob'))).content, 'BETA_BODY');
  await f.update('alice', { skills: ['alpha'] });
  gate.release(); await rejected;
  assert.equal((await f.skills.get('alpha', f.options('alice'))).content, 'ALPHA_BODY');
});

test('skill grants survive legacy partial access updates and service restart', { skip: !modules }, async t => {
  const f = await fixture(t); await f.update('alice', { skills: [], tools: ['read'] });
  await f.update('alice', { terminal: false });
  assert.deepEqual(f.core.memberAccess(f.users.alice, f.cap).skills, []);
  assert.deepEqual(f.core.memberAccess(f.users.alice, f.cap).tools, ['read']);
  const restored = new LanService({ store: f.store, hostCapability: f.cap }); await restored.start(); t.after(() => restored.close());
  assert.deepEqual(restored.memberAccess(f.users.alice, f.cap).skills, []);
  assert.equal(restored.memberAccess(f.users.bob, f.cap).skills, null);
  assert.deepEqual(await f.skills.list(f.options('alice')), []);
});

test('skill grants control managed discovery and file access while script visibility follows DSH', { skip: !modules || process.platform !== 'linux' }, async t => {
  const execution = await memberExecutionFixture({ modules, parent: process.cwd() }); t.after(() => execution.close());
  const alpha = join(execution.directory, 'alpha'), beta = join(execution.directory, 'beta'), alias = join(execution.directory, 'alpha-link');
  await mkdir(alpha); await mkdir(beta); await symlink(alpha, alias);
  await writeFile(join(alpha, 'run.sh'), 'printf SKILL_SCRIPT_OK > skill-result.txt\n');
  await writeFile(join(beta, 'private.txt'), 'OTHER_SKILL');
  const f = await fixture(t, { alpha: alias, beta });
  await f.update('alice', { skills: ['alpha'] }); await f.update('bob', { skills: ['beta'] });
  const value = await f.skills.get('alpha', f.options('alice'));
  assert.equal(value.resourceBase.path, alpha, 'member instructions use the canonical resource base');
  await f.skills.snapshot(f.options('bob'));
  assert.deepEqual(f.capabilities.directories(f.users.alice), [{ path: alpha, mode: 'read-only' }]);
  assert.deepEqual(f.capabilities.directories(f.users.bob), [{ path: beta, mode: 'read-only' }]);
  assert.equal((await f.skills.get('alpha')).resourceBase.path, alias, 'owner result stays unchanged');
  execution.setDirectories(f.capabilities.directories(f.users.alice));
  assert.equal((await execution.run('read', { file_path: join(alpha, 'run.sh') })).isError, false);
  const result = await execution.run('bash', { description: 'Run granted skill resource', command: `bash '${alpha}/run.sh'; test -e '${beta}/private.txt'; if printf forbidden > '${alpha}/run.sh'; then exit 9; fi` });
  assert.equal(result.value?.exitCode, 0, JSON.stringify(result));
  assert.equal(await readFile(join(execution.cwd, 'skill-result.txt'), 'utf8'), 'SKILL_SCRIPT_OK');
  assert.equal((await execution.run('write', { file_path: join(alpha, 'run.sh'), content: 'bad' })).isError, true);
  await f.update('alice', { skills: [] });
  execution.setDirectories(f.capabilities.directories(f.users.alice));
  assert.equal((await execution.run('read', { file_path: join(alpha, 'run.sh') })).isError, true);
  assert.equal((await execution.run('bash', { description: 'Revoked skill resources are absent', command: `test -e '${alpha}/run.sh'` })).value?.exitCode, 0);
  assert.equal(f.capabilities.directories(f.users.bob).length, 1);
  await f.update('alice', { skills: ['alpha'] });
  f.registrations.alpha();
  assert.deepEqual(f.capabilities.directories(f.users.alice), [], 'native registry invalidation drops stale mounts');
});
