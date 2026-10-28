import { lstat, mkdir, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { realpathSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { isAbsolute, join, resolve } from 'node:path';

const inside = (root, value) => value === root || value.startsWith(root + '/');
const commandName = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/;
const variableName = /^[A-Za-z_][A-Za-z0-9_]*$/;
const reserved = /^(?:HOME|PATH|PWD|DSH_HOME|TMPDIR|TMP|TEMP|XDG_.*)$/;
const fail = message => { throw Object.assign(new Error(message), { code: 'MEMBER_CLI_CONFIGURATION', status: 503 }); };

// These files live outside writable member homes. Members receive read-only
// grants for their own generated directory and each explicitly allowed program.
const launcher = `#!${process.execPath}
const { readFileSync } = require('node:fs');
const { dirname, join, basename } = require('node:path');
const { spawn } = require('node:child_process');
const config = JSON.parse(readFileSync(join(dirname(__filename), '..', 'config', basename(__filename) + '.json'), 'utf8'));
const child = spawn(config.command, [...config.args, ...process.argv.slice(2)], { stdio: 'inherit', env: { ...process.env, ...config.environment } });
for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(signal, () => child.kill(signal));
child.on('error', error => { console.error(error.message); process.exitCode = 1; });
child.on('exit', (code, signal) => { if (signal) { process.removeAllListeners(signal); process.kill(process.pid, signal); } else process.exitCode = code ?? 1; });
`;

async function directory(path) {
  await mkdir(path, { recursive: true, mode: 0o700 });
  const info = await lstat(path);
  if (!info.isDirectory() || info.isSymbolicLink() || await realpath(path) !== path || (info.mode & 0o077)) fail('CLI state requires a canonical, owner-only directory.');
}

async function replace(path, text, mode) {
  try { const info = await lstat(path); if (!info.isSymbolicLink() && (info.mode & 0o777) === mode && await readFile(path, 'utf8') === text) return; }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  const temporary = path + '.' + randomUUID() + '.tmp';
  try { await writeFile(temporary, text, { mode, flag: 'wx' }); await rename(temporary, path); }
  finally { await rm(temporary, { force: true }); }
}

export class MemberCliRegistry {
  constructor({ tools = [], credentials = () => undefined, root = join(process.env.DSH_HOME || join(homedir(), '.dsh'), 'cli-tools') } = {}) {
    this.root = resolve(root); this.credentials = credentials; this.queues = new Map(); this.snapshots = new Map();
    if (!isAbsolute(root) || this.root !== root || root === homedir() || ['/','/home','/tmp','/usr','/etc'].includes(root) || /\/usr_[0-9a-f]{32}(?:\/|$)/.test(root)) fail('CLI state must use a dedicated server directory.');
    const protectedPaths = [join(homedir(), '.ssh'), join(homedir(), '.codex'), join(homedir(), '.dsh'), this.root];
    const names = new Set();
    this.tools = tools.filter(tool => tool.enabled !== false).map(tool => {
      if (!commandName.test(tool.id) || names.has(tool.id)) fail('CLI command names must be unique and contain only letters, numbers, dots, underscores or hyphens.');
      names.add(tool.id);
      if (!isAbsolute(tool.command)) fail('CLI commands require absolute executable paths.');
      const command = realpathSync(tool.command);
      if (!statSync(command).isFile() || !(statSync(command).mode & 0o111)) fail('CLI command is not an executable file.');
      const paths = [...new Set([command, ...(tool.readOnlyPaths ?? []).map(path => {
        if (!isAbsolute(path)) fail('CLI runtime paths must be absolute.');
        return realpathSync(path);
      })])];
      for (const path of paths) {
        if (['/', '/home', homedir(), '/tmp', '/var', '/mnt'].includes(path) || /\/usr_[0-9a-f]{32}(?:\/|$)/.test(path)
          || protectedPaths.some(secret => inside(path, secret) || inside(secret, path))) fail('CLI program paths must exclude server credentials, member homes and broad data roots.');
      }
      for (const [key, value] of [...Object.entries(tool.environment ?? {}), ...Object.entries(tool.credentials ?? {})]) {
        if (!variableName.test(key) || reserved.test(key) || typeof value !== 'string' || value.includes('\0')) fail('Invalid CLI environment or credential reference.');
      }
      if (!(tool.args ?? []).every(value => typeof value === 'string' && !value.includes('\0'))) fail('Invalid fixed CLI arguments.');
      return { id: tool.id, label: tool.label || tool.id, command, args: tool.args ?? [], paths,
        environment: tool.environment ?? {}, credentials: tool.credentials ?? {} };
    });
  }

  catalog() { return this.tools.map(({ id, label }) => ({ id, label })); }

  snapshot(userId, policy) {
    const saved = this.snapshots.get(userId);
    return saved?.policy === JSON.stringify(policy.cliTools) ? saved.value : undefined;
  }

  prepare(userId, policy) {
    if (!/^usr_[0-9a-f]{32}$/.test(userId)) fail('Invalid member CLI account.');
    const previous = this.queues.get(userId) ?? Promise.resolve();
    const key = JSON.stringify(policy.cliTools);
    const next = previous.catch(() => {}).then(async () => {
      if (this.snapshots.get(userId)?.policy !== key) this.snapshots.delete(userId);
      const value = await this.synchronize(userId, policy);
      this.snapshots.set(userId, { policy: key, value });
      return value;
    });
    this.queues.set(userId, next);
    return next.finally(() => { if (this.queues.get(userId) === next) this.queues.delete(userId); });
  }

  async synchronize(userId, policy) {
    const allowed = this.tools.filter(tool => policy.cliTools === null || policy.cliTools?.includes(tool.id));
    await directory(this.root);
    const home = join(this.root, userId), bin = join(home, 'bin'), configs = join(home, 'config');
    await directory(home); await directory(bin); await directory(configs);
    await replace(join(home, 'package.json'), '{"type":"commonjs"}\n', 0o600);
    let previous = [];
    try { previous = JSON.parse(await readFile(join(home, 'commands.json'), 'utf8')); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    for (const id of previous) if (commandName.test(id) && !allowed.some(tool => tool.id === id)) {
      await rm(join(bin, id), { force: true }); await rm(join(configs, id + '.json'), { force: true });
    }
    for (const tool of allowed) {
      const environment = { ...tool.environment };
      for (const [key, ref] of Object.entries(tool.credentials)) {
        const value = (await this.credentials()?.resolve(ref))?.value;
        environment[key] = value || '';
      }
      await replace(join(configs, tool.id + '.json'), JSON.stringify({ command: tool.command, args: tool.args, environment }) + '\n', 0o600);
      await replace(join(bin, tool.id), launcher, 0o700);
    }
    await replace(join(home, 'commands.json'), JSON.stringify(allowed.map(tool => tool.id)) + '\n', 0o600);
    return allowed.length ? { bin, readOnlyPaths: [...new Set([home, ...allowed.flatMap(tool => tool.paths)])] } : undefined;
  }
}
