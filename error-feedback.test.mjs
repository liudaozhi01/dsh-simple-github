import test from 'node:test';
import assert from 'node:assert/strict';
import {errorFeedback} from './error-feedback.js';
test('common failures explain next action while retaining diagnostic detail',()=>{
 for(const [raw,code] of [['Repository, branch, HEAD or files changed; refresh the preview before continuing','CODE_CHANGED'],['Sign in to GitHub first','LOGIN_REQUIRED'],['Failed to fetch','CONNECTION_FAILED'],['HTTP 403','ACCESS_DENIED'],['端口 5180 或 8081 已被占用；不会停止其他进程','PORT_BUSY'],['服务在就绪前退出','SERVICE_EXITED'],['本地服务健康检查超时','SERVICE_NOT_READY']]){
  const result=errorFeedback(raw);assert.equal(result.code,code);assert.match(result.message,/[\u3400-\u9fff]/);assert.equal(result.detail,raw);
 }
});
test('unknown errors do not assert success or rollback; sensitive details are redacted',()=>{
 const result=errorFeedback('fatal unexpected failure ghp_abc123 Bearer supersecret');
 assert.equal(result.code,'UNCLASSIFIED');assert.match(result.message,/核对实际结果/);assert.ok(!result.detail.includes('ghp_abc123'));assert.ok(!result.detail.includes('supersecret'));
 const url=errorFeedback('https://user:pass@example.com/path?token=secret');assert.ok(!url.detail.includes('user:pass'));assert.ok(!url.detail.includes('token=secret'));
});
