# 协作插件开发交接：dev 远程部署

> **历史交接（2026-11-02）**：本文描述旧的本地构建/systemd dev 部署，不是当前默认发布方案。最新状态、服务器证据、未决事项及临时 Docker 发布链路见 [2026-11-03 最新交接](开发交接-临时Docker发布-2026-11-03.md)。下文的版本、支持范围和调用链仅作为历史保留。

更新时间：2026-11-02（Asia/Shanghai）

## 1. 用户目标与当前结论

用户要求在协作插件中加入真正的「部署到 dev」功能，不能仅向 AI 发送部署计划。当前只支持 dev，不扩展 test、生产或其他主机。

**当前状态：源码实现和针对性验证完成；未发布新版本、未替换当前安装的插件、未进行真实部署或浏览器验收。** 不要把测试通过、上传成功或打包预检当作部署成功。

## 2. 项目与运行位置

- 工作区：`/Users/mac/Desktop/西安OA工具开发`
- 插件源码/Git 仓库：`/Users/mac/Desktop/西安OA工具开发/github协作插件`
- GitHub：`https://github.com/liudaozhi01/dsh-simple-github`（已由用户明确授权改为公开仓库）
- 源码版本仍为 `0.10.0`；线上已发布版本为 `v0.10.0`，不包含本次直接部署功能。
- 本轮使用的 DSH GUI：`http://127.0.0.1:60582`。后续会话必须以最新 runtime context 为准，不硬编码旧端口。
- SSH 插件安装位置：`/Users/mac/.dsh/profiles/desktop/node_modules/@linxin666/dsh-ssh/lib/index.js`，仅检查和复用接口，未修改。

开发前必须读取工作区 AGENTS.md 及 `.agents/skills/xian-oa-development/SKILL.md`，按需读取 references。不要更改 OA 业务代码、共享服务或 SSH 插件来绕过本功能限制。新增依赖、真实部署、发布、推送、重启需要对应明确授权。

## 3. 实际入口和调用链

`client.js` 挂载 `panel.js` → 「远程部署」页 → `index.js` 的 CSRF 保护接口 → `native-dev-deploy.js` → 当前 DSH 端口的 loopback SSH HTTP 接口。

新增接口均为 POST，保留原 loopback/origin/method/CSRF 限制：

- `/simple-github/api/remote-dev-check`
- `/simple-github/api/remote-dev-start`
- `/simple-github/api/remote-dev-status`

工厂协议：

```js
createNativeDevDeploy({ inspect, port, redact }, deps = {})
// inspect 复用 createService().inspect；port 是整数，不是函数。
// 返回：
{
  check({ directory, head, fingerprint }),
  start({ planId, confirmation: true, databaseRiskAccepted: true }),
  status({ jobId? }),
  close()
}
```

- check：只读；核对 dev 分支、精确仓库目录、HEAD、文件指纹、冲突、SSH 身份和远端配置；返回 5 分钟有效的一次性 planId、summary、risks。
- start：消费计划，异步执行；两项确认缺一不可。注意字段是 `confirmation`，不是 `confirmed`。
- status：返回 `state: idle/running/succeeded/failed`、phase、logs、error、remoteState、backupPath 等。正在运行的任务由前端每 2 秒轮询；卸载面板清理轮询，不等于撤销远程命令。
- close：终止本地资源；已经提交的远程操作可能继续，不能承诺取消服务器操作。

兼容保留 `remote-deploy.js` 和 `/remote-deploy-notify` 的 AI 会话计划入口；它们不是真正的直接部署引擎。

## 4. 固定 dev 目标与只读核验事实

- alias：`xian-oa-test`
- host：`119.45.50.213`
- SSH user：`liudaozhi`
- dev 根目录：`/opt/xian-oa-dev`
- 后端：`/opt/xian-oa-dev/app.jar`
- 前端：`/opt/xian-oa-dev/web`
- systemd：`xian-oa-dev.service`
- 服务账号：`xian-oa-dev`
- 后端端口：`8082`
- 前端端口：`18081`
- 服务 WorkingDirectory：`/opt/xian-oa-dev`
- 服务单元：`/etc/systemd/system/xian-oa-dev.service`
- 现有配置：`/etc/xian-oa-dev/app.env`，SERVER_PORT=8082；配置内容和凭据不输出。

真实只读检查发现：dev 根目录、jar、web 均 root 所有；普通 SSH 用户不可直接替换。因此最终引擎通过固定 `sudo -n /usr/bin/python3 -I -c ...` 做检查/发布，而不是修改服务器权限。现有 sudo Python 能力已只读核验。服务 ExecStart 没有显式 `--server.port`，端口来自现有环境文件。实现已经适配此事实；早期「要求 liudaozhi 可写目录 / 命令行显式端口」的限制已被替换，不要照旧方案改服务器。

