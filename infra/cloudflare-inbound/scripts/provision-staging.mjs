/*
 * Staging ONLY: idempotently provision isolated Cloudflare resources.
 * NEVER edits zone DNS, existing Email Routing rules, or sng.sarl catch-all.
 * Requires CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID in environment.
 */
import {execFileSync} from 'node:child_process';
import {readFileSync, writeFileSync} from 'node:fs';
import {resolve} from 'node:path';

const cwd = resolve(import.meta.dirname, '..');
const names = {
  bucket:'sng-inbound-raw',
  events:'sng-inbound-events',
  dead:'sng-inbound-dead-letter',
  database:'sng-inbound-index',
};
if (!process.env.CLOUDFLARE_API_TOKEN || !/^[a-f0-9]{32}$/i.test(process.env.CLOUDFLARE_ACCOUNT_ID||'')) {
  throw Error('Missing or invalid CLOUDFLARE_API_TOKEN / CLOUDFLARE_ACCOUNT_ID GitHub Actions secrets');
}
function cli(args,quiet=false) {
  const out=execFileSync('wrangler',args,{cwd,env:{...process.env,CI:'true'},encoding:'utf8',stdio:['ignore','pipe','pipe']});
  if (!quiet) process.stdout.write('Cloudflare completed: '+args.slice(0,3).join(' ')+'\n');
  return out;
}
function exists(args) {
  try { cli(args,true); return true; }
  catch(e) {
    // Do not interpret unknown permission failures as "not found" unless
    // explicitly confirmed by a create attempt that will fail safely.
    return false;
  }
}
function ensureBucket() {
  if (!exists(['r2','bucket','info',names.bucket])) {
    cli(['r2','bucket','create',names.bucket]);
  } else process.stdout.write('R2 bucket already exists\n');
}
function ensureQueue(name) {
  const list=cli(['queues','list'],true);
  const match=new RegExp('(^|[^a-z0-9-])'+name+'($|[^a-z0-9-])','i');
  if (!match.test(list)) cli(['queues','create',name]);
  else process.stdout.write('Queue already exists: '+name+'\n');
}
function listDatabases() {
  const body=cli(['d1','list','--json'],true);
  const list=JSON.parse(body);
  if(!Array.isArray(list)) throw Error('Unexpected D1 list response; refusing to provision');
  return list;
}
function ensureDatabase() {
  let row=listDatabases().find(x=>x.name===names.database);
  if (!row) {
    cli(['d1','create',names.database]);
    row=listDatabases().find(x=>x.name===names.database);
  }
  const id=row?.uuid || row?.id;
  if (!/^[0-9a-f]{8}-[0-9a-f-]{27,}$/i.test(id||''))
    throw Error('Could not resolve D1 database UUID; refusing to deploy');
  return id;
}
ensureBucket();
ensureQueue(names.events);
ensureQueue(names.dead);
const databaseId=ensureDatabase();
const template=readFileSync(resolve(cwd,'wrangler.example.toml'),'utf8');
if(template.includes('addresses = ')||template.includes('routes = ')||template.includes('zone_id'))
  throw Error('Refusing to deploy a configuration that could change email routing');
const config=template.replace('REPLACE_WITH_D1_DATABASE_ID',databaseId);
writeFileSync(resolve(cwd,'wrangler.toml'),config,{mode:0o600});
cli(['d1','execute',names.database,'--remote','--file=./schema.sql','--config=./wrangler.toml']);
cli(['deploy','--config=./wrangler.toml']);
process.stdout.write('Staging Worker deployed. No live routing rules were changed.\n');
