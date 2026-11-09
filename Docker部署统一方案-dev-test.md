# dev / test Docker Compose 部署适配（以现有服务器为准）

> 2026-11-03 最新需求覆盖下文：插件本地认证获取远程指定提交、源码包上传、服务器临时执行，不安装固定发布入口，也不要求服务器 Git/GitHub 凭据。当前接入边界见 `temporary-release-README.md`；下文各轮方案及服务器基线均为历史记录，不是当前实机验收结论。桌面 0.12.0 包仍为先前固定入口实现。

## 最新基线：2026-11-02 19:00 只读核查，覆盖下文历史草稿

- 119.45.50.213 的 dev/test Docker 已运行。Compose 分别位于 `/opt/xian-oa-dev-docker/compose.yaml`、`/opt/xian-oa-test-docker/compose.yaml`，项目名 xian-oa-dev / xian-oa-test，服务均为 api/web/db；api、web running，db healthy。
- 每套独立 MySQL 数据卷和 bridge 网络；现有 api 为 Java 基础镜像挂载 app.jar，web 为 Nginx 基础镜像挂载 web/ 与 nginx.conf。不是应用已打入镜像的发布模式。
- 用户最终流程：锁定 GitHub 远程 dev SHA → 独立获取并上传该源码 → 服务器 Docker 多阶段构建 → 只更新 api/web → dev 业务验收 → 同一对镜像晋级 test。此前本机构建、host 网络、宿主 MySQL、仅首次启动的草稿均不适用于当前部署，不能启用旧 runtime 实施更新。
- 服务器 Compose 2.40.3；有 Docker/git/tar/java，无宿主 Node/npm/Maven，因此构建阶段需使用固定 digest 的 Node/Maven(Java21)镜像，不要求安装宿主工具。构建不注入业务 DB 凭据，不挂 Docker socket；依赖 Docker 的集成测试仍需独立测试方案，不能跳过测试冒充通过。
- 新增 docker-server-config.js 只生成多阶段 Dockerfile/.dockerignore 与应用覆盖配置：!override 移除 api 的旧 JAR 挂载和 web 的旧静态目录挂载，保留环境专用 nginx.conf；不定义/替换 db、网络或数据卷。更新参数限定 `up -d --no-deps --no-build --pull never api web`。尚未接执行路由，不代表可直接发布。
- 注意：只读发现 dev MySQL 发布端口 13306 绑定 0.0.0.0。此处未判断公网防火墙是否放行，也未修改；与 test 未发布数据库端口不同，应单独核实访问控制。
- 本轮无服务器写入、源码上传、镜像构建、容器重启或数据库操作，未读取 .env/app.env/db.env 内容。下文保留历史探索记录，不作为现状执行依据。

## 以下为历史设计与验证记录

核查日期：2026-11-02 早期。插件源码未安装更新；旧 0.11.0 安装包情况不代表当前服务器现状。

## 1. 已批准范围

用户确认 dev、test 统一使用 Docker 部署；客户没有指定 Dockerfile、Compose 或部署规范。允许据此设计插件改造；不把该确认扩大为立即安装 Docker、停止服务、修改数据库或切换服务器入口的授权。

本方案仅涉及协作插件及其部署协议。修改 OA 源码、项目部署配置前仍需确认实际源码位置、目录规则及分工边界。

## 2. 已核实事实

通过现有 SSH 别名 xian-oa-test 对 119.45.50.213 只读核查：

| 项目 | dev | test |
| --- | --- | --- |
| 根目录 | /opt/xian-oa-dev | /opt/xian-oa-test |
| 当前后端服务 | xian-oa-dev.service，active | xian-oa-test.service，active |
| 后端端口 | 8082 | 8081 |
| 当前前端目录 | /opt/xian-oa-dev/web | /opt/xian-oa-test/web |
| Nginx 入口 | 18081 | 80，以及仅本机 18080 |
| 配置文件 | /etc/xian-oa-dev/app.env | /etc/xian-oa-test/app.env |
| MySQL 地址 | 127.0.0.1:3306 | 127.0.0.1:3306 |

