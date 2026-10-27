import { createHash } from 'node:crypto';

// The unauthenticated entry cannot load the owner shell, its CSS, or any owner
// credential. Keep this small document self-contained and hash-bound by CSP.
const styles = `
:root{color-scheme:light dark;--page:#fff;--text:#17191d;--muted:#6b6e75;--line:#e8e9ec;--soft:#f5f5f6;--button:#17191d;--on-button:#fff;--error:#b42318;font-family:Inter,-apple-system,BlinkMacSystemFont,"Segoe UI","Microsoft YaHei",sans-serif;font-size:14px;line-height:1.5;color:var(--text);background:var(--page)}
*{box-sizing:border-box}body{margin:0;min-width:280px}main{width:min(100% - 48px,400px);margin:clamp(48px,14vh,160px) auto 48px}a,button,input{font:inherit}button,input{border-radius:10px}button{cursor:pointer}button:disabled{cursor:wait;opacity:.55}button:focus-visible,input:focus-visible,summary:focus-visible{outline:2px solid var(--text);outline-offset:3px}header{display:flex;align-items:center;justify-content:space-between;gap:16px;margin-bottom:36px}.brand{font-size:16px;font-weight:650;letter-spacing:-.3px}.brand small{margin-left:7px;border-radius:4px;padding:2px 5px;font-size:10px;letter-spacing:.6px;background:var(--text);color:var(--page)}h1{font-size:24px;font-weight:550;line-height:32px;letter-spacing:-.5px;margin:0 0 8px}.intro{color:var(--muted);font-size:13px;margin:0 0 24px}.tabs{display:flex;gap:4px;padding:4px;border-radius:12px;background:var(--soft);margin-bottom:24px}.tabs button{flex:1;min-height:34px;border:1px solid transparent;background:transparent;color:var(--muted)}.tabs button[aria-selected=true]{background:var(--page);border-color:var(--line);color:var(--text)}fieldset{border:0;padding:0;margin:0;min-width:0;display:grid;gap:18px}.field{display:grid;gap:7px;font-size:13px}.field input{width:100%;height:42px;padding:0 12px;border:1px solid var(--line);background:var(--page);color:var(--text);font-size:14px}.field input:hover{border-color:var(--muted)}[hidden]{display:none!important}.invitation{display:grid;gap:18px}.remember{display:flex;align-items:center;gap:8px;color:var(--muted);font-size:13px}.remember input{width:16px;height:16px;margin:0;accent-color:var(--text)}.submit{height:42px;width:100%;margin-top:4px;border:0;background:var(--button);color:var(--on-button);font-weight:500}.status{min-height:20px;margin:16px 0 0;color:var(--error);font-size:13px;overflow-wrap:anywhere}.help{position:relative}.help summary{display:grid;place-items:center;width:28px;height:28px;border:0;border-radius:50%;color:var(--muted);cursor:pointer;list-style:none}.help summary::-webkit-details-marker{display:none}.help summary:hover{background:var(--soft);color:var(--text)}.help:not([open]) p{display:none}.help p{position:absolute;right:0;top:32px;z-index:1;width:min(300px,calc(100vw - 48px));margin:0;padding:14px 16px;border:1px solid var(--line);border-radius:12px;background:var(--page);color:var(--muted);font-size:13px;box-shadow:0 6px 24px #0000000d}.help svg{display:block}footer{margin-top:24px;text-align:center;color:var(--muted);font-size:12px}
.brand{display:flex;align-items:center;flex-wrap:wrap;gap:8px;min-width:0;font-size:18px}.brand img{width:28px;height:28px;object-fit:contain;flex:none}.brand-name{overflow-wrap:anywhere}.brand small{margin-left:0;white-space:nowrap;letter-spacing:0}
@media(prefers-color-scheme:dark){:root{--page:#191a1d;--text:#eeeef0;--muted:#a0a1a8;--line:#34353b;--soft:#25262a;--button:#eeeef0;--on-button:#191a1d;--error:#ff9b91}}
@media(max-width:480px){main{margin-top:48px}header{margin-bottom:28px}}
`;
const script = `(() => {
  const zh = !navigator.language || navigator.language.toLowerCase().startsWith('zh');
  const copy = zh ? {title:'登录多用户服务',intro:'管理员和成员使用同一入口，权限按账号授予。',login:'登录',redeem:'接受邀请',username:'用户名',password:'密码',remember:'保持登录（30 天）',inviteToken:'邀请令牌',displayName:'显示名',info:'入口说明',help:'使用服务账号登录。管理员身份由服务端授权决定，与访问地址、DSH 模型账号无关。',footer:'多用户服务',busy:'正在提交…',failed:'登录未完成，请检查账号和密码。'} : {title:'Service sign in',intro:'One entry for administrators and members. Permissions follow your service account.',login:'Sign in',redeem:'Accept invitation',username:'Username',password:'Password',remember:'Remember sign-in (30 days)',inviteToken:'Invitation token',displayName:'Display name',info:'About this entry',help:'Sign in with a service account. Administrator access follows server-side grants, not an address or model account.',footer:'Multi-user service',busy:'Submitting…',failed:'Sign-in failed. Check your username and password.'};
  document.documentElement.lang = zh ? 'zh-CN' : 'en';
  document.title = copy.title + ' · ' + (document.querySelector('[data-login-brand-name]')?.textContent || 'DeepSeek Harness');
  document.querySelectorAll('[data-copy]').forEach(node => { node.textContent = copy[node.dataset.copy]; });
  const form = document.querySelector('form'), fieldset = form.querySelector('fieldset'), submit = form.querySelector('.submit'), status = document.querySelector('.status'), invitation = document.querySelector('.invitation');
  const tabs = [...document.querySelectorAll('[data-mode]')], key = 'lan-workspace.member.username';
  document.querySelector('.help summary').setAttribute('aria-label',copy.info);
  let mode = 'login', pending = false;
  if (new URLSearchParams(location.search).get('passwordChanged') === '1') status.textContent = zh ? '密码已修改，请使用新密码登录。' : 'Password changed. Sign in with your new password.';
  if (new URLSearchParams(location.search).get('identityChanged') === '1') status.textContent = zh ? '账号身份已更新，请重新登录。' : 'Account identity changed. Sign in again.';
  if (location.pathname === '/') {
    void fetch('/lan/auth/session',{credentials:'same-origin',cache:'no-store'}).then(async response => {
      if (!response.ok) return;
      const value = await response.json();
      if (!pending && value?.ok === true && ['admin','member'].includes(value.result?.user?.role)) location.replace('/lan/');
    }).catch(() => {});
  }
  try { const name = localStorage.getItem(key); if (typeof name === 'string' && name.length <= 64) form.elements.username.value = name; } catch {}
  function rememberName() { try { if (form.elements.remember.checked) localStorage.setItem(key, form.elements.username.value.trim()); else localStorage.removeItem(key); } catch {} }
  form.elements.remember.addEventListener('change',rememberName);
  tabs.forEach(tab => tab.addEventListener('click',() => {
    if (pending) return;
    mode = tab.dataset.mode;
    tabs.forEach(item => { const selected = item === tab; item.setAttribute('aria-selected',String(selected)); item.tabIndex = selected ? 0 : -1; });
    invitation.hidden = mode !== 'redeem';
    invitation.querySelectorAll('input').forEach(input => { input.disabled = mode !== 'redeem'; input.required = mode === 'redeem'; });
    form.elements.password.autocomplete = mode === 'redeem' ? 'new-password' : 'current-password';
    form.elements.password.minLength = mode === 'redeem' ? 16 : 0;
    submit.textContent = copy[mode]; status.textContent = '';
  }));
  const invited = new URLSearchParams(location.hash.slice(1)).get('invite');
  if (/^[A-Za-z0-9_-]{43}$/.test(invited || '')) {
    tabs.find(tab => tab.dataset.mode === 'redeem')?.click();
    form.elements.inviteToken.value = invited;
    history.replaceState(null, '', location.pathname + location.search);
  }
  document.querySelector('[role=tablist]').addEventListener('keydown',event => {
    if (!['ArrowLeft','ArrowRight','Home','End'].includes(event.key) || pending) return;
    event.preventDefault(); const current = tabs.findIndex(tab => tab.getAttribute('aria-selected') === 'true');
    const index = event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1 : (current + (event.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length;
    tabs[index].click(); tabs[index].focus();
  });
  form.addEventListener('submit',async event => {
    event.preventDefault(); if (pending) return;
    const fields = {action:mode,username:form.elements.username.value.trim(),password:form.elements.password.value,remember:form.elements.remember.checked};
    if (mode === 'redeem') { fields.inviteToken = form.elements.inviteToken.value.trim(); fields.displayName = form.elements.displayName.value.trim(); }
    pending = true; status.textContent = ''; fieldset.disabled = true; tabs.forEach(tab=>{tab.disabled=true;}); submit.textContent = copy.busy; form.setAttribute('aria-busy','true');
    try {
      const response = await fetch('/lan/auth',{method:'POST',headers:{'Content-Type':'application/json'},credentials:'same-origin',body:JSON.stringify(fields)});
      const result = await response.json();
      if (!response.ok || result.ok !== true) throw new Error(result.error?.message || copy.failed);
      rememberName(); location.replace('/lan/');
    } catch (error) { status.textContent = error.message || copy.failed; status.focus(); }
    finally { pending = false; fieldset.disabled = false; tabs.forEach(tab=>{tab.disabled=false;}); submit.textContent = copy[mode]; form.setAttribute('aria-busy','false'); }
  });
})();`;
const digest = value => createHash('sha256').update(value).digest('base64');

