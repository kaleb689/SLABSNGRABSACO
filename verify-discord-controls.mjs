import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import {parseDropSkus, dropChannelKind, changeSkuItems, skuSelectionView, isNewDropPost} from './discord-community.js';
const source = await fs.readFile('discord-community.js', 'utf8');
const block = source.slice(source.indexOf('  const skuMenusFile ='), source.indexOf('  async function onQuestionMessage'));
const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'discord-controls-'));
const tonightChannelId = '1551070928039845921', upcoming = '1551070928039845922', owner = '1551070928039845923';
const messages = new Map(), changes = [];
let serial = 1551070928039846000n;
const post = (id, channel_id, content) => ({id, channel_id, content, type:0, author:{id:owner,bot:false}});
const nightPost = post('1551070928039845930', tonightChannelId, 'Pokemon Box\nSKU: 123456789');
const upPost = post('1551070928039845931', upcoming, 'Next Box\nSKU: 987654321');
const chatter = post('1551070928039845932', upcoming, 'Thanks everyone');
for (const p of [nightPost, upPost, chatter]) messages.set(p.id,p);
const histories = new Map([[upcoming,[chatter,upPost]], [tonightChannelId,[nightPost]]]);
async function api(route, method='GET', payload) {
  const match = /^\/channels\/([^/]+)\/messages(?:\/([^?]+))?/.exec(route);
  assert.ok(match, `Unexpected route ${route}`);
  const [,channel,id] = match;
  if (!id && method==='GET') return histories.get(channel) || [];
  if (!id && method==='POST') { const p={id:String(serial++),channel_id:channel,...payload};messages.set(p.id,p);changes.push(p);return p; }
  if (method==='DELETE') { messages.delete(id);return null; }
  const existing=messages.get(id);
  if (!existing) throw new Error('HTTP 404');
  if (method==='PATCH') { Object.assign(existing,payload);changes.push(existing); }
  return existing;
}
const deps={fs,path,crypto,dataDir,tonightChannelId,dropChannelIds:new Set([upcoming,tonightChannelId]),guildId:'guild',skuRequestsChannelId:'private',ownerId:owner,
  parseDropSkus,changeSkuItems,skuSelectionView,isNewDropPost,api,
  sendMessage:(channel,content,options)=>api(`/channels/${channel}/messages`,'POST',{content,...options}),
  mention:id=>`<@${id}>`,skuSafeText:v=>String(v||'').replace(/[\r\n<>*_`~|]/g,' ').trim(),
  skuItemToken:key=>crypto.createHash('sha256').update(key).digest('hex').slice(0,16),discordCommunityStatus:{}};
const make = new Function('deps', `const {${Object.keys(deps).join(',')}}=deps; ${block};return {ensureSkuControls,backfillDropMenus,skipTonight,recordSkuSelection,manageSkuSelection};`);
const controls=make(deps);
try {
  assert.equal(dropChannelKind('❗️│upcoming-drop'),'upcomingdrops');
  assert.equal(dropChannelKind('❗️│ｕｐｃｏｍｉｎｇ－ｄｒｏｐｓ'),'upcomingdrops');
  await controls.backfillDropMenus();
  let menus=JSON.parse(await fs.readFile(path.join(dataDir,'discord-sku-controls.json'),'utf8'));
  assert.ok(menus[upPost.id], 'Upcoming SKU post behind chatter must get controls');
  const rows=messages.get(menus[nightPost.id][0]).components;
  assert.ok(rows.at(-1).components.some(c=>c.label==="Don't run my profiles tonight"));
  assert.ok(rows.at(-1).components.some(c=>c.label==='My selected SKUs'));
  await controls.recordSkuSelection(owner,'member',nightPost.id,'all',2,tonightChannelId);
  await controls.recordSkuSelection(owner,'member',upPost.id,'all',1,upcoming);
  await controls.skipTonight(owner,'member',nightPost.id,tonightChannelId);
  let record=JSON.parse(await fs.readFile(path.join(dataDir,'discord-sku-selections.json'),'utf8'))[owner];
  assert.equal(record.items.length,1);assert.ok(record.items[0].key.startsWith(upcoming));
  assert.match(messages.get(record.messageId).content,/DO NOT RUN MY PROFILES TONIGHT/);
  await controls.recordSkuSelection(owner,'member',upPost.id,'all',2,upcoming);
  record=JSON.parse(await fs.readFile(path.join(dataDir,'discord-sku-selections.json'),'utf8'))[owner];
  assert.ok(record.skipTonightDate,'Upcoming selection preserves tonight opt-out');
  await controls.recordSkuSelection(owner,'member',nightPost.id,'all',1,tonightChannelId);
  record=JSON.parse(await fs.readFile(path.join(dataDir,'discord-sku-selections.json'),'utf8'))[owner];
  assert.equal(record.skipTonightDate,undefined);
  assert.doesNotMatch(messages.get(record.messageId).content,/DO NOT RUN/);
  nightPost.content=Array.from({length:16},(_,i)=>`Product ${i}\nSKU: ABC${i}`).join('\n');
  await controls.ensureSkuControls(nightPost);
  menus=JSON.parse(await fs.readFile(path.join(dataDir,'discord-sku-controls.json'),'utf8'));
  assert.equal(menus[nightPost.id].length,2);
  const oldPage=menus[nightPost.id][1];
  nightPost.content='Product\nSKU: ABC0';await controls.ensureSkuControls(nightPost);
  assert.equal(messages.has(oldPage),false,'Removed SKU pages must be deleted');
  nightPost.content='No products';await controls.ensureSkuControls(nightPost);
  menus=JSON.parse(await fs.readFile(path.join(dataDir,'discord-sku-controls.json'),'utf8'));
  assert.equal(menus[nightPost.id],undefined);
  console.log('PASS: channel aliases, existing Upcoming controls, tonight opt-out and reversal, owner notifications, preserved Upcoming selections, menu growth and stale-control cleanup');
} finally { await fs.rm(dataDir,{recursive:true,force:true}); }