- Ubuntu 24.04，x86_64；未检测到 docker 命令，尚不能断言机器上不存在其他容器运行时。
- 2026-11-02 补充只读容量快照：8 个逻辑 CPU；内存总计 15483 MiB、available 13648 MiB；swap 1987 MiB；根文件系统 148 GiB、可用约 136 GiB。仅为当时快照，不是镜像构建峰值容量或后续配额保证。
- 当时从服务器本机分别请求后端 8082/8081 的 /api/v1/health，以及前端 18081/18080 的 /，四项均返回 HTTP 200。未读取响应正文，不代表业务流程、外网访问或迁移后验收。迁移前必须重新测量。
- 两套目录均有 app.jar、web、releases 和历史前端备份；不能把目录存在当作可删除授权。
- 两套服务当前都有 ProtectSystem=strict，既有运行权限语义必须核定保留。
- MySQL 监听 127.0.0.1:3306；不能将容器中的 localhost 当成宿主数据库。
- 现有 JAR 含 BOOT-INF/classes/application.yml；仅做配置名称和部署相关关键字筛选，未完整审查程序持久化行为。
- 用户已提供 OA 源码 /Users/mac/Desktop/临时代码/XiAN-OA；实际 Git 根与该路径一致，当前 dev 分支，核查时工作区干净，HEAD d494471。前端 package.json 的 build 为 tsc -b && vite build，后端 Java 21 / Spring Boot 3.5.16 / Maven / MySQL 8；源码未发现 Dockerfile、Compose 配置。本轮只读审查 OA 源码，不修改业务或共享规则。
- 未输出数据库密码、管理员初始化密码或完整环境文件；未执行上传、构建、安装、停服务、重启或数据库写操作。

## 3. 拟定部署契约

1. 使用独立 Compose project：xian-oa-dev、xian-oa-test；各自独立配置、发布记录、持久化目录及锁。
2. 前后端分别镜像化；Java 21 后端，Nginx 提供前端 SPA 和 /api 反代。构建基于实际项目脚本，不更换技术栈。
3. 镜像以代码快照和产物摘要标识，不只依赖 latest；部署计划固定目标环境、镜像摘要和配置摘要。
4. 密码不进入源码、镜像层、归档、命令参数或 API 响应。运行时配置采用受限权限文件，并核查现有 env 文件与 Compose env_file 语法差异，不能原样加载未经核定的配置。
5. MySQL 暂时继续宿主运行，不自动迁移数据库。数据库连接方案必须单独核定：host networking 能保留 loopback 连接但减弱网络隔离；bridge 方案需要受限的数据库可达性设计。不得擅自改成 0.0.0.0 监听或开放 3306。本轮配置预览采用 Linux host networking：后端保持绑定 127.0.0.1，保留宿主 loopback 数据库连接；两个 Compose project 不是网络隔离边界。最终实施仍须确认该安全取舍，不能把此配置用于 Docker Desktop 来冒充 Linux 运行验证。
6. 先保留宿主 Nginx 作为外部入口，容器前端仅绑定独立本机端口；端口须现场核验。逐环境验证后再切换宿主反代，不能同时占用现有 80/18081 入口。容器内前后端连接取决于最终网络方案。
7. dev/test 统一部署机制不意味着自动将本地 dev 代码发布到 test。test 的来源分支、不可变镜像晋级规则和操作者权限需用户确认；默认拒绝未经确认的 test 发布。
8. 持久化附件、数据库初始化、定时任务和外部写操作必须源码核定。不得未经核定并行启动新旧后端，避免重复初始化、定时任务或业务副作用。
9. 保留一次性计划、源码变化拒绝、固定目标、并发锁、明确确认、超时后只读核对等现有部署安全语义；不简单复制两份 dev 引擎。

## 4. 迁移步骤与授权门禁

