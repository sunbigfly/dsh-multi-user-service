// Member integration over the original DSH application graph; its sidebar,
// sessions, conversation, composer and settings shell stay native.
window.__ModuleLoader__.load({
  id: '@sunbigfly/dsh-multi-user-service/member-client',
  factory(require) {
    const React = require('react');
    const h = React.createElement;
    const NS = 'lan-workspace-account';
    const ENDPOINT = '/lan/api/lan-workspace';
    const AUTH_ENDPOINT = '/lan/auth';
    const failure = code => Object.assign(new Error(code), { code });
    const validText = (value, maximum) => typeof value === 'string' && value.trim().length > 0 && value.length <= maximum && !/[\x00-\x1f\x7f]/.test(value);
    function publicIdentity(user) {
      if (!user || !validText(user.id, 160) || !validText(user.username, 160) || !validText(user.displayName, 160) || !['member', 'admin'].includes(user.role)) throw failure('INVALID_RESPONSE');
      if (user.disabled === true) throw failure('UNAUTHENTICATED');
      return Object.freeze({ id: user.id, username: user.username, displayName: user.displayName, role: user.role });
    }
    function accountFromSnapshot(snapshot, expectedId) {
      const user = publicIdentity(snapshot?.user);
      if (user.id !== expectedId) throw failure('IDENTITY_CHANGED');
      // Deliberately discard projects, routes, account credentials and all paths.
      const home = Object.freeze({ status: ['ready', 'pending'].includes(snapshot?.home?.status) ? snapshot.home.status : 'unavailable' });
      return Object.freeze({ user, home });
    }

    // Native create() seeds a placeholder from the caller's cwd. The carrier
    // assigns a different, private directory, and the initial added event can
    // precede the member's ownership grant. Pull the native baseline when its
    // workingDirectory projection reveals that stale placeholder. Never infer
    // a path or replace the native store. A second pull covers a list request
    // already in flight before creation; retries are bounded per identity/path.
    function syncSessionDirectories(sessions) {
      const attempts = new Map();
      let disposed = false, refreshing = false;
      const synchronize = () => {
        if (disposed || refreshing) return;
        const state = sessions.list.getSnapshot();
        const pending = (state.ids ?? []).flatMap(id => {
          const row = state.byId[id], cwd = row?.projectionValues?.workingDirectory;
          const key = `${id}\0${cwd}`;
          return typeof cwd === 'string' && cwd !== '' && row.cwd !== cwd && (attempts.get(key) ?? 0) < 2 ? [key] : [];
        });
        if (!pending.length) return;
        refreshing = true;
        for (const key of pending) attempts.set(key, (attempts.get(key) ?? 0) + 1);
        void Promise.resolve().then(() => { if (!disposed) return sessions.refresh(); }).catch(() => {}).finally(() => {
          refreshing = false;
          synchronize();
        });
      };
      const unsubscribe = sessions.list.subscribe(synchronize);
      synchronize();
      return () => { disposed = true; unsubscribe(); attempts.clear(); };
    }

    // Identity has only two operations. It never calls the owner's Remote face,
    // persists a token, follows a redirect, or accepts a configurable endpoint.
    function createMemberApi({ csrf, fetcher = (...args) => fetch(...args), onExpired = () => {} }) {
      const controllers = new Set();
      const timers = new Set();
      let disposed = false;
      async function request(action, fields = {}, signal) {
        if (disposed) throw failure('DISPOSED');
        if (!['snapshot', 'logout'].includes(action) || Object.keys(fields).length) throw failure('IDENTITY_ACTION_DENIED');
        if (typeof csrf !== 'string' || !csrf) throw failure('CSRF_REQUIRED');
        if (signal?.aborted) throw failure('ABORTED');
        const controller = new AbortController();
        const abort = () => controller.abort();
        signal?.addEventListener('abort', abort, { once: true });
        controllers.add(controller);
        let timedOut = false;
        const timer = setTimeout(() => { timedOut = true; abort(); }, 20000);
        timers.add(timer);
        try {
          const response = await fetcher(action === 'logout' ? AUTH_ENDPOINT : ENDPOINT, {
            method: 'POST', credentials: 'same-origin', cache: 'no-store', redirect: 'error',
            headers: { 'Content-Type': 'application/json', 'X-Lan-CSRF': csrf },
            body: JSON.stringify({ action, ...(action === 'snapshot' ? { section: 'base' } : {}) }), signal: controller.signal,
          });
          if (response.status === 401) onExpired();
          let envelope;
          try { envelope = await response.json(); }
          catch { throw failure(response.status === 401 ? 'UNAUTHENTICATED' : 'INVALID_RESPONSE'); }
          if (controller.signal.aborted || disposed) throw failure('ABORTED');
          if (!response.ok || envelope?.ok !== true) throw failure(envelope?.error?.code || `HTTP_${response.status}`);
          if (!Object.prototype.hasOwnProperty.call(envelope, 'result')) throw failure('INVALID_RESPONSE');
          return envelope.result;
        } catch (error) {
          if (controller.signal.aborted) throw failure(timedOut ? 'TIMEOUT' : 'ABORTED');
          throw error;
        } finally {
          clearTimeout(timer); timers.delete(timer); controllers.delete(controller);
          signal?.removeEventListener('abort', abort);
        }
      }
      return { request, dispose() {
        if (disposed) return;
        disposed = true; csrf = '';
        controllers.forEach(controller => controller.abort()); controllers.clear();
        timers.forEach(timer => clearTimeout(timer)); timers.clear();
      } };
    }

    const messages = {
      en: {
        account: 'Workspace account', settings: 'Settings', displayName: 'Display name', username: 'Username', role: 'Role',
        adminRole: 'Administrator', memberRole: 'Member', home: 'Personal workspace directory', homeAlias: 'Home directory',
        homeReady: 'Automatically allocated', homePending: 'Waiting for automatic allocation', homeUnavailable: 'Directory status is unavailable.',
        homeNote: 'Your personal directory is allocated automatically. Each project mounts only its own subdirectory.',
        refresh: 'Refresh account', loading: 'Loading account…', logout: 'Sign out', signingOut: 'Signing out…',
        expired: 'Your login expired. Sign in again.', signIn: 'Return to sign in', requestFailed: 'Account information could not be refreshed. Try again.',
        logoutFailed: 'Sign out did not complete. Try again.', timeout: 'The account request timed out. Try again.',
        csrf: 'Reload this page before trying again.', admin: 'Workspace management',
        memberEntry: 'Member entry', enterMember: 'Open the member entry', memberEntryNote: 'Share this address with members. Each member signs in with a workspace account.',
      },
      zh: {
        account: '工作区账号', settings: '设置', displayName: '显示名', username: '用户名', role: '角色',
        adminRole: '管理员', memberRole: '成员', home: '个人工作目录', homeAlias: '家目录',
        homeReady: '已自动分配', homePending: '正在等待系统分配', homeUnavailable: '暂时无法确认目录状态。',
        homeNote: '系统自动分配个人目录；每个项目只挂载各自的子目录。',
        refresh: '刷新账号', loading: '正在加载账号…', logout: '退出登录', signingOut: '正在退出…',
        expired: '登录已失效，请重新登录。', signIn: '返回登录', requestFailed: '未能刷新账号信息，请重试。',
        logoutFailed: '退出登录未完成，请重试。', timeout: '账号请求超时，请重试。',
        csrf: '请重新加载页面后重试。', admin: '工作区管理',
        memberEntry: '成员入口', enterMember: '打开成员入口', memberEntryNote: '将此地址分享给成员，使用各自的工作区账号登录。',
      },
    };
    // Small account controls only; all panel geometry, navigation, keyboard and
    // modal behavior belongs to dsh-client-ui-settings-general, not this file.
    const styles = `
.lann-account,.lann-launcher{box-sizing:border-box;color:var(--dsw-alias-label-primary);font:inherit;min-width:0}
.lann-launcher{display:flex;align-items:center;gap:8px;width:100%;height:44px;padding:6px;border:0;border-radius:8px;background:transparent;text-align:left;font-size:14px;cursor:pointer}
.lann-launcher[data-collapsed=true]{justify-content:center;gap:0;width:36px;height:36px;padding:0}
.lann-launcher:hover,.lann-account button:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}
.lann-launcher:focus-visible,.lann-account button:focus-visible,.lann-account a:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:2px}
.lann-avatar{display:flex;align-items:center;justify-content:center;flex:none;width:24px;height:24px;border-radius:50%;background:var(--dsw-alias-bg-skeleton);color:var(--dsw-alias-label-tertiary)}
.lann-label{overflow:hidden;white-space:nowrap;text-overflow:ellipsis}.lann-role{flex:none;margin-left:auto;padding:1px 6px;border-radius:5px;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-secondary);font-size:11px;line-height:18px;white-space:nowrap}.lann-sr{position:absolute;width:1px;height:1px;padding:0;overflow:hidden;clip-path:inset(50%);white-space:nowrap}
.lann-account{display:flex;flex-direction:column;gap:24px;width:100%;font-size:13px;line-height:20px}.lann-account h2{margin:0;font-size:20px;font-weight:500;line-height:28px}.lann-account h3{margin:0;font-size:14px;font-weight:500;line-height:22px}
.lann-account section{display:flex;flex-direction:column;gap:8px;min-width:0}.lann-account p{margin:0;color:var(--dsw-alias-label-secondary)}
.lann-account dl{display:grid;grid-template-columns:auto minmax(0,1fr);gap:12px 24px;margin:0}.lann-account dt{color:var(--dsw-alias-label-secondary)}.lann-account dd{margin:0;overflow-wrap:anywhere}
.lann-account button{font:inherit;cursor:pointer;min-height:34px;padding:6px 12px;color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-layer-1);border:1px solid transparent;border-radius:8px}
.lann-account button:disabled{opacity:.5;cursor:not-allowed}.lann-actions{display:flex;flex-wrap:wrap;gap:8px}.lann-account a{color:var(--dsw-alias-brand-primary)}
.lann-account [role=alert]{color:var(--dsw-alias-state-error-primary)}
.lann-account dl{grid-template-columns:120px minmax(0,1fr);gap:16px 24px;padding-bottom:24px;border-bottom:1px solid var(--dsw-alias-border-l1)}.lann-account [data-member-entry]{gap:10px}.lann-account .lann-entry-link{display:block;align-self:flex-start;padding:10px 12px;border-radius:8px;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);text-decoration:none;overflow-wrap:anywhere}.lann-account .lann-entry-link:hover{background:var(--dsw-alias-bg-layer-2)}.lann-actions{padding-top:8px}
`;

    function apply(ctx, { WorkspaceSection, installWorkspace } = {}) {
      const flag = window.__DSH_LAN_MEMBER__;
      let bootstrap;
      try { bootstrap = publicIdentity(flag?.user); } catch { return; }
      if (typeof flag?.csrf !== 'string' || !flag.csrf) return;
      const entryPath = flag.adminEntry === true ? '/lan/admin/' : '/lan/';
      return ctx.effect(() => {
        const resources = [];
        const listeners = new Set();
        let alive = true, disposed = false, inFlight, workspaceSnapshot = null, workspaceWindow;
        let state = Object.freeze({ user: bootstrap, home: null, verified: false, pending: null, error: null, expired: false });
        const getSnapshot = () => state;
        const subscribe = listener => { listeners.add(listener); return () => listeners.delete(listener); };
        function update(patch) {
          if (!alive) return;
          state = Object.freeze({ ...state, ...patch });
          for (const listener of [...listeners]) listener();
        }
        function expire() { workspaceSnapshot = null; update({ user: null, home: null, verified: false, expired: true, pending: null, error: null }); }
        const api = createMemberApi({ csrf: flag.csrf, onExpired: expire });
        resources.push(() => api.dispose());
        function cleanup() {
          if (disposed) return;
          disposed = true; alive = false;
          workspaceSnapshot = null;
          state = Object.freeze({ user: null, home: null, verified: false, pending: null, error: null, expired: true });
          listeners.clear();
          let firstError;
          for (const dispose of resources.splice(0).reverse()) {
            try { dispose(); } catch (error) { firstError ??= error; }
          }
          if (firstError) throw firstError;
        }
        try {
          const sessionSync = ctx.inject(['sessions'], child => child.effect(() => syncSessionDirectories(child.get('sessions'))));
          resources.push(() => sessionSync.dispose());
          for (const [locale, dictionary] of Object.entries(messages)) resources.push(ctx.locale.register(NS, locale, dictionary));
          const t = ctx.locale.bind(NS);
          const subscribeLocale = listener => ctx.locale.subscribe(listener);
          const getLocale = () => ctx.locale.getSnapshot();
          function useAccount() {
            React.useSyncExternalStore(subscribeLocale, getLocale, getLocale);
            return React.useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
          }
          function errorKey(error, logout = false) {
            if (error?.code === 'TIMEOUT') return 'timeout';
            if (['CSRF_REQUIRED', 'CSRF_INVALID'].includes(error?.code)) return 'csrf';
            return logout ? 'logoutFailed' : 'requestFailed';
          }
          function refresh() {
            if (!alive || state.expired || state.pending === 'logout') return Promise.resolve(false);
            if (inFlight) return inFlight;
            update({ pending: 'refresh', error: null });
            inFlight = (async () => {
              try {
                const snapshot = await api.request('snapshot');
                const account = accountFromSnapshot(snapshot, bootstrap.id);
                if (alive && !state.expired) { workspaceSnapshot = snapshot; update({ ...account, verified: true }); if (snapshot.admin?.setup?.required) workspaceWindow?.open?.(); }
                return alive && !state.expired;
              } catch (error) {
                if (alive && !state.expired && error.code !== 'ABORTED') {
                  if (['UNAUTHENTICATED', 'IDENTITY_CHANGED'].includes(error.code)) expire();
                  else { workspaceSnapshot = null; update({ verified: false, home: null, error: errorKey(error) }); }
                }
                return false;
              } finally {
                inFlight = undefined;
                if (alive && !state.expired) update({ pending: null });
              }
            })();
            return inFlight;
          }
          async function logout() {
            if (!alive || state.pending || state.expired) return false;
            update({ pending: 'logout', error: null });
            try {
              await api.request('logout');
              if (!alive) return false;
              expire();
              window.location.assign(entryPath);
              return true;
            } catch (error) {
              if (alive && !state.expired && error.code !== 'ABORTED') update({ error: errorKey(error, true) });
              return false;
            } finally { if (alive && !state.expired) update({ pending: null }); }
          }
          function IdentityLauncher({ wide, settingsOpen, settingsShortcut, openSettings }) {
            const view = useAccount();
            const wasOpen = React.useRef(false);
            React.useEffect(() => {
              if (settingsOpen && !wasOpen.current) void refresh();
              wasOpen.current = settingsOpen;
            }, [settingsOpen]);
            const name = view.user?.displayName;
            const role = view.user ? t(view.user.role === 'admin' ? 'adminRole' : 'memberRole') : '';
            const label = `${t('settings')} — ${name || t(view.expired ? 'signIn' : 'account')}${role ? ' · ' + role : ''}`;
            return h(React.Fragment, null, h('style', null, styles), h('button', {
              type: 'button', className: 'lann-launcher', 'data-member-account-launcher': true, 'data-collapsed': !wide,
              'aria-label': label, title: label, 'aria-haspopup': 'dialog', 'aria-expanded': settingsOpen,
              'aria-keyshortcuts': settingsShortcut?.aria, onClick: openSettings,
            }, h('span', { className: 'lann-avatar', 'aria-hidden': true }, h('svg', { width: 18, height: 18, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.6 }, h('circle', { cx: 12, cy: 8, r: 3.5 }), h('path', { d: 'M4.5 21v-2a7.5 7.5 0 0 1 15 0v2' }))), h('span', { className: wide ? 'lann-label' : 'lann-sr' }, name || t(view.expired ? 'signIn' : 'account')), wide && role && h('span', { className: 'lann-role', 'data-service-account-role': view.user.role }, role)));
          }
          function AccountSection({ embedded = false } = {}) {
            const view = useAccount();
            // The workspace tab is gone: an administrator finds the member entry
            // here, under the account it belongs to. Members never see the Host
            // directory allocation.
            const memberEntry = typeof workspaceSnapshot?.memberUrl === 'string' && /^https?:\/\//.test(workspaceSnapshot.memberUrl) ? workspaceSnapshot.memberUrl : window.location.origin ? window.location.origin + '/lan/' : '/lan/';
            return h('div', { className: 'lann-account', 'data-workspace-account': true, 'aria-busy': Boolean(view.pending) },
              h('style', null, styles), !embedded && h('h2', null, t('account')),
              view.expired ? h('section', null, h('p', { role: 'alert' }, t('expired')), h('a', { href: entryPath }, t('signIn'))) : h(React.Fragment, null,
                view.pending && h('p', { role: 'status' }, t(view.pending === 'logout' ? 'signingOut' : 'loading')),
                view.error && h('p', { role: 'alert' }, t(view.error)),
                h('dl', null, h('dt', null, t('displayName')), h('dd', null, view.user.displayName), h('dt', null, t('username')), h('dd', null, view.user.username), h('dt', null, t('role')), h('dd', null, t(view.user.role === 'admin' ? 'adminRole' : 'memberRole'))),
                view.user?.role === 'admin' && h('section', { 'data-member-entry': true },
                  h('h3', null, t('memberEntry')),
                  h('p', null, t('memberEntryNote')),
                  h('a', { className: 'lann-entry-link', 'aria-label': t('enterMember'), href: memberEntry, target: '_blank', rel: 'noopener noreferrer', referrerPolicy: 'no-referrer' }, memberEntry)),
                h('div', { className: 'lann-actions' }, h('button', { type: 'button', disabled: Boolean(view.pending), onClick: refresh }, t('refresh')), h('button', { type: 'button', disabled: Boolean(view.pending), onClick: logout }, t('logout')))));
          }
          function WorkspacePanel({ close, fileAction }) {
            const view = useAccount();
            React.useEffect(() => { void refresh(); }, []);
            return view.verified && !view.expired ? h(WorkspaceSection, { key: `${view.user.id}:${view.user.role}`, close, fileAction, AccountSection, identity: view.user, initialSnapshot: workspaceSnapshot }) : h('div', { style: { height: '100%', overflowY: 'auto', padding: 32 } }, h(AccountSection));
          }
          // Retain the native settings launcher identity. The workspace UI has
          // one separate sidebar entry; it does not add Settings sections.
          resources.push(ctx.slots.inject('settings.launcher', () => ctx.slots.register({ name: 'settings.launcher', locale: NS, priority: -1 }, IdentityLauncher)));
          if (typeof WorkspaceSection === 'function' && typeof installWorkspace === 'function') { workspaceWindow = installWorkspace(WorkspacePanel); resources.push(workspaceWindow); }
          else resources.push(ctx.slots.inject('settings.section', () => ctx.slots.register({ name: 'settings.section', id: 'workspace-account', order: -20, label: () => t('account'), locale: NS }, AccountSection)));
          void refresh();
          return cleanup;
        } catch (error) {
          try { cleanup(); } catch {}
          throw error;
        }
      });
    }
    return { inject: ['slots', 'locale'], apply, createMemberApi, accountFromSnapshot, syncSessionDirectories };
  },
});
