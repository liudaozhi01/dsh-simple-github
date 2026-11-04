const ID = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/;
const SHA = /^[a-f0-9]{40}$/;
const IMAGE = /^[a-z0-9][a-z0-9./:_-]*@sha256:[a-fA-F0-9]{64}$/;
function plain(value, keys) {
  if (!value || ![Object.prototype, null].includes(Object.getPrototypeOf(value)) || Reflect.ownKeys(value).some(k => !keys.includes(k) || !Object.hasOwn(Object.getOwnPropertyDescriptor(value,k),'value'))) throw new TypeError('Explicit trusted snapshot fields required.');
}
function match(pattern,value,max=512){return typeof value==='string'&&value.length<=max&&!/[\s\x00-\x1f\x7f]/.test(value)&&pattern.test(value);}
/** Read-only reconciliation protocol. query must be a trusted server capability
 * that reads authoritative durable markers and current runtime health, not HTTP input.
 * This module never applies, retries, accepts a release, or mutates executor state.
 * A successful health sample is not database readiness or business acceptance.
 */
export function createDockerReconciler({query,now=Date.now}={}) {
 if(typeof query!=='function'||typeof now!=='function')throw new TypeError('Trusted read-only query required.');
 async function reconcile(input){
  plain(input,['jobId','environment','head','backendImage','frontendImage']);
  if(!match(ID,input.jobId,128)||!['dev','test'].includes(input.environment)||!match(SHA,input.head,40)||!match(IMAGE,input.backendImage)||!match(IMAGE,input.frontendImage))throw new TypeError('Complete trusted job identity and immutable images required.');
  const expected=Object.freeze({...input});
  const uncertain=reason=>({jobId:expected.jobId,environment:expected.environment,status:'uncertain',delivered:false,reason,retryAllowed:false});
  let result;
  try{result=await query(expected);}catch{return uncertain('QUERY_FAILED');}
  try{
   plain(result,['schema','jobId','environment','head','backendImage','frontendImage','phase','backendHealthy','frontendHealthy','observedAt']);
   const time=now();
   if(result.schema!==1||!Number.isSafeInteger(result.observedAt)||!Number.isSafeInteger(time)||result.observedAt<0||result.observedAt>time||time-result.observedAt>30000)return uncertain('INVALID_EVIDENCE');
   for(const k of ['jobId','environment','head','backendImage','frontendImage'])if(result[k]!==expected[k])return uncertain('IDENTITY_MISMATCH');
   if(!['applied','failed','pending','absent'].includes(result.phase))return uncertain('INVALID_EVIDENCE');
   // Missing marker and explicit remote failure never authorize a retry: a start
   // could have occurred before the marker was persisted or response was lost.
   if(result.phase!=='applied')return uncertain('REMOTE_'+result.phase.toUpperCase());
   if(result.backendHealthy!==true||result.frontendHealthy!==true)return uncertain('HEALTH_UNCONFIRMED');
   return {jobId:expected.jobId,environment:expected.environment,status:'delivered',delivered:true,healthy:true,head:expected.head,backendImage:expected.backendImage,frontendImage:expected.frontendImage,observedAt:result.observedAt,accepted:false,retryAllowed:false};
  }catch{return uncertain('INVALID_EVIDENCE');}
 }
 return Object.freeze({reconcile});
}
