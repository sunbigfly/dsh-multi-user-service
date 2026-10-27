import test from 'node:test';
import assert from 'node:assert/strict';
import { MemberAttachmentAccess } from '../carrier/attachments.mjs';

const ALICE = 'usr_' + 'a'.repeat(32), BOB = 'usr_' + 'b'.repeat(32), HASH = 'c'.repeat(64), ID = 'sha256:' + HASH;
const ROOT = '/private/attachments/v1';
const filePath = ref => `${ROOT}/files/${HASH.slice(0, 2)}/${ref.attachmentId.slice(7)}/${ref.name}`;
const PATH = filePath({ attachmentId: ID, name: 'own.txt' });
function store(initial = null) {
  let saved = initial;
  return { fail: false, async load() { return structuredClone(saved); }, async save(value) { if (this.fail) throw new Error('disk unavailable'); saved = structuredClone(value); } };
}

test('private attachment receipts isolate users and survive restart without trusting an attachment-like path', async () => {
  const backing = store(), access = await new MemberAttachmentAccess(backing).start();
  await access.record(ALICE, ID, PATH);
  assert.equal(access.allows(ALICE, PATH, filePath), true);
  assert.equal(access.allows(BOB, PATH, filePath), false);
  assert.equal(access.allows(ALICE, '/tmp/.dsh/attachments/other.txt', filePath), false);
  assert.equal(access.allows(ALICE, PATH + '/../../secret', filePath), false);
  const restored = await new MemberAttachmentAccess(backing).start();
  assert.equal(restored.allows(ALICE, PATH, filePath), true);
  assert.equal(restored.allows(BOB, PATH, filePath), false);
});

test('legacy ids migrate once and only derive paths using the real Host store', async () => {
  const backing = store(), access = await new MemberAttachmentAccess(backing).start(async () => [{ userId: ALICE, ids: [ID] }]);
  assert.equal(access.allows(ALICE, PATH, filePath), true);
  assert.equal(access.allows(ALICE, PATH.replace('/private', '/forged/.dsh'), filePath), false);
  const restored = await new MemberAttachmentAccess(backing).start(async () => [{ userId: BOB, ids: [ID] }]);
  assert.equal(restored.allows(BOB, PATH, filePath), false);
});

test('failed persistence does not publish attachment access and corrupt state does not reset to allow', async () => {
  const backing = store(), access = await new MemberAttachmentAccess(backing).start();
  backing.fail = true;
  await assert.rejects(access.record(ALICE, ID, PATH), /disk unavailable/);
  assert.equal(access.allows(ALICE, PATH, filePath), false);
  await assert.rejects(new MemberAttachmentAccess(store({ version: 2, grants: {} })).start(), /Invalid/);
  await access.close();
  assert.equal(access.allows(ALICE, PATH, filePath), false);
});
