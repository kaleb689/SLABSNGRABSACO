'use strict';
// Inspect ZIP metadata BEFORE ditto extracts a downloaded, hash-verified app.
// Framework symlinks are necessary on macOS; only internal relative links are allowed.
const fs = require('node:fs/promises');
const path = require('node:path');
const zlib = require('node:zlib');
const MAX_ARCHIVE = 600 * 1024 * 1024;
const MAX_EXPANDED = 3 * 1024 * 1024 * 1024;
const ROOT = 'ACO Studio.app';
function safeName(name) {
  if (!name || /[\\\x00-\x1f\x7f:]/.test(name) || name.startsWith('/') || name.includes('//')) throw Error('Unsafe update archive path.');
  const parts = name.replace(/\/$/, '').split('/');
  if (parts.some(x => !x || x === '.' || x === '..') || parts[0] !== ROOT) throw Error('Update archive must contain only ACO Studio.app.');
  return name.replace(/\/$/, '');
}
async function bytes(handle, length, position) {
  const result = Buffer.alloc(length);
  const {bytesRead} = await handle.read(result, 0, length, position);
  if (bytesRead !== length) throw Error('Update ZIP is truncated.');
  return result;
}
async function inspectArchive(file) {
  const handle = await fs.open(file, 'r');
  try {
    const size = (await handle.stat()).size;
    if (size < 22 || size > MAX_ARCHIVE) throw Error('Update ZIP size is invalid.');
    const tailSize = Math.min(size, 65557), tail = await bytes(handle, tailSize, size-tailSize);
    let end = -1;
    for (let i=tail.length-22;i>=0;i--) {
      if(tail.readUInt32LE(i)===0x06054b50 && i+22+tail.readUInt16LE(i+20)===tail.length) {end=i;break;}
    }
    if(end<0)throw Error('Update ZIP directory is missing.');
    const count=tail.readUInt16LE(end+10), centralSize=tail.readUInt32LE(end+12), offset=tail.readUInt32LE(end+16);
    if(tail.readUInt16LE(end+4)||tail.readUInt16LE(end+6)||tail.readUInt16LE(end+8)!==count || !count || count>25000 || centralSize>16*1024*1024 || offset+centralSize>size-tailSize+end)
      throw Error('Multi-part, ZIP64, or oversized update ZIP is not supported.');
    const central=await bytes(handle,centralSize,offset), entries=[], names=new Set(), folded=new Set();
    let at=0,total=0;
    for(let i=0;i<count;i++) {
      if(at+46>central.length||central.readUInt32LE(at)!==0x02014b50)throw Error('Invalid ZIP directory entry.');
      const flags=central.readUInt16LE(at+8), method=central.readUInt16LE(at+10);
      const compressed=central.readUInt32LE(at+20), expanded=central.readUInt32LE(at+24);
      const n=central.readUInt16LE(at+28), x=central.readUInt16LE(at+30), c=central.readUInt16LE(at+32);
      const mode=(central.readUInt32LE(at+38)>>>16), local=central.readUInt32LE(at+42);
      if(at+46+n+x+c>central.length || flags&1 || ![0,8].includes(method) || compressed===0xffffffff || expanded===0xffffffff || local+30>offset)
        throw Error('Unsupported or corrupt update ZIP entry.');
      const rawName=central.subarray(at+46,at+46+n), raw=rawName.toString('utf8'), name=safeName(raw);
      if(!Buffer.from(raw,'utf8').equals(rawName)||names.has(name)||folded.has(name.toLowerCase()))throw Error('Duplicate or invalid Unicode ZIP path.');
      names.add(name);folded.add(name.toLowerCase());
      const type=mode&0xf000;
      if(type && ![0x8000,0x4000,0xa000].includes(type))throw Error('Special devices are not allowed in updates.');
      total+=expanded;
      if(total>MAX_EXPANDED)throw Error('Expanded update exceeds the allowed size.');
      const header=await bytes(handle,30,local);
      if(header.readUInt32LE(0)!==0x04034b50 || header.readUInt16LE(6)!==flags || header.readUInt16LE(8)!==method)throw Error('ZIP local header mismatch.');
      const ln=header.readUInt16LE(26), lx=header.readUInt16LE(28);
      if(!(await bytes(handle,ln,local+30)).equals(rawName))throw Error('ZIP entry names do not match.');
      const start=local+30+ln+lx;
      if(start+compressed>offset)throw Error('ZIP entry data exceeds the archive.');
      const entry={name,type};
      if(type===0xa000) {
        if(expanded>4096||compressed>8192)throw Error('Invalid framework symlink.');
        const data=await bytes(handle,compressed,start);
        const text=(method===8?zlib.inflateRawSync(data,{maxOutputLength:4096}):data).toString('utf8');
        if(!text||text.startsWith('/')||/[\\\x00-\x1f\x7f]/.test(text))throw Error('Absolute or unsafe framework symlink.');
        const resolved=path.posix.normalize(path.posix.join(path.posix.dirname(name),text));
        if(resolved!==ROOT&&!resolved.startsWith(ROOT+'/'))throw Error('Framework symlink escapes the app.');
      }
      entries.push(entry);at+=46+n+x+c;
    }
    if(at!==central.length)throw Error('Unexpected ZIP directory content.');
    const links=new Set(entries.filter(x=>x.type===0xa000).map(x=>x.name));
    for(const entry of entries) {
      let parent=path.posix.dirname(entry.name);
      while(parent!=='.') {
        if(links.has(parent))throw Error('ZIP writes through a framework symlink.');
        parent=path.posix.dirname(parent);
      }
    }
    for(const required of ['Contents/Info.plist','Contents/Resources/app/package.json','Contents/_CodeSignature/CodeResources'])
      if(!names.has(ROOT+'/'+required))throw Error('Update does not contain a complete signed application.');
    return {bundleName:ROOT,entries:count,expandedBytes:total};
  } finally { await handle.close(); }
}
async function verifyExtractedLinks(bundle) {
  const root=await fs.realpath(bundle);
  async function visit(dir) {
    for(const e of await fs.readdir(dir,{withFileTypes:true})) {
      const full=path.join(dir,e.name);
      if(e.isSymbolicLink()) {
        const resolved=await fs.realpath(full);
        if(resolved!==root&&!resolved.startsWith(root+path.sep))throw Error('Extracted framework link escapes the app.');
      } else if(e.isDirectory())await visit(full);
      else if(!e.isFile())throw Error('Extracted update contains a special file.');
    }
  }
  await visit(root);
}
module.exports={inspectArchive,verifyExtractedLinks,safeName,MAX_ARCHIVE,MAX_EXPANDED};
