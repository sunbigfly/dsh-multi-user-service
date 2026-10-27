import { memberToolDenial } from './access.mjs';
import { resolveSharedDirectories } from './file-ranges.mjs';
import { realpathSync } from 'node:fs';
import { memberSourceIsolated } from './member-boundary.mjs';

const FILE_TOOLS = new Set(['read', 'read_image', 'write', 'edit', 'glob', 'grep', 'bash', 'run_code', 'working_directory']);
const SUBAGENT_TOOLS = new Set(['subagent', 'subagent_fork', 'list_agents', 'list_subagent_models', 'send_message', 'interrupt_agent', 'wait_agent']);
const denied = () => { throw Object.assign(new Error('This account is not authorized to use this capability.'), { name: 'MemberCarrierError', code: 'MEMBER_CAPABILITY_DENIED', status: 403 }); };

/** Native reminders enter through followup after resolving their stored Session.
 * Check the current task grant before admission, including cold resumed Agents.
 * Keep schedules and their delivery history in the native scheduler. */
export function installMemberScheduleAdmission(agent, capabilities) {
  const original = agent.followup, descriptor = Object.getOwnPropertyDescriptor(agent, 'followup');
  if (typeof original !== 'function') throw new Error('Native reminder admission is unavailable');
  const wrapper = function(input) {
    if (input.source?.kind === 'schedule') {
      const userId = capabilities.userOf(this);
      if (userId && !capabilities.policy(userId).tasks) denied();
    }
    return original.call(this, input);
  };
  agent.followup = wrapper;
  return () => {
    if (agent.followup !== wrapper) return;
    if (descriptor) Object.defineProperty(agent, 'followup', descriptor);
    else delete agent.followup;
  };
}

/** Capability checks use the current account policy at every invocation. Scope
 * masks only shape native discovery; they are never the authorization boundary.
 */
