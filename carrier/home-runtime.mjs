import { lstat, realpath, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { posix, win32 } from 'node:path';
const fail = code => { throw Object.assign(new Error('A dedicated, private canonical member directory is required.'), { name: 'RuntimeError', code, status: 400 }); };
function storageRoot(root) {
  root ??= posix.join(homedir().replaceAll('\\', '/'), '.local/share/dsh-lan-workspaces');
  const windows = process.platform === 'win32' && typeof root === 'string' && /^[A-Za-z]:\//.test(root);
  const system = ['/usr', '/etc', '/run', '/dev', '/proc', '/sys', '/bin', '/sbin', '/lib', '/lib64', '/boot'];
  if (typeof root !== 'string' || !(windows || posix.isAbsolute(root)) || root.length > 4096 || /[\\\x00-\x1f\x7f]/.test(root) || (windows ? win32.resolve(root).replaceAll('\\', '/') : posix.resolve(root)) !== root
    || /^[A-Za-z]:\/$/.test(root) || ['/', '/home', '/tmp', '/var', '/mnt', '/opt', '/srv', '/media', homedir()].includes(root)
    || system.some(path => root === path || root.startsWith(path + '/')) || /^\/(mnt|media)\/[^/]+$/.test(root)
    || root.split('/').some(part => /^(usr|prj)_[0-9a-f]{32}$/.test(part))) fail('INVALID_PROJECT_ROOT');
  return root;
}
async function canonical(directory, create = false) {
  const prefix = /^[A-Za-z]:\//.test(directory) ? 3 : 1;
  let current = directory.slice(0, prefix - 1);
  for (const part of directory.slice(prefix).split('/')) {
    current += '/' + part;
    let info;
    try { info = await lstat(current); }
    catch (error) {
      if (error.code !== 'ENOENT') throw error;
      if (!create) return false;
      await mkdir(current, { mode: 0o700 }).catch(error => { if (error.code !== 'EEXIST') throw error; });
      info = await lstat(current);
    }
    if (!info.isDirectory() || info.isSymbolicLink() || (await realpath(current)).replaceAll('\\', '/') !== current) fail('UNSAFE_PROJECT_ROOT');
  }
  const info = await lstat(directory);
  if (process.platform !== 'win32' && ((info.mode & 0o777) !== 0o700 || process.getuid && info.uid !== process.getuid())) fail('UNSAFE_PROJECT_ROOT');
  return true;
}

/** Directory allocation only. Agent execution stays in the Host's native Bash
 * and terminal providers; no private worker or duplicate Agent graph is started.
 */
export class MemberHomeRuntime {
  constructor({ projectRoot = null, checkExecution } = {}) { this.projectRoot = projectRoot; this.checkExecution = checkExecution; this.ready = false; this.closed = false; }
  async directoryInfo({ root = null } = {}) {
    if (this.closed) fail('RUNTIME_UNAVAILABLE');
    root = storageRoot(root ?? this.projectRoot);
    await canonical(root);
    return { root };
  }
  async ensureHome({ root = null, userId }) {
    if (this.closed) fail('RUNTIME_UNAVAILABLE');
    if (typeof userId !== 'string' || !/^usr_[0-9a-f]{32}$/.test(userId)) fail('INVALID_PROJECT_ID');
    root = storageRoot(root ?? this.projectRoot);
    await canonical(root, true);
    await canonical(posix.join(root, userId), true);
    return { root, userId, relativePath: userId };
  }
  async start() {
    if (this.closed) fail('RUNTIME_UNAVAILABLE');
    if (typeof this.checkExecution !== 'function') fail('RUNTIME_UNAVAILABLE');
    const directory = await mkdtemp(posix.join(tmpdir(), 'dsh-native-execution-'));
    try {
      const result = await this.checkExecution(directory);
      if (this.closed || !Array.isArray(result?.argv) || !result.argv.length || !['full', 'partial'].includes(result.enforcement)) fail('RUNTIME_UNAVAILABLE');
      this.ready = true;
      this.capabilities = { ready: true, backend: 'dsh-native', enforcement: result.enforcement, checks: ['native-sandbox', ...(result.memberDirectoryBoundary ? ['member-directory-boundary'] : [])] };
      return this.capabilities;
    } finally { await rm(directory, { recursive: true, force: true }); }
  }
  async close() { this.closed = true; }
}
