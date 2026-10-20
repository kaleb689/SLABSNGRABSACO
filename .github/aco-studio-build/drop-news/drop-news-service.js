'use strict';
const https=require('node:https'),fs=require('node:fs/promises'),path=require('node:path');
const {validateFeed,staleFeed,publicUrl}=require('./drop-news-core');
const FEED='https://raw.githubusercontent.com/kaleb689/SLABSNGRABSACO/main/public/aco-drop-news.json';
function download(){return new Promise((resolve,reject)=>{
 const req=https.get(FEED,{timeout:15000,headers:{'Cache-Control':'no-cache','User-Agent':'ACO-Studio-Drop-News'}},res=>{
  if(res.statusCode!==200){res.resume();reject(Error('Drop News feed is temporarily unavailable.'));return;}
  const chunks=[];let size=0;res.on('data',chunk=>{size+=chunk.length;if(size>1024*1024){res.destroy(Error('Drop News feed exceeds size limit.'));return;}chunks.push(chunk);});
  res.on('error',reject);res.on('end',()=>{try{resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));}catch{reject(Error('Drop News feed is invalid.'));}});
 });req.on('error',()=>reject(Error('Unable to reach Drop News.')));req.on('timeout',()=>req.destroy(Error('Drop News request timed out.')));
});}
function createNewsService({cacheFile,request=download,now=()=>new Date()}){
 let feed=null,pending=null,lastAttempt=0,lastError='',cached=true;
 async function read(){
  if(!feed){try{feed=validateFeed(JSON.parse(await fs.readFile(cacheFile,'utf8')));}catch{}}
  if(!pending&&(!lastAttempt||+now()-lastAttempt>60000)){
   lastAttempt=+now();pending=(async()=>{try{
    const next=validateFeed(await request());if(feed&&Date.parse(next.publishedAt)<Date.parse(feed.publishedAt))throw Error('Drop News returned an older edition.');
    await fs.mkdir(path.dirname(cacheFile),{recursive:true});await fs.writeFile(cacheFile+'.tmp',JSON.stringify(next),{mode:0o600});await fs.rename(cacheFile+'.tmp',cacheFile);
    feed=next;cached=false;lastError='';
   }catch{cached=true;lastError='The latest edition could not be loaded. Check your connection and try again.';}finally{pending=null;}})();
  }
  if(pending)await pending;
  return {feed,cached,stale:staleFeed(feed,now()),error:lastError,checkedAt:now().toISOString()};
 }
 function sourceAllowed(value){const url=publicUrl(value);if(!url||!feed)return false;const entries=[...feed.retailers.flatMap(r=>r.confirmed),...feed.rumors];return entries.some(e=>e.sources.some(s=>s.url===url));}
 return {read,sourceAllowed};
}
function register({app,ipcMain,requireOwner,shell}){
 const service=createNewsService({cacheFile:path.join(app.getPath('userData'),'drop-news-cache.json')});
 ipcMain.handle('drop-news:read',event=>{requireOwner(event);return service.read();});
 ipcMain.handle('drop-news:source',async(event,url)=>{requireOwner(event);if(!service.sourceAllowed(url))throw Error('Choose a source from the current Drop News edition.');await shell.openExternal(url);return {ok:true};});
 return service;
}
module.exports={createNewsService,register};
