// Owner-only inventory warnings. Usable means unassigned AND not held.
// Walmart is intentionally disabled by default: its customer pool is restricted.
import path from "node:path";

export const DEFAULT_POOL_ALERT_THRESHOLDS = Object.freeze({
  target: { enabled: true, warning: 25, critical: 10 },
  pokemoncenter: { enabled: true, warning: 25, critical: 10 },
  walmart: { enabled: false, warning: 25, critical: 10 }
});
const label = {target:"Target",pokemoncenter:"Pokémon Center",walmart:"Walmart"};
const statusRank = {ok:0,warning:1,critical:2};

export function availablePoolStatus(inventory, rules) {
  const total = Math.max(0, Math.floor(Number(inventory?.total || 0)));
  const available = Math.max(0, Math.floor(Number(inventory?.available || 0)));
  const held = Math.max(0, Math.floor(Number(inventory?.held || 0)));
  const usable = Math.max(0, available - held);
  const severity = !rules.enabled ? "disabled" :
    usable <= rules.critical ? "critical" :
    usable <= rules.warning ? "warning" : "ok";
  return {total,available,held,usable,severity};
}

export function registerPoolAlertMonitoring(app,{
  dataDir,requireAdmin,getAvailability,notifyAdminMobile,
  readJson,writeJson,discordWebhookUrl
}) {
  const settingsFile = path.join(dataDir,"pool-alert-thresholds.json");
  const stateFile = path.join(dataDir,"pool-alert-delivery-state.json");
  const now = () => Date.now();
  const normalize = raw => {
    const result = {};
    for (const [retailer,defaults] of Object.entries(DEFAULT_POOL_ALERT_THRESHOLDS)) {
      const supplied = raw?.[retailer] || {};
      result[retailer] = {
        enabled: typeof supplied.enabled === "boolean" ? supplied.enabled : defaults.enabled,
        warning: Number.isSafeInteger(supplied.warning) && supplied.warning >= 0 && supplied.warning <= 100000
          ? supplied.warning : defaults.warning,
        critical: Number.isSafeInteger(supplied.critical) && supplied.critical >= 0 && supplied.critical <= 100000
          ? supplied.critical : defaults.critical
      };
      if (result[retailer].critical > result[retailer].warning) result[retailer].critical = result[retailer].warning;
    }
    return result;
  };
  const readSettings = async () => normalize(await readJson(settingsFile,{}));
  const summarize = (availability,settings) => Object.fromEntries(
    Object.entries(settings).map(([retailer,rule]) =>
      [retailer,{...availablePoolStatus(availability[retailer] || {},rule),...rule,name:label[retailer]}]));
  let queue = Promise.resolve();
  const sequence = work => {
    const next = queue.then(work);
    queue = next.catch(() => {});
    return next;
  };
  async function sendDiscord(severity,retailer,item) {
    const url = String(discordWebhookUrl() || "").trim();
    if (!url) return false;
    const color = severity === "critical" ? 0xff4757 : 0xf6c55d;
    const text = severity === "critical" ? "CRITICAL" : "LOW";
    const response = await fetch(url,{
      method:"POST",
      headers:{"Content-Type":"application/json"},
      signal:AbortSignal.timeout(10000),
      body:JSON.stringify({username:"SLABSNGRABSACO Inventory",
        allowed_mentions:{parse:[]},
        embeds:[{title:text + " INVENTORY — " + label[retailer],
          description:"Only " + item.usable + " usable account(s) remaining. " +
            item.available + " unassigned, " + item.held + " on hold. " +
            "Warning at " + item.warning + "; critical at " + item.critical + ".",
          color,footer:{text:"Admin account-pool monitor"},
          timestamp:new Date().toISOString()}]})
    });
    if (!response.ok) throw Error("Discord pool alert HTTP " + response.status);
    return true;
  }
  async function inspect({notify=true}={}) {
    return sequence(async()=>{
      const [availability,settings,rawState] = await Promise.all([
        getAvailability(),readSettings(),readJson(stateFile,{})
      ]);
      const state = rawState && typeof rawState === "object" && !Array.isArray(rawState)
        ? rawState : {};
      const items = summarize(availability,settings);
      for (const [retailer,item] of Object.entries(items)) {
        const previous = state[retailer] || {};
        if (item.severity === "ok" || item.severity === "disabled") {
          state[retailer] = {severity:item.severity,updatedAt:new Date().toISOString()};
          continue;
        }
        const changed = item.severity !== previous.severity;
        const reminder = !previous.lastNotifiedAt ||
          now() - Date.parse(previous.lastNotifiedAt) >= 24 * 60 * 60 * 1000;
        if (notify && (changed || reminder)) {
          const text = label[retailer] + " has " + item.usable +
            " usable account(s) remaining (warning " + item.warning +
            ", critical " + item.critical + ").";
          const eventKey = "pool:"+retailer+":"+item.severity+":"+
            (changed ? "threshold-"+now() : "daily-"+new Date().toISOString().slice(0,10));
          let delivered = false;
          try {
            await notifyAdminMobile("actionNeeded",
              item.severity === "critical" ? "CRITICAL: " + label[retailer] + " pool" :
                "Low " + label[retailer] + " pool",
              text, "/admin-app.html",eventKey);
            delivered = true;
          } catch (error) {console.error("Inventory push:",error?.message || error);}
          try {if (await sendDiscord(item.severity,retailer,item)) delivered = true;}
          catch (error) {console.error("Inventory Discord:",error?.message || error);}
          state[retailer] = {
            severity:item.severity,
            updatedAt:new Date().toISOString(),
            lastNotifiedAt: delivered ? new Date().toISOString() : previous.lastNotifiedAt || null
          };
        } else state[retailer] = {...previous,severity:item.severity};
      }
      await writeJson(stateFile,state);
      return {ok:true,inventory:items,discordConfigured:Boolean(discordWebhookUrl()),updatedAt:new Date().toISOString()};
    });
  }
  app.get("/api/admin/pool-alerts",requireAdmin,async(_req,res)=>{
    try {
      const [availability,settings] = await Promise.all([getAvailability(),readSettings()]);
      res.set("Cache-Control","no-store").json({
        ok:true,inventory:summarize(availability,settings),
        discordConfigured:Boolean(discordWebhookUrl()),
        updatedAt:new Date().toISOString()
      });
    }catch(error){console.error("Inventory monitor:",error?.message);res.status(500).json({error:"Unable to read pool availability."});}
  });
  app.put("/api/admin/pool-alerts",requireAdmin,async(req,res)=>{
    try {
      const current = await readSettings(), input = req.body || {};
      for(const key of Object.keys(input)) {
        if(!Object.hasOwn(current,key) || !input[key] || typeof input[key] !== "object")
          return res.status(400).json({error:"Invalid retailer threshold."});
        for(const field of Object.keys(input[key])) {
          if(!["enabled","warning","critical"].includes(field))
            return res.status(400).json({error:"Invalid threshold setting."});
          const value = input[key][field];
          if (field === "enabled" ? typeof value !== "boolean" :
             !Number.isSafeInteger(value) || value < 0 || value > 100000)
            return res.status(400).json({error:"Thresholds must be whole numbers between 0 and 100,000."});
        }
        current[key] = {...current[key],...input[key]};
        if (current[key].critical > current[key].warning)
          return res.status(400).json({error:"Critical threshold cannot exceed the warning threshold."});
      }
      await writeJson(settingsFile,current);
      const result = await inspect();
      res.json(result);
    } catch(error){console.error("Pool threshold save:",error?.message);res.status(500).json({error:"Could not save the pool thresholds."});}
  });
  app.post("/api/admin/pool-alerts/check",requireAdmin,async(_req,res)=>{
    try {res.json(await inspect());}
    catch(error){res.status(500).json({error:"Could not run the pool check."});}
  });
  return function start(){
    void inspect().catch(error=>console.error("First pool check:",error?.message));
    const interval = setInterval(()=>{
      void inspect().catch(error=>console.error("Scheduled pool check:",error?.message));
    },10*60*1000);
    interval.unref?.();
    return interval;
  };
}
