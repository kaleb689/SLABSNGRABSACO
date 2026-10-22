"use strict";
const test=require("node:test"),assert=require("node:assert/strict");
const fs=require("node:fs"),path=require("node:path");
const {readSource,exportSource,changeRow}=require("../formats.cjs");
const base=path.resolve(__dirname,"..");
test("all original imported fields remain visible locally and available to export",()=>{
  const raw=JSON.stringify([{email:"synthetic@example.test",first_name:"Tester",card_number:"4242424242424242",
    security_code:"SAMPLE-CODE",card_expiry:"01/30",password:"fake-example"}]);
  const input=readSource("pkc.json",raw);
  assert.equal(input.rows[0].security_code,"SAMPLE-CODE");
  assert.equal(input.rows[0].card_number,"4242424242424242");
  assert.equal(exportSource(input),raw);
  const main=fs.readFileSync(path.join(base,"main.cjs"),"utf8");
  assert.ok(main.includes("Object.entries(row||{}).slice(0,50)"),
    "Do not omit imported card or security-code fields from the local profile inspector.");
  assert.ok(!main.includes("filter(([k])=>!/pass|card|cvv|security|pin/i.test(k)"));
});
test("security-code fields remain in original retailer export alongside profile card and address",()=>{
  const csv="email,address,card_number,card_expiry,security_code,cardholder\nsynthetic@example.test,12 Main St,,,,\n";
  const s=readSource("target.csv",csv);
  assert.equal(changeRow(s,0,{cardNumber:"4242424242424242",cardExpiry:"01/30",
    cardSecurityCode:"SAMPLE-123",cardholder:"Alex Test"}),4);
  const output=exportSource(s);
  assert.equal(output.split("\n")[0],csv.split("\n")[0]);
  assert.match(output,/4242424242424242,01\/30,SAMPLE-123,Alex Test/);
});
test("desktop enforces live server-permitted jig types before modifying profiles",()=>{
  const main=fs.readFileSync(path.join(base,"main.cjs"),"utf8");
  assert.match(main,/const forbidden=jigKeys\.filter/);
  assert.match(main,/if\(forbidden\.length\)throw Error/);
  assert.match(main,/JIG_EVENTS_URL/);
  const renderer=fs.readFileSync(path.join(base,"renderer.js"),"utf8");
  assert.match(renderer,/box\.hidden=!allowed/);
  assert.match(renderer,/api\.onJigPermissions/);
});
