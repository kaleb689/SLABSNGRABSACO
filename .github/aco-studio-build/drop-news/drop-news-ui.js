(()=>{'use strict';
 const d=document,page=d.getElementById('dropNewsPage'),api=window.desktopAPI?.dropNews;if(!page)return;
 const status=page.querySelector('[data-news-status]'),content=page.querySelector('[data-news-content]'),refresh=page.querySelector('[data-news-refresh]'),filter=page.querySelector('[data-news-retailer]');let result=null,busy=false;
 const node=(tag,text,cls)=>{const n=d.createElement(tag);if(text)n.textContent=text;if(cls)n.className=cls;return n;};
 const date=value=>new Date(value).toLocaleString('en-US',{timeZone:'America/New_York',dateStyle:'medium',timeStyle:'short'})+' ET';
 function checks(parent,items){if(!items?.length)return;parent.append(node('h4','Recommended checks'));const ul=node('ul');for(const s of items)ul.append(node('li',s));parent.append(ul);}
 function article(item,rumor=false){const card=node('article',null,'dropNewsCard'+(rumor?' dropNewsRumor':''));
  card.append(node('span',rumor?'UNVERIFIED REPORT':({drop:'CONFIRMED DROP',rule_change:'RULE CHANGE',policy_baseline:'CURRENT POLICY · BASELINE',listing:'LISTING · DROP TIME UNCONFIRMED'}[item.kind]),'dropNewsBadge'),node('h3',item.title));
  for(const [label,value]of [['Product',item.productName],['SKU / product ID',item.sku],['Drop date / time',item.dropAt]])if(value)card.append(node('p',label+': '+value,'dropNewsMeta'));
  card.append(node('p',item.details));if(item.planningImpact){card.append(node('h4','Impact on drop planning'),node('p',item.planningImpact));}checks(card,item.checks);
  const sources=node('div',null,'dropNewsSources');for(const s of item.sources){const link=node('a',s.title||new URL(s.url).hostname);link.href=s.url;link.addEventListener('click',e=>{e.preventDefault();api?.openSource(s.url).catch(()=>{status.textContent='Source could not be opened. Try again when connected.';});});sources.append(link,node('small','Checked '+date(s.checkedAt)));}card.append(sources);return card;
 }
 function render(){content.replaceChildren();const feed=result?.feed;if(!feed){status.textContent=result?.error||'The first Drop News edition is not available yet.';return;}
  status.textContent='Published '+date(feed.publishedAt)+(result.stale?' · Weekly edition overdue; recheck sources before planning.':'')+(result.cached?' · Saved edition':'')+(result.error?' · '+result.error:'');
  content.append(node('p',feed.summary,'dropNewsSummary'));
  for(const r of feed.retailers){if(filter.value!=='all'&&filter.value!==r.id)continue;const section=node('section',null,'dropNewsRetailer');section.append(node('h2',r.name),node('p',r.coverage));for(const item of r.confirmed)section.append(article(item));if(!r.confirmed.length)section.append(node('p','No confirmed drop or rule change in this edition.'));checks(section,r.checks);content.append(section);}
  const rumors=feed.rumors.filter(r=>filter.value==='all'||filter.value===r.retailer);const section=node('section',null,'dropNewsRetailer');section.append(node('h2','Rumors & unverified reports'));if(!rumors.length)section.append(node('p','No unverified reports included in this edition.'));for(const item of rumors)section.append(article(item,true));content.append(section);
 }
 async function load(){if(busy||!api)return;busy=true;refresh.disabled=true;if(!result)status.textContent='Loading the latest edition…';try{result=await api.read();render();}catch{status.textContent='Drop News could not be loaded. Try again.';}finally{busy=false;refresh.disabled=false;}}
 filter.addEventListener('change',render);refresh.addEventListener('click',()=>void load());
 d.querySelectorAll('.appTabs button').forEach(b=>b.addEventListener('click',()=>{const active=b.dataset.tab==='drop-news';page.hidden=!active;if(active)void load();}));
 d.addEventListener('visibilitychange',()=>{if(!d.hidden&&!page.hidden)void load();});window.addEventListener('online',()=>{if(!page.hidden)void load();});setInterval(()=>{if(!d.hidden&&!page.hidden)void load();},300000);
 if(!api){refresh.disabled=true;status.textContent='Drop News is available in the installed ACO Studio app.';}
})();
