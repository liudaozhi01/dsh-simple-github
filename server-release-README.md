# 历史方案：固定服务器发布入口（已停用，不要安装）

> 最新方案改为插件本地获取远程源码、上传源码包、临时远程执行；不要求服务器安装本文件所述入口或配置。以下仅保留历史审查资料，不是当前接入步骤。当前说明见 `temporary-release-README.md`。

本次只有本地源码及 mock 测试；未 SSH、安装工具、构建业务镜像、操作 Docker、连接数据库或部署。此文件不是安装脚本。

## 人工预置条件（不自动完成）

管理员审查后自行将入口放在 `/usr/local/libexec/xian-oa-release.py`，root 所有且不可由组/其他用户写；Python 3 标准库、Git、Docker/Compose 必须已存在。不执行仓库主机脚本，npm/Maven 仅在 Docker 构建阶段运行。管理员应另外审查构建资源、出站网络和 Docker daemon 安全边界：构建不可信代码不是沙箱安全保证。

固定配置 `/etc/xian-oa-release.json` 及其祖先必须 root 所有、无组/其他用户写权限、无符号链接。字段严格为：

```json
{
  "stateRoot": "/var/lib/xian-oa-release",
  "workRoot": "/var/lib/xian-oa-release-work",
  "allowedUnixUsers": {"dev": ["release_operator"], "test": ["release_reviewer"]},
  "baseImages": {
    "node": "REVIEWED_NODE_IMAGE@sha256:REPLACE_WITH_64_HEX",
    "mavenJava21": "REVIEWED_MAVEN_JAVA21_IMAGE@sha256:REPLACE_WITH_64_HEX",
    "java": "REVIEWED_JAVA21_IMAGE@sha256:REPLACE_WITH_64_HEX",
    "nginx": "REVIEWED_NGINX_IMAGE@sha256:REPLACE_WITH_64_HEX"
  },
  "git": "/usr/bin/git",
  "docker": "/usr/bin/docker"
}
```

以上占位符故意无效；没有默认基础镜像，不自动探测/安装。管理员必须核实 node 对应仓库 engines，Maven 与运行时均 Java 21，所有镜像为已审查 digest pin；程序只能验证 pin 格式，不能凭名称证明 Java 版本。stateRoot/workRoot 为分开的专用 root:root 0700 目录（不可嵌套）；stateRoot 下预置空的 root 所有 `docker-config` 目录，拒绝存放 registry 凭据。不得把 workRoot 指向部署根目录或业务数据。工作目录内只删除当前随机标识、随机 nonce 匹配且持锁的任务源码目录，失败也走清理；不会清理 Docker 镜像/缓存。每个本任务构建镜像附加唯一且永久的 xian-oa-release-api/web:任务编号 tag；旧镜像和成功/失败构建镜像均不自动删除。目录清理同时核对 dev/ino 身份，目录被替换时拒绝删除。异常断电可能留下源码目录，需要人工确认任务已停止后仅清理对应源码；当前入口不自动扫描删除残留。

现有根目录固定 `/opt/xian-oa-dev-docker` 与 `/opt/xian-oa-test-docker`，项目固定 xian-oa-dev/test，服务必须恰为 api/web/db；api 不得有覆盖应用的 volume；web 必须仅保留 nginx.conf 到 `/etc/nginx/conf.d/default.conf` 的只读 bind。发现不符则拒绝，绝不自动修正部署文件。compose.yaml/root/入口/工具要求 root 所有且不可由组/其他用户写。各服务需已有唯一 healthy 容器；db 容器 ID/镜像/健康状态全程保持。

## 传输与身份

客户端命令为 `sudo -n /usr/bin/python3 -I /usr/local/libexec/xian-oa-release.py 'BASE64_JSON'`。JSON 使用 UTF-8 标准 base64，无换行；大小限制 8 KiB（编码参数不超过 16 KiB），重复键/未知字段/非标准数值拒绝。响应最终为唯一顶层 JSON 对象，小于 64 KiB；错误为 `{ "error": "..." }`，非零退出。不会返回构建输出或解析后的 Compose 凭据。

sudoers 必须由管理员审查，只允许这个固定、root-owned 入口与受约束参数，**不要授予任意 python3/shell/Docker sudo 权限**，不要保留可控 SUDO_USER/SUDO_UID。入口核验 sudo Unix 用户和 UID，再按 root 配置 ACL 授权；GitHub 姓名、客户端 name 均不是可信服务器身份。内部 `--worker ID TOKEN` 不属于客户端协议；随机令牌只在 root 私有状态中持久化。对入口的 sudo 授权应覆盖管理员审查的命令格式，不允许替换脚本/解释器参数。

请求统一 `{ "action": "...", "body": {...} }`：

