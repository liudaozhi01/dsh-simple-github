# 西安 OA GitHub 协作网页版

## 第一次使用

1. 安装 Node.js 22、Git 和 GitHub CLI（`gh`）。需要发布时，还要有系统 OpenSSH 客户端。
2. 解压 ZIP。Windows 双击 `start.cmd`，macOS 在解压目录的终端运行 `node web/launch.js`，也可双击 `start.command`。保留启动服务的窗口。
3. 打开 [http://127.0.0.1:8787/](http://127.0.0.1:8787/)。用自己的 GitHub 账号登录，选择本机 XiAN-OA 仓库根目录。尚无仓库时，可在「项目」页执行克隆。

默认仓库为 `ssal-team/XiAN-OA`，协作分支为 `dev`。GitHub 项目访问权限由仓库管理员授予。

原 GitHub 管理员可以在「设置 → GitHub 管理后台」修改仓库、拉取和推送使用的协作分支、克隆范围与单分支克隆时检出的分支。保存后重新启动本机 Web 服务。

## 发布 dev / test

需要发布的成员，先向发布管理员申请自己的服务器 SSH 账号。打开网页版「设置 → 发布服务器连接」，输入 SSH 用户名，点「查找本机私钥」选择现有密钥，也可以手动填写私钥文件的绝对路径。点「保存并测试连接」，程序会校验已固定的服务器指纹，并只读检查发布入口。私钥文件保留在本机，加密私钥可先加载到系统 SSH agent。配置通过后进入「远程部署」。test 发布按团队原有账号权限和 dev 验收条件执行。

私钥路径要包含文件名。例如 `D:\keys` 是文件夹时，应填写其中对应的私钥文件，如 `D:\keys\id_ed25519`。

本版本内置与批准指纹匹配的服务器公钥，兼容 Windows 自带 ssh-keyscan 的密钥交换算法问题。SSH 实际连接时会严格校验服务器公钥。连接失败时，可在 PowerShell 运行 `Test-NetConnection 119.45.50.213 -Port 22`。如果 `TcpTestSucceeded` 为 `False`，把结果发给发布管理员检查网络或 SSH 访问策略。

如果端口 8787 已被占用，可运行 `node web/launch.js 8788`，以终端输出的地址为准。运行细节见 [Web 说明](web/README.md)。

## 远程更新

第一次换用支持更新的版本时，解压新版完整 ZIP，通过 start.cmd、start.command 或 node web/launch.js 启动。以后在「设置 → 网页版远程更新」填写可信发布方的 HTTPS manifest.json 地址，保存后点击「检查更新」，再点击「安装更新并重启」。可开启启动时自动检查，安装由使用者确认。

程序下载并核对每个文件的 SHA256，停止本机服务后替换程序文件并自动重启。新版本启动失败时恢复上一版。更新保留仓库配置、更新地址、SSH 设置和外部项目目录。当前存在克隆、同步或发布操作时，请待操作完成后安装。

发布者运行 node web/package-web.js 输出路径.zip，会同时生成 输出路径-update 目录。将这个目录完整上传到支持 HTTPS 的静态文件服务器，把该目录内 manifest.json 的公开地址发给同事。服务器应对清单禁用缓存，先上传 files 文件，最后发布 manifest.json。更新文件与清单需要位于同一站点，下载地址须直接返回文件。

打包时可通过 SIMPLE_GITHUB_WEB_UPDATE_URL 环境变量预设团队更新清单地址。后续版本沿用同一清单地址发布，并在 web/update.js 提升 WEB_VERSION。发布目录应使用访问者有权限直接下载的地址。
