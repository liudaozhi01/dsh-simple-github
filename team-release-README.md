## 本机原生 SSH 连接（新源码，安装重载后生效）

团队发布不再要求单独安装 DSH SSH 插件。设置页的“发布服务器连接”使用系统 OpenSSH，固定服务器地址和端口来自受控 releaseProfile；成员只填写自己的普通 Unix 用户名及本机私钥绝对路径。配置保存在用户目录下独立的 `.dsh-simple-github/ssh-*` 私有目录，不进入插件包或 Git；不保存私钥正文和口令，不上传私钥。公钥需由管理员预先配置到对应服务器账号，不能以公钥代替私钥登录。

首次连接先获取 SHA256 主机指纹，通过管理员独立渠道核对后明确确认信任。获取指纹本身不代表可信；已信任指纹变化时拒绝连接，不自动覆盖或降级。系统必须提供 ssh、ssh-keyscan；加密私钥请先通过系统 ssh-agent 解锁，插件不弹出或保存口令。禁用密码交互、用户 SSH 配置、代理及 agent 转发，使用严格主机密钥校验。

“测试连接”只读取团队入口 overview，检查登录及读取权限，不上传源码、不构建、不启动发布；没有管理员配置的 releaseProfile 仍不能发布。服务端真实 Unix 身份、ACL、锁和数据库保护不变。可点击“自动查找私钥路径”：只读检查已有连接配置、匹配该服务器的本机 SSH 配置及常见密钥位置，不扫描全盘、不读取私钥正文；Windows 也检查 `D:\keys` 是否为安全的普通文件。唯一候选仅在输入为空时填入，多个候选需选择；不会覆盖已输入路径、自动保存、信任或连接。候选只代表路径及权限检查通过，不代表已获服务器授权，仍需确认后保存；未找到可手动填写。macOS/Linux 对配置目录和文件执行所有权及 700/600 检查；Windows 使用系统 OpenSSH 和固定 PowerShell ACL 检查，配置目录仅当前用户及系统/管理员可信身份可访问，拒绝不安全 ACL 与 reparse point，不自动修改现有私钥权限。Windows 需已启用系统 OpenSSH 客户端。Windows/macOS/Linux 的真实连接及浏览器视觉效果需分别验证，不能以 mock 测试替代。

> **0.15.6（2026-11-04）**：发布 test 与两环境“恢复到此版本”按钮仅插件当前姓名精确为刘道志、於天晨时显示，其他成员只显示发布 dev。所有普通 SSH 成员共享查看 dev/test 发布历史（仍最多20条、安全摘要），不再按发布人过滤；共享查看不授予操作权限。保留现有服务器校验，test 名单已加入经确认的 yutianchen，与 liudaozhi 并列。2026-11-04 已同步服务器：三账号读取相同11条 dev/test 历史；yutianchen 的 test 发布计划与两环境恢复计划均通过，caoyang 的 test 发布仍被拒绝。未调用 start 或切换业务容器。备份 `/var/backups/xian-oa-shared-history-20261104-100715`。姓名控制为界面策略，不是不可绕过的安全边界。旧版本说明以本段为准。

> **0.14.2 当前规则（覆盖下文历史验收/权限说明）**：dev 所有普通 SSH 登录成员可发布；test 仅服务器账号 `liudaozhi` 可发布。test 直接复用最近健康启动成功的 dev 镜像，无需在插件登记业务验收，业务由团队自行校验。失败/运行中/结果不确定的 dev 不可晋级；保留锁、同镜像与健康检查。服务器已同步规则，已验证 liudaozhi 可生成 test 计划、其他成员被拒绝；本轮未实际发布 test 或重新部署 dev。报错仍不自动发送会话。

## 2026-11-04 恢复接口已安装

获用户授权后，确认无 pending/running 任务，持旧入口共享锁备份并更新固定 engine/broker，重启受控入口。备份：`/var/backups/xian-oa-restore-20261104-094021`。dev/test 六个业务容器未更换，授权配置校验和不变。以 liudaozhi 实际入口验证 dev/test 各自历史镜像恢复计划成功，以 caoyang 验证 test 仍被拒绝。仅生成计划，未调用 start、未实际恢复、未改数据库。以下“待安装”为此前开发交付记录。

