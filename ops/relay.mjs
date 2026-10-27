import net from 'node:net';
const [host, port] = process.argv.slice(2);
const server = net.createServer(client => {
  const upstream = net.connect(Number(port), '127.0.0.1');
  const close = () => { client.destroy(); upstream.destroy(); };
  client.on('error', close); upstream.on('error', close);
  client.pipe(upstream); upstream.pipe(client);
});
server.on('error', error => { console.error(`LAN relay: ${error.code}`); process.exit(1); });
server.listen(Number(port), host);
