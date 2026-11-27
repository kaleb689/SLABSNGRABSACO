(()=>{"use strict";
  const original="/slabsngrabs-aco-logo-transparent.png";
  const seasonal="/slabsngrabs-aco-christmas-2026.png?v=2";
  const root=document.documentElement, originals=new Map();
  function active(){
    const p=Object.fromEntries(new Intl.DateTimeFormat("en-US",{timeZone:"America/New_York",year:"numeric",month:"2-digit",day:"2-digit"}).formatToParts(new Date()).map(x=>[x.type,x.value]));
    const d=p.year+"-"+p.month+"-"+p.day;return d>="2026-11-27"&&d<"2027-01-01";
  }
  let loading=false;
  let snow=null;
  function syncSnow(enabled){
    if(!enabled){snow?.remove();snow=null;return;}
    if(snow||!document.body)return;
    snow=document.createElement("div");
    snow.className="sng-holiday-snow";
    snow.setAttribute("aria-hidden","true");
    for(let i=0;i<34;i++){
      const flake=document.createElement("span");
      flake.className="sng-holiday-flake";
      flake.style.setProperty("--snow-x",((i*37.37+4)%100).toFixed(2)+"%");
      flake.style.setProperty("--snow-size",(2.5+(i%5)*.7)+"px");
      flake.style.setProperty("--snow-duration",(12+(i%11)*1.55)+"s");
      flake.style.setProperty("--snow-delay",(-((i*5.37)%24)).toFixed(2)+"s");
      flake.style.setProperty("--snow-drift",((i%2?1:-1)*(18+i%7*7))+"px");
      flake.style.setProperty("--snow-opacity",(.24+(i%4)*.09).toFixed(2));
      snow.append(flake);
    }
    document.body.append(snow);
  }
  function refresh(){
    const enabled=active();root.classList.toggle("christmas-theme",enabled);syncSnow(enabled);
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
