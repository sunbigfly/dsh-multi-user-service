import { realpathSync, statSync } from 'node:fs';
import { posix, win32 } from 'node:path';

export const insideRange = (root, path) => {
  if (process.platform === 'win32') { root = root.replaceAll('\\', '/').toLowerCase(); path = path.replaceAll('\\', '/').toLowerCase(); }
  return path === root || path.startsWith(root + '/');
};
const overlaps = (a, b) => insideRange(a, b) || insideRange(b, a);
const forbidden = ['/proc', '/sys', '/dev', '/run'];
const broad = new Set(['/', '/home', '/tmp', '/var', '/mnt', '/opt', '/srv', '/media', '/usr', '/etc', '/bin', '/sbin', '/lib', '/lib64', '/boot']);
const readonlyRuntime = ['/usr', '/etc', '/bin', '/sbin', '/lib', '/lib64', '/boot'];
const invalid = () => { throw Object.assign(new Error('Shared directories must be existing canonical data directories outside private member homes and protected runtime paths.'), { name: 'MemberCarrierError', code: 'SHARED_DIRECTORY_INVALID', status: 400 }); };

/** Recheck mounts at use time. A removed/replaced directory loses access without
 * disabling the member's ordinary private workspace. Administration is strict.
 */
export function resolveSharedDirectories(rows, { protectedRoots = [], readonlyRoots = [], strict = false } = {}) {
  const result = [];
  for (const row of rows) {
    try {
      const path = row.path;
      const windows = process.platform === 'win32' && /^[A-Za-z]:\//.test(path);
      if (!(windows || posix.isAbsolute(path)) || (windows ? win32.resolve(path).replaceAll('\\', '/') : posix.resolve(path)) !== path || (broad.has(path) || /^[A-Za-z]:\/$/.test(path)) || !['read-only', 'read-write'].includes(row.mode)
        || forbidden.some(root => insideRange(root, path)) || protectedRoots.some(root => overlaps(root, path))
        || row.mode === 'read-write' && [...readonlyRuntime, ...readonlyRoots].some(root => overlaps(root, path))
        || realpathSync(path).replaceAll('\\', '/') !== path || !statSync(path).isDirectory()) invalid();
      result.push({ path, mode: row.mode });
    } catch { if (strict) invalid(); }
  }
  return result.sort((a, b) => a.path.length - b.path.length || a.path.localeCompare(b.path));
}

/** More specific grants take precedence, including a read-only child of a
 * writable shared directory. */
export function rangeForPath(path, ranges) {
  return ranges.filter(row => insideRange(row.path, path)).sort((a, b) => b.path.length - a.path.length)[0];
}

/** Extend the native per-call fence while retaining its atomic write/edit and
 * fresh canonical target. Owner calls keep their original policy. */
export function installMemberFileRanges(receiver, { bindingForPolicy }) {
  const fs = receiver[Symbol.for('cordis.original')] ?? receiver, original = fs.checkedTarget;
  if (typeof original !== 'function') throw new Error('Native filesystem policy integration is unavailable');
  const denied = () => { throw Object.assign(new Error('File mutation is outside the authorized writable directories.'), { code: 'FS_SANDBOX_DENIED' }); };
  const writableRoot = (binding, path) => {
    if (insideRange(binding.cwd, path)) return binding.cwd;
    const range = rangeForPath(path, binding.sharedDirectories ?? []);
    return range?.mode === 'read-write' ? range.path : undefined;
  };
  const wrapper = async function(target, policy) {
    const binding = policy && bindingForPolicy(policy);
    if (!binding) return original.call(this, target, policy);
    if (!['workspace-write', 'danger-full-access'].includes(policy.mode)) denied();
    const fresh = await this.resolve(target.displayPath);
    const current = bindingForPolicy(policy);
    const root = current && writableRoot(current, fresh.targetKey);
    if (!root || !writableRoot(current, target.displayPath)) denied();
    const checked = await original.call(this, fresh, { ...policy, mode: 'workspace-write', workspaceRoot: root });
    const latest = bindingForPolicy(policy);
    if (!latest || !writableRoot(latest, checked.targetKey)) denied();
    return checked;
  };
  fs.checkedTarget = wrapper;
  return () => { if (fs.checkedTarget === wrapper) fs.checkedTarget = original; };
}