## 0.15.0 恢复接口设计（历史开发记录）

新增固定 `restore` 动作：仅接收 `{environment,jobId}`，用 root 保存的同环境健康交付记录生成短期恢复计划，再沿用 `start`。dev 恢复不上传源码、不构建；test 同样只切换其历史镜像。环境 ACL、共享锁、提交幂等、配置/容器快照、执行前源镜像检查及 api/web 健康检查保持不变。缺失镜像不拉取或重建，失败不自动回退；数据库不撤销、不复制或重置。历史仍遵循现有本人记录可见范围，不扩张任务查询权限。

本次只开发与隔离测试，没有修改服务器程序或执行恢复。启用需在确认无运行任务后，由管理员备份并同步安装包内 engine 和 broker；客户端与服务端缺一不能恢复，不能仅安装插件就宣称已启用。无须修改现有授权名单或业务容器。原有发布/晋级接口兼容保留。

# 团队 dev 自助发布 broker

## 2026-11-03 安装进度

已获授权安装至 `xian-oa-test`（119.45.50.213），dev 为 `all-ssh-users`，test 为 `[]`。12 个现有普通 Unix 登录账号的入口 status 检查通过；未逐人验证 SSH 凭据。未新增成员 sudo/docker 权限。历史测试任务 `17a604721a981f5107ab08eeb7525f6b` 锁定 dev SHA `5796905bf0841291cf595987275ab2f47fa2e507`：缓存后服务器构建至测试结束 103 秒，149 项后端测试中 148 通过、1 失败、0 错误/跳过。唯一失败是 `MySqlMigrationTest.schemaCanRunTwiceAndKeepsEngineCollationAndForeignKeys` 第54行 `expected: <68> but was: <71>`；测试清单遗漏当前新增 access-catalog（2表）和 organization-assignment（1表）迁移。没有修改业务源码、跳过测试或切换 dev/test，因此不能宣称发布成功或给出完整发布耗时。修复了临时 stage helper 权限、镜像内 Maven settings 所有权、国内依赖下载速度和测试 MySQL 连接数（仅临时库 max_connections=512）。首次慢 Central 尝试由管理员准确终止其测试中间容器，不触碰服务容器。dev/test 原有三份配置均与安装前备份逐字节一致，服务容器保留原实例且健康。插件客户端的打包、安装和 releaseProfile 配置需另行完成，服务器安装不等于所有客户端已可点击发布。

### 17:28 后续成功结果（优先于以上历史失败记录）

用户明确批准：dev 与业务测试解耦，只在服务器编译打包，保留编译/前端构建失败阻断、权限、锁、健康检查；不修改业务源码。root helper 默认 `mvn -DskipTests package`，不启动测试MySQL；可选 `run_tests=True` 保留原测试路径，HTTP调用者不能选择策略。test 仍只晋级已验收镜像且当前ACL为空。

使用实际插件 `createTemporaryReleaseClient` / `createLocalSourceBundle`，通过现有 DSH `60582` 的 SSH 桥，检查、下载锁定SHA、普通上传、启动任务 `1ddf8cf2debc6afaf27335f81af17524` 成功交付 dev，状态 `delivered` / 内部 `ready`，尚未业务验收。SHA仍为 `5796905bf0841291cf595987275ab2f47fa2e507`。从服务器任务创建至最终状态文件落盘约86.7秒（已有缓存；不含本地下载上传，不是冷启动承诺）。api/web已更换为新镜像并健康，经过dev网页代理的 `/api/v1/health` 返回ok；dev数据库容器不变，test三个容器及三份配置不变。没有跳过编译、关闭健康检查或自动业务验收。

