// Owner-approved SNG chibi robot as the bot's global Discord avatar.
// Applies once per artwork version; never logs or persists the bot token.
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

const ASSET_URL=new URL("./assets/discord-bot-avatar-sng-20261114.b64",import.meta.url);
const MARKER_FILE="discord-bot-avatar-applied.json";
const BOT_ID=/^\d{17,22}$/;

export async function applyApprovedDiscordBotAvatar({api,dataDir,assetUrl=ASSET_URL}={}){
  if(typeof api!=="function"||!dataDir)throw Error("Discord avatar requires bot API and data directory");
  const base64=(await fs.readFile(assetUrl,"utf8")).trim();
  if(!/^[A-Za-z0-9+/]+={0,2}$/.test(base64)||base64.length>250000||
     Buffer.from(base64,"base64").subarray(0,3).toString("hex")!=="ffd8ff")
    throw Error("Approved Discord avatar image is missing or invalid");
  const sha256=crypto.createHash("sha256").update(base64).digest("hex");
  const markerPath=path.join(dataDir,MARKER_FILE);
  let saved=null;
  try{saved=JSON.parse(await fs.readFile(markerPath,"utf8"));}
  catch(error){if(error.code!=="ENOENT")throw error;}
  if(saved?.assetSha256===sha256&&saved?.discordBotId)return {status:"unchanged"};
  const user=await api("/users/@me");
  if(!BOT_ID.test(String(user?.id||""))||user?.bot!==true)
    throw Error("Authenticated Discord account is not a bot");
  const patched=await api("/users/@me","PATCH",{avatar:"data:image/jpeg;base64,"+base64});
  if(String(patched?.id)!==String(user.id)||!patched?.avatar)
    throw Error("Discord did not confirm the bot avatar update");
  await fs.mkdir(dataDir,{recursive:true});
  const temporary=markerPath+"."+crypto.randomUUID()+".tmp";
  await fs.writeFile(temporary,JSON.stringify({
    assetSha256:sha256,discordBotId:String(user.id),appliedAt:new Date().toISOString()
  }),{mode:0o600});
  await fs.rename(temporary,markerPath);
  return {status:"updated"};
}