- 源码核定：读取实际构建脚本、后端配置、初始化逻辑、附件持久化位置和权限；确定镜像及 Compose 配置。
- 离线验证：生成配置并做语法/契约测试；真实 Docker 构建需环境可用且获依赖下载/执行授权，未运行不得声称通过。
- 迁移前展示：安装来源、镜像来源、资源占用、目标端口、网络方案、配置/数据目录、数据库副作用、备份清单、维护窗口、切换命令及回退命令。
- 单独确认后安装 Docker/Compose（若确需安装），验证版本；不让普通插件请求自动获取任意 root shell 或 Docker socket。
- 逐环境迁移：先 dev 验收，再 test；备份应用、入口配置和运行清单，停止旧后端后按核定方案启动容器并验证。数据库备份另行设计授权，文件备份不等于数据库备份。
- 仅在健康、页面/API 和权限验收后记录成功；401/403 或仅进程存活不等于健康。切换入口后核验实际访问链路。
- 失败保留现场和明确状态，不重复写入、不自动回退数据库；旧应用回退必须核对数据库兼容性并单独确认。

## 5. 未决项与验收

必须补齐：test 发布来源/权限；Docker 镜像来源、基础镜像固定摘要及传输方式；host networking 安全取舍；数据库初始化及迁移策略；运行 UID/GID、时区、资源限制及维护窗口。源码位置/分支、服务器容量、附件存储方式已初核，不再索要已提供的信息。

验收包含：两套环境隔离、错误目标拒绝、旧协议不会误执行、凭据脱敏、归档及镜像完整性、并发/重放门禁、断线只读核对、数据库不被越权修改、日志限量、卸载资源清理，以及真实浏览器/API 验收。

## 当前约束（后续确认优先于以下历史审查）

- 远程发布只使用 GitHub ssal-team/XiAN-OA 远程 dev 分支，先锁定 SHA，再隔离检出。绝不部署本地工作区或回退至本地代码；本地新源码用于审查，未推送内容不进入远程发布。
- dev 验收通过后，test 使用相同前后端 digest，不重新构建。test 服务端当前姓名必须精确为刘道志；显示姓名可修改可重名，不等于唯一账号认证。
- 最新本地参考源码 /Users/mac/Desktop/githubTest/XiAN-OA 已去除 BootstrapData 演示业务实例创建；AccountBootstrap 仍有演示账号分支，因此容器明确设置 XINGLIAN_DEMO_AUTH_ENABLED=false。远程目标提交还须独立核查，不能把本地修复当成已推送事实。
- 新增 docker-plan / docker-promote POST 计划接口，沿用 CSRF/Origin/loopback 门禁。计划5分钟、128条；dev已验收记录仅可信内部流程可登记，不提供客户端登记入口。目前执行器未接通，计划 deployable=false，不伪造发布或验收记录。
- 旧 remote-dev-check / remote-dev-start 已服务端拒绝，防止继续执行本地构建上传。旧状态查询保留用于核对历史任务。

## 6. 历史源码审查与预览实现（旧目录基线，不适用于新源码全部结论）

