/** Inspect a restored copy with the installed native readers, never a DSH server. */
import { readFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import assert from 'node:assert/strict';
import { z } from 'zod';
import { DomainStore, DOMAIN_SPEC } from '../domain-store.js';
import { LanService, MemoryStore } from '../core/service.js';
import { readArchivedSessions } from '../carrier/workspaces.mjs';

const [destination, proofPath, credentialPath, baselinePath] = process.argv.slice(2);
if (!destination || !proofPath || !credentialPath || !baselinePath) throw new Error('Pass restored directory, synthetic proof, credentials and native baseline paths');
const modules = process.env.DSH_LAN_CONTRACT_MODULES;
if (!modules) throw new Error('Installed native module directory is required');
const load = name => import(pathToFileURL(join(modules, '@deepseek-ai', name, 'lib/index.js')).href);
const proof = JSON.parse(await readFile(proofPath, 'utf8')), credential = JSON.parse(await readFile(credentialPath, 'utf8'));
const baseline = JSON.parse(await readFile(baselinePath, 'utf8'));
const home = resolve(destination, 'scopes/dsh'), restoredMember = resolve(destination, 'scopes/home-' + proof.userId);
assert.equal(await readFile(join(restoredMember, proof.path), 'utf8'), proof.text);
assert.ok((await readArchivedSessions({ home: restoredMember })).includes(proof.sessionId));
const [{ Context }, { default: Sessions }, { default: Projections }, Jsonl, { default: Query }, { DomainFacility }, { JsonStorageBackend }, { BackendRegistry }] = await Promise.all(['cordis', 'dsh-session', 'dsh-session-projection', 'dsh-session-persistence-jsonl', 'dsh-session-query', 'dsh-storage-domain', 'dsh-storage-json', 'dsh-storage'].map(load));
const root = new Context(), fibers = [], backend = new JsonStorageBackend(join(home, 'storages')), registry = new BackendRegistry();
registry.register('json', backend);
const facility = new DomainFacility({ storage: { backend: registry }, emit() {}, logger: { warn() {}, error() {} } }, { backend: 'json' });
let core;
try {
  const mount = async (plugin, config) => { const fiber = root.plugin(plugin, config); fibers.push(fiber); await fiber.await(); };
  await mount(Sessions); await mount(Projections); await mount(Jsonl.default ?? Jsonl, { root: join(home, 'sessions'), compression: 'zstd' }); await mount(Query, {});
  const query = root.get('sessionQuery'), observed = await query.observeSession(proof.sessionId, { projectionMode: 'none' });
  assert.ok(observed.events.length > 0); const eventCount = observed.events.length; observed[Symbol.dispose]();
  const rows = await query.listSessions(), ids = new Set(rows.map(row => row.header.id));
  assert.ok(baseline.every(id => ids.has(id)), 'Every baseline native Session must be readable from the restored corpus');
  for (const id of baseline) {
    const copy = await query.observeSession(id, { projectionMode: 'none' });
    assert.equal(copy.header.id, id); copy[Symbol.dispose]();
  }
  assert.equal(root.get('agents'), undefined); assert.equal(root.get('agentLoop'), undefined);
  const open = async name => new DomainStore(await facility.open({ name, version: 1, layout: 'single', tables: { state: { valueSchema: z.json() } } }));
  const saved = await new DomainStore(await facility.open(DOMAIN_SPEC)).load();
  const owned = await (await open('lan_workspace_ownership')).load();
  assert.equal(owned.sessions[proof.sessionId].userId, proof.userId);
  const limits = await (await open('lan_workspace_limits')).load();
  assert.equal(limits.users[proof.userId].maxConcurrent, 0);
  assert.ok(saved.users.find(user => user.id === proof.userId)?.disabled);
  // Enable only the synthetic account in an isolated memory copy, so its
  // restored password is actually exercised without changing any live grant.
  const memory = structuredClone(saved); memory.users.find(user => user.id === proof.userId).disabled = false;
  core = new LanService({ store: new MemoryStore(memory) }); await core.start();
  const login = await core.execute({ action: 'login', username: credential.username, password: credential.password });
  assert.equal(login.user.id, proof.userId);
  console.log(JSON.stringify({ nativeSessionCount: rows.length, baselineSessionsReadable: baseline.length, syntheticEvents: eventCount, syntheticFileRestored: true, nativeOwnershipRestored: true, limitsRestored: true, disabledAccountPreserved: true, syntheticPasswordVerifiedInMemory: true, agentStarted: false, liveDataChanged: false }));
} finally {
  await core?.close();
  for (const fiber of fibers.reverse()) await fiber.dispose();
  await facility.closeAll(); await backend.close();
}
