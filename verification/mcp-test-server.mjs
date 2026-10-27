// Local stdio protocol fixture. Never installed into the production profile.
import { createInterface } from 'node:readline';
import { appendFileSync } from 'node:fs';
const [server, log] = process.argv.slice(2);
const send = value => process.stdout.write(JSON.stringify(value) + '\n');
for await (const line of createInterface({ input: process.stdin })) {
  const message = JSON.parse(line);
  if (message.id === undefined) continue;
  const { id, method, params = {} } = message;
  appendFileSync(log, JSON.stringify({ server, method, value: params.arguments?.value }) + '\n');
  let result;
  if (method === 'initialize') result = { protocolVersion: params.protocolVersion, capabilities: { tools: {}, resources: {} }, serverInfo: { name: server, version: '1.0.0' }, instructions: 'SYNTHETIC_' + server };
  else if (method === 'tools/list') result = { tools: [{ name: 'echo', description: 'Synthetic echo', inputSchema: { type: 'object', properties: { value: { type: 'string' }, delay: { type: 'number' } }, required: ['value'] } }] };
  else if (method === 'tools/call') {
    const result = { content: [{ type: 'text', text: server + ':' + params.arguments.value }] };
    setTimeout(() => send({ jsonrpc: '2.0', id, result }), params.arguments.delay ?? 0);
    continue;
  } else if (method === 'resources/list') result = { resources: [{ uri: 'test://' + server, name: server }] };
  else if (method === 'resources/templates/list') result = { resourceTemplates: [] };
  else if (method === 'resources/read') result = { contents: [{ uri: params.uri, text: server + ':resource' }] };
  else if (method === 'ping') result = {};
  else { send({ jsonrpc: '2.0', id, error: { code: -32601, message: 'Unsupported fixture method' } }); continue; }
  send({ jsonrpc: '2.0', id, result });
}
