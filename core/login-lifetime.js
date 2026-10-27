/** Host-only, credential-free handles over exact authenticated session rows.
 * No callback executes when a source is denied. This is not an event bus. */
import {randomUUID} from 'node:crypto';
import {types} from 'node:util';
const deny=()=>{throw Error('Login lifetime unavailable.');};
const fields=['tokenHash','csrfHash','userId','credentialFingerprint','audience','createdAt','expiresAt'];
const same=(a,b)=>!!a&&!!b&&fields.every(key=>a[key]===b[key]);
export class LoginLifetime {
 #cap;#now;#cuts=new Map();#byId=new Map();#epoch={};#auth=new WeakMap();#observations=new Set();#closed=false;
 constructor({hostCapability,now}){if(hostCapability!==undefined&&(!hostCapability||typeof hostCapability!=='object'||types.isProxy(hostCapability)||Array.isArray(hostCapability)))throw TypeError('Login lifetime requires an opaque Host capability.');this.#cap=hostCapability;this.#now=now;}
 #settle(entry,state){if(entry.state!=='pending')return;entry.state=state;this.#observations.delete(entry);entry.cut.observers.delete(entry);clearTimeout(entry.timer);entry.resolve();}
 #retire(cut){if(cut.denied)return;cut.denied=true;if(this.#cuts.get(cut.row.tokenHash)===cut)this.#cuts.delete(cut.row.tokenHash);this.#byId.delete(cut.descriptor.loginId);for(const entry of [...cut.observers])this.#settle(entry,'denied');}
 #time(){let now;try{now=this.#now();}catch{this.fail();deny();}if(!Number.isSafeInteger(now)||now<0){this.fail();deny();}return now;}
 #assert(cut){if(this.#closed||cut.denied||this.#cuts.get(cut.row.tokenHash)!==cut)deny();if(this.#time()>=cut.row.expiresAt){this.#retire(cut);deny();}if(this.#closed||cut.denied||this.#cuts.get(cut.row.tokenHash)!==cut)deny();}
 #arm(entry){const delay=Math.min(2147483647,Math.max(1,entry.cut.row.expiresAt-this.#time()));if(entry.state!=='pending'||entry.cut.denied||this.#closed)deny();entry.timer=setTimeout(()=>{if(entry.state!=='pending')return;try{this.#assert(entry.cut);this.#arm(entry);}catch{this.#settle(entry,'denied');}},delay);entry.timer.unref?.();}
 #observe(cut){this.#assert(cut);if(this.#observations.size>=128)deny();let resolve;const entry={cut,state:'pending',resolve:undefined,timer:undefined},invalidated=Object.freeze(new Promise(done=>resolve=done));entry.resolve=resolve;this.#observations.add(entry);cut.observers.add(entry);try{this.#arm(entry);this.#assert(cut);if(entry.state!=='pending')deny();return Object.freeze({invalidated,get state(){return entry.state;},close:()=>this.#settle(entry,'closed')});}catch(error){this.#settle(entry,'closed');throw error;}}
 reconcile(rows){const current=new Map(rows.map(row=>[row.tokenHash,row]));for(const cut of [...this.#cuts.values()])if(!same(cut.row,current.get(cut.row.tokenHash)))this.#retire(cut);}
 stamp(){return this.#epoch;}
 record(auth,row,stamp){if(this.#closed||stamp!==this.#epoch)deny();if(!this.#cap)return;this.reconcileRow(row);let cut=this.#cuts.get(row.tokenHash);if(!cut){cut={row:Object.freeze(Object.fromEntries(fields.map(key=>[key,row[key]]))),denied:false,observers:new Set(),descriptor:undefined};cut.descriptor=Object.freeze({userId:row.userId,loginId:randomUUID(),assertCurrent:()=>this.#assert(cut),observe:()=>this.#observe(cut)});this.#cuts.set(row.tokenHash,cut);this.#byId.set(cut.descriptor.loginId,cut);}this.#assert(cut);if(stamp!==this.#epoch)deny();this.#auth.set(auth,cut);}
 reconcileRow(row){const cut=this.#cuts.get(row.tokenHash);if(cut&&!same(cut.row,row))this.#retire(cut);}
 capture(auth,cap){if(!this.#cap||cap!==this.#cap)deny();const cut=this.#auth.get(auth);if(!cut)deny();this.#assert(cut);return cut.descriptor;}
 denyToken(tokenHash){const cut=this.#cuts.get(tokenHash);if(cut)this.#retire(cut);}
 denyUser(userId){for(const cut of [...this.#cuts.values()])if(cut.row.userId===userId)this.#retire(cut);}
 resolve(principal,cap){if(!this.#cap||cap!==this.#cap||principal?.kind!=='lan-project-member')deny();const cut=this.#byId.get(principal.loginId);if(!cut||cut.row.userId!==principal.userId||cut.row.audience!=='member')deny();this.#assert(cut);return cut.descriptor;}
 /** Deny-only identity/retirement seal after an ordinary clock assertion. */
 seal(principal,cap){if(!this.#cap||cap!==this.#cap||principal?.kind!=='lan-project-member')deny();const cut=this.#byId.get(principal.loginId);if(!cut||cut.denied||this.#closed||this.#cuts.get(cut.row.tokenHash)!==cut||cut.row.userId!==principal.userId||cut.row.audience!=='member')deny();}
 fail(){this.#epoch={};for(const cut of [...this.#cuts.values()])this.#retire(cut);}
 close(){this.#closed=true;this.fail();}
}