禁止操作另一个目录 `/opt/xian-oa`、`xian-oa.service`、后端 8081 或其他环境。本轮没有改服务器配置、上传、备份、重启或真实部署。

## 5. 部署流程及安全边界

1. 检查固定团队仓库、dev 分支和源码快照；计划只用一次，过期或源码变化拒绝。
2. 用户单独接受数据库启动风险，再确认构建和发布。
3. 使用现有工具发现逻辑，核对 Maven 实际使用 Java 21。
4. 执行 `npm run build` 与 `mvn -B -f backend/pom.xml package`（不跳过后端测试）。不自动 npm install、安装系统软件或注入本地数据库设置。只运行可信项目；测试环境必须先核对为隔离数据库。
5. 收集 dist 和唯一后端 jar；拒绝链接/特殊文件，限制大小和条目；只打包 app.jar 与 web，不复制仓库环境配置或本地数据库密码。
6. 生成 UUID 暂存目录 `/tmp/dsh-xian-oa-dev-<jobId>`，复用 SSH 插件原始 body 上传接口。
7. SHA256 固定归档字节；远端 O_NOFOLLOW 打开并有界读取归档，哈希与解包使用同一份 bytes；逐条校验归档路径、类型、大小后手动解包。
8. 固定根目录 flock + 持久 started/failed/completed 标记，避免 SSH 重放同一任务再次覆盖。
9. 备份 `/opt/xian-oa-dev/.dsh-native-backup-<jobId>`，仅替换 app.jar 与 web；仅重启 dev 服务。
10. 检查后端 `/api/v1/health` 真正 2xx、前端 200 和已构建首页摘要；401/403 不算健康成功，不跟随重定向。
11. 远程响应不确定时仅做只读标记查询，不重发覆盖/上传/重启，不自动回退。

重要限制：文件切换不是跨前后端原子事务；异常可能部分替换。备份不包含数据库，初始化/迁移副作用不能靠文件回退撤销。服务 hooks/drop-ins 等不符合预期时拒绝。外部不遵守锁的操作、SSH 主机配置变化仍有竞态；连接身份检查不是新增主机密钥认证体系。归档暂存、备份和标记保留，未提供自动清理或一键回退。宿主重启后内存任务状态不恢复，不要显示「无任务」就推断之前未执行；需人工核对持久标记和服务状态。

## 6. 文件清单及改动归因

本次直接部署任务新增/继续修改：

| 文件（相对插件根目录） | 内容 |
| --- | --- |
| `native-dev-deploy.js` | 新增直接部署引擎、SSH HTTP 桥接、检查/构建/上传/备份/发布/健康确认 |
| `native-dev-deploy.test.mjs` | 新增 12 项引擎测试、生成 Python AST 校验、localhost 桥接测试 |
| `index.js` | 在已有 AI 通知接口基础上接入 native check/start/status，注册关闭清理 |
| `panel.js` | 在已有远程部署页中新增直接检查、风险确认、执行、状态轮询与结果 |
| `sidebar-ui.test.mjs` | 新增直接部署确认门禁测试 |
| `update-route.test.mjs` | 将新接口纳入请求安全测试 |
| `package.json` | 将 native 引擎纳入 files；仍是 0.10.0，无新增依赖 |
| `README.md` | 增加直接 dev 部署操作及风险说明 |
| `开发交接-dev远程部署.md` | 本交接文件 |

任务开始前工作区已有、不得全部归因本次：`index.js`、`package.json`、`panel.js`、`panel.css`、`panel.test.mjs` 的 AI 计划入口/导航相关改动，以及未跟踪 `remote-deploy.js`、`remote-deploy.test.mjs`。这些均保留。本次没有额外改 panel.css 或 panel.test.mjs（已有差异仍存在）。

已有未跟踪旧安装包 `local-dsh-simple-github-0.1.0.tgz`、`local-dsh-simple-github-0.2.0.tgz`、`local-dsh-simple-github-0.5.0.tgz` 保留，不要 `git add .` 或 `git add -A` 把旧包混入提交。

所有写入位于协作插件目录；未修改 OA 业务源码、SSH 插件或 DSH 宿主。运行时复用 SSH 插件，实际发布会影响 dev 共享服务，需用户执行确认。

## 7. 已执行验证

最终针对性命令：

```sh
node --test native-dev-deploy.test.mjs sidebar-ui.test.mjs panel.test.mjs update-route.test.mjs remote-deploy.test.mjs
# 40/40 通过，exit 0
node --check index.js
node --check panel.js
node --check native-dev-deploy.js
npm pack --dry-run
git diff --check
# 均通过
```

引擎测试含 mocked 发布链路、安全拒绝、计划一次性/过期、快照变化、断线只读确认、链接产物拒绝、关闭资源、localhost 原始上传及 NDJSON 失败、构建命令/Java21、Python 代码语法。不是实际远端部署或 OA 构建验收。

