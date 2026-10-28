import { createHash } from 'node:crypto';
import { readFile, readdir, realpath, stat, access, open } from 'node:fs/promises';
import { constants } from 'node:fs';
import { basename, dirname, isAbsolute, join } from 'node:path';
import { homedir } from 'node:os';
import { parse } from 'smol-toml';
import { MemberCliRegistry } from './cli-tools.mjs';
import { reject } from '../core/errors.js';
import * as v from '../core/validation.js';

const name = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/;
// Classification is shared with the paused bridge prototype; production keeps
// its sessionBrowser callback disabled and does not load that implementation.
export function nativeExecutionBridge(plugin) {
  return plugin === 'chrome-devtools' ? { tool: 'workspace_browser', version: 1 } : undefined;
}
// Native DSH confinement follows child processes and gives each member a
// private HOME, configuration, cache and temporary directory. Detached services
// need an additional lifecycle/connection boundary, outside the file sandbox.
const within = (root, path) => path === root || path.startsWith(root + '/');
const hash = value => createHash('sha256').update(value).digest('hex');
const publicOperation = operation => ({ id: operation.id, description: operation.description, parameters: operation.parameters });
async function file(path) {
  const info = await stat(path);
  if (!info.isFile() || info.size > 128 * 1024) throw new Error('Tool manifest is unavailable or too large.');
  return readFile(path, 'utf8');
}
function identifier(value) {
  if (typeof value !== 'string' || !name.test(value)) reject('INVALID_INPUT', 'Invalid execution tool identifier.');
  return value;
}
export function executionConfiguration(value = {}) {
  v.object(value, ['version', 'sources', 'grants'], []);
  if (value.version !== undefined && value.version !== 1) reject('INVALID_INPUT', 'Unsupported execution tools configuration version.');
  const sources = value.sources ?? [], grants = value.grants ?? [];
  if (!Array.isArray(sources) || sources.length > 16 || !Array.isArray(grants) || grants.length > 256 || JSON.stringify(value).length > 256 * 1024) reject('INVALID_INPUT', 'Execution tools configuration is too large.');
  const seen = new Set(), granted = new Set();
  return { version: 1, sources: sources.map(source => {
    v.object(source, ['id', 'kind', 'root', 'command']); identifier(source.id);
    if (source.kind !== 'tool-runner' || seen.has(source.id)) reject('INVALID_INPUT', 'Invalid or duplicate execution tool source.');
    seen.add(source.id);
    for (const key of ['root', 'command']) if (!isAbsolute(v.text(source[key], key, 4096))) reject('INVALID_INPUT', 'Execution tool paths must be absolute.');
    return { id: source.id, kind: source.kind, root: source.root, command: source.command };
  }), grants: grants.map(grant => {
    v.object(grant, ['id', 'fingerprint', 'operations', 'harness', 'shared']);
    const parts = v.text(grant.id, 'execution tool', 129).split('/');
    if (parts.length !== 2 || !seen.has(identifier(parts[0])) || !name.test(parts[1]) || granted.has(grant.id) || !/^[a-f0-9]{64}$/.test(grant.fingerprint)) reject('INVALID_INPUT', 'Invalid execution tool grant.');
    granted.add(grant.id);
    if (!Array.isArray(grant.operations) || grant.operations.length > 128 || new Set(grant.operations).size !== grant.operations.length) reject('INVALID_INPUT', 'Invalid execution tool operations.');
    return { id: grant.id, fingerprint: grant.fingerprint, operations: grant.operations.map(identifier), harness: v.bool(grant.harness, 'Harness use'), shared: v.bool(grant.shared, 'member sharing') };
  }) };
}
export async function suggestedExecutionSources() {
  const root = join(homedir(), '.agents/tool-runner'), command = join(root, 'target/release/tool-runner');
  try { await access(command, constants.X_OK); await access(join(root, 'tools')); return [{ id: 'tool-runner', kind: 'tool-runner', root, command }]; }
  catch { return []; }
}
async function runtimeDirectory(program) {
  let path = dirname(program);
  // Package and virtual-environment roots carry runtime code, not user homes.
  for (let i = 0; i < 5 && path !== '/' && path !== homedir(); i++, path = dirname(path)) {
    try { await access(join(path, 'package.json')); return path; } catch {}
    try { await access(join(path, 'pyvenv.cfg')); return path; } catch {}
  }
  return dirname(program);
}
async function interpreterPaths(program) {
  const handle = await open(program, 'r');
  try {
    const buffer = Buffer.alloc(1024), { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    const first = buffer.subarray(0, bytesRead).toString('utf8').split('\n')[0];
    const match = /^#!\s*(\/[^\s]+)(?:\s|$)/.exec(first);
    if (!match || match[1] === '/usr/bin/env') return [];
    const interpreter = await realpath(match[1]);
    return /^python[0-9.]*$/.test(basename(interpreter)) ? [interpreter, dirname(dirname(interpreter))] : [interpreter];
  } finally { await handle.close(); }
}
async function editablePythonPaths(runtime) {
  try { await access(join(runtime, 'pyvenv.cfg')); } catch { return []; }
  const project = await realpath(dirname(runtime)), paths = [];
  const libraries = (await readdir(join(runtime, 'lib'), { withFileTypes: true })).filter(row => row.isDirectory() && /^python[0-9.]+$/.test(row.name)).slice(0, 8);
  for (const library of libraries) {
    const site = join(runtime, 'lib', library.name, 'site-packages');
    for (const entry of (await readdir(site, { withFileTypes: true })).filter(row => row.isFile() && row.name.endsWith('.pth')).slice(0, 32)) {
      const path = join(site, entry.name), text = await file(path);paths.push(path);
      // Read static editable source paths only. Do not evaluate .pth Python or
      // turn arbitrary personal directories into inferred runtime grants.
      for (const line of text.split(/\r?\n/).map(line => line.trim())) {
        if (!isAbsolute(line)) continue;
        const source = await realpath(line);
        if (within(project, source) && source !== project && (basename(source) === 'src' || basename(dirname(source)) === 'src') && (await stat(source)).isDirectory()) paths.push(source);
      }
    }
  }
  return paths;
}

/** Infer code dependencies from one selected executable, without starting it. */
export async function cliRuntimePaths(program) {
  const command = await realpath(program), runtime = await runtimeDirectory(command);
  await access(command, constants.X_OK);
  if (!(await stat(command)).isFile()) throw new Error('CLI executable must be a file.');
  return [...new Set([command, runtime, ...await interpreterPaths(command), ...await editablePythonPaths(runtime)])];
}

/** Read installed manifests only: discovery never starts a plugin, executes
 * --help, imports a personal Skill, or reads personal credentials/configuration. */
export class ExecutionCatalog {
  constructor(configuration = {}, { sessionBrowser = () => false } = {}) { this.configuration = executionConfiguration(configuration); this.sessionBrowser = sessionBrowser; }
  async scan(sources = this.configuration.sources) {
    sources = executionConfiguration({ sources }).sources;
    const tools = [], errors = [];
    for (const source of sources) {
      try {
        const root = await realpath(source.root), command = await realpath(source.command);
        if (!within(root, command) || root === '/' || root === homedir()) throw new Error('The runner executable must belong to its installation directory.');
        await access(command, constants.X_OK);
        const executable = await stat(command), directories = await readdir(join(root, 'tools'), { withFileTypes: true });
        if (directories.length > 256) throw new Error('Too many installed execution tools.');
        for (const directory of directories) {
          if (!directory.isDirectory() || !name.test(directory.name)) continue;
          try {
            const toolPath = join(root, 'tools', directory.name, 'tool.toml');
            if (!within(root, await realpath(toolPath))) throw new Error('Tool manifest leaves its installation directory.');
            const raw = await file(toolPath), manifest = parse(raw), info = manifest.tool;
            if (!info || !name.test(info.plugin) || !manifest.operations || typeof manifest.operations !== 'object') throw new Error('Invalid tool manifest.');
            const pluginPath = join(root, 'plugins', info.plugin, 'plugin.json');
            if (!within(root, await realpath(pluginPath))) throw new Error('Plugin manifest leaves its installation directory.');
            const pluginRaw = await file(pluginPath), plugin = JSON.parse(pluginRaw);
            const operations = Object.entries(manifest.operations).map(([id, operation]) => {
              identifier(id);
              const parameters = {};
              for (const [key, value] of Object.entries(operation.parameters ?? {})) {
                identifier(key);
                parameters[key] = { type: String(value.type ?? 'string'), required: value.required === true,
                  ...(typeof value.description === 'string' ? { description: value.description } : {}),
                  ...(Array.isArray(value.values) ? { values: value.values.filter(item => typeof item === 'string') } : {}) };
              }
              return { id, enabled: operation.enabled === true, description: String(operation.description ?? '').slice(0, 2000), parameters };
            });
            if (operations.length > 128) throw new Error('Too many operations.');
            const id = `${source.id}/${directory.name}`;
            const memberRuntime = nativeExecutionBridge(info.plugin);
            let runtimePaths = [], sharingIssue = '';
            if (memberRuntime) {
              if (!this.sessionBrowser()) sharingIssue = '此工具需要会话隔离桥接；当前执行工具入口尚未启用该桥接，暂不共享给成员。';
            } else if (plugin.lifecycle !== 'one-shot') sharingIssue = plugin.lifecycle === 'managed-daemon'
              ? '此工具会启动常驻后台进程。DSH 原生文件沙箱不隔离后台连接和登录会话，暂不开放成员共享；可继续供 Harness 使用。'
              : '此工具未声明一次性运行方式，无法确认后台进程的隔离范围，暂不开放成员共享。';
            try {
              const binary = await realpath(plugin.plugin_binary), upstream = await realpath(plugin.upstream_executable);
              await access(binary, constants.X_OK); await access(upstream, constants.X_OK);
              let outputPolicy = [];
              try { const path = join(root, 'output-policy.toml'); await file(path); outputPolicy = [await realpath(path)]; } catch {}
              const runtime = await runtimeDirectory(upstream);
              runtimePaths = [...new Set([command, toolPath, pluginPath, binary, upstream, runtime, ...await interpreterPaths(upstream), ...await editablePythonPaths(runtime), ...outputPolicy])];
              new MemberCliRegistry({ tools: [{ id: 'execution-runtime-check', command, readOnlyPaths: runtimePaths }] });
            } catch { runtimePaths = []; sharingIssue ||= '运行程序或依赖路径需要单独配置，暂不开放共享。'; }
            const fingerprints = await Promise.all([...new Set([command, plugin.plugin_binary, plugin.upstream_executable, ...runtimePaths])].map(async path => {
              try { const target = await realpath(path), s = await stat(target); return [target, s.dev, s.ino, s.size, s.mtimeMs]; } catch { return [path, 'missing']; }
            }));
            const fingerprint = hash(JSON.stringify([raw, pluginRaw, fingerprints, executable.size, ...(memberRuntime ? [memberRuntime] : [])]));
            const grant = this.configuration.grants.find(row => row.id === id), current = grant?.fingerprint === fingerprint;
            tools.push({ id, sourceId: source.id, tool: directory.name, label: directory.name,
              description: String(info.description ?? '').slice(0, 2000), skill: typeof info.skill === 'string' ? info.skill : '',
              enabled: info.enabled === true && runtimePaths.length > 0, lifecycle: plugin.lifecycle, fingerprint,
              operations, usage: `tool-runner run ${directory.name} <operation> --scope <workspace> --query <input> --json`,
              harness: current && grant.harness, shared: current && grant.shared && !sharingIssue,
              approvedOperations: current ? grant.operations.filter(id => operations.some(operation => operation.id === id && operation.enabled)) : [],
              stale: !!grant && !current, sharingIssue,
              ...(memberRuntime ? { memberRuntime, sharingNote: '成员使用自己的 DSH 会话浏览器，支持的操作以 discover 返回的合同为准；同时受账号的浏览器权限控制。不会共享宿主 Chrome 连接。' } : {}),
              runtime: { command, root, paths: runtimePaths, timeoutMs: Math.min(300000, Math.max(1000, (Number(plugin.timeout_seconds) || 120) * 1000)) } });
          } catch { errors.push({ sourceId: source.id, tool: directory.name, message: '工具清单或运行依赖无法读取，请检查安装。' }); }
        }
      } catch { errors.push({ sourceId: source.id, message: '无法扫描来源，请检查 tool-runner 安装目录及可执行程序。' }); }
    }
    if (tools.length > 256 || JSON.stringify(tools).length > 2 * 1024 * 1024) reject('EXECUTION_CATALOG_TOO_LARGE', '工具目录过大，请缩小扫描来源。', 413);
    return { tools: tools.sort((a, b) => a.id.localeCompare(b.id)), errors };
  }
  publicInventory(inventory) {
    return { ...inventory, tools: inventory.tools.map(({ runtime, ...tool }) => ({ ...tool, readOnlyPaths: runtime.paths })) };
  }
  async validateGrants() {
    const inventory = await this.scan();
    for (const grant of this.configuration.grants) {
      if (!grant.harness && !grant.shared) continue;
      const tool = inventory.tools.find(tool => tool.id === grant.id);
      if (!tool || !tool.enabled || grant.fingerprint !== tool.fingerprint || grant.operations.some(id => !tool.operations.some(operation => operation.id === id && operation.enabled))) reject('EXECUTION_TOOL_CHANGED', '工具已更新或不可用，请重新扫描并确认授权。', 409);
      if (grant.shared && tool.sharingIssue) reject('EXECUTION_TOOL_NOT_ISOLATED', tool.sharingIssue, 422);
      if (!grant.operations.length) reject('INVALID_INPUT', '请至少选择一个开放的操作。');
    }
  }
  async allowed({ member = false, administrator = false, policy } = {}) {
    const { tools } = await this.scan();
    return tools.filter(tool => tool.enabled && tool.approvedOperations.length && (member ? (tool.shared || administrator && tool.harness) && policy?.files !== false && (policy?.cliTools === null || policy?.cliTools?.includes(tool.id)) : tool.harness));
  }
  async catalog() { return (await this.allowed({ member: true, policy: { cliTools: null } })).map(tool => ({ id: tool.id, label: tool.label, description: tool.description })); }
  describe(tool, principal = {}) { return { id: tool.id, description: tool.description, skill: tool.skill, operations: tool.operations.filter(operation => tool.approvedOperations.includes(operation.id)).map(publicOperation), scope: 'The current session workspace is supplied by DSH.',
    ...(principal.member && tool.memberRuntime ? { runtime: 'dsh-session-browser', note: 'Discover/describe returns the native workspace_browser schema. For call, set tool=workspace_browser and arguments to that schema. Only this account and session are accessible; the host Chrome MCP is not used.' } : {}) }; }
}