插件0.13.0的bundle patch已携带实际releaseProfile。成员在DSH保存SSH别名 `xian-oa-test`、主机119.45.50.213、端口22及**自己的普通Unix账号**，无需共用liudaozhi账号。team transport固定别名/主机/端口、禁止代理、操作前后重新核对账号配置；服务器以真实Unix身份授权。profile.target.user仅为兼容字段，不作为成员账号约束。0.13.0安装包需通过DSH插件管理安装后重载；当前会话仍在旧0.12.0宿主插件上，不能把独立源码客户端联调等同于旧面板已经更新。

### 18:00 状态入口升级与 0.14.0 界面

经用户单独批准，在共享锁下确认无 pending/running 任务后，仅升级 root broker/engine 并重启发布入口，备份位于服务器 `/var/backups/xian-oa-status-20261103-180035`。未更新构建 helper、ACL 或业务服务，升级前后 dev/test 六个服务容器编号相同。真实普通 SSH `liudaozhi` 的 overview 返回本人8条历史、最近 delivered；caoyang/xufeng 返回空本人历史，nobody 被拒绝；全部无 test releaseId。通过插件实际 HTTP handler、当前 CSRF 和真实 DSH SSH 桥验证 `/simple-github/api/docker-overview` 返回200。未触发新的业务发布。

0.14.0页面仅保留发布dev/test两个主按钮，自动计划/确认/提交、轮询阶段/耗时，历史和安全排查信息折叠；业务验收仍显式操作。overview 严格空请求，最多20条本人当前权限内的任务，test无权不返回可晋级ID；status/reconcile/accept按真实Unix任务本人校验。固定错误摘要不包含原始构建输出，原始日志继续root私有。客户端安装、重载和真实浏览器视觉验收仍需实际执行，DOM自动化不能替代它们。

## 目标与边界

普通成员通过自己的 Unix SSH 身份发布，不需要 sudo，不授予 Docker group/root 权限。源码仍由插件使用 GitHub 登录下载并锁定 SHA，服务器 Docker 编译；不会在成员电脑编译。服务器必须由管理员一次性安装受控入口。下文保留管理员审核模板；当前服务器实际进度见上节，不能以模板替代实测结果。

链路：插件 → 普通 SSH 命令 `python3 -I /usr/local/libexec/xian-oa-team-entry.py BASE64` → `/run/xian-oa-team-release.sock` → root broker → root 临时 stage 的既有 `temporary-release.py` → 后台 worker。

root 固定配置提供唯一 profile。profile.target.user 为 canonical 配置身份，不能随调用成员改变（否则 profile digest/state marker 会变化）。真正审计 actor 来自 Unix socket SO_PEERCRED 的 uid 经 pwd 解析，不接受调用者传 profile、actor、sudo 环境或命令。共享同一 Unix 登录账号的成员无法在此机制中区分，必须使用各自 Unix 账号；GitHub 显示姓名不是 broker 授权边界。

## 协议约定

BASE64 是 UTF-8 JSON 的标准 base64；只允许顶层 `{action,body}`，拒绝额外字段及重复 JSON key。

| action | body | Unix 授权环境 |
|---|---|---|
| check | `{head:完整40位SHA}` | dev |
| promote | `{releaseId}` | test |
| start | `{planId,confirmation:true,databaseRiskAccepted:true,bundle?}` | 从 root plan 读取，不信任客户端环境；plan actor 须为当前 Unix 用户 |
| status | `{jobId?}` | 从 root job 读取；省略 id 时锁定该用户最新 job 后再授权；没有 job 返回 idle |
| accept | `{jobId,confirmation:true}` | 从 root job 读取 |
| reconcile | `{jobId}` | 从 root job 读取 |

返回既有 engine 的 JSON，不转发 stderr/构建输出。失败命令最多 1 MiB 输出留在 root-only state 的 `last-command-failure.log`（0600）；Maven 测试失败时 surefire 报告保留在 state 的 `test-reports-JOBID/`（父目录0700）。这些可能包含敏感测试信息，仅供管理员核查，不经成员接口返回，不上传仓库；目前不自动清理历史报告。Maven Central 使用固定 HTTPS `https://maven.aliyun.com/repository/central` 公共镜像，设置文件由受控 helper 生成，不读取成员凭据。未知错误使用通用文案，避免业务凭据泄露。一个成员可查询/验收自己有环境权限的其他成员任务；创建 plan 的用户才能 start。test 必须独立授权，不因 dev 权限自动开放。broker 不接受 `_worker` 或 `query`。