export class MemberCapabilities {
  skillResources = new Map();
  constructor({ core, hostCapability, ownership, ctx, origins, protectedRoots = [], readonlyRoots = [] }) { Object.assign(this, { core, hostCapability, ownership, ctx, origins, protectedRoots, readonlyRoots }); }
  userOf(agent) { return this.ownership.ownerOf(agent.id) ?? this.ownership.bindingForCwd(agent.session?.header?.cwd)?.userId; }
  policy(userId) { return this.core.memberAccess(userId, this.hostCapability); }
  assertAgentPreset(userId, id) {
    const allowed = this.policy(userId).agentPresets;
    if (allowed !== null && !allowed.includes(id)) denied();
  }
  assertPermissionPreset(userId, name) {
    const allowed = this.policy(userId).permissionPresets;
    if (allowed !== null && !allowed.includes(name)) denied();
  }
  permissionPresetCatalog(userId, catalog) {
    const allowed = this.policy(userId).permissionPresets;
    if (allowed === null) return catalog;
    const options = catalog.options.filter(row => allowed.includes(row.value));
    const defaultOptions = catalog.defaultOptions.filter(row => allowed.includes(row.value));
    return { ...catalog, options, defaultOptions, defaultPreset: defaultOptions.some(row => row.value === catalog.defaultPreset) ? catalog.defaultPreset : defaultOptions[0]?.value ?? null };
  }
  commandAllowed(userId, name) {
    const policy = this.policy(userId);
    if (name === 'goal' && !policy.tasks) return false;
    return true;
  }
  agentPresetCatalog(userId, catalog) {
    const allowed = this.policy(userId).agentPresets;
    if (allowed === null) return catalog;
    const presets = catalog.presets.filter(row => allowed.includes(row.id));
    const fallback = presets.find(row => row.isDefault) ?? presets.find(row => !row.broken);
    return { ...catalog, presets: presets.map(row => ({ ...row, isDefault: row === fallback })) };
  }
  async chooseAgentPreset(userId, requested) {
    const registry = this.ctx.get('agentPresets');
    if (!registry) { if (this.policy(userId).agentPresets !== null) denied(); return requested; }
    if (requested !== undefined) { this.assertAgentPreset(userId, requested); return requested; }
    const catalog = this.agentPresetCatalog(userId, await registry.remoteExportList());
    const preset = catalog.presets.find(row => row.isDefault && !row.broken) ?? catalog.presets.find(row => !row.broken);
    if (!preset) denied();
    return preset.id;
  }
  directories(userId) {
    const policy = this.policy(userId);
    if (!policy.files) return [];
    const resources = [];
    for (const [registry, users] of this.skillResources) {
      const saved = users.get(userId);
      if (!saved || saved.revision !== registry.revision) continue;
      for (const [name, path] of saved.paths) if (policy.skills === null || policy.skills.includes(name)) resources.push({ path, mode: 'read-only' });
    }
    // Explicit admin directory grants take precedence over inferred read-only
    // skill resources at the same path.
    const ranges = new Map(resources.map(row => [row.path, row]));
    for (const row of policy.sharedDirectories) ranges.set(row.path, row);
    return resolveSharedDirectories([...ranges.values()], { protectedRoots: [...this.protectedRoots, ...this.ownership.privateRoots()], readonlyRoots: this.readonlyRoots });
  }
  rememberSkillResources(registry, userId, skills, replace) {
    let users = this.skillResources.get(registry);
    if (!users) this.skillResources.set(registry, users = new Map());
    let saved = users.get(userId);
    if (!saved || replace || saved.revision !== registry.revision) users.set(userId, saved = { revision: registry.revision, paths: new Map() });
    return skills.map(skill => {
      saved.paths.delete(skill.name);
      if (skill.resourceBase?.kind !== 'directory') return skill;
      let path;
      try { path = realpathSync(skill.resourceBase.path); } catch { return skill; }
      const valid = resolveSharedDirectories([{ path, mode: 'read-only' }], { protectedRoots: [...this.protectedRoots, ...this.ownership.privateRoots()] });
      if (!valid.length) return skill;
      saved.paths.set(skill.name, path);
      return { ...skill, resourceBase: { ...skill.resourceBase, path } };
    });
  }
  sourceAllowed(policy, source) {
    if (!memberSourceIsolated(source)) return false;
    const plugin = source.plugin;
    if (policy.files === false && /\/(?:dsh-tool-(?:fs|fs-search|bash|pwsh|working-directory|terminal)|dsh-ptc-runtime-node)$/.test(plugin)) return false;
    if (policy.terminal === false && plugin === '@deepseek-ai/dsh-tool-terminal') return false;
    if (policy.subagents === false && /\/dsh-tool-subagent(?:-control)?$/.test(plugin)) return false;
    if (policy.tasks === false && /\/dsh-tool-(?:goal|jobs|schedule|workflow)$/.test(plugin)) return false;
    if (policy.interactions === false && plugin === '@deepseek-ai/dsh-tool-ask-user') return false;
    if (policy.plugins !== null && (!source || !policy.plugins.includes(source.plugin))) return false;
    if (policy.mcpServers !== null) {
      if (!source || source.plugin === '@deepseek-ai/dsh-mcp-client' && !source.mcpServer) return false;
      if (source.mcpServer && !policy.mcpServers.includes(source.mcpServer)) return false;
    }
    return true;
  }
  toolAllowed(policy, name, agent) {
    if (policy.tools !== null && !policy.tools.includes(name)) return false;
    if (!policy.files && FILE_TOOLS.has(name)) return false;
    if (!policy.terminal && name === 'terminal') return false;
    if (!policy.subagents && SUBAGENT_TOOLS.has(name)) return false;
    if (!policy.interactions && name === 'ask_user_question') return false;
    if (!policy.tasks && /^(?:schedule_|job_|workflow|create_goal$|update_goal$)/.test(name)) return false;
    if (name === 'run_code' && this.origins && !this.sourceAllowed(policy, this.origins.service(agent?.ctx?.get('ptcRuntime') ?? this.ctx.get('ptcRuntime')))) return false;
    return true;
  }
  toolDenial(exec, mode) {
    const userId = this.userOf(exec.agent);
    if (!userId) return undefined;
    const policy = this.policy(userId);
    if (!this.toolAllowed(policy, exec.name, exec.agent)) return 'This account is not authorized to execute this tool.';
    // Consuming installed plugins does not confer authority to rewrite the
    // shared profile or install Host code. Native per-call approval still applies
    // to administrators; a member cannot approve their own profile mutation.
    if (exec.name === 'plugin_manager' && !/^list_/.test(exec.arguments?.action ?? '') && !this.core.memberIsAdministrator(userId, this.hostCapability)) return 'Profile plugin changes require an administrator.';
    const presets = exec.agent?.ctx?.get?.('permissionPresets') ?? this.ctx?.get?.('permissionPresets');
    const names = presets ? policy.permissionPresets ?? presets.names : [];
    const allowedModes = [mode, 'read-only', ...names.map(name => presets.specOf(name)?.sandbox).filter(Boolean)];
    return memberToolDenial(exec, { allowed: null, mode, allowedModes });
  }
  assertEndpoint(userId, endpoint) {
    const policy = this.policy(userId);
    if ((!policy.terminal || !policy.files) && endpoint.startsWith('terminal/')) denied();
    if (!policy.files && /^(?:workspaceFiles|directoryPicker)\//.test(endpoint)) denied();
    if (!policy.attachments && /^(?:session\/(?:upload|attachment)|attachments\/)/.test(endpoint)) denied();
    if (!policy.tasks && /^(?:schedule|workflow|jobs?)\//.test(endpoint)) denied();
    if (!policy.subagents && /^(?:session\/fork|subagents?\/)/.test(endpoint)) denied();
    if (!policy.interactions && /^(?:userQuestions|approval)\//.test(endpoint)) denied();
  }
}
