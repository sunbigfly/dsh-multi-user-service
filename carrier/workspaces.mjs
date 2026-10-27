/**
 * Member workspaces: the member-visible projection of the private project
 * directories under one member home.
 *
 * The Host's workspace registry is owner-scoped, so a member Peer can never see
 * or create a Host Workspace. The member page still needs a Workspace to start a
 * Session from, so this module derives one row per project directory the member
 * already owns, using the same directory names `session/create` forces. The
 * filesystem is the registry: creating a project directory creates a workspace,
 * and no member ever sees a directory outside its own home.
 *
 * @module carrier/workspaces
 */
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readdir, readFile, writeFile, open, rename, unlink } from 'node:fs/promises';
import { posix } from 'node:path';
import { memberPath } from './access.mjs';

/** Metadata file holding the member's own titles; lives inside its own home. */
const META = '.lan-workspaces.json';
/** Metadata file holding the member's archived Sessions. */
const ARCHIVED = '.lan-archived.json';
/** Metadata file holding the attachment ids this member uploaded. */
const ATTACHMENTS = '.lan-attachments.json';
/** One project segment, matching the rule `session/create` enforces. */
const SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const DEFAULT_PROJECT = 'workspace';
const DEFAULT_TITLE = '我的工作区';
const TITLE_MAX = 120;
const STAMP = new Date(0).toISOString();
const archiveWrites = new Map();

/** Members and administrators update the same archive set without losing a
 * concurrent account-side change. The native Session and files are retained. */
export function setMemberSessionArchived({ home, sessionId, archived }) {
  const previous = archiveWrites.get(home) ?? Promise.resolve();
  const task = previous.catch(() => {}).then(async () => {
    let ids;
    try { ids = JSON.parse(await readFile(posix.join(home, ARCHIVED), 'utf8')); if (!Array.isArray(ids)) throw new Error('Invalid archive list'); }
    catch (error) { if (error.code !== 'ENOENT') throw error; ids = []; }
    return writeArchivedSessions({ home, ids: archived ? [...ids, sessionId] : ids.filter(id => id !== sessionId) });
  });
  archiveWrites.set(home, task);
  void task.finally(() => { if (archiveWrites.get(home) === task) archiveWrites.delete(home); }).catch(() => {});
  return task;
}

const idOf = (userId, projectId) => `ws_${createHash('sha256').update(`${userId}\u0000${projectId}`).digest('hex').slice(0, 16)}`;

const titleOf = value => (typeof value === 'string' && value.trim() !== '' && value.trim().length <= TITLE_MAX ? value.trim() : null);

async function readMeta(home) {
  try {
    const parsed = JSON.parse(await readFile(posix.join(home, META), 'utf8'));
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    return parsed;
  } catch { return {}; }
}

async function writeMeta(home, meta) {
  const body = `${JSON.stringify(meta, null, 2)}\n`;
  try { await writeFile(posix.join(home, META), body, 'utf8'); } catch { /* Titles fall back to the directory name. */ }
}

async function projectDirectories(home) {
  let entries;
  try { entries = await readdir(home, { withFileTypes: true }); } catch { return []; }
  const names = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (!SEGMENT.test(entry.name)) continue;
    names.push(entry.name);
  }
  return names.sort();
}

/**
 * Every workspace a member may see: its project directories, default first.
 * @param home - the member home directory.
 * @param userId - the member's stable id, used for workspace identity.
 * @param sessions - `{sessionId, projectId}` pairs the ownership map records.
 */
export async function listMemberWorkspaces({ home, userId, sessions = [] }) {
  const root = memberPath(home);
  if (root === null) return [];
  const meta = await readMeta(root);
  const names = await projectDirectories(root);
  if (!names.includes(DEFAULT_PROJECT)) names.unshift(DEFAULT_PROJECT);
  const items = [];
  for (const projectId of names) {
    const entry = meta[projectId];
    const recorded = sessions.filter(session => session?.projectId === projectId).map(session => session.sessionId).filter(id => typeof id === 'string');
    items.push({
      workspaceId: idOf(userId, projectId),
      path: posix.join(root, projectId),
      title: titleOf(entry?.title) ?? (projectId === DEFAULT_PROJECT ? DEFAULT_TITLE : projectId),
      sessionIds: recorded,
      createdAt: typeof entry?.createdAt === 'string' ? entry.createdAt : STAMP,
      updatedAt: typeof entry?.updatedAt === 'string' ? entry.updatedAt : STAMP,
    });
  }
  return items;
}

