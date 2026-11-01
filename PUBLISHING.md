# 上传 GitHub 前的本地准备

此处只整理源码与忽略规则，不会自动推送、创建远程仓库、初始化本机 Git 仓库或改变服务配置。

- Android 项目上传 Kotlin / 资源 / Gradle 构建配置，以及 Gradle wrapper（含 gradle-wrapper.jar）。本机 SDK 路径、IDE 设置、构建目录、APK 和签名私钥不纳入源码。
- PC 后台上传 src、scripts、test、控制台与旧版入口脚本、文档、package.json、pnpm-lock.yaml。node_modules、cloudflared.exe、APK、备份及运行数据不纳入源码。
- .gitignore 只影响 Git 是否收录，不删除本地文件，也不对直接上传整个 ZIP 文件的内容生效；已经提交过的内容也不会因新增忽略规则自动退出历史。
- 实际账号校验值、聊天数据库、设备批准记录、后台管理凭据和加密隧道凭据默认存于当前 Windows 用户的 `%LOCALAPPDATA%\CodexPhoneBridge`，不要将该目录复制到仓库。也不要分享 `%USERPROFILE%\.codex`、签名私钥或整个用户数据备份。

## PC 后台的固定值与可配置项

- 首次固定域名由使用者输入；旧的已保存域名继续读取本机配置。可通过 BRIDGE_PUBLIC_HOSTNAME 提供首次配置默认值。
- 18766 是默认端口，127.0.0.1 是隧道访问本机后台的地址，均不是私密信息。换端口时，后台与 Cloudflare 服务地址需保持一致。
- 项目目录通过控制台设置，默认采用当前用户的 Documents/Codex；不固定为开发者的绝对路径。
- Codex 可执行文件通过 CODEX_EXE、PATH 和当前用户的安装位置查找。
- Windows 控制台会先查找 PATH 内的 Node.js，再尝试当前用户的 Codex 自带运行时位置；这是平台约定，不包含真实用户名。建议其他使用者安装 Node.js 24 或更新版本。
- 设备注册、请求签名、账号校验代码可以公开；实际密钥与运行状态不提交。
- 当前控制台、自动启动和凭据保护依赖 Windows，尚未作为跨平台后台打包。

## 从源码准备 PC 后台

1. 安装 Node.js 24 或更新版本；安装并登录 Codex，使后台可找到 Codex 可执行文件。
2. 在后端仓库运行 `pnpm install --frozen-lockfile` 安装依赖。
3. 从 Cloudflare 官方下载适合 Windows 的 cloudflared，放到 `tools/cloudflared.exe`。该二进制文件不进源码仓库。
4. 打开控制台，设置自己的账号密码、允许操作的项目目录和外网入口。固定域名及隧道凭据使用自己的配置。

Android 的可选跨运行时联通测试目前依赖开发工作区提供的 CODEXLINK_SECURITY_FIXTURE；未提供时会跳过该项，常规单元测试与 APK 构建不依赖此本机测试夹具。将此夹具整理到两个独立仓库内属于后续可移植性工作。

本次检查是上传前的文件排除与明显私密信息检查，不等同于完整的安全审计或对任意未来文件的泄露保证。