dev bundle：`{path:'/tmp/dsh-upload-xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx/source.tar',sha256:64位小写hex,size:整数}`。路径 UUID 必须小写标准格式；**source.tar 实际内容仍必须为 gzip tar**（复用 engine 校验）。SSH 上传目录由成员创建为 0700，文件 0600，归属当前 Unix 用户；禁止目录/文件链接、硬链接、其他路径、超 256 MiB。broker 用目录 fd + NOFOLLOW + NONBLOCK + inode/ownership/size/mtime/ctime/hash 检查复制到 root stage 的 `archive.tar.gz`。复制校验成功后只 unlink 已确认 inode 的上传文件，尝试 rmdir 空目录，不递归清理用户目录。失败或身份发生变化的上传保留，用户自行核对清理。

root stage 固定 `/var/tmp/dsh-release-UUID/` 0700，脚本及 archive 0600。脚本只能来自 root-owned 安装文件，不执行上传脚本。同步结束清理 stage；start 从持久 plan/job 核对接管后交给既有 worker 终态清理。未知状态保守保留 stage，不强删可能仍在使用的源码，也不自动重试部署。强杀、磁盘错误仍可能留下 stage，管理员核对持久 job 后处理。

## 既有 engine 必须配合的最小契约

安装版本的 `temporary-release.py` 必须由父任务完成并测试以下兼容改动（broker 不修改该文件）：

1. `DSH_RELEASE_BROKER=1` 时只放行 `self.user != profile.target.user`，仍严格核验 SUDO_USER/SUDO_UID 与 pwd 的对应关系、euid root、root stage/script 权限。
2. spawn 后台 worker 时显式保留 `DSH_RELEASE_BROKER=1`，不可因重建最小 env 丢失。
3. profile 仍完全固定，不按成员重写 target.user，不弱化 bundle/init 校验。broker 用受控最小 env 设置 peer 对应 SUDO_USER/SUDO_UID；客户端不能设置这些值。

4. broker 将 root-owned build helper 复制到 stage 的 `build.py`（0600），engine broker 模式允许此固定文件并用 importlib 显式加载；worker 显式继承 `DSH_RELEASE_MYSQL_IMAGE`。该值仅来自 root 配置，不来自客户端 profile。

本次客户端入口已切换 team 模式，但尚未打包安装；旧插件不会因此自动更新。服务器必须同时安装本次匹配版本的 broker、engine 和 build helper。配置 mysqlImage 必须由管理员审核为 MySQL 8+、支持官方初始化语义、mysql 用户和 mysql CLI 的实际 digest；仅格式校验不能证明镜像主版本。

## test 数据库保护（新增，需成套安装后才生效）

仅旧版 OA 固定 broker 项目启用；通用项目 namespace 不自动套用。新增 `test-database.py` → `/usr/local/libexec/xian-oa-test-database.py`、`test-schema-plan.py` → `/usr/local/libexec/xian-oa-test-schema-plan.py`，root-owned 0600，与 broker/engine 同步审核安装；缺失 helper 会拒绝请求，不降级为无备份发布。