export const LOGIN_CSP = `default-src 'none'; connect-src 'self'; img-src data: http: https:; script-src 'sha256-${digest(script)}'; style-src 'sha256-${digest(styles)}'; form-action 'self'; frame-ancestors 'self' http://127.0.0.1:* http://localhost:*; base-uri 'self'`;

const escapeHtml = value => String(value).replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
function loginBrand(branding) {
  const name = branding?.name ?? 'deepseek', badge = branding?.badge ?? 'HARNESS';
  return `<div class="brand">${branding?.logo ? `<img src="${escapeHtml(branding.logo)}" alt="" referrerpolicy="no-referrer">` : ''}<span class="brand-name" data-login-brand-name>${escapeHtml(name)}</span>${badge ? `<small>${escapeHtml(badge)}</small>` : ''}</div>`;
}

function baseLoginDocument() {
  return `<!doctype html><html lang="zh-CN"><head><base href="/lan/"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Service sign in · DeepSeek Harness</title><style>${styles}</style></head><body><main data-member-login><header><div class="brand">deepseek <small>HARNESS</small></div><details class="help"><summary aria-label="入口说明" title="入口说明"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M12 11v6M12 7h.01"/></svg></summary><p data-copy="help">使用服务账号登录。管理员身份由服务端授权决定，与访问地址、DSH 模型账号无关。</p></details></header><h1 data-copy="title">登录多用户服务</h1><p class="intro" data-copy="intro">管理员和成员使用同一入口，权限按账号授予。</p><div class="tabs" role="tablist" aria-label="登录方式"><button type="button" role="tab" id="member-login-tab" aria-controls="member-auth-form" data-mode="login" aria-selected="true" data-copy="login">登录</button><button type="button" role="tab" id="member-invite-tab" aria-controls="member-auth-form" data-mode="redeem" aria-selected="false" tabindex="-1" data-copy="redeem">接受邀请</button></div><form id="member-auth-form" method="post" action="/lan/auth" aria-busy="false"><fieldset><label class="field"><span data-copy="username">用户名</span><input name="username" autocomplete="username" required maxlength="64" autocapitalize="none" spellcheck="false"></label><label class="field"><span data-copy="password">密码</span><input name="password" type="password" autocomplete="current-password" required maxlength="1024"></label><div class="invitation" hidden><label class="field"><span data-copy="inviteToken">邀请令牌</span><input name="inviteToken" autocomplete="off" maxlength="256" disabled></label><label class="field"><span data-copy="displayName">显示名</span><input name="displayName" autocomplete="nickname" maxlength="120" disabled></label></div><label class="remember"><input type="checkbox" name="remember" checked><span data-copy="remember">保持登录（30 天）</span></label><button class="submit" type="submit" data-copy="login">登录</button></fieldset></form><p class="status" role="alert" aria-live="polite" tabindex="-1"></p><noscript><p>请启用 JavaScript 后登录 / Enable JavaScript to sign in.</p></noscript><footer data-copy="footer">多用户服务</footer></main><script>${script}</script></body></html>`;
}

export function memberLoginDocument({ branding } = {}) {
  const html = baseLoginDocument().replace('<div class="brand">deepseek <small>HARNESS</small></div>', loginBrand(branding));
  return html.replace('· DeepSeek Harness</title>', `· ${escapeHtml(branding?.name ?? 'DeepSeek Harness')}</title>`);
}
