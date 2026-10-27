import * as v from '../core/validation.js';
import { reject } from '../core/errors.js';

// Budget for normalized settings artwork, not for the user's source file.
// The client fits and encodes originals before sending them here.
export const MAX_LOGO_BYTES = 128 * 1024;
const defaults = () => ({ version: 1, revision: 0, logo: null, slogan: null, name: null, badge: null, showPreviewBadge: true });

function logoSource(value) {
  if (value === null) return null;
  v.text(value, 'logo', Math.ceil(MAX_LOGO_BYTES / 3) * 4 + 64);
  if (value.startsWith('data:')) {
    const match = /^data:image\/(png|jpeg|webp);base64,([A-Za-z0-9+/]+={0,2})$/.exec(value);
    if (!match) reject('INVALID_INPUT', 'Logo must be a PNG, JPEG or WebP image.');
    const bytes = Buffer.from(match[2], 'base64');
    const type = match[1];
    const valid = type === 'png' ? bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
      : type === 'jpeg' ? bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255
      : bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP';
    if (!valid || bytes.length > MAX_LOGO_BYTES || bytes.toString('base64') !== match[2]) reject('INVALID_INPUT', 'Invalid logo image or image exceeds 128 KB.');
  } else {
    v.text(value, 'logo URL', 2048);
    let url;
    try { url = new URL(value); } catch { reject('INVALID_INPUT', 'Logo requires an absolute HTTP(S) URL.'); }
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) reject('INVALID_INPUT', 'Logo requires a credential-free HTTP(S) URL.');
  }
  return value;
}

function document(value) {
  v.object(value, ['version', 'revision', 'logo', 'slogan', 'name', 'badge', 'showPreviewBadge'], ['version', 'revision', 'logo', 'slogan']);
  if (value.version !== 1) reject('BRANDING_INVALID', 'Unsupported branding version.', 503);
  v.integer(value.revision, 'branding revision'); logoSource(value.logo);
  if (value.slogan !== null) v.text(value.slogan, 'slogan', 80);
  if (value.name != null) v.text(value.name, 'sidebar name', 40);
  if (value.badge != null) v.text(value.badge, 'sidebar badge', 16, 0);
  const showPreviewBadge = value.showPreviewBadge === undefined ? true : v.bool(value.showPreviewBadge, 'preview badge visibility');
  return { ...value, name: value.name ?? null, badge: value.badge ?? null, showPreviewBadge };
}

/** Public presentation in a separate domain; changing it never revokes Agents
 * or model authority. The Core's account queue guards every durable update. */
export class Branding {
  constructor({ store, core }) { this.store = store; this.core = core; }
  async start() {
    const stored = await this.store.load();
    this.state = structuredClone(document(stored ?? defaults()));
    return this;
  }
  snapshot() {
    const { version: _version, ...value } = this.state;
    return structuredClone(value);
  }
  update(request, caller) {
    return this.core.runAdministratorOperation(caller, async () => {
      v.object(request, ['action', 'logo', 'slogan', 'name', 'badge', 'showPreviewBadge', 'expectedRevision'], ['action', 'logo', 'slogan', 'expectedRevision']);
      if (request.action !== 'admin.updateBranding') reject('INVALID_INPUT', 'Unknown branding action.');
      v.integer(request.expectedRevision, 'expected branding revision');
      if (request.expectedRevision !== this.state.revision) reject('BRANDING_CONFLICT', 'Branding was updated. Reload before saving.', 409);
      const next = document({ version: 1, revision: this.state.revision + 1, logo: request.logo, slogan: request.slogan,
        name: request.name === undefined ? this.state.name : request.name, badge: request.badge === undefined ? this.state.badge : request.badge,
        showPreviewBadge: request.showPreviewBadge === undefined ? this.state.showPreviewBadge : request.showPreviewBadge });
      try { await this.store.save(structuredClone(next)); }
      catch { reject('BRANDING_STORAGE_FAILURE', 'Branding could not be saved. Your draft is retained.', 503); }
      this.state = next;
      return { branding: this.snapshot() };
    });
  }
}
