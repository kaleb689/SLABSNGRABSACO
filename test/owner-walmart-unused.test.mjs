import test from 'node:test';
import assert from 'node:assert/strict';
import {ownerWalmartUnused} from '../owner-walmart-unused.js';
import fs from 'node:fs';
const source=fs.readFileSync(new URL('../server.js',import.meta.url),'utf8');
const base=[
 {id:'w1',walmart:{username:'one@example.test',password:'pass1'}},
 {id:'w2',walmart:{username:'two@example.test',password:'pass2'}},
 {id:'w3',walmart:{username:'three@example.test',password:'pass3'}},
 {id:'w4',walmart:{username:'four@example.test',password:'pass4'},needsRepair:true},
 {id:'w5',walmart:{username:'one@example.test',password:'pass5'}},
 {id:'w6',walmart:{username:'six@example.test',password:'pass6'}}
];
const options={managed:base,free:[{managedAccountId:'w2',customerAccountId:'customer1',active:true}],rented:[],holds:['w3'],duplicates:[],linked:a=>a.active===true&&!!a.customerAccountId,decrypt:a=>({walmart:a.walmart})};
test('only unassigned unheld nonduplicate healthy Walmart logins belong to Personal Unused',()=>{
 const result=ownerWalmartUnused(options);
 assert.deepEqual(result.accounts.map(x=>x.email),['one@example.test','six@example.test']);
 assert.equal(result.accounts[0].password,'pass1');
 assert.equal(result.counts.assigned,1);
 assert.equal(result.counts.held,1);
 assert.equal(result.counts.needsRepair,1);
 assert.equal(result.counts.duplicate,1);
 assert.equal(base[1].walmart.username,'two@example.test');
});
test('no Walmart account becomes available to customer assignment or signup',()=>{
 assert.match(source,/const retailers=\["target","pokemoncenter"\]/);
 assert.match(source,/if\s*\(normalizedRetailer === "walmart"\) return \[\];/);
 assert.match(source,/\/api\/admin\/owner-walmart-unused\/export/);
 assert.match(source,/ownerWalmartUnused\(/);
});
