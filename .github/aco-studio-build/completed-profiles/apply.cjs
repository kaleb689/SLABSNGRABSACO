'use strict';
const fs=require('node:fs'),path=require('node:path');
const root=path.resolve(process.argv[2]);
for(const file of ['profile-vault.js','profile-workshop-service.js','profile-workshop-ui.js','profile-bank-ui.js','profile-draft-core.js','profile-completion-core.js','email-vault-ui.js','account-login-parser.js'])fs.copyFileSync(path.join(__dirname,file),path.join(root,file));
fs.copyFileSync(path.join(__dirname,'profile-completion.test.js'),path.join(root,'tests/profile-completion.test.js'));
fs.copyFileSync(path.join(__dirname,'account-login-parser.test.js'),path.join(root,'tests/account-login-parser.test.js'));
const indexPath=path.join(root,'index.html'),html=fs.readFileSync(indexPath,'utf8'),script='<script src="email-vault-ui.js"></script>';
if(html.split(script).length!==2)throw Error('Account paste integration anchor changed');
fs.writeFileSync(indexPath,html.replace(script,'<script src="account-login-parser.js"></script>\n'+script));
const p=path.join(root,'package.json'),pkg=JSON.parse(fs.readFileSync(p,'utf8'));if(!pkg.build.files.includes('profile-completion-core.js'))pkg.build.files.push('profile-completion-core.js');
if(!pkg.build.files.includes('account-login-parser.js'))pkg.build.files.push('account-login-parser.js');fs.writeFileSync(p,JSON.stringify(pkg,null,2)+'\n');
console.log('Completed Profiles section, readiness checklist, unused pool indicators and authorized full card views applied.');


fs.copyFileSync(path.join(__dirname,'pool-generation.test.js'),path.join(root,'tests','pool-generation.test.js'));
