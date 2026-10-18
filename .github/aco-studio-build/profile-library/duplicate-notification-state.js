'use strict';
// Only opaque conflict hashes and lifecycle metadata persist here. Profile data,
// email, PAN, customer names and Personal content never enter this ledger.
(function(root){
 function createLedger({load=()=>({}),save=()=>{},now=()=>new Date().toISOString()}={}){
  const raw=load();let records=raw&&raw.version===1&&raw.records&&typeof raw.records==='object'?raw.records:{};
  const valid=v=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v);
  function persist(){save({version:1,records});}
  function observe(conflicts){const active=new Set();let changed=false;for(const c of conflicts){if(!valid(c.conflictId)||!valid(c.signature))continue;active.add(c.conflictId);const old=records[c.conflictId];if(!old||old.signature!==c.signature){records[c.conflictId]={id:c.conflictId,signature:c.signature,at:now(),dismissed:false,cleared:false,kept:false,resolved:false};changed=true;}else if(old.resolved){old.resolved=false;changed=true;}}
   for(const [id,r]of Object.entries(records))if(!active.has(id)&&!r.resolved){r.resolved=true;changed=true;}if(changed)persist();
   return conflicts.filter(c=>!records[c.conflictId]?.kept);
  }
  function action(id,kind){const r=records[id];if(!r)return;if(kind==='dismiss')r.dismissed=true;else if(kind==='keep'){r.kept=true;r.dismissed=true;}else if(kind==='clear'){r.cleared=true;r.dismissed=true;}else if(kind==='reopen'){r.kept=false;r.cleared=false;}else throw Error('Unknown notification action');persist();}
  function history(){return Object.values(records).filter(r=>!r.cleared).map(r=>({...r})).sort((a,b)=>b.at.localeCompare(a.at));}
  function clearAll(){for(const r of Object.values(records)){r.cleared=true;r.dismissed=true;}persist();}
  return {observe,action,history,clearAll};
 }
 if(typeof module==='object'&&module.exports)module.exports={createLedger};else root.ACODuplicateNotifications={createLedger};
})(typeof window==='object'?window:globalThis);
