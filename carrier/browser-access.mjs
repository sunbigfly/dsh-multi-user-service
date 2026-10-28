import { reject } from '../core/errors.js';

export async function performBrowserOperation(browser,...args){
  try{return await browser.perform(...args);}
  catch(error){
    if(error?.name==='BrowserError'&&/^[A-Z][A-Z0-9_]{1,79}$/.test(error.code??'')&&Number.isInteger(error.status)&&error.status>=400&&error.status<=599)reject(error.code,error.message,error.status);
    throw error;
  }
}

/** Optional account adapter. The independent browser plugin owns the runtime. */
export function browserAuthorization({ ownership, capabilities, core, plugin }) {
  const authorize = async (sessionId, identity = {}) => {
    const userId = identity.caller ? (await core.execute({ action: 'snapshot', section: 'base' }, identity.caller)).user.id : identity.agent ? capabilities.userOf(identity.agent) : undefined;
    const owner = ownership.ownerOf(sessionId);
    if (userId) {
      if (owner !== userId) reject('BROWSER_DENIED', '只能操作本人会话的浏览器。管理员预览不授予浏览器操作权。', 403);
      const policy = capabilities.policy(userId);
      if (!capabilities.sourceAllowed(policy, { plugin }) || !capabilities.toolAllowed(policy, 'workspace_browser', identity.agent)) reject('BROWSER_DENIED', '未获得浏览器使用权限。', 403);
      return userId;
    }
    if ((!identity.owner && !identity.agent) || owner) reject('BROWSER_DENIED', '浏览器需要有效的本人会话。', 403);
    return 'native-owner';
  };
  authorize.account = async (identity = {}) => {
    if (identity.owner) return 'native-owner';
    if (!identity.caller) reject('BROWSER_DENIED', '桌面连接需要有效的登录。', 403);
    const { user } = await core.execute({ action: 'snapshot', section: 'base' }, identity.caller);
    const policy = capabilities.policy(user.id);
    if (!capabilities.sourceAllowed(policy, { plugin }) || !capabilities.toolAllowed(policy, 'workspace_browser')) reject('BROWSER_DENIED', '未获得浏览器使用权限。', 403);
    return user.id;
  };
  return authorize;
}
