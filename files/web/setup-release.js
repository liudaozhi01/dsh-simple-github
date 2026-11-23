import { openReleaseSsh } from './release.js';

const [user, privateKeyPath, fingerprint] = process.argv.slice(2);
if (process.argv.length !== 5 || !user || !privateKeyPath || !/^SHA256:[A-Za-z0-9+/]{43}$/.test(fingerprint || '')) {
  console.error('用法：node web/setup-release.js SSH用户名 私钥绝对路径 已核验的ED25519指纹');
  process.exitCode = 1;
} else {
  const ssh = openReleaseSsh();
  try {
    const scan = await ssh.scan();
    if (scan.fingerprint !== fingerprint) throw new Error('服务器指纹与输入值不一致，配置未保存');
    await ssh.trust({ fingerprint });
    await ssh.save({ user, privateKeyPath });
    const result = await ssh.test();
    console.log(result.message);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  } finally { ssh.close(); }
}
