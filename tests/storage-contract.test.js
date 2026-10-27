import test from 'node:test';
import assert from 'node:assert/strict';
import { DOMAIN_SPEC } from '../domain-store.js';

// Installed @deepseek-ai/dsh-storage/lib/index.js UNIT_NAME_RE, verified after
// the first real activation rejected the earlier hyphenated domain name.
test('storage domain and table identifiers match the installed DSH contract', () => {
  assert.match(DOMAIN_SPEC.name, /^[a-z][a-z0-9_]*$/);
  for (const name of Object.keys(DOMAIN_SPEC.tables)) assert.match(name, /^[a-z][a-z0-9_]*$/);
});
