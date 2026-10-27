/** The public root leads every service account to the same login/session.
 * Native owner access retains its own authentication and never implies a
 * service administrator role. No credential or query string is forwarded.
 */
export function mountAdministratorEntry(webServer, auth) {
  return webServer.register({ kind: 'exact', path: '/', handler: async (req, res) => {
    try {
      // This GET serves only the public login document. Its POST and every
      // private resource still enforce the full same-origin/session checks.
      try { auth.trust({ host: req.headers.host }); }
      catch (error) {
        const owner = new URL(webServer.getOrigin()), host = req.headers.host;
        const local = /^(?:localhost|127\.0\.0\.1|\[::1\])(?::\d+)?$/;
        const ownerHost = host === owner.host || typeof host === 'string' && local.test(host) && local.test(owner.host) && new URL(`${owner.protocol}//${host}`).port === owner.port;
        if (error.code === 'HOST_DENIED' && ownerHost && typeof webServer.fallback === 'function') return webServer.fallback(req, res);
        throw error;
      }
      if (!['GET', 'HEAD'].includes(req.method)) {
        res.writeHead(405, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store, private', allow: 'GET, HEAD' });
        res.end('GET or HEAD required');
        return;
      }
      res.writeHead(302, { location: '/lan/', 'cache-control': 'no-store, private', 'referrer-policy': 'no-referrer', 'x-content-type-options': 'nosniff' });
      res.end();
    } catch {
      res.writeHead(403, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store, private' });
      res.end('Untrusted management entry');
    }
  } });
}