/**
 * Archived Session ids of one member. The member's archive is its own file: the
 * Host registry is owner-scoped, so the plugin keeps this list beside the home.
 * @returns the archived id list (empty when the file is missing or unreadable).
 */
export async function readArchivedSessions({ home }) {
  const root = memberPath(home);
  if (root === null) return [];
  try {
    const parsed = JSON.parse(await readFile(posix.join(root, ARCHIVED), 'utf8'));
    return Array.isArray(parsed) ? parsed.filter(id => typeof id === 'string') : [];
  } catch { return []; }
}

/** Persist the archived Session list of one member. */
export async function writeArchivedSessions({ home, ids }) {
  const root = memberPath(home);
  if (root === null) throw new TypeError('A canonical member home is required');
  const unique = [...new Set(ids.filter(id => typeof id === 'string'))];
  const temporary = posix.join(root, ARCHIVED + '.' + randomUUID());
  const file = await open(temporary, 'wx', 0o600);
  try { await file.writeFile(`${JSON.stringify(unique, null, 2)}\n`, 'utf8'); await file.sync(); }
  catch (error) { await unlink(temporary).catch(() => {}); throw error; }
  finally { await file.close(); }
  try { await rename(temporary, posix.join(root, ARCHIVED)); }
  catch (error) { await unlink(temporary).catch(() => {}); throw error; }
  return unique;
}

/** Attachment ids this member uploaded. */
export async function readMemberAttachments({ home }) {
  const root = memberPath(home);
  if (root === null) return [];
  try {
    const parsed = JSON.parse(await readFile(posix.join(root, ATTACHMENTS), 'utf8'));
    return Array.isArray(parsed) ? parsed.filter(id => typeof id === 'string') : [];
  } catch { return []; }
}

/** Remember one uploaded attachment id for this member. */
export async function addMemberAttachment({ home, id }) {
  const root = memberPath(home);
  if (root === null) return [];
  const ids = [...new Set([...await readMemberAttachments({ home: root }), id])];
  try { await writeFile(posix.join(root, ATTACHMENTS), `${JSON.stringify(ids, null, 2)}\n`, 'utf8'); } catch { /* unlisted file */ }
  return ids;
}

/**
 * Create the next free project directory inside the member home.
 *
 * The Host's native picker answers with one absolute path and cannot be driven
 * by a member, so "add a workspace" means "make a new project here": the first
 * free name wins and the directory exists by the time it is registered.
 * @returns the absolute path, or `null` when the home is unusable.
 */
export async function nextMemberProject({ home, base = 'project' }) {
  const root = memberPath(home);
  if (root === null) return null;
  await mkdir(root, { recursive: true });
  const taken = new Set(await projectDirectories(root));
  for (let index = 1; index < 1000; index += 1) {
    const name = index === 1 ? base : `${base}-${index}`;
    if (!SEGMENT.test(name) || taken.has(name)) continue;
    const path = posix.join(root, name);
    try {
      await mkdir(path);
      return path;
    } catch (error) {
      if (error?.code === 'EEXIST') continue;
      return null;
    }
  }
  return null;
}

/**
 * Create one directory for a brand-new conversation under its project.
 *
 * Every new conversation gets its own folder so two conversations never see each
 * other's files. The name is a local timestamp, made unique with a suffix.
 * @returns the absolute path, or `null` when it cannot be created.
 */
export async function nextSessionDirectory({ projectPath, base = stampName() }) {
  const root = memberPath(projectPath);
  if (root === null) return null;
  await mkdir(root, { recursive: true });
  for (let index = 1; index < 1000; index += 1) {
    const name = index === 1 ? base : `${base}-${index}`;
    try {
      const path = posix.join(root, name);
      await mkdir(path);
      return path;
    } catch (error) {
      if (error?.code === 'EEXIST') continue;
      return null;
    }
  }
  return null;
}

