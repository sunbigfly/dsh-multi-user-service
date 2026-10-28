import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,readFile,realpath,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import { CliManagement } from '../carrier/cli-management.mjs';
import { LanService, MemoryStore } from '../core/service.js';

const password = 'synthetic-cli-manager-password';
const caller = session => ({token:session.token,csrf:session.csrf,audience:'owner'});
async function fixture(t) {
  const core=new LanService({store:new MemoryStore()}); await core.start(); t.after(()=>core.close());
  const admin=await core.execute({action:'bootstrap',username:'admin',displayName:'Admin',password},{ownerBootstrap:true,audience:'owner'});
  await core.execute({action:'admin.createUser',username:'member',displayName:'Member',password,routeIds:[]},caller(admin));
  const member=await core.execute({action:'login',username:'member',password},{audience:'owner'});
  const entry={options:{id:'member-cli-tools',name:'@sunbigfly/dsh-multi-user-service/cli-tools',config:{tools:[],other:'preserved'}}};
  const other={options:{id:'unrelated',name:'unrelated',config:{private:true}}};
  let writes=0,resets=0;
  const editor={entries:()=>[entry,other],edit:async(target,change)=>{
    assert.equal(target,entry); const next=change(structuredClone(target.options.config));
    entry.options.config=next;writes++;
  }};
  const manager=new CliManagement({core,editor,onChanged:async()=>{resets++;}});
  const read=()=>manager.execute({action:'admin.cliTools',operation:'read'},caller(admin));
  const save=async(tools,revision)=>manager.execute({action:'admin.cliTools',operation:'save',expectedRevision:revision ?? (await read()).revision,tools},caller(admin));
  return {core,admin,member,entry,other,editor,manager,read,save,counts:()=>({writes,resets})};
}
const tool={id:'qa-cli',label:'QA CLI',command:'/usr/bin/printf',args:['%s'],credentials:{SYNTHETIC_KEY:'credential-reference'}};

test('CLI configuration requires an authenticated administrator and CSRF, including reads',async t=>{
  const f=await fixture(t),request={action:'admin.cliTools',operation:'read'};
  await assert.rejects(f.manager.execute(request,{}),{code:'UNAUTHENTICATED'});
  await assert.rejects(f.manager.execute(request,caller(f.member)),{code:'FORBIDDEN'});
  await assert.rejects(f.manager.execute(request,{...caller(f.admin),csrf:'bad'}),{code:'CSRF_INVALID'});
  assert.deepEqual((await f.read()).tools,[]); assert.deepEqual(f.counts(),{writes:0,resets:0});
});

test('a specified CLI is identified from its path without executing or saving it',async t=>{
  const f=await fixture(t),root=await mkdtemp(join(tmpdir(),'dsh-cli-target-'));
  t.after(()=>rm(root,{recursive:true,force:true}));
  const program=join(root,'selected-tool'),marker=join(root,'must-not-run');
  await writeFile(program,'#!/bin/sh\ntouch "'+marker+'"\n',{mode:0o755});
  const before=await f.read();
  const result=await f.manager.execute({action:'admin.cliTools',operation:'inspect',target:program},caller(f.admin));
  assert.equal(result.tool.id,'selected-tool');assert.equal(result.tool.command,await realpath(program));
  assert.ok(result.tool.readOnlyPaths.includes(await realpath('/bin/sh')));
  assert.deepEqual(result.tool.args,[]);assert.deepEqual(result.tool.credentials,{});assert.deepEqual(result.tool.environment,{});
  await assert.rejects(readFile(marker),{code:'ENOENT'});
  assert.deepEqual(await f.read(),before);assert.deepEqual(f.counts(),{writes:0,resets:0});
});

test('a specified PATH command resolves without interpreting arguments or accepting missing programs',async t=>{
  const f=await fixture(t);
  const result=await f.manager.execute({action:'admin.cliTools',operation:'inspect',target:'printf'},caller(f.admin));
  assert.equal(result.tool.command,await realpath('/usr/bin/printf'));
  assert.equal(result.tool.id,'printf');
  for(const target of ['printf --version','$(touch marker)','./printf'])await assert.rejects(f.manager.execute({action:'admin.cliTools',operation:'inspect',target},caller(f.admin)),{code:'INVALID_INPUT'});
  await assert.rejects(f.manager.execute({action:'admin.cliTools',operation:'inspect',target:'/missing/specified-tool'},caller(f.admin)),{code:'CLI_NOT_FOUND'});
  assert.deepEqual(f.counts(),{writes:0,resets:0});
});

test('specified tool identification is administrator-only, requires CSRF and rejects injected configuration',async t=>{
  const f=await fixture(t),request={action:'admin.cliTools',operation:'inspect',target:'printf'};
  await assert.rejects(f.manager.execute(request,caller(f.member)),{code:'FORBIDDEN'});
  await assert.rejects(f.manager.execute(request,{...caller(f.admin),csrf:'bad'}),{code:'CSRF_INVALID'});
  await assert.rejects(f.manager.execute({...request,tools:[]},caller(f.admin)),{code:'INVALID_INPUT'});
  assert.deepEqual(f.counts(),{writes:0,resets:0});
});

