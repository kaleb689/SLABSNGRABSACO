/**
 * Owner-only, read-only preview of Target, PKC and monthly recaps calculated
 * from the original SLABSNGRABSTC #success Discord channel.
 *
 * Does not read website Success totals, send Discord messages, save orders,
 * create notifications, or return customer PII / retailer order numbers.
 */
import {easternLocalInstant,buildDiscordSourceRecap} from "./discord-source-recap-report.js";
import {SLABSNGRABSTC_SUCCESS_CHANNEL_ID} from "./discord-source-price-field-policy.js";

const MAX_PAGES=60;
const PAGE_SIZE=100;
const CHANNEL=SLABSNGRABSTC_SUCCESS_CHANNEL_ID;
const snowflake=t=>((BigInt(Math.floor(t))-1420070400000n)<<22n).toString();

function validDate(d) {
  if(!/^\d{4}-\d{2}-\d{2}$/.test(d))return false;
  const [y,m,day]=d.split("-").map(Number);
  const parsed=new Date(Date.UTC(y,m-1,day));
  return !Number.isNaN(parsed.getTime())&&parsed.toISOString().slice(0,10)===d;
}
function selectPeriod(q,now) {
  const mode=String(q.mode||"target").toLowerCase();
  if(mode==="target"){
    const day=String(q.date||"");
    if(!validDate(day))throw Error("Supply a valid Target drop date, YYYY-MM-DD.");
    return {mode,retailer:"Target",from:easternLocalInstant(day,3),
      toExclusive:easternLocalInstant(day,8),partial:false};
  }
  if(mode==="pkc"){
    const start=String(q.startedAt||"");
    const instant=Date.parse(start);
    if(!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(start)||
      !Number.isFinite(instant))throw Error("Supply an exact PKC Drop Is Live timestamp.");
    return {mode,retailer:"PKC",from:new Date(instant).toISOString(),
      toExclusive:new Date(instant+12*60*60*1000).toISOString(),partial:false};
  }
  if(mode==="monthly"){
    const month=String(q.month||"");
    if(!/^\d{4}-\d{2}$/.test(month))throw Error("Supply a month, YYYY-MM.");
    const [y,m]=month.split("-").map(Number);
    if(m<1||m>12||y<2020||y>2100)throw Error("Invalid calendar month.");
    const next=new Date(Date.UTC(y,m,1)).toISOString().slice(0,10);
    const first=easternLocalInstant(month+"-01",0);
    const end=easternLocalInstant(next,0);
    const requestedMtd=String(q.scope||"").toLowerCase()==="mtd";
    const partial=requestedMtd&&Date.parse(end)>now;
    return {mode,retailer:"All",from:first,
      toExclusive:partial?new Date(now-1000).toISOString():end,partial};
  }
  throw Error("Unknown recap mode.");
}
async function discordGetJson(token,relativePath){
  for(let attempt=0;attempt<5;attempt++){
    const response=await fetch("https://discord.com/api/v10"+relativePath,{
      headers:{Authorization:"Bot "+token},
      signal:AbortSignal.timeout(15000)
    });
    if(response.status===429&&attempt<4){
      const limiter=await response.json().catch(()=>({}));
      const delay=Math.max(300,Math.min(8000,Math.ceil(Number(limiter.retry_after||.75)*1000)+150));
      await new Promise(resolve=>setTimeout(resolve,delay));
      continue;
    }
    if(!response.ok)throw Error("Original Discord Success source returned HTTP "+response.status);
    return response.json();
  }
  throw Error("Original Discord Success source remained rate limited.");
}
export async function fetchDirectSourceMessages(token,startMs,nowMs) {
  const messages=[],seen=new Set();
  let before=snowflake(nowMs+60000),complete=false,pages=0;
  for(;pages<MAX_PAGES;pages++){
    const page=await discordGetJson(token,"/channels/"+CHANNEL+
      "/messages?limit="+PAGE_SIZE+"&before="+encodeURIComponent(before));
    if(!Array.isArray(page))throw Error("Discord returned an invalid message page.");
    let oldest=Infinity;
    for(const msg of page){
      const id=String(msg?.id||"");
      const at=Date.parse(msg?.timestamp||"");
      if(!Number.isFinite(at)||!/^\d{17,22}$/.test(id))continue;
      oldest=Math.min(oldest,at);
      if(at>=startMs&&at<=nowMs&&!seen.has(id)){
        seen.add(id);messages.push(msg);
      }
    }
    if(page.length===0||page.length<PAGE_SIZE||oldest<startMs){
      complete=true;pages++;break;
    }
    const lastId=String(page[page.length-1]?.id||"");
    if(!/^\d{17,22}$/.test(lastId))throw Error("Discord source pagination lost its cursor.");
    before=lastId;
  }
  return {messages,historyComplete:complete,pages};
}
export function registerDirectSourceRecapReview({app,requireAdmin,parseCheckout,botToken}) {
  if(!app?.get||typeof requireAdmin!=="function"||typeof parseCheckout!=="function")
    throw Error("Recap preview requires admin authentication and a trusted source parser.");
  app.get("/api/admin/source-recap-preview",requireAdmin,async(req,res)=>{
    res.set("Cache-Control","private, no-store");
    res.set("X-Content-Type-Options","nosniff");
    const now=Date.now();
    let selection;
    try {
      selection=selectPeriod(req.query||{},now);
      if(Date.parse(selection.toExclusive)>now)
        return res.status(409).json({error:"This recap window has not ended."});
      if(Date.parse(selection.from)>now||Date.parse(selection.toExclusive)<=Date.parse(selection.from))
        return res.status(400).json({error:"Invalid recap time window."});
    }catch(error){
      return res.status(400).json({error:String(error.message||"Invalid recap request").slice(0,180)});
    }
    const token=typeof botToken==="function"?botToken():botToken;
    if(!String(token||"").trim())
      return res.status(503).json({error:"Original Discord Success source is not configured."});
    try {
      const historical=await fetchDirectSourceMessages(String(token),
        Date.parse(selection.from),now);
      const report=buildDiscordSourceRecap(historical.messages,{
        channelId:CHANNEL,from:selection.from,toExclusive:selection.toExclusive,
        asOf:now,retailer:selection.retailer,parseCheckout,
        historyComplete:historical.historyComplete
      });
      // No customer emails, order IDs, webhook body, or credentials in response.
      return res.status(200).json({
        ...report,
        mode:selection.mode,
        partialPeriod:selection.partial,
        calculationReadyForReview:report.readyToPublish&&!selection.partial,
        // No automatic publication: only the owner may approve a final post.
        // The source audit never creates, schedules, or sends Discord messages.
        readyToPublish:false,
        ownerApprovalRequired:true,
        sourceScan:{pages:historical.pages,
          checkedMessages:historical.messages.length,
          reachedWindowStart:historical.historyComplete},
        blockedReasons:[...report.blockedReasons,
          ...(selection.partial?["unfinished_calendar_month"]:[]),
          "owner_approval_pending"]
      });
    }catch(error){
      const status=/Discord.*HTTP 401|Discord.*HTTP 403/.test(String(error.message||""))
        ? 503:502;
      // Error text cannot include Discord response bodies or customer data.
      return res.status(status).json({error:"Unable to verify original Discord Success messages.",
        reason:String(error.message||"source_unavailable").slice(0,120)});
    }
  });
}
