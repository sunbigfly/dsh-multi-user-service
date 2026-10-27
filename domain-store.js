import { z } from 'zod';

/** One record is the transaction boundary: accounts, policies and ownership
 * publish together, never as a partially committed multi-table change. */
export const DOMAIN_SPEC = Object.freeze({
  name: 'lan_workspace',
  version: 1,
  layout: 'single',
  tables: { state: { valueSchema: z.json() } },
});

export const SESSION_DOMAIN_SPEC = Object.freeze({ ...DOMAIN_SPEC, name: 'lan_workspace_sessions' });

export class DomainStore {
  constructor(domain) { this.domain = domain; this.table = domain.table('state'); }
  async load() {
    const value = this.table.get('snapshot');
    return value === undefined ? null : structuredClone(value);
  }
  async save(state) {
    // Core validates the strict versioned schema before this operation. Storage
    // also rejects non-JSON values, and acknowledges durability before return.
    const value = z.json().parse(structuredClone(state));
    await this.table.put('snapshot', value);
  }
}
