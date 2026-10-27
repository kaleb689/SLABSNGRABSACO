'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {parse}=require('../account-login-parser');
test('Pasted account pairs accept single or triple colon, semicolon, CSV, pipe and tabs',()=>{
 const rows=parse([
  'A@example.test:pass:with:colons',
  'B@example.test:::abc;def',
  'C@example.test; p@ss:word;ok',
  'D@example.test, space less',
  'E@example.test | xyz123',
  'F@example.test\tthis-is-a-password'
 ].join('\n'));
 assert.deepEqual(rows,[
  {email:'a@example.test',password:'pass:with:colons'},
  {email:'b@example.test',password:'abc;def'},
  {email:'c@example.test',password:'p@ss:word;ok'},
  {email:'d@example.test',password:'space less'},
  {email:'e@example.test',password:'xyz123'},
  {email:'f@example.test',password:'this-is-a-password'}
 ]);
});
test('Optional CSV header and blanks do not create accounts',()=>{
 assert.deepEqual(parse('email,password\n\nTEST@example.test, p@ss\n'),[{email:'test@example.test',password:'p@ss'}]);
});
test('Reject invalid or repeated logins atomically without exposing passwords in errors',()=>{
 for(const raw of [
  'nonsense', 'missing@example.test:', 'no-email:private',
  'x@example.test:valid\nX@example.test;other',
  'good@example.test:okay\nbad line with password',
  'x@example.test:'+ 'p'.repeat(501)
 ]){
  assert.throws(()=>parse(raw),e=>{assert.doesNotMatch(e.message,/private|valid|other|okay|p{20}/);return true;});
 }
 assert.throws(()=>parse('x@example.test:abc\n'.repeat(501)),/1-500/);
});
