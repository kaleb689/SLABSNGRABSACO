import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";

const ACTIVE = new Set(["active", "trialing"]);
const ROLE = "Target Raffle Club";
const money = n => "$" + (Number(n) / 100).toFixed(2);
const plain = s => String(s || "").replace(/[\r\n<>*@|]/g, " ").trim();
const snowflake = id => /^\d{17,22}$/.test(String(id || ""));
const priceOf = item => typeof item?.price === "string" ? item.price : item?.price?.id;

export function orderRaffleQueue(entries = []) {
  return (Array.isArray(entries) ? entries : []).filter(x => x.qty > 0)
    .sort((a,b) => BigInt(a.joinId) < BigInt(b.joinId) ? -1 :
      BigInt(a.joinId) > BigInt(b.joinId) ? 1 : String(a.userId).localeCompare(String(b.userId)));
}
export function selectRaffleQuantity(item, {userId, accountId, name, qty, joinId}) {
  if (!item.active) throw Error("This raffle queue is closed.");
  if (!snowflake(userId) || !snowflake(joinId) ||
      !Number.isInteger(qty) || qty < 0 || qty > Number(item.maxQty || 20))
    throw Error("Enter a whole-number quantity from 0 to " + (item.maxQty || 20) + ".");
  const old = (item.entries || []).find(x => x.userId === userId);
  item.entries = (item.entries || []).filter(x => x.userId !== userId);
  if (qty) item.entries.push({
    userId, accountId, name: plain(name).slice(0,75), qty,
    joinId: old?.joinId || joinId, joinedAt:old?.joinedAt || new Date().toISOString(),
    updatedAt:new Date().toISOString()
  });
  const index = orderRaffleQueue(item.entries).findIndex(x => x.userId === userId);
  return index < 0 ? 0 : index + 1;
}