- 新 dev 成功任务记录结构快照并绑定镜像；旧任务没有快照，须先发布 dev。推广时校验 dev 当前结构没有漂移。
- test 先计算保守结构差异，不复制 dev 业务数据。不可证明安全的字段、索引、外键变更在执行前拒绝，不能承诺任意结构自动同步。
- 停止 test api/web 后才备份，再验证备份、清理旧备份、执行 DDL。系统备份按创建时间保留最新一个；新备份失败不删旧备份。创建期间短暂同时存在两份以保护恢复点。
- 结构变更或结构验证失败，立即使用本次备份恢复；恢复成功仍为发布失败，应用保持停止待核对。恢复失败为结果不确定，继续维护、禁止重复发布。不能把应用保持停止描述为服务已恢复。
- 镜像更新/健康检查失败不自动回退数据库，避免把不兼容镜像回退误称为完整回滚。启用保护后的 test 拒绝旧的仅镜像“恢复到此版本”，必须先核对数据库兼容性。历史任务存在 `db-restore-failed` 时服务端拒绝后续 test 计划；管理员必须独立完成恢复、核对并受控处理该故障记录，插件不会自动清除此门禁。
- 备份验证使用与受控 live 数据库相同 image ID 的隔离 MySQL，禁用网络、不挂载业务数据，临时数据目录为 2 GiB tmpfs；库体积超限或资源不足会拒绝发布并保留旧备份，不能跳过验证。只支持 InnoDB 基表；视图、触发器、事件、存储过程、跨库外键等不自动恢复。
- 数据库保护要求 test api/web 停止、无额外数据库会话，数据库没有对外映射端口或未知共享网络成员。仍须由运维排除并发 root/宿主机操作；瞬时会话检查不等于能阻止未来特权连接。
- 备份/恢复/验证是受控数据库操作；只有隔离测试通过不能证明真实 MySQL 可恢复。上线前必须在隔离 MySQL 演练，并核实应用以外写入者已隔离。当前不为已不健康且有 unresolved job 的 test 绕过健康门禁，首次恢复仍需独立受控处理。

## 管理员安装前准备

- Linux Python 3（SO_PEERCRED、systemd socket activation）、既有 Docker/Compose、审核后的四个 digest-pinned 基础镜像。
- root 审核并安装四个脚本到 `/usr/local/libexec/`：`team-release-broker.py` → `xian-oa-team-broker.py`，`team-release-entry.py` → `xian-oa-team-entry.py`，`temporary-release.py` → `xian-oa-temporary-release.py`，`team-release-build.py` → `xian-oa-team-build.py`。父目录全部 root-owned 且不可组/其他用户写。broker/entry 可 0755；engine/build 可 0600，root 可读即可。不得从成员可写目录执行 root 代码。
- 全部普通 SSH 账号模式：`allowedUsers.dev` 设为字符串 `all-ssh-users`，socket 使用 root:root 0666；由 broker 的 SO_PEERCRED 核验身份，按 `/etc/login.defs` UID_MIN/UID_MAX 和 `/etc/shells` 登录 shell 排除 root、系统账号、nobody、nologin/false。SSH 自身仍负责登录认证；broker 不重复解析 sshd 的密钥、PAM、Match/AllowUsers。新增普通登录账号无需改名单或重启，不给成员 sudo/docker 权限。
- 名单模式仍支持 `allowedUsers.dev` 数组；此时 socket 使用 root-owned 0660 和专用授权用户组。test 始终仅支持独立用户名数组，不接受 `all-ssh-users`。
- 固定 profile 的 roots/stateRoot/projects/baseImages 复用现有校验规范；stateRoot 与旧发布系统隔离，root0700。配置 `/etc/xian-oa-team-release.json` root-owned0600；父目录不可成员写；禁止在配置中放业务密码。
- 配置示意（非可直接使用；profile 必须填完整真实值）：

```json
{
  "profile": {"完整固定releaseProfile": "按temporary-release-README填写，不使用示意digest"},
  "allowedUsers": {"dev": "all-ssh-users", "test": []},
  "mysqlImage": "mysql:8.4@sha256:由管理员审核填写真实64位digest"
}
```

`allowedUsers.test` 可以为空；profile.allowedNames 仍须符合旧 profile validator 的非空形状，但不是此 broker 的 Unix 授权名单。不要为方便给成员任意 sudo 或加入 docker group。

## systemd 模板（仅文档，不自动安装）

`/etc/systemd/system/xian-oa-team-release.socket`：

```ini
[Unit]
Description=XiAN OA team release socket
[Socket]
ListenStream=/run/xian-oa-team-release.sock
SocketUser=root
SocketGroup=root
SocketMode=0666
Backlog=16
RemoveOnStop=true
[Install]
WantedBy=sockets.target
```

