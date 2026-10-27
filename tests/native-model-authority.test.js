import { updateAccount } from './helpers/account-update.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import {LanService,MemoryStore} from '../core/service.js';
import {modelVariantId} from '../runtime/model-catalog.mjs';
const password='synthetic-native-model-authority';
const variants=[['think','low'],['think','high'],['plain',null]].map(([model,effort])=>({id:modelVariantId('configured',model,effort),label:model+' '+effort,provider:'configured',providerName:'Configured',model,modelName:model,reasoningEffort:effort,effortName:effort}));

test('personal capability changes retire only that account’s current model authority', async () => {
 const f=await fixture();try {
  const alice=f.authority.capture(f.logins.alice.principal),bob=f.core.memberModels(f.logins.bob.principal.userId,f.cap),cut=f.core.memberModels(f.logins.alice.principal.userId,f.cap);
  await f.core.execute({action:'preferences.update',expectedRevision:0,access:{terminal:false}},f.contexts.alice);
  assert.throws(alice.assertCurrent);assert.equal(cut.signal.aborted,true);assert.doesNotThrow(bob.assertCurrent);
  assert.equal(f.core.memberAccess(f.logins.alice.principal.userId,f.cap).terminal,false);
 }finally{await f.core.close();}
});
async function fixture(){
 const cap={},store=new MemoryStore(),core=new LanService({store,hostCapability:cap});await core.start();await core.setProviderKeys(['configured']);await core.setModelCatalog(variants);
 const owner=await core.execute({action:'bootstrap',username:'owner',displayName:'Owner',password},{ownerBootstrap:true,audience:'owner'}),admin={token:owner.token,csrf:owner.csrf,audience:'owner'};
 for(const username of ['alice','bob'])await core.execute({action:'admin.createUser',username,displayName:username,password,routeIds:[variants[username==='alice'?0:1].id],defaultRouteId:variants[username==='alice'?0:1].id},admin);
 const logins={},contexts={};for(const username of ['alice','bob']){const login=await core.execute({action:'login',username,password},{audience:'member'});logins[username]=await core.captureLogin(login.token,'member',cap);contexts[username]={token:login.token,csrf:login.csrf,audience:'member'};}
 return{core,store,cap,admin,logins,contexts,authority:core.modelAuthority(cap),update:(username,routeIds)=>updateAccount(core, { action: 'admin.updateUser',userId:logins[username].principal.userId,routeIds},admin)};
}

test('native model authority captures only exact login effective variants, never credentials or implicit grants',async()=>{
 const f=await fixture();try{assert.throws(()=>f.core.modelAuthority({}));assert.throws(()=>f.authority.capture({kind:'lan-project-member',userId:f.logins.alice.principal.userId,loginId:'forged'}));const a=f.authority.capture(f.logins.alice.principal),b=f.authority.capture(f.logins.bob.principal);assert.deepEqual(a.routes.map(row=>row.reasoningEffort),['low']);assert.deepEqual(b.routes.map(row=>row.reasoningEffort),['high']);assert.ok(Object.isFrozen(a.routes[0]));assert.doesNotMatch(JSON.stringify(a),/password|token|csrf|salt|Hash|invite/i);assert.equal(a.defaultRouteId,variants[0].id);await f.core.setModelCatalog([...variants,{...variants[2],id:modelVariantId('configured','new'),model:'new',modelName:'New'}]);assert.throws(a.assertCurrent);assert.equal(f.authority.capture(f.logins.alice.principal).routes.length,1);await f.core.setProviderKeys([]);assert.deepEqual(f.authority.capture(f.logins.alice.principal).routes,[]);}finally{await f.core.close();}
});

test('model grant cut retires before durable policy ACK and remains retired after failed update or grant ABA',async()=>{
 const f=await fixture();try{const cut=f.authority.capture(f.logins.alice.principal),save=f.store.save;let entered,release;const ready=new Promise(resolve=>entered=resolve),gate=new Promise(resolve=>release=resolve);f.store.save=async()=>{entered();await gate;throw Error('synthetic disk failure');};const pending=f.update('alice',[]),rejected=assert.rejects(pending,{code:'STORAGE_FAILURE'});await ready;assert.throws(cut.assertCurrent);assert.throws(cut.seal);assert.throws(()=>f.authority.capture(f.logins.alice.principal));release();await rejected;f.store.save=save;assert.throws(cut.assertCurrent);const fresh=f.authority.capture(f.logins.alice.principal);assert.equal(fresh.routes.length,1);await f.update('alice',[]);await f.update('alice',[variants[0].id]);assert.throws(fresh.assertCurrent);assert.equal(f.authority.capture(f.logins.alice.principal).routes.length,1);}finally{await f.core.close();}
});

test('model deny-only final seal cannot survive logout without a new clock callback',async()=>{
 const f=await fixture();try{const cut=f.authority.capture(f.logins.alice.principal);await f.core.execute({action:'logout'},f.contexts.alice);assert.throws(cut.seal);assert.throws(cut.assertCurrent);assert.equal(f.authority.capture(f.logins.bob.principal).routes.length,1);}finally{await f.core.close();}
});

test('native model cuts do not convert managed-catalog absence or disabled login into fallback',async()=>{
 const f=await fixture();try{const cut=f.authority.capture(f.logins.alice.principal);await updateAccount(f.core, { action: 'admin.updateUser',userId:f.logins.alice.principal.userId,disabled:true},f.admin);assert.throws(cut.assertCurrent);assert.throws(()=>f.authority.capture(f.logins.alice.principal));await f.core.setModelCatalog([]);assert.deepEqual(f.authority.capture(f.logins.bob.principal).routes,[]);}finally{await f.core.close();}
});

test('native login model authority shares inherited and exact grants with account authorization', async () => {
 const f = await fixture();
 try {
  const userId = f.logins.alice.principal.userId;
  await updateAccount(f.core, { action: 'admin.updateUser', userId, modelAccess: 'inherit', routeIds: [], defaultRouteId: null }, f.admin);
  const inherited = f.authority.capture(f.logins.alice.principal), account = f.core.memberModels(userId, f.cap);
  assert.deepEqual(inherited.routes, account.routes);
  assert.equal(inherited.routes.length, variants.length);
  assert.equal(inherited.defaultRouteId, account.defaultRouteId); account.close();
  const added = { ...variants[2], id: modelVariantId('configured', 'new'), model: 'new', modelName: 'New' };
  await f.core.setModelCatalog([...variants, added]);
  assert.throws(inherited.assertCurrent);
  assert.equal(f.authority.capture(f.logins.alice.principal).routes.length, variants.length + 1);
  await updateAccount(f.core, { action: 'admin.updateUser', userId, modelAccess: 'custom', routeIds: [variants[1].id], defaultRouteId: variants[1].id }, f.admin);
  assert.deepEqual(f.authority.capture(f.logins.alice.principal).routes.map(route => route.reasoningEffort), ['high']);
  await updateAccount(f.core, { action: 'admin.updateUser', userId, modelAccess: 'custom', routeIds: [], defaultRouteId: null }, f.admin);
  assert.deepEqual(f.authority.capture(f.logins.alice.principal).routes, []);
 } finally { await f.core.close(); }
});
