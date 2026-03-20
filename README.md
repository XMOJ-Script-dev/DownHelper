# DownHelper

通过 Cloudflare Worker 将下载入口统一成：

- `https://你的域名/win/{version}.exe`
- `https://你的域名/linux/{version}.AppImage`
- `https://你的域名/macos/{version}.dmg`

Worker 会按命名规则拼接 GitHub Release 资产名：

- `ELXMOJ-${version}-${os}-${arch}.${ext}`

并由 Worker 代理拉取 `XMOJ-Script-dev/ELXMOJ` 对应 release 资产并返回下载流。

## 1. 命名与映射

- `os` 路径映射：
  - `win` / `windows` -> `windows`
  - `linux` -> `linux`
  - `mac` / `macos` / `darwin` / `osx` -> `macos`
- `arch` 默认从 User-Agent 推断，可用查询参数覆盖：
  - `?arch=x64`
  - `?arch=arm64`
  - `?arch=x86`

示例：

- 请求：`/win/1.2.3.exe?arch=x64`
- 目标资产：`ELXMOJ-1.2.3-windows-x64.exe`

## 2. 部署

1. 安装依赖（全局安装 Wrangler，若未安装）：
   - `npm i -g wrangler`
2. 登录 Cloudflare：
   - `wrangler login`
3. 在项目目录发布：
   - `wrangler deploy`
4. 可选：设置 GitHub Token（提高 API 速率限制）
   - `wrangler secret put GITHUB_TOKEN`
   - 仅在私有仓库/额外鉴权场景需要，当前实现不依赖 GitHub REST API 查 release

## 3. 配置

- 已固定只允许下载：`XMOJ-Script-dev/ELXMOJ` 的 Release 资产。
- 不提供仓库切换配置项。

## 4. 健康检查

- `GET /healthz`

返回 Worker 配置和用法说明。

## 5. 说明

- 当前实现是“Worker 代理下载”，不是 302 重定向。
- 支持 `Range` 请求，下载器可断点续传（取决于上游响应）。
- 客户端只看到你的域名下载地址，不会直接暴露 GitHub 资产 URL。

## 6. Cache API 缓存策略

- 使用 `caches.default` 缓存完整文件响应（仅 `GET` 且无 `Range`）。
- 缓存键会加入解析后的 `arch`，避免不同架构文件串缓存。
- 版本化文件默认写入：`Cache-Control: public, max-age=86400, s-maxage=31536000, immutable`。
- `Range` 请求会绕过缓存，直接回源并透传分片响应。

可通过响应头观察缓存状态：

- `x-downhelper-cache: HIT`：命中边缘缓存
- `x-downhelper-cache: MISS-STORED`：未命中并已写入缓存
- `x-downhelper-cache: BYPASS-RANGE`：分片请求绕过缓存
- `x-downhelper-cache: BYPASS`：其他绕过场景