- backend/src/main/resources/application.yml:15-17：SQL init mode always；schema.sql 含 CREATE TABLE IF NOT EXISTS 和 org_guard 初始行，不是版本化升级机制。
- backend/src/main/java/com/xinglian/oa/bootstrap/BootstrapData.java：空流程实例表时写演示业务数据，不受 demo-auth 开关控制；AccountBootstrap、OrganizationBootstrap、DictionaryBootstrap、OaBootstrap 也有启动写入。禁止与旧服务并行试启动；仅关闭 SQL init 或 demo-auth 不能排除 Java 初始化副作用。首次启动必须核定现有库结构、初始化策略、数据库备份及单实例门禁。
- 附件/照片位于 MySQL BLOB 和相关引用表，不能创建 /app/uploads 卷冒充持久化完成。当前 Java 源码未发现业务文件持久化路径；Servlet/ImageIO 仍需可写临时目录，预览给出有限 /tmp tmpfs，容量待运行验证。
- /api/v1/health 为固定响应，仅作为存活线索，不证明数据库就绪或初始化完成。未发现源码业务定时任务，不因此排除运行环境中的外部任务。
- 插件新增 POST docker-preview：沿用 loopback、Origin、POST、CSRF 门禁；检查固定 XiAN-OA 仓库、干净 dev 快照，前后复核快照；仅生成文本，不执行命令。test 输入只预览环境差异，不表示 dev 到 test 晋级获准。
- 输出包含 Compose、两份 Dockerfile、Nginx 配置、.dockerignore 和待确认门禁；运行镜像必须为 repository@sha256 摘要，但输入摘要不证明镜像存在或来自该源码。基础镜像模板 tag 尚须锁定经审核的 digest。Compose >=2.30，env_file 使用 raw；只引用新建待审核 container.env 路径，不读取或输出配置内容。
- dev 前端候选端口 28081、test 28080，均仅 loopback；后端沿用 8082/8081，切换前需停止旧后端和核查端口；宿主现有入口未改。read-only、非 root UID/GID、无额外 capabilities、禁自动重启、日志限量；host 网络不提供环境网络隔离。
- 插件远程部署页新增预览输入及结果，旧 systemd 按钮保留兼容并明确标注，不能把它当作 Docker 部署。没有 Docker 自动发布入口，没有静默切换既有协议。

## 7. 本轮验证与尚未完成

- node --test docker-release.test.mjs docker-preview.test.mjs sidebar-ui.test.mjs panel.test.mjs update-route.test.mjs error-notice.test.mjs native-dev-deploy.test.mjs remote-deploy.test.mjs：67 项通过，0 失败。更新源码风险文案后首次回归出现一项旧文案断言失败，随后同步为 BLOB、demo 初始化和存活探针断言，重跑全部通过。
- node --check docker-release.js / docker-preview.js / panel.js / index.js：通过；git diff --check：通过。
- 本机 Docker CLI 29.3.0、Compose 5.1.0；daemon socket 不存在，docker info 失败。未启动 Docker Desktop，也未构建、拉取或启动镜像。
- dev/test 分别执行 docker compose -f 临时配置 config --no-env-resolution --quiet：离线校验通过，不读取 env_file、不访问数据库、不启动容器；临时配置校验后清理。
- npm pack --dry-run：21 个文件，确认包含两个 Docker 运行模块；未生成新安装包，未覆盖桌面旧 0.11.0 包，未安装插件。当前 GUI 尚未加载本轮变更。
- 尚未完成：实际镜像构建和来源证明、Linux 容器运行/Nginx 配置实测、数据库就绪/初始化策略、test 发布规则、带并发锁/一次性计划/断线核对的 Docker 执行引擎、服务器迁移及真实浏览器验收。旧 systemd 执行引擎保留，不冒充 Docker 引擎。

## 8. 追加请求边界复核

- docker-preview 请求只接受 directory/head/fingerprint/environment/backendImage/frontendImage/uid/gid；显式拒绝额外凭据、命令、确认执行字段和非普通对象，避免路由层悄悄忽略不应提交的敏感字段。路径拒绝全部 ASCII 控制字符，在调用源码 inspect 前失败。
- 新增拒绝路径测试及 null-prototype 合法请求测试；node --test docker-preview.test.mjs docker-release.test.mjs sidebar-ui.test.mjs update-route.test.mjs：25 项通过，0 失败；node --check docker-preview.js、git diff --check 通过。
- 追加 npm test 全量回归（与上述边界修改并行启动，不能替代修改后的全量验证）：253 项中 252 通过、1 失败，用时约 267 秒。失败为 project-memory.test.mjs:26，断言 calls.every(c=>/\/(status|inspect)$/.test(c.url)) 不满足；项目恢复用例只允许 status/inspect，但当前面板存在其他状态请求。该测试不属于本轮 Docker 请求边界修改，尚未改动或确认其根因，不声称全量通过。

