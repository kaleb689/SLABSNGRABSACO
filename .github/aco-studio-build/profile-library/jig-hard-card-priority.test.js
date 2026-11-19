'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const Policy=require(fs.existsSync(path.join(__dirname,'card-pool-policy.js'))?'./card-pool-policy':'../card-pool-policy');

test('Hard Cards are first, and regular card ordering is stable',()=>{
 let settings={};
 settings=Policy.toggle(settings,'4111111111111111',true);
 const cards=[{id:'regular-a',number:'5555555555554444'},{id:'hard',number:'4111111111111111'},{id:'regular-b',number:'378282246310005'}];
 assert.deepEqual(Policy.hardFirst(cards,settings).map(c=>c.id),['hard','regular-a','regular-b']);
 assert.deepEqual(cards.map(c=>c.id),['regular-a','hard','regular-b']);
});
test('Jig Studio exposes a persisted, optional Hard Card priority setting',()=>{
 const overlay=path.join(__dirname,'..','completed-profiles');
 const root=fs.existsSync(path.join(overlay,'profile-workshop-ui.js'))?overlay:path.join(__dirname,'..');
 const ui=fs.readFileSync(path.join(root,'profile-workshop-ui.js'),'utf8');
 const service=fs.readFileSync(path.join(root,'profile-workshop-service.js'),'utf8');
 assert.match(ui,/id="workshopHardCardPriority"/);
 assert.match(ui,/localStorage\.setItem\(hardPrioritySetting/);
 assert.match(ui,/prioritizeHardCards:\$\('workshopHardCardPriority'\)\.checked/);
 assert.match(service,/p\.prioritizeHardCards===false\?cards:CardPolicy\.hardFirst\(cards/);
 assert.match(service,/typeof p\.prioritizeHardCards!=='boolean'/);
 assert.match(service,/prioritizeHardCards:p\.prioritizeHardCards!==false/);
});
test('Hard Card eligibility remains one per retailer',()=>{
 const hard='4111111111111111',settings=Policy.toggle({},hard,true);
 const row={id:'target-existing',retailer:'target',data:{cc_number:hard}};
 assert.throws(()=>Policy.checkAllocation([row],'target',[hard],settings),/one per retailer/i);
 assert.doesNotThrow(()=>Policy.checkAllocation([row],'walmart',[hard],settings));
});
