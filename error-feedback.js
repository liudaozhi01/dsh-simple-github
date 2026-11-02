// Presentation only: never infer that a failed request rolled back a Git operation.
export function errorFeedback(value) {
 const raw=String(value||'未知错误');
 const detail=raw
  .replace(/https:\/\/[^\s'"<>]+/gi,url=>url.replace(/\/\/[^/@\s]+:[^/@\s]+@/,'//[已隐藏凭据]@').replace(/([?&](?:token|access_token|password|secret)=)[^&\s]+/gi,'$1[已隐藏]'))
  .replace(/\b(?:gh[pousr]_[A-Za-z0-9_]+|github_pat_[A-Za-z0-9_]+)\b/g,'[已隐藏令牌]')
  .replace(/\b(Bearer\s+)\S+/gi,'$1[已隐藏]')
  .replace(/\b((?:password|passwd|token|secret)\s*[:=]\s*)[^\s,;]+/gi,'$1[已隐藏]');
 const rules=[
  [/Repository, branch, HEAD or files changed|Files changed during|Index changed during|Branch changed during|Committed content differs/i,'CODE_CHANGED','操作已暂停：项目文件、分支或暂存状态发生了变化。请先点击「刷新改动」，确认后重试；不要删除本地修改。'],
  [/Another operation is running|Clone already running|已有.*任务正在执行/i,'OPERATION_BUSY','已有任务正在处理此项目。请等任务结束后重试，不要重复点击。'],
  [/Missing or invalid CSRF|CSRF token|refresh status/i,'PAGE_EXPIRED','面板的操作凭据已失效。请关闭并重新打开协作面板后重试。'],
  [/Sign in to GitHub first|No authenticated GitHub account|authentication required|not logged into/i,'LOGIN_REQUIRED','尚未完成 GitHub 登录，或授权已失效。请先点击「登录 GitHub」完成授权。'],
  [/GitHub CLI \(gh\) is not installed|ENOENT.*gh/i,'GH_MISSING','运行 DSH 的电脑未找到 GitHub 命令行工具。请按账号区域的安装指引安装，重启 DSH 后重新登录。'],
  [/HTTP 40[13]|permission denied|authentication failed|could not read Username|Resource not accessible/i,'ACCESS_DENIED','无法访问仓库或执行操作，可能是登录授权、仓库权限或本机文件权限不足。请核对当前账号和项目访问权限；仍失败时将技术详情交给维护者。'],
  [/Could not resolve host|ENOTFOUND|ECONNREFUSED|ECONNRESET|Failed to fetch|fetch failed|network|TLS|SSL|timed out|TimeoutError/i,'CONNECTION_FAILED','连接失败或等待超时。请检查运行 DSH 的电脑的网络及服务状态。若刚才正在推送或安装，请先核对结果，再决定是否重试。'],
  [/Directory must be absolute|Directory does not exist|Select the exact repository root|ENOENT.*(?:directory|scandir)/i,'PROJECT_DIRECTORY','项目目录无效或选到了项目子目录。请点击「选择目录」，选择包含 Git 仓库的项目根目录。'],
  [/Resolve merge conflicts first/i,'CONFLICT_UNRESOLVED','项目中仍有未处理的合并冲突。请先处理冲突并确认文件内容，再继续操作。'],
  [/non-fast-forward|fetch first|rejected.*push/i,'PUSH_REJECTED','远程分支可能已更新，本次推送被拒绝。请刷新改动、从 dev 拉取并处理合并结果，确认后再推送；不要强制推送。'],
  [/Untracked collision|Ignored\/untracked collision/i,'FILE_COLLISION','本地未跟踪或被忽略的文件与远程文件同名，无法安全合并。请先备份并检查这些文件，不要直接删除整个项目。'],
  [/Safe sync|Unsafe sync path|Intent-to-add|skip-worktree|assume-unchanged/i,'SYNC_UNSUPPORTED','当前文件类型或 Git 配置暂不支持安全同步。请保留现场，将技术详情交给维护者处理，不要重置项目。'],
  [/端口.*已被占用|EADDRINUSE/i,'PORT_BUSY','本地服务端口已被占用。请先停止此前启动的本地环境；若仍失败，请让维护者检查端口占用，不要随意结束其他进程。'],
  [/服务在就绪前退出|本地服务已退出/i,'SERVICE_EXITED','本地服务启动中或运行时退出。请展开「查看本地运行与检查日志」，确认前端还是后端失败，并将末尾错误提供给维护者。'],
  [/本地服务健康检查超时/i,'SERVICE_NOT_READY','本地服务未在规定时间内就绪。请查看运行日志，检查依赖下载、数据库连接和启动错误；不要连续重复启动。'],
  [/进程树清理未确认/i,'STOP_UNCONFIRMED','尚未确认旧服务已完全停止。请先点击「停止本地环境」并查看日志，确认后再启动新任务。']
 ];
 for(const [pattern,code,message] of rules)if(pattern.test(raw))return {code,message,detail};
 // Keep useful existing Chinese guidance; hide untranslated command output behind details.
 const chinese=/[\u3400-\u9fff]/.test(raw),english=/\b[A-Za-z]{4,}\s+[A-Za-z]{3,}/.test(raw);
 return {code:'UNCLASSIFIED',message:chinese&&!english?detail:'操作未确认完成。请查看技术详情；如果涉及提交、推送或安装，先核对实际结果，不要盲目重复操作。',detail};
}
