// Keep every existing supported Admin tool available inside the installed app.
// The isolated, authenticated website view uses the existing bridge/session;
// no customer data or API credentials enter a second database or local vault.
(()=>{'use strict';
 const d=document,api=window.desktopAPI?.site,root=d.getElementById('sitePage'),bar=d.getElementById('acoNativeSections');if(!api?.open||!api?.bounds||!root||!bar)return;
 const button=d.createElement('button');button.type='button';button.className='btn secondary';button.textContent='All Admin tools';button.id='acoFullAdmin';bar.append(button);
 const frame=d.createElement('section');frame.hidden=true;frame.className='panel';frame.style.cssText='position:relative;margin-top:12px';
 const toolbar=d.createElement('div'),back=d.createElement('button'),status=d.createElement('p'),host=d.createElement('div');back.type='button';back.className='btn secondary';back.textContent='Back to Studio panels';toolbar.append(back);status.setAttribute('role','status');status.textContent='The existing website Admin workspace opens here using your secure Admin session. All changes use the same live records.';host.style.cssText='height:calc(100vh - 220px);min-height:400px;width:100%;';frame.append(toolbar,status,host);root.append(frame);
 let opened=false;
 function bounds(){if(!opened||frame.hidden||root.hidden)return;const r=host.getBoundingClientRect();void api.bounds({x:Math.max(0,Math.round(r.x)),y:Math.max(0,Math.round(r.y)),width:Math.max(1,Math.round(r.width)),height:Math.max(1,Math.round(r.height))});}
 async function close(){if(!opened)return;opened=false;frame.hidden=true;await api.hide();}
 button.onclick=async()=>{try{frame.hidden=false;opened=true;await api.open();bounds();status.textContent='All Admin tools use the website’s authoritative records. Studio’s native panels remain available above.';}catch(error){opened=false;frame.hidden=true;status.textContent='Unable to open the Admin workspace: '+String(error.message||error);}};
 back.onclick=()=>void close();
 for(const node of [...bar.querySelectorAll('button'),...d.querySelectorAll('.appTabs button')])if(node!==button)node.addEventListener('click',()=>void close());
 window.addEventListener('resize',bounds);window.addEventListener('scroll',bounds,{passive:true});new ResizeObserver(bounds).observe(host);
})();
