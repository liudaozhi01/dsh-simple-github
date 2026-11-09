import test from 'node:test';
import assert from 'node:assert/strict';
import {renderSchemaRefusal} from './panel.js';
import {schemaReviewMessage} from './schema-review-message.js';
const make=(tag,text,cls)=>({tag,text,cls,children:[],append(...nodes){this.children.push(...nodes);}});
test('schema refusal uses brief summary and collapsed semantic list, preserving every reason',()=>{
 const message=schemaReviewMessage('SCHEMA_REVIEW_V1:'+JSON.stringify({force:false,details:[{code:'TARGET_ONLY_TABLE',table:'access_role'},{code:'COLUMN_TYPE_MISMATCH',table:'org_employee',column:'id',fromType:'varchar(36)',toType:'bigint'}]}));
 const keys=[];const box=renderSchemaRefusal('发布未启动：'+message,make,key=>{keys.push(key);return make('details');});
 assert.match(box.children[0].text,/无法安全同步/);assert.ok(!box.children[0].text.includes('access_role'));
 const details=box.children[2];assert.equal(details.tag,'details');assert.notEqual(details.open,true);assert.equal(details.children[0].text,'查看具体原因（2 项）');
 assert.equal(details.children[1].tag,'ul');assert.equal(details.children[1].children.length,2);assert.match(details.children[1].children[1].text,/org_employee.id/);assert.deepEqual(keys,['schema-refusal-reasons']);
});
test('ordinary errors keep old path and unvalidated text is never rendered as schema list',()=>{
 assert.equal(renderSchemaRefusal('网络错误',make,()=>make('details')),undefined);
 assert.equal(renderSchemaRefusal('数据库结构差异需要人工审查，未执行 SQL、未删除数据。\n<script>\n本次结构同步已停止，仅展示原因，不执行自动处理。',make,()=>make('details')),undefined);
});
