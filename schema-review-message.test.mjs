import test from 'node:test';
import assert from 'node:assert/strict';
import {schemaReviewMessage} from './schema-review-message.js';
const encode=details=>'SCHEMA_REVIEW_V1:'+JSON.stringify({force:false,details});
test('structural schema diagnostics explain direction and survive second boundary',()=>{
 const message=schemaReviewMessage(encode([{code:'COLUMN_TYPE_MISMATCH',table:'org_employee',column:'id',fromType:'varchar(36)',toType:'bigint'},{code:'TARGET_ONLY_TABLE',table:'platform_account'}]));
 assert.match(message,/org_employee.id.*test varchar\(36\) → dev bigint/);assert.match(message,/platform_account/);assert.equal(schemaReviewMessage(message),message);
});
test('raw reasons SQL identifiers and forged formatted details remain private',()=>{
 assert.equal(schemaReviewMessage(encode([{code:'BOGUS',table:'secret'}])),undefined);
 assert.equal(schemaReviewMessage(encode([{code:'COLUMN_TYPE_MISMATCH',table:'a; DROP TABLE b',fromType:'varchar(36)',toType:'bigint'}])),undefined);
 assert.equal(schemaReviewMessage(encode([{code:'UNSUPPORTED_TYPE',table:'safe',fromType:'secret password',toType:'bigint'}])),undefined);
 const message=schemaReviewMessage(encode([{code:'UNSUPPORTED_METADATA',reason:'password=secret SELECT payroll',table:'safe'}]));assert.ok(!message.includes('secret'));assert.equal(schemaReviewMessage(message.replace('结构定义包含未支持的差异','password=secret')),undefined);
 assert.equal(schemaReviewMessage(encode(Array(13).fill({code:'UNSUPPORTED_METADATA'}))),undefined);
});