test('CLI saves preserve native config and disabled rows; unchanged saves do not reset resources',async t=>{
  const f=await fixture(t),before=await f.read();
  const saved=await f.save([tool,{...tool,id:'disabled',enabled:false,command:'/not-installed/cli'}]);
  assert.equal(saved.changed,true);assert.notEqual(saved.revision,before.revision);
  assert.equal(f.entry.options.config.other,'preserved');assert.deepEqual(f.other.options.config,{private:true});
  assert.equal(saved.tools[1].enabled,false);assert.equal(saved.tools[0].credentials.SYNTHETIC_KEY,'credential-reference');
  assert.deepEqual(f.counts(),{writes:1,resets:1});
  assert.equal((await f.save(saved.tools,saved.revision)).changed,false);assert.deepEqual(f.counts(),{writes:1,resets:1});
});

test('invalid CLI programs, broad dependencies and injected fields cannot replace valid configuration',async t=>{
  const f=await fixture(t);await f.save([tool]);const saved=await f.read();
  for(const tools of [[{...tool,command:'/not-installed/cli'}],[{...tool,readOnlyPaths:['/']}],[{...tool,environment:{HOME:'/tmp'}}],[tool,tool],[{...tool,extra:true}]]){
    await assert.rejects(f.save(tools,saved.revision));assert.deepEqual(await f.read(),saved);
  }
  assert.deepEqual(f.counts(),{writes:1,resets:1});
});

test('CLI stale revisions and native lock-time races cannot overwrite newer settings',async t=>{
  const f=await fixture(t),stale=await f.read();await f.save([tool]);
  await assert.rejects(f.save([],stale.revision),{code:'CLI_CONFLICT'});
  const saved=await f.read(),edit=f.editor.edit;
  f.editor.edit=async(entry,change)=>{entry.options.config.external=true;await edit(entry,change);};
  await assert.rejects(f.save([],saved.revision),{code:'CLI_CONFLICT'});
  assert.equal(f.entry.options.config.tools.length,1);assert.equal(f.entry.options.config.external,true);
  assert.deepEqual(f.counts(),{writes:1,resets:1});
});

test('CLI management refuses arbitrary or ambiguous native plugin entries',async t=>{
  const f=await fixture(t);
  f.entry.options.name='other-package';await assert.rejects(f.read(),{code:'CLI_UNAVAILABLE'});
  f.entry.options.name='@sunbigfly/dsh-multi-user-service/cli-tools';
  f.editor.entries=()=>[f.entry,structuredClone(f.entry)];await assert.rejects(f.read(),{code:'CLI_UNAVAILABLE'});
});

test('native save failure keeps CLI settings and never resets resources',async t=>{
  const f=await fixture(t),before=await f.read();f.editor.edit=async()=>{throw new Error('native write failed');};
  await assert.rejects(f.save([tool]),{code:'CLI_SAVE_FAILED'});assert.deepEqual(await f.read(),before);
  assert.deepEqual(f.counts(),{writes:0,resets:0});
});

test('resource reset errors report that the native CLI configuration was already saved',async t=>{
  const f=await fixture(t);f.manager.onChanged=async()=>{throw new Error('reset failed');};
  await assert.rejects(f.save([tool]),{code:'CLI_RESET_FAILED'});assert.equal((await f.read()).tools[0].id,tool.id);
});

test('execution whitelist saves preserve manual CLI configuration and scan remains administrator-only',async t=>{
  const f=await fixture(t);await f.save([tool]);const before=await f.read();
  const executionTools={version:1,sources:[{id:'unavailable',kind:'tool-runner',root:'/not-installed/runner',command:'/not-installed/runner/bin/runner'}],grants:[]};
  await f.manager.execute({action:'admin.cliTools',operation:'save',expectedRevision:before.revision,executionTools},caller(f.admin));
  const after=await f.read();assert.deepEqual(after.tools,before.tools);assert.deepEqual(after.executionTools,executionTools);assert.equal(f.entry.options.config.other,'preserved');
  const scan=await f.manager.execute({action:'admin.cliTools',operation:'scan'},caller(f.admin));assert.equal(scan.errors.length,1);assert.deepEqual(scan.tools,[]);
  await assert.rejects(f.manager.execute({action:'admin.cliTools',operation:'scan'},caller(f.member)),{code:'FORBIDDEN'});
  await assert.rejects(f.manager.execute({action:'admin.cliTools',operation:'scan'},{...caller(f.admin),csrf:'bad'}),{code:'CSRF_INVALID'});
});

test('generic UTF-8 configuration limits keep exported configurations within the existing HTTP facade bound',async t=>{
  const f=await fixture(t),before=await f.read();
  const tools=Array.from({length:12},(_,index)=>({...tool,id:'large-'+index,args:['汉'.repeat(4096)]}));
  await assert.rejects(f.save(tools),{code:'CLI_CONFIG_TOO_LARGE'});assert.deepEqual(await f.read(),before);assert.deepEqual(f.counts(),{writes:0,resets:0});
});