`/etc/systemd/system/xian-oa-team-release.service`：

```ini
[Unit]
Description=XiAN OA controlled team release broker
Requires=xian-oa-team-release.socket
After=docker.service
[Service]
Type=simple
User=root
Group=root
ExecStart=/usr/bin/python3 -I /usr/local/libexec/xian-oa-team-broker.py
UMask=0077
NoNewPrivileges=true
PrivateTmp=false
ProtectHome=true
ProtectSystem=full
TasksMax=256
MemoryMax=4G
CPUQuota=200%
LimitNOFILE=256
Restart=on-failure
RestartSec=5
KillMode=control-group
TimeoutStopSec=30
```

PrivateTmp 必须 false，否则看不到真实 SSH 上传 `/tmp`。不要配置 PrivateUsers/RestrictSUIDSGID 等未验证选项改变 peer uid 语义。root broker 仍是高权限受信任组件，不宣称 systemd sandbox 消除了风险。Docker daemon 构建不一定受 broker cgroup 的 CPU/内存限额约束，需管理员另审 Docker/BuildKit 资源限制。service restart/stop 可杀既有 worker，先确认无活动发布；不确定结果只查询/reconcile，不自动 replay。

broker 同时最多 4 个连接任务，线程池前有 semaphore，因此没有无界排队/无限 daemon 线程；accept backlog 16。请求 16 KiB、回复小于 64 KiB、读取总时限 10 秒、engine 同步调用 600 秒、socket 写 10 秒；entry 等待总时限 620 秒。后台构建复用 engine 的 3600 秒单次构建上限，不占 broker 线程。超限/断线并不证明未发布，先 query status。普通授权成员仍可能反复提交请求占满容量，当前不是多租户抗 DoS 服务，管理员应限制 SSH 用户及监控。

既有 engine 的环境锁/未决 job 阻断仍有效：这是串行拒绝冲突，不是无限任务排队。dev 达到 ready 后允许下一次发布，不伪造验收；未经验收不能晋级 test。broker 模式的 operation 锁额外取得本服务器既有 `/var/lib/xian-oa-release/.release.lock`，跨 dev/test、跨新旧入口共享互斥；不覆盖旧系统脚本、业务数据或配置。入口检查/启动冲突快速拒绝，已启动 worker 等待锁后重新核对部署快照和 plan 有效期。该固定路径根据服务器只读核查得出，其他服务器必须先核对旧 CLI 实际锁路径；真实进程间互斥仍待 Linux 联调。

## 构建与速度

- 全部 Java/npm 编译在服务器 Docker 内；不会本地编译或上传本地 jar/dist。
- Maven 的 pom 依赖层先于源码复制，`.m2` 使用 profile 命名空间的专用命名卷；前端先复制 package/lock 执行 npm ci，再复制源码。源码变动不会直接使依赖安装层失效。
- Maven package 不跳过测试。一次性独立 MySQL 容器不映射宿主端口、无业务数据挂载，runner 共享其网络命名空间，使用 loopback JDBC 和随机密码；只按本次完整 ID + 随机 label 清理容器，保留依赖缓存，不执行 prune。
- 首次拉镜像/依赖仍可能较慢；现阶段只有 fixture/mock 验证，尚无真实冷/热构建耗时，不能承诺秒级发布。

## 本地验证与尚未验证

`node --test team-release-broker.test.mjs` 使用隔离 Python unittest/mock，不需要 root，不连接服务器、不拉镜像、不读真实配置/凭据。内部 14 项 unittest 覆盖 JSON/动作边界、root plan 环境授权、Unix peer uid（macOS 下模拟 Linux SO_PEERCRED 字节，非实机认证证明）、固定上传格式、真实文件 descriptor/hash/link/权限校验、socket 请求限额、真实隔离子进程输出限额/超时杀进程、配置0600拒绝路径与静态有界并发约束。

实际 systemd socket activation、Linux 多账号组授权、root stage + 真实 engine worker 交接、服务器构建资源、原有系统互斥和端到端发布仍必须在另行授权后联调。测试通过不等于安装完成或全员已能发布。
