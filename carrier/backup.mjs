import net from 'node:net';
import { lstat, unlink, chmod, realpath } from 'node:fs/promises';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';

const originalOf = service => service[Symbol.for('cordis.original')] ?? service;

/** Private local control only; the socket is neither a member RPC nor a new DSH. */
export class BackupControl {
  constructor({ path, busy, plan, RemoteError, leaseMs = 30000 }) { Object.assign(this, { path, busy, plan, RemoteError, leaseMs }); this.models = 0; }
  assertAvailable() {
    if (this.token) throw new this.RemoteError('lan/backup-maintenance', '服务器正在准备备份，请稍后重试。', { reason: 'BACKUP_MAINTENANCE' });
  }
  enterModel() { this.assertAvailable(); this.models++; let closed = false; return () => { if (!closed) { closed = true; this.models--; } }; }
  release() { this.token = null; clearTimeout(this.timer); }
  async command(request) {
    if (request.action === 'release') {
      if (!this.token || request.token !== this.token) throw new Error('Invalid backup lease');
      this.release(); return { released: true };
    }
    if (request.action !== 'prepare') throw new Error('Unknown backup command');
    if (this.token || this.models || await this.busy()) return { ready: false, reason: 'busy' };
    // No await between the final check and closing admission.
    if (this.token || this.models) return { ready: false, reason: 'busy' };
    this.token = randomUUID();
    const token = this.token;
    this.timer = setTimeout(() => this.release(), this.leaseMs); this.timer.unref?.();
    try {
      const plan = await this.plan();
      if (this.token !== token) return { ready: false, reason: 'lease-expired' };
      if (await this.busy()) { this.release(); return { ready: false, reason: 'busy' }; }
      return { ready: true, token: this.token, roots: plan };
    } catch (error) { this.release(); throw error; }
  }
  async start() {
    if (!this.path.startsWith('/') || Buffer.byteLength(this.path) > 100 || await realpath(dirname(this.path)) !== dirname(this.path)) throw new Error('Backup socket requires a canonical private directory');
    try {
      const stat = await lstat(this.path);
      if (!stat.isSocket() || stat.uid !== process.getuid()) throw new Error('Backup socket path is occupied');
      const active = await new Promise(done => { const peer = net.connect(this.path); peer.once('connect', () => { peer.destroy(); done(true); }); peer.once('error', () => done(false)); });
      if (active) throw new Error('Backup control is already running');
      await unlink(this.path);
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
    this.server = net.createServer(socket => {
      let text = '', done = false;
      socket.setTimeout(3000, () => socket.destroy()); socket.on('error', () => {});
      socket.on('data', async bytes => {
        if (done) return;
        text += bytes.toString('utf8');
        if (text.length > 1024) { done = true; socket.destroy(); return; }
        if (!text.includes('\n')) return; done = true;
        try { socket.end(JSON.stringify({ ok: true, ...await this.command(JSON.parse(text.trim())) }) + '\n'); }
        catch { socket.end(JSON.stringify({ ok: false, error: 'Backup preparation failed; no backup was started.' }) + '\n'); }
      });
    });
    this.server.maxConnections = 2;
    await new Promise((done, fail) => { this.server.once('error', fail); this.server.listen(this.path, done); });
    await chmod(this.path, 0o600); this.stat = await lstat(this.path);
    return this;
  }
  async close() {
    this.release();
    await new Promise(done => this.server?.close(done) ?? done());
    try { const current = await lstat(this.path); if (current.ino === this.stat?.ino) await unlink(this.path); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
}

export function installBackupOperationGuard(receiver, name, control, wakes = () => true) {
  const target = originalOf(receiver), original = target[name], descriptor = Object.getOwnPropertyDescriptor(target, name);
  if (typeof original !== 'function') throw new Error(`Native ${name} backup admission is unavailable`);
  const wrapper = function(...args) { if (wakes(args)) control.assertAvailable(); return original.apply(this, args); };
  target[name] = wrapper;
  return () => { if (target[name] === wrapper) { if (descriptor) Object.defineProperty(target, name, descriptor); else delete target[name]; } };
}
export function installBackupAgent(agent, control) {
  const restores = [];
  try {
    for (const name of ['send', 'wakeDriver', 'runMaintenance']) restores.push(installBackupOperationGuard(agent, name, control, args => name !== 'send' || args[2]));
  } catch (error) { restores.reverse().forEach(fn => fn()); throw error; }
  return () => restores.reverse().forEach(fn => fn());
}
export function installBackupModelGuard(receiver, control) {
  const runtime = originalOf(receiver), original = runtime.streamWithRegistration;
  const wrapper = function(...args) {
    const self = this;
    return (async function* () { const release = control.enterModel(); try { yield* original.apply(self, args); } finally { release(); } })();
  };
  runtime.streamWithRegistration = wrapper;
  return () => { if (runtime.streamWithRegistration === wrapper) runtime.streamWithRegistration = original; };
}
