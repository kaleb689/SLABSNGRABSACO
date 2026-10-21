'use strict';
// Main-process Personal-only file import. Destination and rows never come from
// the confirmation request. Scans are read-only; confirmation is one-use.
const crypto = require('node:crypto');
const Core = require('./app');
const {emailFrom, retailerId, stripVerifiers} = require('./profile-vault');
const {readSelectedFiles} = require('./local_files');
const MAX_ROWS = 500;
function assertPersonalSource(row) {
  if (!row || typeof row !== 'object') return;
  if (row.customerId || row.acoCustomerId || row.websiteImport === true ||
      ['aco', 'customer', 'website', 'shared'].includes(String(row.scope || row.originScope || '').toLowerCase()))
    throw Error('This file is tagged for a customer or shared bank. It cannot enter Personal Jigs. Use the matching customer import.');
}
function parseFiles(entries, retailer) {
  retailer = retailerId(retailer);
  if (!Array.isArray(entries) || !entries.length || entries.length > 100) throw Error('Choose one or more profile files.');
  const files = [], rows = [];
  for (const entry of entries) {
    if (typeof entry.name !== 'string' || typeof entry.text !== 'string') throw Error('Invalid selected profile file.');
    const parsed = Core.parseFile(entry.name, entry.text);
    assertPersonalSource(parsed.root);
    if (!parsed.records.length) throw Error(entry.name + ' has no profiles.');
    const indices = [];
    for (const [i, raw] of parsed.records.entries()) {
      assertPersonalSource(raw);
      const data = stripVerifiers(raw,0,'personal'), email = emailFrom(data);
      if (!email) throw Error(entry.name + ': profile ' + (i + 1) + ' needs a valid account email. Nothing was imported.');
      if (JSON.stringify(data).length > 16000) throw Error(entry.name + ': profile ' + (i + 1) + ' is too large.');
      indices.push(rows.length);
      rows.push({scope:'personal', customerId:null, retailer, data, email});
      if (rows.length > MAX_ROWS) throw Error('Choose at most 500 profiles per import. Nothing was imported.');
    }
    files.push({name:entry.name, parsed, indices});
  }
  return {retailer, rows, files};
}
// Filter without changing the original CSV columns or Valor profile UUIDs.
function selectedFile(file, rows, skipped) {
  const localIndices = file.indices.map((global, i) => ({global, i})).filter(x => !skipped.has(x.global));
  if (!localIndices.length) return null;
  const p = file.parsed, data = localIndices.map(x => rows[x.global].data);
  let text;
  if (p.objectKeys) {
    const root = Object.fromEntries(localIndices.map((x, j) => [p.objectKeys[x.i], data[j]]));
    text = JSON.stringify(root, null, p.pretty ? p.indent : undefined);
  } else if (p.type === 'jsonl' || p.type === 'ndjson') {
    text = data.map(x => JSON.stringify(x)).join(p.newline);
  } else if (p.type === 'keyvalue') {
    text = localIndices.map((x, j) => Object.keys(p.groups[x.i]).map(key =>
      p.groups[x.i][key].prefix + String(data[j][key] ?? '')).join(p.newline)).join(p.newline + p.newline);
  } else {
    const filtered = p.matrix ? {...p, matrix:[p.header, ...localIndices.map(x => p.matrix[x.i + 1])]} : p;
    text = Core.serialize(filtered, data);
    return {name:file.name, text};
  }
  return {name:file.name, text:(p.encodingBOM ? '\uFEFF' : '') + text + (p.endNewline ? p.newline : '')};
}
function createPersonalImporter({requireAccess, chooseFiles, readFiles=readSelectedFiles, vault, webAccounts,
  now=Date.now, uuid=crypto.randomUUID} = {}) {
  const pending = new Map(), generations = new Map(), active = new Set();
  const invalidate = id => { pending.delete(id); generations.set(id, (generations.get(id) || 0) + 1); };
  async function scan(stage) {
    let site;
    try { site = await webAccounts(); }
    catch (_) { site = {records:[], complete:false, reason:'Website scan unavailable. Local banks were checked.'}; }
    const result = await vault.scanRows(stage.rows, site.records || [], true);
    const skipped = new Set(), conflicts = [];
    for (const group of result.duplicates) {
      const imported = group.items.filter(x => x.scope === 'import');
      if (!imported.length) continue;
      // Email reuse is valid across retailer pools. Target, Walmart and
      // Pokemon Center may intentionally share the same account email.
      // Only an existing profile in the SAME retailer pool is a duplicate.
      const samePool = item => {
        if (item.scope === 'import') return true;
        try { return retailerId(item.retailer) === stage.retailer; }
        catch { return false; }
      };
      const saved = group.items.filter(x => x.scope !== 'import' && samePool(x));
      const flagged = saved.length ? imported : imported.slice(1);
      for (const row of flagged) skipped.add(row.index);
      if (flagged.length) conflicts.push({email:stage.rows[imported[0].index].email, count:flagged.length,
        reason:saved.some(x => x.scope === 'aco' || x.scope === 'website') ? 'Already in this retailer customer or linked website pool' :
          saved.length ? 'Already in this Personal retailer pool' : 'Repeated within the selected files'});
    }
    const websiteComplete = site.complete === true;
    const fingerprint = JSON.stringify({skipped:[...skipped].sort((a,b)=>a-b), websiteComplete});
    return {skipped, fingerprint, summary:{token:stage.token, destination:'Personal only', retailer:stage.retailer,
      total:stage.rows.length, ready:stage.rows.length-skipped.size, skipped:skipped.size,
      files:stage.files.map(x=>({name:x.name, count:x.indices.length})), conflicts:conflicts.slice(0,50),
      websiteComplete, websiteReason:websiteComplete ? '' : (site.reason || 'Website Admin is not connected.'),
      sample:stage.rows.filter((_,i)=>!skipped.has(i)).slice(0,12).map(x=>({email:x.email,
        label:String(x.data.profile_name || x.data.profileName || x.data.name || x.email).slice(0,150)}))}};
  }
  async function choose(event, retailer) {
    requireAccess(event);
    const id = event.sender.id;
    if (active.has(id)) throw Error('Wait for the current Personal import to finish.');
    active.add(id); invalidate(id); const generation = generations.get(id);
    try {
      retailer = retailerId(retailer);
      const selection = await chooseFiles();
      requireAccess(event);
      if (generation !== generations.get(id)) throw Error('Personal import was cancelled or locked.');
      if (selection.canceled || !selection.filePaths?.length) return {cancelled:true};
      const entries = await readFiles(selection.filePaths);
      const stage = {...parseFiles(entries, retailer), token:uuid(), createdAt:now()};
      const checked = await scan(stage);
      requireAccess(event);
      if (generation !== generations.get(id)) throw Error('Personal import was cancelled or locked.');
      stage.fingerprint = checked.fingerprint;
      pending.set(id, stage);
      return checked.summary;
    } finally { active.delete(id); }
  }
  async function confirm(event, payload) {
    requireAccess(event); const id = event.sender.id;
    if (!payload || Object.keys(payload).some(k=>!['token','confirmPersonalOnly','skipDuplicates','acknowledgePartialScan'].includes(k)))
      throw Error('The Personal importer cannot accept another destination or replacement rows.');
    if (payload.confirmPersonalOnly !== true) throw Error('Confirm Personal only before importing.');
    const stage = pending.get(id);
    if (!stage || stage.token !== payload.token || now() - stage.createdAt > 10*60*1000)
      throw Error('This preview expired or was already used. Choose your files again.');
    if (active.has(id)) throw Error('A Personal import is already running.');
    active.add(id); const generation = generations.get(id);
    try {
      const checked = await scan(stage);
      requireAccess(event);
      if (pending.get(id) !== stage) throw Error('Personal import was cancelled or locked.');
      if (stage.fingerprint !== checked.fingerprint) {
        stage.fingerprint = checked.fingerprint;
        return {reviewRequired:true, preview:checked.summary};
      }
      if (checked.skipped.size && payload.skipDuplicates !== true) throw Error('Review the duplicate warnings and confirm skipping flagged profiles.');
      if (!checked.summary.websiteComplete && payload.acknowledgePartialScan !== true)
        throw Error('Acknowledge that the website duplicate check is incomplete.');
      const rows = stage.rows.filter((_,i)=>!checked.skipped.has(i)).map(x=>x.data);
      if (!rows.length) throw Error('No new profiles remain. Existing banks were not changed.');
      const entries = stage.files.map(f=>selectedFile(f,stage.rows,checked.skipped)).filter(Boolean);
      pending.delete(id);
      const result = await vault.importRows({scope:'personal', customerId:null, retailer:stage.retailer, rows,
        source:'personal-only-file-import', status:'active', personalImportGuard:true,
        beforeWrite:()=>{requireAccess(event);if(generation !== generations.get(id))throw Error('Personal import was cancelled before saving.');}});
      try { requireAccess(event); } catch (_) { return {saved:true, added:result.added.length, skipped:checked.skipped.size, locked:true}; }
      return {saved:true, added:result.added.length, skipped:checked.skipped.size, retailer:stage.retailer, entries};
    } finally { active.delete(id); }
  }
  return Object.freeze({choose, confirm, cancel:(event)=>{invalidate(event.sender.id);return {cancelled:true};}});
}
function registerPersonalImporter(options) {
  const importer = createPersonalImporter(options), {ipcMain} = options;
  ipcMain.handle('personal:profiles:choose', (event,retailer)=>importer.choose(event,retailer));
  ipcMain.handle('personal:profiles:confirm', (event,payload)=>importer.confirm(event,payload));
  ipcMain.handle('personal:profiles:cancel', event=>{options.requireOwner(event);return importer.cancel(event);});
  return importer;
}
module.exports = {createPersonalImporter, registerPersonalImporter, parseFiles, selectedFile};

