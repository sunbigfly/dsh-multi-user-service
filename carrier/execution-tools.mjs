import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { reject } from '../core/errors.js';
import * as v from '../core/validation.js';

export async function runNativeExecutionTool({ argv, cwd, tool, exec, context, principal }) {
  const policy = context.get('sandboxPolicy')?.resolve({ session: exec.agent.session });
  if (!policy) reject('EXECUTION_TOOL_UNAVAILABLE', 'Native execution policy is unavailable.', 503);
  const control = new AbortController(), timer = setTimeout(() => control.abort(new Error('Installed tool timeout')), tool.runtime.timeoutMs);
  const signal = exec.signal ? AbortSignal.any([exec.signal, control.signal]) : control.signal;
  let handle;
  try {
    const confined = await context.get('sandbox').confine(argv, { ...policy, workspaceRoot: cwd }, signal);
    if (principal?.member && confined.enforcement !== 'full') reject('EXECUTION_TOOL_UNAVAILABLE', 'Member tools require full native filesystem confinement.', 503);
    handle = await context.get('subprocess').spawn({ argv: confined.argv, cwd, env: { DSH_SESSION_ID: exec.agent.id },
      stdio: { stdin: 'ignore', stdout: { maxBytes: 1024 * 1024 }, stderr: { maxBytes: 65536 } }, graceMs: 500, signal });
    const result = await handle.done;
    signal.throwIfAborted();
    const output = handle.collected.stdout?.readFrom(0);
    if (!output || output.lossy) reject('EXECUTION_TOOL_OUTPUT_LIMIT', 'Installed tool output exceeded the limit.', 413);
    let value;
    try { value = JSON.parse(output.text); } catch { value = { output: output.text }; }
    const diagnostic = result.exitCode ? handle.collected.stderr?.readFrom(0).text.slice(-8192) : '';
    return { exitCode: result.exitCode, result: value, ...(diagnostic ? { stderr: diagnostic } : {}) };
  } finally {
    clearTimeout(timer);
    if (handle) {
      handle.terminate();
      if (!await handle.waitForExit(AbortSignal.timeout(5000))) reject('EXECUTION_TOOL_STOP_FAILED', 'Installed tool did not fully stop.', 503);
    }
  }
}

/** Native tool dispatch is the authority boundary. Skills remain user-owned;
 * installed program paths and runner configuration never enter member PATH. */
export function executionToolsDefinition({ catalogOf, principalOf, workspaceOf, run, runMemberBridge }) {
  return {
    name: 'execution_tools',
    description: 'Discover, inspect and run administrator-approved installed tools, including tool-runner capabilities. Use action=catalog to see tools available to this account, then describe to read all permitted operations and parameter contracts. Run tool-runner tools through this interface: DSH supplies the current workspace and enforces the whitelist. Native member bridges return their actual DSH tool schema through discover/describe; follow that schema instead of host runner instructions. User Skills provide guidance, not execution permission.',
    parameters: { type: 'object', additionalProperties: false, properties: {
      action: { type: 'string', enum: ['catalog', 'describe', 'run'] }, id: { type: 'string' }, operation: { type: 'string' },
      query: { type: 'string' }, tool: { type: 'string', description: 'Exact callable tool name from discover/describe, including native DSH bridges.' },
      arguments: { type: 'object', additionalProperties: true },
    }, required: ['action'] },
    isConcurrencySafe: args => args.action !== 'run',
    output: { schema: { type: 'object', additionalProperties: true }, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] },
    async execute(args, exec) {
      v.object(args, ['action', 'id', 'operation', 'query', 'tool', 'arguments'], ['action']);
      if (!['catalog', 'describe', 'run'].includes(args.action)) reject('INVALID_INPUT', 'Unknown installed tool action.');
      const principal = principalOf(exec), catalog = catalogOf();
      if (!catalog) reject('EXECUTION_TOOLS_UNAVAILABLE', 'Installed tools are unavailable.', 503);
      const allowed = await catalog.allowed(principal);
      exec.signal?.throwIfAborted();
      if (args.action === 'catalog') return { tools: allowed.map(tool => catalog.describe(tool, principal)) };
      const tool = allowed.find(tool => tool.id === args.id);
      if (!tool) reject('EXECUTION_TOOL_DENIED', 'This installed tool is not authorized for this account.', 403);
      if (args.action === 'describe') return catalog.describe(tool, principal);
      const operation = tool.operations.find(operation => operation.id === args.operation && operation.enabled && tool.approvedOperations.includes(operation.id));
      if (!operation) reject('EXECUTION_OPERATION_DENIED', 'This operation is not in the approved tool whitelist.', 403);
      const query = args.query ?? '';
      if (typeof query !== 'string' || query.length > 32768 || query.includes('\0')) reject('INVALID_INPUT', 'Invalid installed tool input.');
      if (operation.parameters.query?.required && !query) reject('INVALID_INPUT', 'This operation requires query.');
      if (args.tool !== undefined) v.text(args.tool, 'upstream tool', 256);
      if (args.arguments !== undefined && (!args.arguments || typeof args.arguments !== 'object' || Array.isArray(args.arguments) || JSON.stringify(args.arguments).length > 65536)) reject('INVALID_INPUT', 'Tool arguments must be a JSON object no larger than 64 KiB.');
      const cwd = await workspaceOf(exec, principal);
      const finish = async value => {
        exec.signal?.throwIfAborted();
        // Revocation also suppresses a result from an in-flight native bridge.
        const current = await catalogOf()?.allowed(principalOf(exec));
        if (!current?.some(row => row.id === tool.id && row.fingerprint === tool.fingerprint && row.approvedOperations.includes(operation.id))) reject('EXECUTION_TOOL_DENIED', 'Tool authorization changed while the operation was running.', 403);
        return value;
      };
      if (principal.member && tool.memberRuntime) {
        if (!runMemberBridge) reject('EXECUTION_BRIDGE_UNAVAILABLE', '成员会话浏览器入口不可用。不会退回宿主 Chrome 连接。', 503);
        return finish(await runMemberBridge({ tool, args, exec, principal }));
      }
      const temp = await mkdtemp(join(cwd, '.dsh-execution-'));
      const argv = [tool.runtime.command, 'run', tool.tool, operation.id, '--scope', cwd, '--query', query, '--output-root', temp, '--json'];
      try {
        if (args.tool !== undefined) argv.push('--tool', args.tool);
        if (args.arguments !== undefined) {
          const path = join(temp, 'arguments.json'); await writeFile(path, JSON.stringify(args.arguments), { mode: 0o600, flag: 'wx' });
          argv.push('--arguments-file', path);
        }
        const value = await run({ argv, cwd, tool, exec, principal });
        return finish(value);
      } finally {
        // Runner artifacts remain in this account's workspace for references.
        await rm(join(temp, 'arguments.json'), { force: true });
      }
    },
  };
}