## 9. 发布策略显式门禁与全量失败定位

- 纯配置生成器追加 publication-policy pending 门禁：dev 不自动晋级 test；test 的发布来源、不可变镜像晋级及操作者权限必须明确确认。仅生成 test 配置不授权发布，直接调用生成器也保留此提示，而非只由 HTTP 外层提示。
- node --test docker-release.test.mjs docker-preview.test.mjs sidebar-ui.test.mjs update-route.test.mjs：25 项全部通过。
- node --test project-memory.test.mjs：独立重现同一失败（1 项失败）。源码 panel.js:260 在挂载时调用 checkUpdate，panel.js:68 会发 POST /update-check；project-memory.test.mjs:26 仅允许 /status 和 /inspect，二者契约不一致。此更新流程不是本轮 Docker 实现新增，未修改更新行为或放宽原有测试断言。要使全量回归通过，需另核定自动检查更新的契约及对应测试范围。

本文件及预览均不代表 Docker 部署完成；没有部署成功证据前不得以打包或单元测试替代真实迁移结果。

## 10. 历史重型链路记录（已由下文轻量服务器方案取代，不作为当前启用说明）

- 已确认：源码仅来自 GitHub ssal-team/XiAN-OA 的远程 dev；锁定远程 SHA，不读取本地工作区构建发布。test 仅晋级已交付且已验收 dev 的同一对镜像 digest，不重新构建；服务端读取插件登录姓名，严格匹配刘道志。显示姓名可修改或重名，不是唯一账号强认证。
- core.js / docker-plan.js / index.js / panel.js 已接入远程提交查询、5 分钟计划和晋级申请；HTTP 旧 remote-dev-check / remote-dev-start 返回 409。docker-start 同样明确返回 409，未开放真实执行。
- remote-source.js：独立临时目录、固定 HTTPS dev fetch、SHA 比对及 detached checkout；不支持私库认证时明确失败，不回退本地源码。
- docker-build.js：内部可注入 Java21/npm/Maven 构建和两个镜像构建组件；基础镜像必须固定 digest，非 root。前端镜像不固化 nginx.conf 或环境端口，运行时只读挂载。返回本地 image ID/tag 和 attested:false，不能当作 registry RepoDigest。
- docker-executor.js：内部可注入的一次性计划/单任务锁/身份复查/验收状态机，未挂 HTTP。需要真实可信 build/deliver 适配器；当前不能与下述 preflight 模块直接拼接成可用交付，接口中的 provenance/head 及可信证明也需后续适配。状态仅内存，不承诺重启恢复。
- docker-delivery.js：仅内部 preflight-only。检查已独立预置的受限配置、精确模板、旧服务 inactive、已有真实 RepoDigest；返回 deployable:false / delivered:false。没有 registry 发布、上传、pull/up、迁移、健康验收或入口切换。没有执行真实预检。
- docker-publish.js 已新增内部 buildAndPublish 组件：registry 仓库与 Docker 认证配置路径只由服务端构造时注入；从可信 build 返回的 image ID 打唯一 tag，push 后分别核对 tag 与固定 digest 的 registry manifest config digest，绑定原本地 image ID。仅接受单平台 manifest，拒绝列表；不自动登录、不打印认证/原始输出、不自动重试。provenanceVerified 表示此内部绑定校验，不代表签名或独立供应链认证。未执行真实 push，尚未接 HTTP 或远端运行适配器；实际 registry、权限与认证位置仍需配置确认。
- docker-pipeline.js 已将内部 plan/publisher/executor 组合成单生命周期服务。原始构建与 registry 绑定证据保存在有界内存中；test 使用同一份可信证据补齐 head/provenance，不接受调用方伪造标记，不重新 build/push。mock 贯穿测试覆盖 dev 发布→验收→同镜像 test、registry 错配阻断、仅预检不算交付及姓名变化拒绝。该服务仍未挂 HTTP，也没有真实远程交付默认实现。
- docker-journal.js 新增内部 accepted-dev 日志：显式注入独立 owner-only 目录，独占锁、0600 文件、只追加并 fsync、hash 链、最多128条/1MiB；损坏/截断/外部改写拒绝，不自动修复或抢占残留锁。hash 链不是防本地属主篡改的签名。pipeline 可注入 journal，验收先持久化再开放晋级；重启恢复已验收摘要和内部证据，计划/执行中任务仍不恢复。未为实际插件创建正式日志或启用恢复，文件系统测试仅用隔离临时目录。
- docker-reconcile.js 新增内部只读核对协议：可信 query 查询服务端持久 marker 和当前健康，jobId/environment/head/双镜像 digest 必须完全匹配，健康采样不超过30秒且不可来自未来；只返回 delivered/uncertain，不验收、不重放、不修改执行器。不存在、失败或pending marker 都不能授权重试。尚未实现真实远程 query，不能单独称为远程断线核对已落地。
- executor 追加 dev 绑定检查：构建发布证据必须包含锁定 head、provenanceVerified 与固定双镜像摘要；交付响应对 dev/test 都必须逐字等于本次预期摘要，合法但错误的摘要也只能标记 uncertain，不能验收。pipeline 将 jobId 传给交付能力，供未来服务端 marker/query 使用；内部能力的该参数调整尚无已启用远程消费者。
- journal 安全补强：append 绑定目录 dev/ino、私有权限和属主；写入不确定后 close 保留独占锁，禁止未经人工核对直接重启恢复验收。哈希链仍只用于意外损坏检测，不是抗本地恶意属主的签名。
- docker-apply.js 新增可信内部远程 one-shot 启动与 query 适配器源码：固定 SSH alias；严格核验预置 root 私有目录、精确 Compose/nginx、env 元信息（非秘密 nginx 配置 root:0644 以供 UID10001 读取；compose/env/lock/marker 仍 root:0600）、旧 unit 全 inactive、已载入 RepoDigest；持久 pending marker 后单次 compose up --no-build --pull never --no-recreate，核对实际容器 image ID/RepoDigest 和 loopback HTTP，再记录 applied。query 只读 marker+实时健康；错误抑制细节且绝不自动重放。尚未接入 HTTP 或真实 SSH。
- apply 不是通用更新器：要求该 Docker project 既无运行也无停止容器，配置须独立预置为本次精确 digest，3个旧 unit 都需 loaded+inactive。现服务器不满足，必须先另获迁移/配置授权；不安装Docker、不停止服务、不拉镜像、不切入口，不声称无停机或数据库就绪。
- executor/pipeline 新增可选可信 query 与 reconcile({jobId})：仅 DELIVERY_UNCERTAIN 原任务可核对，预期 SHA/双摘要在发起交付前内部保存，不接受客户端覆盖；核对前后校验当前姓名，持有互斥锁，成功仅恢复 delivered 且 accepted=false，仍需显式验收。不核对 RECORD_UNCERTAIN，防止验收日志不确定被绕过。任务及预期证据仍在内存，不能恢复进程重启前未验收任务。
- 插件 apply(ctx,{dockerRuntime}) 支持启动时注入可信内部运行时；未注入继续拒绝 docker-start/status/accept/reconcile。注入后 docker-plan/promote/start/status/accept/reconcile 均经过现有 loopback/origin/POST/CSRF 再委派；浏览器不能创建或配置该能力。status 只允许 jobId，不返回构建原始日志。默认部署配置未变化，不会自行激活。
- docker-runtime.js 提供显式启动时组合工厂：固定基础镜像digest、UID/GID10001、独立remote-source checkout、build/publish/apply/query及必选私有验收journal；command/exec/身份/远程SHA查询全部强制可信注入，无真实默认 runner。close 先停新请求，待API promise结束；若任务仍pending/running则保留资源并拒绝关闭，终态后可再close，不伪装取消远程操作。入口不自动创建该runtime。
- panel 新增 Docker 显式风险确认/启动、手动状态查询、仅交付不确定时只读核对、dev显式业务验收；不自动poll/retry/start，查询不接受源码路径；计划在启动请求前清除，响应丢失提示查询最新状态，避免复用计划。沿用现有控件样式，不改CSS。默认未配置runtime仍由服务端拒绝。
- docker-ssh.js 已提供固定目标 DSH loopback 桥接组件，每次 exec 先验证 host/user/22/无代理；超时/截断/非零退出均拒绝且不重试，close 仅中止本地等待。只由可信 apply 提供脚本；prefix 校验不是任意脚本沙箱。16 项 mock/本地 HTTP 测试通过，无真实 GUI/SSH 请求。组件尚未自动启用。
- 尚缺获授权后的正式配置与 SSH 运行时装配、已有项目更新生命周期和真实端到端验证；本地mock界面验证不代表当前安装GUI已加载或浏览器实机验收。registry 发布组件目前仅 mock 验证，不代表真实 registry 兼容性或部署已完成。不得把组件单元测试通过称为 Docker 发布链路完成。
- 本轮未安装插件、未生成新安装包、未修改 OA 源码、未连接业务数据库、未执行真实构建或服务器写操作。桌面原 0.11.0 包不包含这些最新改动。

