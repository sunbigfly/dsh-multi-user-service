import test from 'node:test';
import assert from 'node:assert/strict';
import { accountAccess, effectiveAccess, mergeAccountAccess, personalAccess, toolAccessAllows } from '../core/validation.js';

test('tool access defaults to a blacklist, while an empty whitelist disables every tool', () => {
  const defaults = accountAccess();
  assert.equal(defaults.toolMode, 'blacklist');
  assert.equal(toolAccessAllows(defaults, 'future_tool'), true);
  const blocked = accountAccess({ toolMode: 'blacklist', tools: ['bash'] });
  assert.equal(toolAccessAllows(blocked, 'bash'), false);
  assert.equal(toolAccessAllows(blocked, 'read'), true);
  assert.equal(toolAccessAllows(blocked, 'future_tool'), true);
  const allowed = accountAccess({ toolMode: 'whitelist', tools: ['read'] });
  assert.equal(toolAccessAllows(allowed, 'read'), true);
  assert.equal(toolAccessAllows(allowed, 'future_tool'), false);
  assert.equal(toolAccessAllows(accountAccess({ toolMode: 'whitelist' }), 'read'), false);
  assert.equal(toolAccessAllows(accountAccess({ toolMode: 'blacklist', tools: [] }), 'read'), true);
  for (const value of ['allow', '', false]) assert.throws(() => accountAccess({ toolMode: value }), { code: 'INVALID_INPUT' });
});

test('legacy allowlists retain their meaning through partial updates and personal preferences', () => {
  const legacy = accountAccess({ tools: ['read'] });
  assert.equal(legacy.toolMode, 'whitelist');
  assert.equal(personalAccess({ tools: [] }).toolMode, 'whitelist');
  assert.equal(mergeAccountAccess(legacy, { files: false }).toolMode, 'whitelist');
  assert.equal(mergeAccountAccess({}, { tools: ['read'] }).toolMode, 'whitelist');
  const blacklist = mergeAccountAccess(legacy, { toolMode: 'blacklist', tools: ['bash'] });
  assert.equal(mergeAccountAccess(blacklist, { terminal: false }).toolMode, 'blacklist');
  assert.equal(toolAccessAllows(mergeAccountAccess(blacklist, { terminal: false }), 'read'), true);
});

test('administrator and personal tool policies intersect across both modes', () => {
  const policy = (toolMode, tools) => ({ toolMode, tools });
  const cases = [
    [policy('blacklist', ['bash']), policy('blacklist', ['edit']), 'blacklist', ['bash', 'edit']],
    [policy('blacklist', ['bash']), policy('whitelist', ['read', 'bash']), 'whitelist', ['read']],
    [policy('whitelist', ['read', 'edit']), policy('blacklist', ['edit']), 'whitelist', ['read']],
    [policy('whitelist', ['read', 'edit']), policy('whitelist', ['edit', 'bash']), 'whitelist', ['edit']],
  ];
  for (const [access, preferences, mode, names] of cases) {
    const effective = effectiveAccess({ access, preferences });
    assert.equal(effective.toolMode, mode);
    assert.deepEqual(effective.tools, names);
    for (const name of ['read', 'edit', 'bash', 'future_tool']) assert.equal(toolAccessAllows(effective, name), toolAccessAllows(access, name) && toolAccessAllows(preferences, name));
  }
});
