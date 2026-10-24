"use strict";
const test=require("node:test"),assert=require("node:assert/strict");
const {readSource,exportSource,changeRow}=require("../formats.cjs");
const {jigProfile,jigAddress}=require("../jigs.cjs");
test("unaltered JSON remains byte-for-byte, preserving retailer JSON structures",()=>{
 const original='{\n  "name": "Target Profiles",\n  "profiles": [{"email":"a@example.test","address":"87th Street"}],\n  "meta":{"version":2}\n}\n';
 const source=readSource("style1-target.json",original);
 assert.equal(exportSource(source),original);
 changeRow(source,0,{address:"87th St"});
 const output=JSON.parse(exportSource(source));
 assert.equal(output.meta.version,2);assert.equal(output.profiles[0].address,"87th St");
 assert.equal(output.profiles[0].email,"a@example.test");
 assert.equal(output.name,"Target Profiles");
});
test("Walmart CSV preserves headers, delimiter, extension and quoted fields",()=>{
 const original='email;street_address;note\r\nuser@example.test;"12, Elm St";"has ""quoted"" text"\r\n';
 const source=readSource("style2-walmart.csv",original);
 assert.equal(exportSource(source),original);
 assert.equal(changeRow(source,0,{address:"12 Elm Road"}),1);
 assert.equal(exportSource(source),'email;street_address;note\r\nuser@example.test;12 Elm Road;"has ""quoted"" text"\r\n');
});
test("unknown source format remains unchanged and noneditable",()=>{
 const raw="unusual binary-ish source \u0000 nonformat";
 const s=readSource("custom.xyz",raw);assert.equal(exportSource(s),raw);
 assert.throws(()=>changeRow(s,0,{address:"changed"}),/not editable/);
});
test("duplicate retailer emails remain independent imported records",()=>{
 const f=readSource("target.json",'[{"email":"same@example.test"},{"email":"same@example.test"}]');
 assert.equal(f.rows.length,2);
 assert.equal(exportSource(f),'[{"email":"same@example.test"},{"email":"same@example.test"}]');
});
test("retailer address jig only edits available fields and preserves file envelope",()=>{
 const f=readSource("sams.json",JSON.stringify({profiles:[{email:"a@example.test",address:"10 Main Street",phone:"9540000000"}]}));
 const result=jigProfile(f,0,{suffix:true});assert.equal(result.count,1);
 assert.match(f.rows[0].address,/St$/);assert.equal(JSON.parse(exportSource(f)).profiles[0].email,"a@example.test");
});
test("random units apply only when a profile has no existing unit",()=>{
 const f=readSource("costco.json",'[{"address":"10 Main Street","address2":"Apt 200"}]');
 jigProfile(f,0,{randomUnit:true});assert.equal(f.rows[0].address2,"Apt 200");
});
test("all supported import formats export the unchanged original bytes",()=>{
 for(const [file,raw]of [["pkc.tsv","email\tstreet\nabc@example.test\t5 Bay Rd\n"],["misc.txt","Some original opaque note\r\nSecond line\r\n"],["target.csv","accountEmail,address\r\na@b.com,9 Street\r\n"]])
   assert.equal(exportSource(readSource(file,raw)),raw);
});

test("card/address bank allocation keeps imported CSV column names and order",()=>{
 const raw="email,street_address,card_number,card_expiry,cardholder,billing_address\nu@example.test,10 Main St,,,,\n";
 const source=readSource("walmart-bank-style.csv",raw);
 assert.equal(changeRow(source,0,{address:"42 Road",cardNumber:"4111111111111111",cardExpiry:"12/29",cardholder:"Jordan Lane",billingAddress:"42 Road"}),5);
 const out=exportSource(source);
 assert.equal(out.split("\n")[0],raw.split("\n")[0]);
 assert.match(out,/u@example\.test,42 Road,4111111111111111,12\/29,Jordan Lane,42 Road/);
});
test("name jig synchronizes cardholder first and last within source schema",()=>{
 const src=readSource("target-names.json",'[{"first_name":"Old","last_name":"Name","cardholder":"Old Name"}]');
 const result=jigProfile(src,0,{name:true});
 assert.equal(result.count,3);
 assert.equal(src.rows[0].cardholder,src.rows[0].first_name+" "+src.rows[0].last_name);
});


test("Choose file format preserves a legacy Security Code column and leading zeros",()=>{
 const original="email,CVV,card_number\r\nuser@example.test,0044,4242424242424242\r\n";
 const source=readSource("legacy.csv",original);
 const {exportAs}=require("../formats.cjs");
 assert.equal(exportAs(source,"original").content,original);
 for(const type of ["csv","json","tsv","txt"]){
  const output=exportAs(source,type);
  assert.ok(output.filename.endsWith("."+type));
  assert.match(output.content,/0044/);
  assert.match(output.content,/4242424242424242/);
 }
 assert.equal(source.rows[0].CVV,"0044");
 assert.equal(source.changed,false);
});