## 11. 当前方案：轻量插件直接调用服务器（2026-11-03）

本节取代上述重型构建/registry/首次启动方案。插件默认使用 server-release-client.js，通过现有 DSH SSH 桥调用固定入口 `/usr/local/libexec/xian-oa-release.py`，仅传递固定 action 与严格字段。插件不拉源码、不构建、不 push 镜像，不向 AI 会话发送部署任务；旧模块保留但不进入默认发布链路。

服务器入口源码随插件提供，需另行审核并授权安装。服务器自行拉取固定 GitHub 远程 dev，核对计划 SHA，在固定基础镜像的多阶段 Docker 构建内运行 npm/Maven，更新现有 Compose api/web；不重建 db、不删除数据卷。只清理该任务新建的临时源码及构建上下文，不执行 image rm、prune、builder prune、volume rm。构建镜像、旧镜像、任务记录、配置、备份均保留；空间不足应明确失败，不能自动扩大清理范围。

计划、任务及验收记录在服务器持久化，断线后只查询，不自动重放。test 仅使用已验收 dev 的相同本地 image ID，不重新构建；本地 image ID 不冒充 registry manifest digest。插件姓名门禁不替代服务器 sudo Unix 身份 ACL。当前实现保守地要求所有发布启动及验收姓名均为刘道志，防止拿 test plan 绕过姓名门禁。

运维须统一使用默认 `compose.override.yaml` 或同时显式指定该文件；单独 `-f compose.yaml` 会绕过已发布的 image override，安装前必须核对备份、监控和重启命令。临时目录中断残留、uncertain 任务人工核对，不自动强清或自动回滚。镜像保留提供人工回退材料，不代表数据库迁移可回滚或已有一键回滚。

验证：`node --test server-release.test.mjs server-release-client.test.mjs server-release-bridge.test.mjs docker-ssh.test.mjs docker-http.test.mjs sidebar-ui.test.mjs panel.test.mjs update-route.test.mjs` 为 57/57 通过，其中服务器用一个 Node 测试执行 19 项 Python mock fixture；入口/面板/客户端语法检查、`git diff --check` 与 `npm pack --dry-run` 通过。未重跑全量 npm test；历史已知 project-memory 自动更新契约失败没有在本轮修改。

安装配置、固定入口权限、私库拉取凭据、实际基础镜像以及现有运维命令兼容性尚需现场验收。本轮仅本地源码与隔离测试；未安装入口、未修改服务器、未触发真实构建或发布，未更新当前 GUI 或桌面安装包。