另外使用真实当前 DSH loopback SSH 桥接执行 **check-only**：本地 inspect 为合成身份，未使用真实 OA 源码；远端真实只读预检查成功。它证明当时 SSH HTTP 契约、sudo、固定 dev 服务及端口检查可运行，不证明真实项目构建/上传/发布成功。检查后关闭工厂，未调用 start。

未跑完整 npm test（历史 Git 测试耗时长，用户不希望扩大慢操作）；未运行真实 OA npm/Maven 构建、真实发布、浏览器视觉及交互验收。

## 8. 后续建议与授权点

1. 继续前先检查当前 Git 状态和本文件所述源码，保留未提交改动。若需要更改其他模块先确认。
2. 用户若要求安装包/上传新版：先明确版本（源码仍 0.10.0，不要覆盖线上同版本冒充更新），同步 package、client/panel 缓存参数及对应测试，针对性验证后再打包/发布。当前未执行此步骤。
3. 用户若授权真实部署验收：核对真实本地 OA 目录、dev 分支、源码快照、构建配置、隔离测试数据库和启动迁移风险，先 check，再让用户确认准确目标与计划；不能沿用只读探针的合成本地身份进行部署。
4. 真实测试时核对发布后前后端、服务账号可读权限、Nginx 静态资源以及故障状态；失败先保留现场与备份，不自动改数据库或其他环境。
5. 历史 Windows 用户的 index.js 错误尚缺完整堆栈和 DSH 版本，未凭猜测修复，属于独立待补信息。

## 9. 插件报错自动通知（2026-11-02 增补）

用户追加需求：插件提示报错时，自动发送报错信息到当前 AI 会话。

- 源码已接通 `panel.js` 的统一错误展示与 `POST /simple-github/api/error-notify`；覆盖操作异常、更新错误、本地环境错误及 dev 远程部署 failed/uncertain 状态。不是全局浏览器或其他插件错误监听，也不覆盖面板模块加载前的宿主加载失败。
- `error-notice.js` 复用既有 `agent.followup` 和 notice 消息协议，发送功能上下文、错误分类、脱敏技术详情；不附带完整运行日志、环境变量或项目文件。通知只请求分析和只读排查，不授权修复、部署或重试操作。
- 前端按当前会话/相同错误五分钟去重；服务端按会话/功能/脱敏详情五分钟去重、合并并发请求，缓存和并发均限制 128 项。前后端各做脱敏；服务端额外去除 ANSI 控制序列。规则脱敏无法保证识别任意未知格式的敏感信息。
- 没有当前会话或 CSRF 凭据时不发送，错误卡片保留手动复制提示；发送失败保留技术详情并提示手动复制，不递归触发报错、不自动重试原操作。发送失败的前端记录也保留五分钟以避免轮询刷请求。
- 保留 loopback/origin/POST/CSRF 防护，检查目标 agent/session 身份，不发送到其他会话。卸载后不再更新提示，但已经提交的通知不能撤回。
- 本轮新增 `error-notice.js`、`error-notice.test.mjs`；继续修改 `panel.js`、`index.js`、`package.json`、`sidebar-ui.test.mjs`、`update-route.test.mjs` 及本交接文档。未改样式、OA 代码、DSH 宿主或 SSH 插件；既有工作区修改保留。
- 验证：`node --test error-notice.test.mjs sidebar-ui.test.mjs panel.test.mjs update-route.test.mjs remote-deploy.test.mjs native-dev-deploy.test.mjs` 最终 54/54 通过；`node --check panel.js`、`node --check index.js`、`node --check error-notice.js`、`npm pack --dry-run`、`git diff --check` 均通过。初次测试发现仅含 ANSI 的消息被转换为“未知错误”，已修正为拒绝空详情后复测通过。未跑全量 npm test。
- 源码仍为 0.10.0；未发布、安装或替换运行中插件。因此当前已安装插件不会仅因本次源码修改就自动获得功能；尚未做真实 GUI/会话通知验收。

## 10. 发布历史的易错点

- Git push 历史使用 `git -c credential.helper= -c 'credential.helper=!gh auth git-credential' push origin main`，避免旧系统凭据；是否推送仍需当前授权。
- gh release 的 `--target` 用完整 `git rev-parse HEAD`，短 SHA 曾触发 HTTP422。
- `npm pack --dry-run` 只预检，本次未产生新版可安装 tgz。
- 过去安装显示旧版本的根因是 DSH node_modules 开发软链接仍指向旧源码，而非简单页面缓存。后来通过独立 release-copy 修复过一次；不能只看 tgz 文件名就宣称当前运行版本已更新。安装新版后须核对实际加载位置和包内版本；不要擅自替换运行中插件。
- 公开仓库历史和旧安装包包含经用户授权的临时本地数据库固定凭据风险；不要在交接、日志或新增代码复述密码，不把该历史例外扩展到服务器发布。
