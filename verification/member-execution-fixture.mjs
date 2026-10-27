import { mkdtemp, mkdir, writeFile, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { memberToolAllow, memberToolDenial, memberPathDenial } from '../carrier/access.mjs';
import { installMemberFileRanges } from '../carrier/file-ranges.mjs';
import { createMemberBoundary, installMemberBoundary } from '../carrier/member-boundary.mjs';

/** Real installed DSH services and native tools; no model/provider is called. */
export async function memberExecutionFixture({ modules, parent = tmpdir(), ptc = false, ptcConfig = {}, sharedDirectories = [], strict = false }) {
  const load = name => import(pathToFileURL(join(modules, '@deepseek-ai', name, 'lib/index.js')).href);
  const [{ Context }, { createScope, scopeParentOf }] = await Promise.all(['cordis', 'dsh-scope'].map(load));
  const directory = await mkdtemp(join(parent, 'dsh-member-execution-'));
  const userId = 'usr_' + 'a'.repeat(32), home = strict ? join(directory, userId) : directory;
  if (strict) await mkdir(home, { mode: 0o700 });
  const cwd = join(home, 'workspace'), canary = join(directory, 'outside-canary');
  await mkdir(cwd); await writeFile(canary, 'synthetic-only');
  const root = new Context(), fibers = [];
  let memberScope, presetScope, services, agent, mode = 'workspace-write', permissionPreset = null, approvalPolicy = 'ask', closed;
  const events = [];
  root.provide('sessionProjections', { register() {}, stateOf(session, key) { return key === 'workingDirectory' ? session.header.cwd : key === 'sandboxMode' ? mode : key === 'permissions' ? { preset: permissionPreset, sandbox: mode, approval: approvalPolicy, seeded: false } : null; } });
  const mount = async (name, config, ctx = root) => {
    const module = await load(name), fiber = ctx.plugin(module.default ?? module, config);
    fibers.push(fiber); await fiber.await();
  };
  const close = () => closed ??= (async () => {
    await memberScope?.dispose(); await presetScope?.dispose();
    for (const fiber of fibers.reverse()) await fiber.dispose();
    await rm(directory, { recursive: true });
  })();
  try {
    await mount('dsh-system-prompt', { includeHarnessIdentity: false, includeRuntimeContext: false });
    await mount('dsh-sandbox-policy', { mode: 'workspace-write', workspaceRoot: cwd });
    await mount('dsh-fs-sandbox', { cwd });
    await mount('dsh-working-directory', { defaultDirectory: cwd });
    await mount('dsh-shell-env', { dshHome: directory });
    await mount('dsh-subprocess-local'); await mount('dsh-sandbox-local');
    await mount('dsh-bash-sandbox', { cwd }); await mount('dsh-tools');
    if (ptc) await mount('dsh-ptc-runtime-node', ptcConfig);
    await mount('dsh-typert-registry');
    await mount('dsh-api-terminal-controller', { unattendedTimeoutMs: 0, disposeGraceMs: 3000,
      shell: { path: '/usr/bin/bash', name: 'bash', args: ['--noprofile', '--norc', '-i'] } });
    const harness = root.plugin({ inject: ['tools', 'fs', 'workingDirectory', 'systemPrompt', 'shell', 'shellEnv', 'sandboxPolicy', 'subprocess', 'terminalController'], async apply(ctx) {
      const preset = {};
      services = ctx;
      agent = { id: 'member-execution-fixture', session: { id: 'member-execution-fixture', header: { cwd }, append(type, data) {
        const event = { type, data, seq: events.length + 1 }; events.push(event);
        if (type === 'sandbox/mode') mode = data.mode;
        if (type === 'permission/preset') permissionPreset = data.preset;
        if (type === 'approval/policy') approvalPolicy = data.policy;
        return event;
      } } };
      presetScope = createScope(ctx, preset);
      await mount('dsh-tool-fs', { readImage: false }, presetScope.ctx);
      await mount('dsh-tool-bash', { enableRunInBackground: false, promoteOnTimeout: false }, presetScope.ctx);
      memberScope = createScope(ctx, agent, { parent: preset }); agent.ctx = memberScope.ctx; agent.scope = memberScope;
      const scope = agent.ctx, allowed = null;
      if (strict) {
        const boundary = await createMemberBoundary({ native: await load('node-addon-system'), runtimePaths: [modules] });
        const binding = () => ({ userId, home, cwd, sharedDirectories });
        const options = { boundary, bindingForPolicy: policy => policy.workspaceRoot === cwd ? binding() : undefined,
          bindingForExecution: spec => spec.cwd === home || spec.cwd === cwd || spec.cwd?.startsWith(cwd + '/') ? binding() : undefined };
        for (const name of ['sandbox', 'subprocess']) scope.effect(() => installMemberBoundary(ctx.get(name), { ...options, kind: name }));
      }
      scope.effect(() => installMemberFileRanges(ctx.fs, { bindingForPolicy: policy => policy.workspaceRoot === cwd ? { cwd, sharedDirectories } : undefined }));
      scope.tools.restrict({ allow: memberToolAllow(scope.tools.schemas(scopeParentOf(agent))) });
      scope.tools.guard(exec => memberToolDenial(exec, { allowed, mode: ctx.sandboxPolicy.resolve({ session: agent.session }).mode }));
      scope.on('tools/pre-execute', async (exec, next) => {
        const reason = await memberPathDenial(exec, cwd, { realpath, sharedDirectories });
        return reason === undefined ? next() : { kind: 'deny', reason };
      });
    } });
    fibers.push(harness); await harness.await();
    return {
      directory, home, cwd, canary, agent, events, get services() { return services; }, close,
      provide: (name, value) => root.provide(name, value), mountService: mount,
      setMode(value) { mode = value; },
      setDirectories(value) { sharedDirectories = value; },
      run(name, args) { return services.tools.execute({ callId: 'fixture-' + name + '-' + Date.now(), agent, name, arguments: args, signal: AbortSignal.timeout(20000) }); },
    };
  } catch (error) { await close(); throw error; }
}
