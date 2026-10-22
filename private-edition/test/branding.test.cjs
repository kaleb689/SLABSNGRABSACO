"use strict";
const test=require("node:test");
const assert=require("node:assert/strict");
const fs=require("node:fs");
const path=require("node:path");
const read=name=>fs.readFileSync(path.join(__dirname,"..",name),"utf8");
test("ACO STUDIO customer UI uses only the new product name",()=>{
 const html=read("index.html"),main=read("main.cjs"),render=read("renderer.js"),pkg=require("../package.json");
 assert.equal(pkg.build.productName,"ACO STUDIO");
 assert.equal(pkg.version,"1.0.2");
 assert.match(html,/<title>ACO STUDIO<\/title>/);
 assert.match(main,/app\.setName\("ACO STUDIO"\)/);
 for(const text of [html,main,render]){
   assert.doesNotMatch(text,/ACO Studio Private Edition|PRIVATE EDITION|Private Edition settings/i);
   assert.doesNotMatch(text,/No Email Gen|No website admin|website administration|email generation|owner access/i);
 }
});
