(()=>{"use strict";
  const original="/slabsngrabs-aco-logo-transparent.png";
  const seasonal="/slabsngrabs-aco-christmas-2026.png?v=1";
  const root=document.documentElement, originals=new Map();
  function active(){
    const p=Object.fromEntries(new Intl.DateTimeFormat("en-US",{timeZone:"America/New_York",year:"numeric",month:"2-digit",day:"2-digit"}).formatToParts(new Date()).map(x=>[x.type,x.value]));
    const d=p.year+"-"+p.month+"-"+p.day;return d>="2026-11-27"&&d<"2027-01-01";
  }
  let loading=false;
  function refresh(){
    const enabled=active();root.classList.toggle("christmas-theme",enabled);
    if(!enabled){for(const [node,old] of originals){node.setAttribute(old.attr,old.value)}originals.clear();return;}
    if(loading||originals.size)return;
    loading=true;const img=new Image();
    img.onload=()=>{loading=false;if(!active())return;
      const targets=[...document.querySelectorAll("img.brand-logo,img.home-reference-logo,.top .brand img,link[rel=icon],link[rel='shortcut icon']")];
      for(const node of targets){
        const attr=node.tagName==="LINK"?"href":"src",value=node.getAttribute(attr);
        if(value&&value.split("?")[0]===original){originals.set(node,{attr,value});node.setAttribute(attr,seasonal);}
      }
    };
    img.onerror=()=>{loading=false};img.src=seasonal;
  }
  refresh();setInterval(refresh,60000);
})();
