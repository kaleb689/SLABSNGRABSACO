"use strict";

// An intentional reuse is one additional selected profile with the same complete
// shipping address as an earlier selected profile (including address line 2).
const fields=["address","unit","city","state","zip"];
const normalized=value=>String(value??"").trim().replace(/\s+/g," ").toUpperCase();
function addressKey(address){
  return fields.map(field=>normalized(address?.[field])).join("\u001f");
}
function distinctAddresses(addresses){
  const seen=new Set();
  const unique=[];
  for(const entry of (Array.isArray(addresses)?addresses:[])){
    if(!normalized(entry?.address))continue;
    const key=addressKey(entry);
    if(!seen.has(key)){seen.add(key);unique.push({...entry});}
  }
  return unique;
}
function planAddressAssignments(addresses,profileCount,duplicateCount=0){
  if(!Number.isSafeInteger(profileCount)||profileCount<1||profileCount>2500)
    throw Error("Choose between 1 and 2,500 profiles.");
  if(!Number.isSafeInteger(duplicateCount)||duplicateCount<0||duplicateCount>=profileCount)
    throw Error("Choose a duplicate count between 0 and one less than the selected profile count.");
  const uniqueRequired=profileCount-duplicateCount;
  const unique=distinctAddresses(addresses);
  if(unique.length<uniqueRequired){
    throw Error("Only "+unique.length+" distinct shipping address(es) are available. "+uniqueRequired+
      " are required to create exactly "+duplicateCount+" duplicate profile address(es). "+
      "Add more unique addresses or explicitly increase the duplicate count.");
  }
  const selected=unique.slice(0,uniqueRequired);
  // Distribute intentional repeats across the selected unique addresses; the
  // final duplicateCount rows use EXACTLY the same full shipping fields.
  const assignments=Array.from({length:profileCount},(_,position)=>
    position<uniqueRequired ? selected[position] : selected[(position-uniqueRequired)%uniqueRequired]);
  return {assignments,uniqueRequired,duplicates:duplicateCount};
}
module.exports={addressKey,distinctAddresses,planAddressAssignments};