export function registerTargetRaffleClub({app, stripe, requireCustomer, requireAdmin, dataDir,
  baseUrl, getAccounts, getActiveMemberProfiles,
  memberPriceId = process.env.STRIPE_RAFFLE_CLUB_MEMBER_PRICE_ID,
  standalonePriceId = process.env.STRIPE_RAFFLE_CLUB_STANDALONE_PRICE_ID}) {
  const subscribersPath=path.join(dataDir,"target-raffle-subscribers.json");
  const itemsPath=path.join(dataDir,"target-raffle-items.json");
  const panelPath=path.join(dataDir,"target-raffle-panel.json");
  const prices={member:String(memberPriceId||""),standalone:String(standalonePriceId||"")};
  const cents={member:500,standalone:2000};
  let discord=null,chain=Promise.resolve(),refreshChain=Promise.resolve();
  function serial(task){const p=chain.then(task,task);chain=p.catch(()=>{});return p;}
  async function read(file,empty){try{return JSON.parse(await fs.readFile(file,"utf8"));}
    catch(e){if(e.code==="ENOENT")return empty;throw e;}}
  async function save(file,rows){
    await fs.mkdir(dataDir,{recursive:true,mode:0o700});
    const tmp=file+"."+crypto.randomUUID()+".tmp";
    await fs.writeFile(tmp,JSON.stringify(rows,null,2),{mode:0o600,flag:"wx"});
    await fs.rename(tmp,file);
  }
  const subscribers=async()=>{const r=await read(subscribersPath,[]);if(!Array.isArray(r))throw Error("Invalid raffle subscription store.");return r;};
  const items=async()=>{const r=await read(itemsPath,[]);if(!Array.isArray(r))throw Error("Invalid raffle item store.");return r;};
  async function stripePrice(plan){
    const id=prices[plan];
    if(!/^price_[A-Za-z0-9]+$/.test(id))throw Error("Raffle Stripe prices are not configured.");
    const p=await stripe.prices.retrieve(id);
    if(!p.active||p.currency!=="usd"||p.type!=="recurring"||
      p.unit_amount!==cents[plan]||p.recurring?.interval!=="month"||
      Number(p.recurring?.interval_count||1)!==1)throw Error("Incorrect raffle Stripe price.");
    return id;
  }
  async function active(accountId){
    return (await subscribers()).find(x=>x.accountId===String(accountId)&&ACTIVE.has(x.status)&&!x.revokedAt)||null;
  }
  async function linked(userId){
    if(!snowflake(userId))return null;
    const matches=(await getAccounts()).filter(x=>x.id&&!x.disabled&&String(x.discordUserId||"")===String(userId));
    return matches.length===1&&await active(matches[0].id)?matches[0]:null;
  }
  async function updateSubscription(sub,session){
    const meta=sub.metadata?.purchase_type==="target_raffle_club"?sub.metadata:session?.metadata;
    if(meta?.purchase_type!=="target_raffle_club")return false;
    const accountId=String(meta.customer_account_id||session?.client_reference_id||"");
    const plan=Object.keys(prices).find(p=>prices[p]&&sub.items?.data?.some(x=>priceOf(x)===prices[p]));
    if(!accountId||!String(sub.id||"").startsWith("sub_")||!plan)throw Error("Unrecognized raffle subscription.");
    await serial(async()=>{
      const rows=await subscribers();
      let r=rows.find(x=>x.subscriptionId===sub.id);
      if(r&&r.accountId!==accountId)throw Error("Raffle subscription ownership mismatch.");
      if(!r){r={subscriptionId:sub.id,accountId,createdAt:new Date().toISOString()};rows.push(r);}
      Object.assign(r,{plan,status:String(sub.status||"incomplete"),
        stripeCustomerId:String(sub.customer?.id||sub.customer||""),
        cancelAtPeriodEnd:sub.cancel_at_period_end===true,
        periodEnd:sub.items?.data?.[0]?.current_period_end||sub.current_period_end||null,
        updatedAt:new Date().toISOString()});
      await save(subscribersPath,rows);
    });
    void syncRoles().catch(e=>console.error("Raffle role sync:",e.message));
    return true;
  }
  async function onStripeEvent(event){
    const obj=event.data?.object||{};
    if(["checkout.session.completed","checkout.session.async_payment_succeeded"].includes(event.type)
      &&obj.metadata?.purchase_type==="target_raffle_club"){
      if(obj.mode!=="subscription"||!obj.subscription)return true;
      return updateSubscription(await stripe.subscriptions.retrieve(String(obj.subscription)),obj);
    }
    if(["customer.subscription.created","customer.subscription.updated","customer.subscription.deleted"].includes(event.type)
      &&(obj.metadata?.purchase_type==="target_raffle_club"||
        (await subscribers()).some(x=>x.subscriptionId===obj.id)))return updateSubscription(obj);
    return false;
  }
  async function syncRoles(){
    if(!discord)return false;
    const accounts=new Map((await getAccounts()).map(a=>[String(a.id),a]));
    for(const row of await subscribers()){
      const a=accounts.get(String(row.accountId));
      const desired=ACTIVE.has(row.status)&&a&&!a.disabled&&snowflake(a.discordUserId)?String(a.discordUserId):"";
      const previous=snowflake(row.discordUserId)?String(row.discordUserId):"";
      if(previous&&previous!==desired){
        await discord.api("/guilds/"+discord.guildId+"/members/"+previous+"/roles/"+discord.roleId,"DELETE")
          .catch(e=>{if(!/HTTP 404/.test(e.message))console.error("Raffle role revoke:",e.message);});
      }
      if(desired){
        await discord.api("/guilds/"+discord.guildId+"/members/"+desired+"/roles/"+discord.roleId,"PUT")
          .catch(e=>console.error("Raffle role add:",e.message));
      }
      if(previous!==desired)await serial(async()=>{
        const rows=await subscribers(),current=rows.find(x=>x.subscriptionId===row.subscriptionId);
        if(current){current.discordUserId=desired;await save(subscribersPath,rows);}
      });
    }
    return true;
  }
  const queueFor=item=>orderRaffleQueue(item.entries||[]);
  function payload(item){
    const q=queueFor(item);
    const lines=q.slice(0,35).map((x,i)=>"**"+(i+1)+".** <@"+x.userId+"> × "+x.qty+
      " ("+money(x.qty*item.priceCents)+")");
    return {allowed_mentions:{parse:[]},embeds:[{
      title:"🎯 "+item.name,color:item.active?0x28cbd0:0x88929c,
      description:"**Price:** "+money(item.priceCents)+" each\n"+
        "**Available stock:** "+(item.stock===null?"Owner to confirm":item.stock)+"\n"+
        "**Queue:** "+q.length+" people / "+q.reduce((n,x)=>n+x.qty,0)+" requested units\n"+
        "**Status:** "+(item.active?"OPEN — first come, first served":"CLOSED")+"\n\n"+
        (lines.join("\n")||"No requests yet.")+
        (q.length>35?"\n+"+(q.length-35)+" more (use View Queue)":"")+
        "\n\nRequesting does not place or charge an order. The owner confirms availability and payment.",
      footer:{text:"Changing quantity preserves position; leaving and rejoining starts at the back."}
    }],components:[{type:1,components:[
      {type:2,style:1,label:"Choose Quantity",custom_id:"raffle:qty:"+item.id,disabled:!item.active},
      {type:2,style:2,label:"View Queue",custom_id:"raffle:view:"+item.id+":0"},
      {type:2,style:4,label:"Close (Owner)",custom_id:"raffle:close:"+item.id,disabled:!item.active}
    ]}]};
  }
  function refreshItem(id){
    const job=refreshChain.then(async()=>{
      if(!discord)return;
      const item=(await items()).find(x=>x.id===id);
      if(item?.messageId)await discord.api("/channels/"+discord.channelId+"/messages/"+item.messageId,"PATCH",payload(item));
    });
    refreshChain=job.catch(e=>console.error("Raffle post refresh:",e.message));
    return job;
  }
  async function postItem({name,priceCents,stock=null,maxQty=20,createdBy}){
    const title=plain(name).slice(0,160);
    const price=Number(priceCents),max=Number(maxQty);
    const count=stock===""||stock===undefined||stock===null?null:Number(stock);
    if(title.length<3||!Number.isInteger(price)||price<1||price>99999999||
      !Number.isInteger(max)||max<1||max>100||
      (count!==null&&(!Number.isInteger(count)||count<1||count>100000)))
      throw Error("Invalid item name, price, stock, or maximum quantity.");
    if(!discord?.channelId)throw Error("The private raffle channel is not ready.");
    const item={id:crypto.randomBytes(9).toString("hex"),name:title,priceCents:price,
      stock:count,maxQty:max,active:true,entries:[],createdBy,
      createdAt:new Date().toISOString(),messageId:null};
    await serial(async()=>{const list=await items();list.push(item);await save(itemsPath,list);});
    const sent=await discord.api("/channels/"+discord.channelId+"/messages","POST",payload(item));
    await serial(async()=>{const list=await items(),x=list.find(x=>x.id===item.id);
      if(x){x.messageId=sent.id;await save(itemsPath,list);}});
    return item;
  }
  async function setQty(id,input){
    return serial(async()=>{
      const list=await items(),item=list.find(x=>x.id===id);
      if(!item)throw Error("Item not found.");
      const place=selectRaffleQuantity(item,input);
      await save(itemsPath,list);
      return {place,item};
    });
  }
  async function close(id){
    await serial(async()=>{
      const list=await items(),item=list.find(x=>x.id===id);
      if(!item)throw Error("Item not found.");
      item.active=false;item.closedAt=new Date().toISOString();
      await save(itemsPath,list);
    });
    void refreshItem(id).catch(()=>{});
  }
  function queuePage(item,page){
    const q=queueFor(item),pages=Math.max(1,Math.ceil(q.length/20));
    const p=Math.max(0,Math.min(pages-1,Number(page)||0));
    const text=q.slice(p*20,(p+1)*20).map((x,i)=>
      "**"+(i+p*20+1)+".** <@"+x.userId+"> × "+x.qty+" = "+money(x.qty*item.priceCents)).join("\n");
    return {content:"**"+item.name+" — queue page "+(p+1)+"/"+pages+"**\n"+(text||"No requests yet."),
      flags:64,allowed_mentions:{parse:[]},components:pages===1?[]:[{type:1,components:[
        {type:2,style:2,label:"Previous",custom_id:"raffle:view:"+item.id+":"+(p-1),disabled:p===0},
        {type:2,style:2,label:"Next",custom_id:"raffle:view:"+item.id+":"+(p+1),disabled:p===pages-1}
      ]}]};
  }
  async function handleInteraction(d){
    const action=String(d.data?.custom_id||"");
    if(!action.startsWith("raffle:")||!discord||String(d.guild_id)!==discord.guildId)return false;
    const userId=String(d.member?.user?.id||d.user?.id||"");
    const endpoint="/interactions/"+d.id+"/"+d.token+"/callback";
    const reply=message=>discord.api(endpoint,"POST",{type:4,data:{content:message,flags:64,allowed_mentions:{parse:[]}}});
    const owner=userId===discord.ownerId;
    try{
      if(action==="raffle:role"&&d.type===3){
        if(!await linked(userId)){await reply("Link your Discord and purchase Target Raffle Club at "+baseUrl+"/target-raffle-club.html");return true;}
        await discord.api("/guilds/"+discord.guildId+"/members/"+userId+"/roles/"+discord.roleId,"PUT");
        await reply("Your paid Target Raffle Club role is active.");return true;
      }
      if(String(d.channel_id)!==discord.channelId){await reply("Use #target-raffle-club.");return true;}
      if(action==="raffle:create"&&d.type===3){
        if(!owner){await reply("Only the owner can post raffle items.");return true;}
        await discord.api(endpoint,"POST",{type:9,data:{custom_id:"raffle:create:submit",
          title:"Post Target Raffle Item",components:[
            {type:1,components:[{type:4,style:1,custom_id:"name",label:"Product",required:true,min_length:3,max_length:160}]},
            {type:1,components:[{type:4,style:1,custom_id:"price",label:"Price each (USD e.g. 49.99)",required:true,max_length:12}]},
            {type:1,components:[{type:4,style:1,custom_id:"stock",label:"Available stock (optional)",required:false,max_length:6}]},
            {type:1,components:[{type:4,style:1,custom_id:"max",label:"Max per person (default 20)",required:false,max_length:3}]}
          ]}});return true;
      }
      if(action==="raffle:create:submit"&&d.type===5){
        if(!owner){await reply("Only the owner can post.");return true;}
        const fields=(d.data.components||[]).flatMap(x=>x.components||[]);
        const field=k=>String(fields.find(x=>x.custom_id===k)?.value||"").trim();
        if(!/^\d{1,6}(\.\d{1,2})?$/.test(field("price"))){await reply("Enter a valid USD price.");return true;}
        const item=await postItem({name:field("name"),priceCents:Math.round(Number(field("price"))*100),
          stock:field("stock"),maxQty:field("max")||20,createdBy:userId});
        await reply("Posted "+item.name+" at "+money(item.priceCents)+".");return true;
      }
      const choose=action.match(/^raffle:qty:([a-f0-9]{18})$/);
      if(choose&&d.type===3){
        if(!await linked(userId)){await reply("This requires a paid raffle subscription and linked Discord.");return true;}
        const item=(await items()).find(x=>x.id===choose[1]);
        if(!item?.active){await reply("This item queue is closed.");return true;}
        const current=queueFor(item).find(x=>x.userId===userId);
        await discord.api(endpoint,"POST",{type:9,data:{custom_id:"raffle:submit:"+item.id,
          title:"Choose Raffle Quantity",components:[{type:1,components:[
            {type:4,style:1,custom_id:"qty",label:"0 to leave; max "+item.maxQty,
              required:true,min_length:1,max_length:3,value:String(current?.qty||1)}
          ]}]}});return true;
      }
      const submit=action.match(/^raffle:submit:([a-f0-9]{18})$/);
      if(submit&&d.type===5){
        const account=await linked(userId);
        if(!account){await reply("Your raffle subscription is no longer active.");return true;}
        const qtyString=String((d.data.components||[]).flatMap(x=>x.components||[])
          .find(x=>x.custom_id==="qty")?.value||"").trim();
        if(!/^(0|[1-9]\d{0,2})$/.test(qtyString)){await reply("Enter a whole-number quantity or 0.");return true;}
        const qty=Number(qtyString);
        const result=await setQty(submit[1],{userId,accountId:String(account.id),
          name:d.member?.user?.global_name||d.member?.user?.username||"Member",
          qty,joinId:String(d.id)});
        await reply(qty===0?"Removed. Rejoining starts at the end of the queue.":
          "Saved "+qty+" × "+result.item.name+" ("+money(qty*result.item.priceCents)+
          "). Queue position #"+result.place+". This is not a completed purchase.");
        void refreshItem(submit[1]).catch(()=>{});return true;
      }
      const view=action.match(/^raffle:view:([a-f0-9]{18}):(\d{1,4})$/);
      if(view&&d.type===3){
        if(!owner&&!await linked(userId)){await reply("Active club access required.");return true;}
        const item=(await items()).find(x=>x.id===view[1]);
        if(!item){await reply("Item not found.");return true;}
        await discord.api(endpoint,"POST",{type:4,data:queuePage(item,view[2])});return true;
      }
      const closer=action.match(/^raffle:close:([a-f0-9]{18})$/);
      if(closer&&d.type===3){
        if(!owner){await reply("Only the owner can close queues.");return true;}
        await close(closer[1]);await reply("Queue closed. The existing requests remain saved.");return true;
      }
      await reply("Unknown raffle control.");
    }catch(e){console.error("Raffle interaction:",e.message);
      try{await reply("Could not process your raffle request. Please try again.");}catch{}}
    return true;
  }
  async function provisionDiscord({api,guildId,appId,ownerId,channels}){
    const roles=await api("/guilds/"+guildId+"/roles");
    let role=roles.find(x=>x.name===ROLE&&!x.managed);
    if(!role)role=await api("/guilds/"+guildId+"/roles","POST",
      {name:ROLE,color:0x2fcbd4,permissions:"0",mentionable:false,hoist:false});
    const target=(channels||[]).find(x=>x.type===0&&
      String(x.name||"").toLowerCase().replace(/[^a-z]/g,"").endsWith("targetdrops"));
    const overwrites=[
      {id:guildId,type:0,allow:"0",deny:"1024"},
      {id:role.id,type:0,allow:"66560",deny:"2048"},
      {id:appId,type:1,allow:"68624",deny:"0"},
      {id:ownerId,type:1,allow:"68608",deny:"0"}
    ];
    let channel=(channels||[]).find(x=>x.type===0&&
      String(x.name||"").toLowerCase().replace(/[^a-z]/g,"")==="targetraffleclub");
    if(!channel)channel=await api("/guilds/"+guildId+"/channels","POST",{
      name:"target-raffle-club",type:0,parent_id:target?.parent_id||undefined,
      topic:"Paid Target Raffle Club • item prices and first-come-first-served queues",
      permission_overwrites:overwrites});
    else{
      const existing=channel.permission_overwrites||[];
      if(!overwrites.every(y=>existing.some(x=>x.id===y.id&&
        String(x.allow||"0")===y.allow&&String(x.deny||"0")===y.deny)))
        channel=await api("/channels/"+channel.id,"PATCH",{permission_overwrites:overwrites});
    }
    discord={api,guildId:String(guildId),appId:String(appId),
      ownerId:String(ownerId),roleId:String(role.id),channelId:String(channel.id)};
    const intro={
      allowed_mentions:{parse:[]},
      content:"🎯 **TARGET RAFFLE CLUB**\n**$5/month** for existing paid ACO members; **$20/month** for standalone subscribers.\n\n"+
        "The owner posts priced items below. On each, press **Choose Quantity** to request 1 or more units, "+
        "or choose **0** to leave. Join one, several, or no item queues. "+
        "Everyone in this channel can view the first-come-first-served line.\n"+
        "Queue requests are not purchases or guarantees. Stock and payment are confirmed separately.",
      components:[{type:1,components:[
        {type:2,style:1,label:"Post Item (Owner)",custom_id:"raffle:create"},
        {type:2,style:2,label:"Confirm Club Role",custom_id:"raffle:role"}
      ]}]
    };
    const panel=await read(panelPath,{});
    if(panel.channelId===channel.id&&panel.messageId){
      try{await api("/channels/"+channel.id+"/messages/"+panel.messageId,"PATCH",intro);}
      catch{const p=await api("/channels/"+channel.id+"/messages","POST",intro);
        await save(panelPath,{channelId:channel.id,messageId:p.id});}
    }else{
      const p=await api("/channels/"+channel.id+"/messages","POST",intro);
      await save(panelPath,{channelId:channel.id,messageId:p.id});
    }
    for(const item of await items()){
      if(item.messageId)continue;
      try{
        const p=await api("/channels/"+channel.id+"/messages","POST",payload(item));
        await serial(async()=>{const rows=await items(),x=rows.find(x=>x.id===item.id);
          if(x){x.messageId=p.id;await save(itemsPath,rows);}});
      }catch(e){console.error("Raffle item restoration:",e.message);}
    }
    await syncRoles();
    return {channelId:channel.id,roleId:role.id};
  }
  app.get("/api/public/raffle-club/offer",async(_req,res)=>{
    let available=false;
    try{await Promise.all([stripePrice("member"),stripePrice("standalone")]);available=true;}
    catch{}
    res.setHeader("Cache-Control","no-store");
    res.json({name:ROLE,memberMonthly:500,standaloneMonthly:2000,available});
  });
  app.get("/api/account/raffle-club/status",requireCustomer,async(req,res)=>{
    try{
      const subscription=await active(req.customerAccount.id);
      res.setHeader("Cache-Control","no-store");
      res.json({active:!!subscription,plan:subscription?.plan||null,
        memberEligible:Number(await getActiveMemberProfiles(req.customerAccount.id))>0,
        discordLinked:snowflake(req.customerAccount.discordUserId),
        periodEnd:subscription?.periodEnd||null});
    }catch(e){res.status(503).json({error:"Cannot verify raffle status."});}
  });
  app.post("/api/account/raffle-club/checkout",requireCustomer,async(req,res)=>{
    try{
      const account=req.customerAccount;
      if(!account?.id||account.id==="demo"||req.customerAdminPreview)
        return res.status(403).json({error:"A real customer account is required."});
      if(await active(account.id))return res.status(409).json({error:"Raffle Club is already active."});
      const plan=Number(await getActiveMemberProfiles(account.id))>0?"member":"standalone";
      const price=await stripePrice(plan);
      const session=await stripe.checkout.sessions.create({
        mode:"subscription",line_items:[{price,quantity:1}],
        client_reference_id:String(account.id),customer_email:account.email,
        success_url:baseUrl+"/target-raffle-club.html?raffle=success&session_id={CHECKOUT_SESSION_ID}",
        cancel_url:baseUrl+"/target-raffle-club.html?raffle=cancelled",
        metadata:{purchase_type:"target_raffle_club",customer_account_id:String(account.id),plan},
        subscription_data:{metadata:{purchase_type:"target_raffle_club",customer_account_id:String(account.id),plan}}
      },{idempotencyKey:"raffle-checkout-"+String(account.id)+"-"+Math.floor(Date.now()/300000)});
      res.json({url:session.url,plan,amount:cents[plan]});
    }catch(e){console.error("Raffle checkout:",e.message);
      res.status(502).json({error:"Raffle checkout is not configured or available yet."});}
  });
  app.post("/api/account/raffle-club/claim",requireCustomer,async(req,res)=>{
    try{
      const id=String(req.body?.sessionId||"");
      if(!/^cs_(?:test_)?[A-Za-z0-9_]{12,150}$/.test(id))
        return res.status(400).json({error:"Invalid session."});
      const session=await stripe.checkout.sessions.retrieve(id);
      if(session.mode!=="subscription"||session.metadata?.purchase_type!=="target_raffle_club"||
        String(session.metadata?.customer_account_id)!==String(req.customerAccount.id))
        return res.status(403).json({error:"This purchase is not yours."});
      const sub=await stripe.subscriptions.retrieve(String(session.subscription));
      await updateSubscription(sub,session);
      res.json({active:!!await active(req.customerAccount.id)});
    }catch(e){res.status(502).json({error:"Payment confirmation is not available yet."});}
  });
  app.post("/api/account/raffle-club/manage",requireCustomer,async(req,res)=>{
    try{
      const row=await active(req.customerAccount.id);
      if(!row)return res.status(404).json({error:"No active raffle subscription."});
      const session=await stripe.billingPortal.sessions.create({
        customer:row.stripeCustomerId,return_url:baseUrl+"/target-raffle-club.html"});
      res.json({url:session.url});
    }catch(e){res.status(502).json({error:"Billing management unavailable."});}
  });
  app.get("/api/account/raffle-club/queue",requireCustomer,async(req,res)=>{
    try{
      if(!await active(req.customerAccount.id))
        return res.status(403).json({error:"Paid raffle access required."});
      res.setHeader("Cache-Control","no-store");
      res.json({items:(await items()).map(item=>({
        id:item.id,name:item.name,priceCents:item.priceCents,active:item.active,
        queue:queueFor(item).map((x,i)=>({
          position:i+1,userId:x.userId,name:x.name,qty:x.qty,
          mine:x.accountId===String(req.customerAccount.id)
        }))
      }))});
    }catch(e){res.status(503).json({error:"Raffle queue unavailable."});}
  });
  app.get("/api/admin/raffle-club/items",requireAdmin,async(_req,res)=>{
    try{
      const [all,accounts,subs]=await Promise.all([items(),getAccounts(),subscribers()]);
      const lookup=new Map(accounts.map(x=>[String(x.id),x]));
      res.setHeader("Cache-Control","no-store");
      res.json({subscribers:subs.map(x=>({accountId:x.accountId,plan:x.plan,status:x.status})),
        items:all.map(item=>({...item,entries:queueFor(item).map((x,i)=>({
          ...x,position:i+1,customerEmail:lookup.get(x.accountId)?.email||""
        }))}))});
    }catch(e){res.status(503).json({error:"Owner queue unavailable."});}
  });
  app.post("/api/admin/raffle-club/items",requireAdmin,async(req,res)=>{
    try{
      const item=await postItem({name:req.body?.name,priceCents:req.body?.priceCents,
        stock:req.body?.stock,maxQty:req.body?.maxQty||20,createdBy:"admin"});
      res.status(201).json({id:item.id});
    }catch(e){res.status(400).json({error:e.message});}
  });
  app.post("/api/admin/raffle-club/items/:id/close",requireAdmin,async(req,res)=>{
    try{await close(String(req.params.id));res.json({ok:true});}
    catch(e){res.status(400).json({error:e.message});}
  });
  const timer=setInterval(()=>void syncRoles().catch(e=>console.error("Raffle role sweep:",e.message)),600000);
  timer.unref?.();
  return {onStripeEvent,provisionDiscord,handleInteraction,syncRoles};
}
