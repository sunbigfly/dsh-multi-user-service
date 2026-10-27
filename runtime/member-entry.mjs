import { networkInterfaces } from 'node:os';
import { isIP } from 'node:net';

const privateV4 = address => {
  if (isIP(address) !== 4) return false;
  const [a, b] = address.split('.').map(Number);
  return a === 10 || a === 192 && b === 168 || a === 172 && b >= 16 && b <= 31;
};

/** Each installation resolves its own entry. An explicit origin remains the
 * operator's authority; no deployment-specific address is shipped in the plugin. */
export function memberEntry({ ownerOrigin, memberOrigin, interfaces = networkInterfaces() }) {
  if (memberOrigin) return memberOrigin;
  const owner = new URL(ownerOrigin);
  const candidates = Object.entries(interfaces).flatMap(([name, rows]) => (rows ?? []).filter(row => !row.internal && privateV4(row.address) && row.address !== owner.hostname).map(row => ({ name, address: row.address })));
  const candidate = candidates.find(row => !/^(?:docker|veth|br-|virbr|tun|tap|wg|tailscale)/i.test(row.name)) ?? candidates[0];
  const hostname = candidate?.address ?? (owner.hostname === 'localhost' ? '127.0.0.1' : 'localhost');
  return `${owner.protocol}//${hostname}${owner.port ? ':' + owner.port : ''}`;
}
