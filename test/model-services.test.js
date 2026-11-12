import test from 'node:test';import assert from 'node:assert/strict';
import {openDb} from '../assistant/src/db.js';import {getSecret,setSecret} from '../assistant/src/integrations.js';
import {modelSettings,switchModel,modelCommand} from '../assistant/src/model-settings.js';
import {externalStatus,saveExternal,readExternal,sendDiscord} from '../assistant/src/external-services.js';
const key='ad'.repeat(32);
test('switch models without losing saved credentials or exposing them',()=>{
 const db=openDb(':memory:');switchModel(db,key,{provider:'openai',model:'fixture-model',api_key:'fixture-api-credential'});switchModel(db,key,{provider:'claude-cli'});
 assert.equal(modelSettings(db,key).provider,'claude-cli');assert.doesNotMatch(JSON.stringify(modelSettings(db,key)),/fixture-api-credential/);
 assert.match(modelCommand(db,key,'/model openai'),/openai/);assert.equal(getSecret(db,'config:model',key).api_key,'fixture-api-credential');
 assert.match(modelCommand(db,key,'/model codex'),/codex-cli/);assert.equal(modelCommand(db,key,'hello'),null);assert.match(modelCommand(db,key,'/model'),/Current model/);
 assert.throws(()=>switchModel(db,key,{provider:'unknown'}),/supported/);db.close();
});
test('connectors encrypt credentials, restrict destinations and keep Discord sending explicit',async()=>{
 const db=openDb(':memory:');saveExternal(db,key,'github',{credential:'fixture-token'});saveExternal(db,key,'notion',{credential:'fixture-notion'});
 assert.doesNotMatch(JSON.stringify(externalStatus(db,key)),/fixture-token|fixture-notion/);
 let called;const send=async(url,options)=>{called={url:String(url),options};return [{id:1,full_name:'owner/repo',html_url:'https://github.com/owner/repo'}];};
 const repos=await readExternal(db,key,'github',{},send);assert.equal(repos.items[0].title,'owner/repo');assert.match(called.url,/^https:\/\/api.github.com\//);
 const notion=await readExternal(db,key,'notion',{query:'test'},async()=>({results:[{id:'p1',properties:{Name:{type:'title',title:[{plain_text:'Page'}]}}}]}));assert.equal(notion.items[0].title,'Page');
 assert.throws(()=>saveExternal(db,key,'discord',{credential:'http://127.0.0.1/api/webhooks/123/token'}),/official/);
 saveExternal(db,key,'discord',{credential:'https://discord.com/api/webhooks/123456789/'+'a'.repeat(30)});
 await assert.rejects(()=>sendDiscord(db,key,{text:'hello'},send),/Confirm/);
 await sendDiscord(db,key,{text:'hello',confirmed:true},async(url,options)=>{assert.equal(new URL(url).searchParams.get('wait'),'true');assert.deepEqual(JSON.parse(options.body).allowed_mentions,{parse:[]});return {id:'fixture-message'};});
 db.close();
});
