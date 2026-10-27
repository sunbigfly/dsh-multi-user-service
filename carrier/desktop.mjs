import { Readable } from 'node:stream';

/** Reuse the native desktop routes for authenticated administrators. Desktop
 * launch is a Host operation; members keep using their isolated native tools. */
export function installAdministratorDesktop(webReceiver, connectionReceiver) {
  const web = webReceiver[Symbol.for('cordis.original')] ?? webReceiver;
  const connection = connectionReceiver[Symbol.for('cordis.original')] ?? connectionReceiver;
  const admitted = new WeakSet(), original = connection.requestRejection;
  const descriptor = Object.getOwnPropertyDescriptor(connection, 'requestRejection');
  const wrapper = function(request) { return admitted.has(request) ? undefined : original.call(this, request); };
  connection.requestRejection = wrapper;
  return {
    async serve(request, user) {
      if (user.role !== 'admin') return new Response('Administrator required', { status: 403 });
      const url = new URL(request.url), path = url.pathname.slice('/lan'.length);
      // Native launch targets the serving Host's desktop, not the visitor's
      // device. An empty availability catalog also disables native shortcuts.
      // Local access still uses the Host's own installed-application probe.
      if (path === '/open-in-app/apps' && ['GET', 'HEAD'].includes(request.method)
          && !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) {
        return new Response(request.method === 'HEAD' ? null : JSON.stringify({ apps: [] }), {
          headers: { 'content-type': 'application/json', 'cache-control': 'no-store, private' },
        });
      }
      const route = web.exact.get(path) ?? (path.startsWith('/open-in-app/icon/') ? web.prefixes.get('/open-in-app/icon') : undefined);
      if (!route) return new Response('Native desktop route unavailable', { status: 404 });
      const chunks = []; let size = 0;
      if (request.method === 'POST' && request.body) for await (const chunk of request.body) {
        size += chunk.length;
        if (size > 65536) return new Response('Request too large', { status: 413 });
        chunks.push(chunk);
      }
      const bytes = Buffer.concat(chunks);
      const req = Readable.from(bytes.length ? [bytes] : []);
      req.method = request.method; req.url = path + url.search; req.headers = Object.fromEntries(request.headers);
      const headers = new Headers({ 'cache-control': 'no-store, private' });
      let body;
      const res = { statusCode: 200, setHeader(name, value) { headers.set(name, String(value)); }, end(value) { body = value; } };
      admitted.add(req);
      try { await route.handler(req, res); }
      finally { admitted.delete(req); req.destroy(); }
      headers.delete('set-cookie');
      return new Response(request.method === 'HEAD' ? null : body ?? null, { status: res.statusCode, headers });
    },
    dispose() { if (connection.requestRejection === wrapper) { if (descriptor) Object.defineProperty(connection, 'requestRejection', descriptor); else delete connection.requestRejection; } },
  };
}

// The native desktop client uses ordinary fetch rather than the RPC carrier.
// Add the member session's CSRF token only to this exact local route family.
export const ADMINISTRATOR_DESKTOP_FETCH = `(()=>{const original=window.fetch.bind(window);window.fetch=(input,init)=>{const request=new Request(input instanceof Request?input:new URL(input,document.baseURI),init);const url=new URL(request.url);if(url.origin===location.origin&&url.pathname.startsWith('/lan/open-in-app/')&&!['GET','HEAD'].includes(request.method)){const headers=new Headers(request.headers);headers.set('X-Lan-CSRF',window.__DSH_LAN_MEMBER__.csrf);return original(new Request(request,{headers}));}return original(request);};})();`;
