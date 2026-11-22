import test from "node:test";
import assert from "node:assert/strict";
import { orderRaffleQueue, selectRaffleQuantity } from "../target-raffle-club.js";
const A="111111111111111111",B="222222222222222222",C="333333333333333333";
function item(){return {active:true,maxQty:10,entries:[]};}
const selection=(userId,qty,joinId)=>({userId,accountId:userId,name:"Member",qty,joinId});
test("requests are ordered by Discord interaction time, not alphabetical member name",()=>{
 const i=item();
 selectRaffleQuantity(i,selection(B,2,"222222222222222222"));
 selectRaffleQuantity(i,selection(A,1,"111111111111111111"));
 assert.deepEqual(orderRaffleQueue(i.entries).map(x=>x.userId),[A,B]);
});
test("changing quantity preserves original FIFO position",()=>{
 const i=item();
 selectRaffleQuantity(i,selection(A,1,"111111111111111111"));
 selectRaffleQuantity(i,selection(B,1,"222222222222222222"));
 const position=selectRaffleQuantity(i,selection(A,8,"333333333333333333"));
 assert.equal(position,1);
 assert.equal(orderRaffleQueue(i.entries)[0].qty,8);
 assert.equal(orderRaffleQueue(i.entries)[0].joinId,"111111111111111111");
});
test("quantity zero removes; rejoining moves member to back",()=>{
 const i=item();
 selectRaffleQuantity(i,selection(A,1,"111111111111111111"));
 selectRaffleQuantity(i,selection(B,2,"222222222222222222"));
 assert.equal(selectRaffleQuantity(i,selection(A,0,"333333333333333333")),0);
 assert.deepEqual(i.entries.map(x=>x.userId),[B]);
 selectRaffleQuantity(i,selection(C,1,"333333333333333333"));
 selectRaffleQuantity(i,selection(A,1,"444444444444444444"));
 assert.deepEqual(orderRaffleQueue(i.entries).map(x=>x.userId),[B,C,A]);
});
test("rejects invalid quantities and spoiled interactions",()=>{
 const i=item();
 assert.throws(()=>selectRaffleQuantity(i,selection(A,11,"111111111111111111")),/quantity/i);
 assert.throws(()=>selectRaffleQuantity(i,selection(A,-1,"111111111111111111")),/quantity/i);
 assert.throws(()=>selectRaffleQuantity(i,selection(A,1.5,"111111111111111111")),/quantity/i);
 assert.throws(()=>selectRaffleQuantity(i,selection(A,1,"not-a-snowflake")) ,/quantity/i);
});
test("closed queues reject new or updated requests",()=>{
 const i=item();
 selectRaffleQuantity(i,selection(A,1,"111111111111111111"));
 i.active=false;
 assert.throws(()=>selectRaffleQuantity(i,selection(A,2,"222222222222222222")) ,/closed/i);
 assert.equal(i.entries[0].qty,1);
});
test("selections are separate for each item",()=>{
 const i=item(),j=item();
 selectRaffleQuantity(i,selection(A,3,"111111111111111111"));
 selectRaffleQuantity(j,selection(A,5,"222222222222222222"));
 assert.equal(i.entries[0].qty,3);assert.equal(j.entries[0].qty,5);
});
