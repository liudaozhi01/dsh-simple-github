import test from 'node:test';
import assert from 'node:assert/strict';
import {createDockerSsh} from './docker-ssh.js';
test('SSH accepts only the exact installed release entry command grammar',async()=>{
 let n=0;
 const ssh=createDockerSsh({port:51234,bridge:async(path)=>{
  n++;return path.endsWith('/hosts')?{hosts:[{alias:'xian-oa-test',host:'119.45.50.213',user:'liudaozhi',port:22,auth:'key',proxyJump:[]}]}:{result:{exitCode:0,timedOut:false,truncated:false,stdout:'{}'}};
 }});
 const command="sudo -n /usr/bin/python3 -I /usr/local/libexec/xian-oa-release.py 'e30='";
 await ssh.exec({alias:'xian-oa-test',command});assert.equal(n,2);
 for(const bad of [command+'\n',command+'; echo bad',command.replace('e30=',"$(id)"),command.replace('release.py','other.py'),command.replace('python3 -I','python3')]) await assert.rejects(ssh.exec({alias:'xian-oa-test',command:bad}));
 assert.equal(n,2);ssh.close();
});
