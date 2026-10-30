// Run from the client, not the plugin's disposable HTTP handler. The host owns
// the installation request even when HMR unmounts this panel. Never uninstall self.
const KEY = 'simple-github:update-install:v1';
let active;
const failure = message => new Error(String(message || '宿主安装请求失败'));
function unwrap(reply) {
  if (!reply?.ok) throw failure(reply?.error?.message);
  return reply.value;
}
export function installationOutcome(result) {
  if (result?.bundle !== '@local/dsh-simple-github') throw failure('宿主未确认目标插件，安装结果未知，请在插件管理中核对，勿重复安装');
  switch (result.application) {
    case 'applied': return {installed:true,message:'插件更新已应用，请重新打开协作面板确认版本。',restartRequired:false};
    case 'restart-required': return {installed:true,message:'插件已安装，请手动重启 DSH 后确认版本。',restartRequired:true};
    case 'failed': throw failure(result.error?.message || '插件安装失败，请在插件管理中查看详情');
    case 'cancelled': throw failure('安装已取消，请在插件管理中核对当前版本');
    default: throw failure('插件未确认生效，请在插件管理中核对，勿重复安装');
  }
}
export function createAutoInstaller(manager, storage = globalThis.sessionStorage) {
  const save = value => { storage?.setItem(KEY, JSON.stringify(value)); };
  const load = () => { try { return JSON.parse(storage?.getItem(KEY) || 'null'); } catch { return null; } };
  return {
    status: load,
    async install({manualInstallPath, version}) {
      if (!manager?.installBundle || !manager?.inspect) throw failure('宿主未提供官方安装接口，请使用插件管理安装');
      if (active || ['pending','unknown'].includes(load()?.state)) throw failure('已有安装请求或结果尚未确认，请在插件管理中核对，勿重复安装');
      if (typeof manualInstallPath !== 'string' || !(/^(?:\/|[A-Za-z]:[\\/])/.test(manualInstallPath)) || !manualInstallPath.endsWith('.tgz')) throw failure('更新安装包路径无效');
      if (!storage) throw failure('无法保存安装状态，请使用官方插件管理安装');
      const requestId = globalThis.crypto.randomUUID();
      save({state:'pending',requestId,version,message:'正在安装更新；如面板重载，请重新打开查看结果。'});
      active = true;
      let submitted = false;
      try {
        const inspected = unwrap(await manager.inspect(manualInstallPath, {}));
        if (inspected?.status !== 'accepted') throw failure(inspected?.reason || '宿主拒绝此安装包');
        // Unique downloaded tarball spec; retain normal compatibility/build checks.
        submitted = true;
        const reply = await manager.installBundle(manualInstallPath, {enabled:true,saveExact:true,requestId});
        if (!reply?.ok) { save({state:'unknown',requestId,version,message:'未收到安装结果，请在插件管理核对，勿重复安装。'}); throw failure(reply?.error?.message || '安装结果未知'); }
        const result = unwrap(reply);
        const outcome = installationOutcome(result);
        save({state:'done',requestId,version,...outcome});
        return outcome;
      } catch (error) {
        if (load()?.state !== 'unknown') save({state:submitted?'unknown':'rejected',requestId,version,message:'安装未确认完成：'+error.message+'；请在插件管理核对，勿重复安装。'});
        throw error;
      } finally { active = false; }
    },
    async reconcile() {
      const record = load();
      if (record?.state !== 'pending' || !manager?.waitForInstall) return record;
      try {
        const result = unwrap(await manager.waitForInstall(record.requestId));
        if (result === null) { save({...record,state:'unknown',message:'安装结果未知，请在插件管理确认版本，勿重复安装。'}); }
        else save({...record,state:'done',...installationOutcome(result)});
      } catch (error) { save({...record,state:'unknown',message:error.message}); }
      return load();
    },
  };
}
