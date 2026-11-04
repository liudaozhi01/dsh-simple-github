# 本地获取源码 + 临时远程执行（当前方案）

仅实现本地插件与随附脚本；未连接或修改客户服务器，未触发真实部署。桌面已生成的 0.12.0 安装包仍是旧方案，本次源码修改不会自动更新该包。

## 发布边界

- 插件使用本机 GitHub CLI 登录获取远程指定分支与提交，下载到独立临时目录；不读取本地工作区作为发布源码，不在本机构建业务产物。
- 通过现有 DSH SSH 连接上传源码压缩包；服务器校验摘要，用本次临时 Python 脚本执行 Docker 构建及 Compose 应用更新。
- 服务器无需 Git、GitHub 登录或长期安装专用发布程序；仍需要 SSH、Python 3、Docker/Compose，以及经过审查的执行权限和构建网络条件。
- 发布仅改变应用 api/web 镜像，不清理数据库、数据卷、配置、旧镜像或 Docker 缓存。
- dev 明确业务验收后，test 使用同一服务器上保留的同一对镜像，不重新获取或构建源码。
- 暂时保留独立任务和小型发布记录供断线查询；结果未知不自动重试、不自动回滚数据库。不确定任务须先查询或人工核对。

## 项目接入

通过插件可信启动配置 `releaseProfile` 指定仓库、分支、SSH 目标、Compose 目录及项目名、状态目录、构建基础镜像和允许操作的登录姓名；不接受浏览器请求覆写目标或任意命令。不同项目使用独立配置及状态目录，不修改插件实现。

配置结构如下（仅结构示意，`REVIEWED_*` 必须换为审核后的真实 digest，否则校验拒绝）：

```js
releaseProfile: {
  repository: 'example/oa', branch: 'dev',
  target: {alias: 'reviewed-ssh-alias', host: 'reviewed.example', user: 'deployer', port: 22},
  roots: {dev: '/opt/example-dev', test: '/opt/example-test'},
  projects: {dev: 'example-dev', test: 'example-test'},
  stateRoot: '/var/lib/example-release',
  baseImages: {
    node: 'node@sha256:REVIEWED_64_HEX',
    mavenJava21: 'maven@sha256:REVIEWED_64_HEX',
    java: 'eclipse-temurin@sha256:REVIEWED_64_HEX',
    nginx: 'nginx@sha256:REVIEWED_64_HEX'
  },
  allowedNames: {dev: ['允许发布的显示姓名'], test: ['允许晋级的显示姓名']}
}
```

模板当前要求 Compose 服务名 api/web/db，已有应用及数据库健康检查；更换项目参数不是对任意 Compose 或技术栈的自动兼容承诺。配置由可信插件启动配置提供，不从网页发布请求接收。

基础镜像必须经项目维护者审核并锁定 digest；不编造 digest、不自动选择 latest。没有有效配置时发布接口明确拒绝，不回退旧固定入口。项目配置中不放 GitHub token、数据库密码或 SSH 私钥，GitHub 凭据只在本地 CLI 使用。

显示姓名可修改、可重名，姓名门禁不是强身份认证；SSH 账号权限仍是服务器执行权限边界。Docker 构建不可信源码不构成安全沙箱；业务迁移、Testcontainers 和真实环境兼容性需单独验收。

## 临时文件

只清理插件及本次任务创建并能验证身份的临时源码、压缩包和脚本目录。任务运行时脚本可能暂时保留供后台任务执行；异常关机或清理身份检查失败可能残留，不能据此扩大删除路径。镜像及发布记录长期保留，清理策略另行审批。

## 已知限制与验证

- 归档上限 256 MiB，展开上限 1 GiB；拒绝软硬链接、穿越路径、特殊文件及敏感/生成路径（包括 `.env.example`、`.npmrc`、`settings.xml`）。源码中存在此类文件会明确拒绝，不静默跳过。服务器只校验本地可信下载器提供的归档摘要，不独立访问 GitHub。
- 状态目录仅支持受控 `/opt/...` 或 `/var/lib/...`，部署目录为 `/opt/...`；目录父级必须符合 root 所有权和权限要求。
- 本机中断或网络故障可能遗留上传目录；不会为了自动清理而重复发布。后台任务被强制终止可能留下未决状态，需人工核对。
- 新增测试采用注入命令、桥接和本地 Python fixture，无真实联网、上传、Docker 构建、数据库迁移或客户服务器验收；测试通过不等于实机发布成功。

本轮验证：13 个相关测试文件合计 **81/81** 通过（Python 状态机文件内部含 21 项 unittest）；最后补充默认状态查询回归后，该 Python 测试与 JS/Python 协议测试复跑 **3/3** 通过。Node 语法、Python AST、`git diff --check` 和 `npm pack --dry-run` 通过，dry-run 为 0.12.0 / 42 文件并包含五个新增运行文件。本轮未重跑全量 `npm test`；此前记录的 project-memory 更新检查契约失败未在本次范围内修复。未生成新桌面包或更新当前安装。
