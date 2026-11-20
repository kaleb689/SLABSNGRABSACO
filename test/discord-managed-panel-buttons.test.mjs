import test from "node:test";
import assert from "node:assert/strict";
import {managedPanelButtonsChanged} from "../discord-community.js";
import {dropControlRows} from "../discord-live-drop-recap.js";

const old={components:[{type:1,components:[{type:2,custom_id:"sngdrop:manual:open",label:"Create Manual Recap"}]}]};
const fresh={components:dropControlRows()};

test("existing owner controls refresh when Graphic Status is newly added",()=>{
  assert.equal(fresh.components.flatMap(x=>x.components).some(x=>x.custom_id==="sngdrop:graphic:status"),true);
  assert.equal(managedPanelButtonsChanged("owner-drop-controls",old,fresh),true);
});
test("unchanged pinned owner controls do not create a duplicate refresh",()=>{
  assert.equal(managedPanelButtonsChanged("owner-drop-controls",fresh,fresh),false);
});
test("label and disabled changes trigger safe component refresh",()=>{
  const newer={components:[{type:1,components:[{type:2,custom_id:"sngdrop:manual:open",label:"Create Manual Recap",disabled:true}]}]};
  assert.equal(managedPanelButtonsChanged("owner-drop-controls",old,newer),true);
});
test("other managed panels keep their existing update behavior",()=>{
  assert.equal(managedPanelButtonsChanged("unrelated-panel",old,fresh),false);
  assert.equal(managedPanelButtonsChanged("server-roles",old,fresh),true);
});
