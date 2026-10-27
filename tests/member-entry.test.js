import test from 'node:test';
import assert from 'node:assert/strict';
import { memberEntry } from '../runtime/member-entry.mjs';

const row = address => ({ address, family: 'IPv4', internal: false });
test('independent installations derive different LAN entries and retain their own DSH port', () => {
  assert.equal(memberEntry({ ownerOrigin: 'http://127.0.0.1:18620', interfaces: { eth0: [row('192.168.50.7')] } }), 'http://192.168.50.7:18620');
  assert.equal(memberEntry({ ownerOrigin: 'http://localhost:28000', interfaces: { wlan0: [row('10.20.30.40')] } }), 'http://10.20.30.40:28000');
  assert.equal(memberEntry({ ownerOrigin: 'http://127.0.0.1:80', memberOrigin: 'https://workspace.example.test', interfaces: {} }), 'https://workspace.example.test');
});
test('entry discovery prefers ordinary interfaces and never advertises a public address by default', () => {
  assert.equal(memberEntry({ ownerOrigin: 'http://127.0.0.1:18000', interfaces: { docker0: [row('172.17.0.1')], eth0: [row('192.168.1.7')] } }), 'http://192.168.1.7:18000');
  assert.equal(memberEntry({ ownerOrigin: 'http://127.0.0.1:18000', interfaces: { eth0: [row('8.8.8.8')], lo: [{ ...row('10.0.0.1'), internal: true }] } }), 'http://localhost:18000');
});
