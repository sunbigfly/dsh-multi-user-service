/** Host-only account infrastructure shared by early partition bootstrap and the
 * late existing-listener carrier. No business graph, model, tool or route deps.
 * Opaque handles are private-WeakMap branded; no shape/cwd/absent identity grant.
 * The opener alone owns close. Borrowers must pin/assert and never close it. */
import{LanService}from'../core/service.js';
import{PersistentSessions}from'../core/remember-sessions.js';
import{DOMAIN_SPEC,SESSION_DOMAIN_SPEC,DomainStore}from'../domain-store.js';
const runtimes=new WeakMap(),owners=new WeakMap();
const denied=()=>{throw Error('LAN account runtime unavailable.');};
function assert(row){
 if(row.checking){row.invalid=true;denied();}if(!row.live||row.closed||row.invalid)denied();row.checking=true;
 try{row.lifetime();if(!row.live||row.closed||row.invalid)denied();}catch(error){row.invalid=true;throw error;}finally{row.checking=false;}
}
function close(row){
 if(row.closing)return row.closing;row.live=false;row.closed=true;
 return row.closing=Promise.resolve().then(async()=>{const failures=[];
  // Each close owns its errors; a rejected core close must not skip releasing
  // either domain. Keep the same rejected drain receipt after uncertain cleanup.
  for(const work of[()=>row.core?.close(),()=>row.sessions?.close(),()=>row.sessionDomain?.close(),()=>row.domain?.close()])try{await work();}catch(error){failures.push(error);}
  if(failures.length)throw new AggregateError(failures,'LAN account runtime cleanup failed');
  if(owners.get(row.storage)===row)owners.delete(row.storage);
 });
}
export async function openLanAccountRuntime({storageDomain,assertCurrent}){
 if(!storageDomain||typeof storageDomain.open!=='function'||typeof assertCurrent!=='function'||owners.has(storageDomain))denied();
 const row={storage:storageDomain,lifetime:assertCurrent,live:true,closed:false,invalid:false,checking:false,domain:undefined,sessionDomain:undefined,sessions:undefined,core:undefined,closing:undefined};owners.set(storageDomain,row);
 try{
  assert(row);row.domain=await storageDomain.open(DOMAIN_SPEC);assert(row);const store=new DomainStore(row.domain);
  row.sessionDomain=await storageDomain.open(SESSION_DOMAIN_SPEC);assert(row);
  const runtimeIdentity=Object.freeze({}),hostCapability=Object.freeze({});row.sessions=new PersistentSessions({store:new DomainStore(row.sessionDomain),hostCapability});
  row.core=new LanService({store,runtime:runtimeIdentity,sessions:row.sessions,hostCapability});await row.core.start();assert(row);
  const handle=Object.freeze({});row.view=Object.freeze({core:row.core,coreStore:store,runtimeIdentity,hostCapability,assertCurrent:()=>assert(row),assertStorage:storage=>{assert(row);if(storage!==row.storage)denied();}});runtimes.set(handle,row);return handle;
 }catch(error){try{await close(row);}catch(cleanup){throw new AggregateError([error,cleanup],'LAN account runtime startup and cleanup failed');}throw error;}
}
export function inspectLanAccountRuntime(handle){const row=handle&&runtimes.get(handle);if(!row)denied();assert(row);return row.view;}
export function closeLanAccountRuntime(handle){const row=handle&&runtimes.get(handle);if(!row)denied();return close(row);}
