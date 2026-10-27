import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import {parseDropSkus, dropChannelKind, changeSkuItems, skuSelectionView, skuOwnerDetails, uniformSkuQuantity, setGlobalSkuQuantity, isNewDropPost, skuControlPayload, isSelectableSkuSource} from './discord-community.js';
import {skuReminderOwnerPanel} from './sku-reminders.js';
import {createDropMessageRetention} from './discord-drop-retention.js';
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
  if (!id && method==='GET' && channel==='1551070928039845960') throw new Error('HTTP 403');
  if (!id && method==='GET') return histories.get(channel) || [];
  if (!id && method==='POST') { const p={id:String(serial++),channel_id:channel,...payload};messages.set(p.id,p);changes.push(p);return p; }
  if (method==='DELETE') { messages.delete(id);return null; }
  const existing=messages.get(id);
  if (!existing) throw new Error('HTTP 404');
  if (method==='PATCH') { Object.assign(existing,payload);changes.push(existing); }
  return existing;
}
const deps={fs,path,crypto,dataDir,tonightChannelId,upcomingChannelId:upcoming,retailerDropLabels:{},dropChannelIds:new Set([upcoming,tonightChannelId]),guildId:'guild',skuRequestsChannelId:'private',ownerId:owner,appId:'1551070928039845900',
  parseDropSkus,isSelectableSkuSource,changeSkuItems,skuSelectionView,skuOwnerDetails,uniformSkuQuantity,setGlobalSkuQuantity,isNewDropPost,skuControlPayload,api,
  sendMessage:(channel,content,options)=>api(`/channels/${channel}/messages`,'POST',{content,...options}),
  mention:id=>`<@${id}>`,skuSafeText:v=>String(v||'').replace(/[\r\n<>*_`~|]/g,' ').trim(),
  skuItemToken:key=>crypto.createHash('sha256').update(key).digest('hex').slice(0,16),skuReminderOwnerPanel,createDropMessageRetention,discordCommunityStatus:{}};
const make = new Function('deps', `const {${Object.keys(deps).join(',')}}=deps; ${block};return {ensureSkuControls,backfillDropMenus,skipDrop,recordSkuSelection,manageSkuSelection,mutateSkuDraft,confirmSkuDraft};`);
const controls=make(deps);
try {
  assert.equal(dropChannelKind('❗️│upcoming-drop'),'upcomingdrops');
  assert.equal(dropChannelKind('❗️│ｕｐｃｏｍｉｎｇ－ｄｒｏｐｓ'),'upcomingdrops');
  await controls.backfillDropMenus();
  let menus=JSON.parse(await fs.readFile(path.join(dataDir,'discord-sku-controls.json'),'utf8'));
  assert.ok(menus[upPost.id], 'Upcoming SKU post behind chatter must get controls');
  const privateReminders = [...messages.values()].filter(p => p.channel_id === 'private' &&
    p.components?.some(row => row.components.some(button => button.custom_id?.startsWith('sku:remind:'))));
  assert.equal(privateReminders.length, 2, 'The owner gets a private bell for each existing SKU-bearing original post');
  assert.ok(privateReminders.every(p => p.components[0].components[0].emoji?.name === '🔔'));
  assert.ok(menus[chatter.id], 'Upcoming opt-out must work without SKUs');
  const upcomingRows=messages.get(menus[chatter.id][0]).components;
  assert.ok(upcomingRows.at(-1).components.some(c=>c.label==="Don't run my profiles for this upcoming drop"));
  assert.ok(!upcomingRows.at(-1).components.some(c=>c.label==='Run all SKUs'));
  const rows=messages.get(menus[nightPost.id][0]).components;
  assert.ok(rows.at(-1).components.some(c=>c.label==="Don't run my profiles tonight"));
  assert.ok(rows.some(row=>row.components.some(c=>c.label==='My selected SKUs')));
  await controls.recordSkuSelection(owner,'member',nightPost.id,'all',2,tonightChannelId);
  await controls.recordSkuSelection(owner,'member',upPost.id,'all',1,upcoming);
  await controls.skipDrop(owner,'member',nightPost.id,tonightChannelId);
  let record=JSON.parse(await fs.readFile(path.join(dataDir,'discord-sku-selections.json'),'utf8'))[owner];
  assert.equal(record.items.length,1);assert.ok(record.items[0].key.startsWith(upcoming));
  assert.match(messages.get(record.messageId).content,/DO NOT RUN MY PROFILES TONIGHT/);
  await controls.recordSkuSelection(owner,'member',upPost.id,'all',2,upcoming);
  record=JSON.parse(await fs.readFile(path.join(dataDir,'discord-sku-selections.json'),'utf8'))[owner];
  assert.ok(record.skipTonightDate,'Upcoming selection preserves tonight opt-out');
  assert.ok(record.items.every(item=>item.quantity===2),'One quantity applies to all currently selected SKUs');
  await controls.recordSkuSelection(owner,'member',nightPost.id,'all',1,tonightChannelId);
  record=JSON.parse(await fs.readFile(path.join(dataDir,'discord-sku-selections.json'),'utf8'))[owner];
  assert.equal(record.skipTonightDate,undefined);
  assert.doesNotMatch(messages.get(record.messageId).content,/DO NOT RUN/);
  const otherUp=post('1551070928039845940',upcoming,'Another drop\nSKU: OTHER123');
  messages.set(otherUp.id,otherUp);
  await controls.recordSkuSelection(owner,'member',otherUp.id,'all',1,upcoming);
  await controls.skipDrop(owner,'member',upPost.id,upcoming);
  record=JSON.parse(await fs.readFile(path.join(dataDir,'discord-sku-selections.json'),'utf8'))[owner];
  assert.equal(record.items.length,2,'Upcoming opt-out preserves tonight and other upcoming drops');
  assert.ok(!record.items.some(item=>item.key.startsWith(`${upcoming}:${upPost.id}:`)));
  assert.deepEqual(record.skippedUpcomingDrops,[{channelId:upcoming,sourceId:upPost.id}]);
  assert.ok(messages.get(record.messageId).embeds.some(e=>e.title.includes('these upcoming drops') && e.description.includes(upPost.id)));
  await controls.skipDrop(owner,'member',upPost.id,upcoming);
  record=JSON.parse(await fs.readFile(path.join(dataDir,'discord-sku-selections.json'),'utf8'))[owner];
  assert.equal(record.skippedUpcomingDrops.length,1,'Repeated upcoming opt-out is idempotent');
  await controls.recordSkuSelection(owner,'member',upPost.id,'all',1,upcoming);
  record=JSON.parse(await fs.readFile(path.join(dataDir,'discord-sku-selections.json'),'utf8'))[owner];
  assert.equal(record.skippedUpcomingDrops.length,0,'Selecting this upcoming drop cancels its opt-out');
  await controls.skipDrop(owner,'member',chatter.id,upcoming);
  record=JSON.parse(await fs.readFile(path.join(dataDir,'discord-sku-selections.json'),'utf8'))[owner];
  assert.equal(record.skippedUpcomingDrops[0].sourceId,chatter.id,'A post with no SKUs can be skipped');

  const batchUser='1551070928039845999';
  const batchPost=post('1551070928039845998',upcoming,'TCG Booster One\nSKU: ABC1234\nTCG Booster Two\nSKU: XYZ5678');
  messages.set(batchPost.id,batchPost);
  const batchProducts=parseDropSkus(batchPost);
  const batchDraft=await controls.mutateSkuDraft(batchUser,upcoming,batchPost.id,items=>changeSkuItems(items,batchProducts,batchPost.id,upcoming,2));
  assert.equal(batchDraft.length,2,'Both SKUs are in the private unconfirmed draft');
  const priorBatch=JSON.parse(await fs.readFile(path.join(dataDir,'discord-sku-selections.json'),'utf8'));
  assert.equal(priorBatch[batchUser],undefined,'Draft changes do not prematurely notify admin');
  const savedBatch=await controls.confirmSkuDraft(batchUser,'batch-member',batchPost.id,upcoming);
  assert.equal(savedBatch.length,2);
  assert.ok(savedBatch.every(item=>item.quantity===2));
  const batchRecord=JSON.parse(await fs.readFile(path.join(dataDir,'discord-sku-selections.json'),'utf8'))[batchUser];
  const adminBatch=messages.get(batchRecord.messageId);
  assert.match(adminBatch.embeds.map(item=>item.description).join('\n'),/\(ABC1234, XYZ5678\)/);
  assert.match(adminBatch.embeds.map(item=>item.description).join('\n'),/Qty: 2/);
  assert.doesNotMatch(adminBatch.embeds.map(item=>item.description).join('\n'),/ABC1234 x2|XYZ5678 x2/);
  await assert.rejects(controls.confirmSkuDraft(batchUser,'batch-member',batchPost.id,upcoming),/draft is no longer active/);
  nightPost.content=Array.from({length:16},(_,i)=>`Product ${i}\nSKU: ABC${i}`).join('\n');
  await controls.ensureSkuControls(nightPost);
  menus=JSON.parse(await fs.readFile(path.join(dataDir,'discord-sku-controls.json'),'utf8'));
  assert.equal(menus[nightPost.id].length,1,'One public panel regardless of SKU count');
  const activePanel=menus[nightPost.id][0];
  const oldPage=String(serial++);
  messages.set(oldPage,{id:oldPage,channel_id:tonightChannelId,content:'Obsolete panel'});
  menus[nightPost.id].push(oldPage);
  await fs.writeFile(path.join(dataDir,'discord-sku-controls.json'),JSON.stringify(menus));
  nightPost.content='Product\nSKU: ABC0';await controls.ensureSkuControls(nightPost);
  menus=JSON.parse(await fs.readFile(path.join(dataDir,'discord-sku-controls.json'),'utf8'));
  assert.equal(menus[nightPost.id].length,1);
  assert.equal(menus[nightPost.id][0],activePanel,'Reuse public panel instead of duplicating it');
  assert.equal(messages.has(oldPage),true,'Obsolete panels remain until their ten-day expiry');
  assert.deepEqual(messages.get(oldPage).components,[],'Obsolete panel buttons are disabled without erasing the message');
  nightPost.content='No products';await controls.ensureSkuControls(nightPost);
  menus=JSON.parse(await fs.readFile(path.join(dataDir,'discord-sku-controls.json'),'utf8'));
  assert.equal(menus[nightPost.id],undefined);
  const finalOwnerPanels = [...messages.values()].filter(p => p.channel_id === 'private' &&
    p.components?.some(row => row.components.some(button => button.custom_id?.startsWith('sku:remind:'))));
  assert.equal(finalOwnerPanels.length, 1, 'Removing SKUs retires its owner-only reminder button');
  // Regression: an inaccessible retailer must not block PKC controls from appearing.
  const inaccessibleId='1551070928039845960', pkcId='1551070928039845961';
  const pkcPost=post('1551070928039845962',pkcId,
    'Pokemon Center Elite Trainer Box\nSKU: PKC123456\nPokemon Center Booster Bundle\nSKU: PKC987654');
  messages.set(pkcPost.id,pkcPost);
  histories.set(pkcId,[pkcPost]);
  deps.dropChannelIds.add(inaccessibleId);
  deps.dropChannelIds.add(pkcId);
  deps.retailerDropLabels[pkcId]='PKC Drops';
  await controls.backfillDropMenus();
  menus=JSON.parse(await fs.readFile(path.join(dataDir,'discord-sku-controls.json'),'utf8'));
  assert.ok(menus[pkcPost.id], 'PKC SKU menus must backfill even if another drop channel is forbidden');
  const pkcPanel=messages.get(menus[pkcPost.id][0]);
  assert.equal(pkcPanel.embeds[0].title,'PKC Drops — products');
  assert.match(pkcPanel.embeds[0].description,/PKC123456/);
  assert.match(pkcPanel.embeds[0].description,/PKC987654/);
  assert.ok(pkcPanel.components[0].components.some(item=>item.label==='Choose Multiple SKUs'));
  assert.ok(pkcPanel.components[0].components.some(item=>item.label==='Run all SKUs'));
  assert.ok(pkcPanel.components[0].components.some(item=>item.label==='My selected SKUs'));
  const pkcDraft=await controls.mutateSkuDraft(batchUser,pkcId,pkcPost.id,
    items=>changeSkuItems(items,parseDropSkus(pkcPost),pkcPost.id,pkcId,2));
  assert.equal(pkcDraft.length,2);
  const pkcSaved=await controls.confirmSkuDraft(batchUser,'batch-member',pkcPost.id,pkcId);
  assert.equal(pkcSaved.length,4, 'Confirming PKC must preserve existing retailer selections');
  assert.ok(pkcSaved.every(item=>item.quantity===2));
  // Every recent SKU source in a retailer must get a usable panel, not only
  // the first post encountered during the startup backfill.
  const olderTarget=post('1551070928039845970',pkcId,'Older PKC bundle\\nSKU: OLDER9876');
  const newerTarget=post('1551070928039845971',pkcId,'Newer PKC bundle\\nSKU: NEWER9876');
  const ordinaryRetailerChatter=post('1551070928039845972',pkcId,'Thanks for the update');
  for(const msg of [olderTarget,newerTarget,ordinaryRetailerChatter])messages.set(msg.id,msg);
  histories.set(pkcId,[ordinaryRetailerChatter,newerTarget,olderTarget,pkcPost]);
  await controls.backfillDropMenus();
  menus=JSON.parse(await fs.readFile(path.join(dataDir,'discord-sku-controls.json'),'utf8'));
  assert.ok(menus[olderTarget.id],'Older retailer drop must receive usable SKU controls');
  assert.ok(menus[newerTarget.id],'Newer retailer drop must receive usable SKU controls');
  assert.equal(menus[ordinaryRetailerChatter.id],undefined,'Chatter without product SKUs must not create a retailer selection/skip panel');
  console.log('PASS: PKC channel gets SKU controls despite another channel HTTP 403; saved cross-retailer selections remain');

  console.log('PASS: channel aliases, existing Upcoming controls, tonight and per-post Upcoming opt-out/reversal, no-SKU opt-out, owner notifications, preserved other-drop selections, idempotency, menu growth and stale-control cleanup');
} finally { await fs.rm(dataDir,{recursive:true,force:true}); }