function stampName() {
  const now = new Date();
  const pad = value => String(value).padStart(2, '0');
  return `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
}

/**
 * Resolve the project directory a member asked to register.
 * @returns `{projectId, path}` or `null` when the path leaves the member home.
 */
export function memberWorkspacePath({ home, requested }) {
  const root = memberPath(home);
  if (root === null) return null;
  const candidate = memberPath(requested);
  if (candidate === null) return null;
  const relative = posix.relative(root, candidate);
  if (relative.startsWith('/') || relative === '..' || relative.startsWith('../')) return null;
  if (relative === '') return { projectId: DEFAULT_PROJECT, path: posix.join(root, DEFAULT_PROJECT) };
  const projectId = relative.split('/')[0];
  if (!SEGMENT.test(projectId)) return null;
  return { projectId, path: posix.join(root, projectId) };
}

/**
 * Register one workspace over an existing (or new) project directory.
 * @returns `{workspace, created}`.
 */
export async function createMemberWorkspace({ home, userId, requested, sessions = [], now = () => new Date().toISOString() }) {
  const root = memberPath(home);
  const resolved = memberWorkspacePath({ home, requested });
  if (root === null || resolved === null) return null;
  await mkdir(resolved.path, { recursive: true });
  const meta = await readMeta(root);
  const existing = meta[resolved.projectId];
  const created = existing === undefined;
  const stamp = now();
  meta[resolved.projectId] = {
    title: titleOf(existing?.title) ?? (resolved.projectId === DEFAULT_PROJECT ? DEFAULT_TITLE : resolved.projectId),
    createdAt: typeof existing?.createdAt === 'string' ? existing.createdAt : stamp,
    updatedAt: stamp,
  };
  await writeMeta(root, meta);
  const rows = await listMemberWorkspaces({ home: root, userId, sessions });
  const workspace = rows.find(row => row.path === resolved.path) ?? rows[0];
  return { workspace, created };
}

/** Rename one member workspace title. Files and Sessions stay in place. */
export async function renameMemberWorkspace({ home, userId, workspaceId, title, sessions = [] }) {
  const next = titleOf(title);
  const root = memberPath(home);
  if (next === null || root === null) return null;
  const rows = await listMemberWorkspaces({ home: root, userId, sessions });
  const row = rows.find(candidate => candidate.workspaceId === workspaceId);
  if (row === undefined) return null;
  const meta = await readMeta(root);
  const projectId = posix.basename(row.path);
  meta[projectId] = {
    title: next,
    createdAt: typeof meta[projectId]?.createdAt === 'string' ? meta[projectId].createdAt : new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  await writeMeta(root, meta);
  const updated = (await listMemberWorkspaces({ home: root, userId, sessions })).find(candidate => candidate.workspaceId === workspaceId);
  return updated === undefined ? null : { workspace: updated };
}

/**
 * Directory listing for the member's own in-app folder browser, rooted at the
 * member home. Paths outside the home are refused, never relocated.
 */
export async function listMemberDirectory({ home, requested }) {
  const root = memberPath(home);
  if (root === null) return null;
  const target = requested === undefined || requested === null || requested === ''
    ? root
    : memberPath(String(requested));
  if (target === null) return null;
  const relative = posix.relative(root, target);
  if (relative.startsWith('/') || relative === '..' || relative.startsWith('../')) return null;
  await mkdir(root, { recursive: true });
  let entries = [];
  try {
    const read = await readdir(target, { withFileTypes: true });
    entries = read
      .filter(entry => entry.isDirectory())
      .map(entry => ({ name: entry.name, path: posix.join(target, entry.name), hidden: entry.name.startsWith('.') }))
      .sort((left, right) => left.name.localeCompare(right.name));
  } catch { entries = []; }
  const crumbs = [{ name: root, path: root, hidden: false }];
  if (relative !== '') {
    let walked = root;
    for (const segment of relative.split('/')) {
      if (segment === '') continue;
      walked = posix.join(walked, segment);
      crumbs.push({ name: segment, path: walked, hidden: false });
    }
  }
  return { path: target, home: root, crumbs, entries, truncated: false };
}