| action | body | 响应 |
|---|---|---|
| check | `{ "environment": "dev" }`，也可空 | `{planId, environment, remote:{repository,branch,head}, expiresAt}`，Unix 秒，5 分钟 |
| promote | `{ "releaseId": "已验收dev记录ID" }` | 同 check 的 test 计划；不拉 Git、不构建 |
| start | `{ "planId": "...", "confirmation": true, "databaseRiskAccepted": true }` | `{jobId,status:"pending"}`；重复调用原计划返回同 job 当前状态 |
| status | `{ "jobId": "..." }` 或空 | 单 job；空返回 ACL 可见最新 job，无记录为 idle；白名单字段，小于 SSH 桥 4096 字节上限 |
| accept | `{ "jobId": "...", "confirmation": true }` | 完整公共 job（含 releaseId、status:delivered、accepted:true）；仅内部 ready/accepted 且实时健康、镜像、compose 全匹配 |
| reconcile | `{ "jobId": "..." }` | 实时观察及匹配布尔；只读，不变更状态或执行部署 |

check 仅允许 dev；test 只能 promote accepted dev。计划绑定创建者 Unix identity；允许不同且具对应环境权限的 reviewer accept。所有 ID 为 32 位小写十六进制。SHA 为 40 位，镜像标识为 Docker 本地 `sha256:...` image ID，**不是 registry manifest digest**，不上传 registry。

## 主链与持久化

Git 固定 public HTTPS `https://github.com/ssal-team/XiAN-OA.git`，只 fetch refs/heads/dev，禁外部/file 协议、系统/用户配置、凭据 helper、提示和 hooks。check fetch 锁定 SHA；worker 重新 fetch，若 dev 已改变则失败，要求重新 check，而不是悄悄发布新 SHA。固定 HEAD detached checkout 并核验 clean。隔离克隆不继承本地仓库配置。

固定生成多阶段 Dockerfile：根目录 npm ci/npm run build，backend Maven `mvn -B package`，无 skipTests；Java 21/runtime 和 nginx 由 root 审查 pin 提供。缺少 Testcontainers/Docker 测试环境时构建真实失败，不挂载宿主 Docker socket、不注入业务 DB 环境、不伪造测试通过。仅支持根 npm/package-lock.json + backend/pom.xml 布局；源码符号链接拒绝。忽略 .git/node_modules/target/dist/.env/env 文件、.npmrc、settings.xml、pem/key；无法保证开发者硬编码到源码的秘密不存在，管理员必须审查仓库。

异步 worker 为独立 session/process，SSH 断线不影响；状态/计划/验收记录使用同目录临时文件 + rename + 文件/目录 fsync，flock 串行化，先持久 intent/previous image+container IDs/compose 指纹/job marker 再做应用变更。start 原计划幂等；同环境 pending/running/ready/uncertain 均阻止另一新 job，dev 只有 failed/accepted 可开始后续发布，test ready 也可开始下一次同镜像晋级。公共 API 将内部 ready/accepted 映射为 delivered，并用 accepted 标识验收情况。

持久 override 使用 **Compose 默认识别的 `compose.override.yaml`**，root 私有原子写入，仅含 api/web image 两键；若原文件非本工具确切格式或存在其他 override 名称，拒绝覆盖。通过 `docker compose --project-directory ROOT -p PROJECT -f ROOT/compose.yaml -f ROOT/compose.override.yaml up -d --no-deps --no-build --pull never api web` 更新，并显式注入 API_IMAGE/WEB_IMAGE。合并结果必须除了这两项 image 完全不变。不修改 .env、db、网络、卷、端口、env 或 ops。不自动 rollback。

普通管理员在根目录执行不指定 `-f` 的 `docker compose up` 会自动加载该 override，故重启后镜像选择持久；显式仅 `-f compose.yaml` 的既有运维命令会绕过它，必须人工调整为同时带两个文件。服务 docker restart 保持既有容器镜像。不要将这个 override 误命名为不会自动加载的自定义文件后宣称永久生效。

worker 成功到 ready，accept 后成为可 promote 的 release。应用阶段异常、健康/镜像/DB漂移标记 uncertain，不自动回滚；构建/preflight 失败标记 failed。崩溃/断电可能保留 pending/running，reconcile 只观察不接管、不重新部署；需要管理员审查持久 marker/compose/容器/状态，手工恢复，当前协议未实现自动恢复或手工解除 uncertain 的写操作。

## 实际验证与限制

`node --test github协作插件/server-release.test.mjs` 通过 Node subprocess 执行 Python 标准库 fixture，mock 全部外部 Git/Docker/身份/worker spawn，覆盖 SHA/TTL、严格输入、ACL、风险确认、计划幂等、同镜像 test、验收、失败、不自动 rollback、只读 reconcile、DB identity、Dockerfile、源码目录清理等。无第三方依赖，不触碰真实 Docker/Git/DB。

**未验证/未实现：**真实服务器 sudoers/权限、GitHub 可达性、仓库业务布局与 Java/node 兼容性、Compose 版本差异、真实 npm/Maven/Testcontainers 构建、真实健康检查与线上迁移行为；没有 HTTP 业务验收、异步日志下载/轮转、过期状态 GC、失败部署自动回滚或自动修复。正常健康等待 180 秒；构建单命令 3600 秒。管理员需另行制定留存和人工恢复政策，不能将 mock 通过解释为已部署可用。
