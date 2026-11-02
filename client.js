window.__ModuleLoader__.load({
 id:'@local/dsh-simple-github',
 factory:require=>{
  const React=require('react');
  const inject=['slots','sidebarRight','sidebarRightTabs','remote','remote.pluginManager'];
  function apply(ctx){
   const id='@local/dsh-simple-github/panel',kind='simple-github';
   function Panel({sessionId}={}){
    const ref=React.useRef(null);
    React.useEffect(()=>{
     let cancelled=false,dispose;
     Promise.all([import('/simple-github/panel.js?v=0.8.0'),import('/simple-github/auto-install.js?v=0.8.0')]).then(([module,installer])=>{
      const autoInstaller=installer.createAutoInstaller(ctx.remote.pluginManager);
      if(!cancelled&&ref.current)dispose=module.mount(ref.current,{autoInstaller,getSessionId:()=>{const active=ctx.sidebarRight.mounted.getSnapshot();return sessionId&&active===sessionId?sessionId:null;}});
     }).catch(error=>{if(!cancelled&&ref.current)ref.current.textContent='GitHub 面板加载失败：'+error.message;});
     return()=>{cancelled=true;dispose?.();};
    },[sessionId]);
    return React.createElement('div',{ref,style:{height:'100%',overflow:'auto'}});
   }
   ctx.effect(()=>ctx.sidebarRightTabs.register({id,kind,title:()=> 'GitHub 协作',keepMounted:true,guide:[{id:'open',order:1,title:()=> 'GitHub 协作',description:()=> '登录 · 提交推送 · 合并 PR'}]}));
   ctx.effect(()=>ctx.slots.inject('sidebar.right.pane.tab',()=>ctx.slots.register({name:'sidebar.right.pane.tab',key:id},Panel)));
  }
  return {inject,apply};
 }
});
