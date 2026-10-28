import test from 'node:test';
import assert from 'node:assert/strict';
import { browserAuthorization, performBrowserOperation } from '../carrier/browser-access.mjs';

test('browser capacity and startup errors retain their public status and message at the member boundary',async()=>{
  for(const [code,message,status]of [['BROWSER_BUSY','远程浏览器名额已满',429],['REMOTE_BROWSER_START_FAILED','远程浏览器启动失败',503]]){
    const browser={perform:async()=>{throw Object.assign(new Error(message),{name:'BrowserError',code,status});}};
    await assert.rejects(performBrowserOperation(browser,'owned',{operation:'remote-connect'},{caller:{}}),{name:'LanError',code,message,status});
  }
  const internal=new Error('private internal details');
  await assert.rejects(performBrowserOperation({perform:async()=>{throw internal;}}),error=>error===internal);
});

test('manual access, AI tools and administrator previews share the same ownership and grant boundary', async () => {
  let allowed = true, enabled = true;
  const authorize = browserAuthorization({plugin:'dsh-browser',ownership:{ownerOf:id=>({a:'alice',b:'bob'}[id])},capabilities:{userOf:agent=>agent.userId,policy:()=>{if(!enabled)throw Error('disabled');return{};},sourceAllowed:(_policy,source)=>allowed && source.plugin==='dsh-browser',toolAllowed:()=>allowed},core:{execute:async(_request,caller)=>({user:{id:caller.userId}})}});
  assert.equal(await authorize('a',{caller:{userId:'alice'}}),'alice');
  assert.equal(await authorize('a',{agent:{userId:'alice'}}),'alice');
  await assert.rejects(authorize('b',{caller:{userId:'alice',role:'admin'}}),{status:403});
  await assert.rejects(authorize('native',{caller:{userId:'alice'}}),{status:403});
  await assert.rejects(authorize('b',{agent:{}}),{status:403});
  assert.equal(await authorize('native',{agent:{}}),'native-owner');
  assert.equal(await authorize('native',{owner:true}),'native-owner');
  assert.equal(await authorize.account({caller:{userId:'alice'}}),'alice');
  assert.equal(await authorize.account({owner:true}),'native-owner');
  await assert.rejects(authorize.account({agent:{userId:'alice'}}),{status:403});
  await assert.rejects(authorize('a',{owner:true}),{status:403});
  allowed=false;await assert.rejects(authorize('a',{agent:{userId:'alice'}}),{status:403});
  await assert.rejects(authorize.account({caller:{userId:'alice'}}),{status:403});
  allowed=true;enabled=false;await assert.rejects(authorize('a',{caller:{userId:'alice'}}),/disabled/);
});
