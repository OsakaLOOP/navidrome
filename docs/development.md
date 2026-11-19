# 开发记录

## 已完成的交付

2026-11-07，基础版本经用户交互验收通过。当前交付包含源码导入、Feishin Web 整合、媒体路径、缓存控制与曲目和专辑封面统一，前后端构建成功。实现与行为分别记录在[开发架构](architecture.md)和[产品设计](design.md)。

| 内容 | 结果 |
|---|---|
| 源码 | Navidrome v0.64.2 位于 `backend/`，Feishin v1.17.0 位于 `web/` |
| 音乐站 | `/music/` 提供 Web 页面，`settings.js` 指向同源 Navidrome 服务 |
| 管理界面 | `/app/` 提供管理员创建、用户与音乐库管理 |
| 媒体路径 | `/media/cover/`、`/media/stream/` 承载资源与输出规格 |
| 缓存 | 动态接口 `no-store`，版本化封面和原始音频私有长期缓存，封面支持条件请求，原始音频支持 Range |
| 封面统一 | 原生曲目数据返回 `coverArtId`，同内容封面使用 `al-`，独立曲目封面使用 `mf-`，已有媒体别名通过 `307` 指向统一地址 |
| 兼容接口 | `/rest/` 继续提供浏览、收藏、播放记录和播放，专用转码保持现有入口 |
| 验收 | 后续采用本机音乐库与浏览器交互，由用户确认体验 |

标签编辑提供站内覆写、批量曲目覆写和文件写入。文件写入使用 TagLib，支持 MP3、FLAC、M4A、Ogg、Opus、WavPack、APE、WAV 和 AIFF。站点在替换原文件前逐个回读所选字段；格式不支持的字段可使用站内覆写。所选字段的站内覆写随文件替换一起更新，后续扫描刷新音乐库索引。专辑合并时，目标专辑保留同字段覆写及已有封面，双方评论合并。

## 依赖与安装

使用 Node.js 24、pnpm 11、Go 1.27、FFmpeg，以及支持 CGO 的 C 编译器。Windows 本机工具位于 `.tools/go/bin` 与 `.tools/w64devkit/bin`。

在项目根目录执行：

```powershell
$env:Path = "$PWD/.tools/go/bin;$PWD/.tools/w64devkit/bin;$env:Path"
$env:CGO_ENABLED = '1'
$env:GOPROXY = 'https://mirrors.aliyun.com/goproxy/'
go -C backend mod download -x
pnpm --dir web install --frozen-lockfile --ignore-scripts
npm --prefix backend/ui ci --ignore-scripts --no-audit --no-fund
```

`go mod download -x` 显示具体模块的请求与响应，已缓存模块直接复用。本机依赖下载日志位于 `.local/go-mod-download.log`。

## 构建

```powershell
./scripts/build.ps1
```

| 顺序 | 处理 | 产物 |
|---|---|---|
| 1 | `web/` 执行 `pnpm build:web`，使用 4 GB Node 堆上限 | `backend/resources/music/` |
| 2 | 从管理界面的依赖准备 Workbox 文件，再执行 `npm run build` | `backend/ui/build/` |
| 3 | 使用 `netgo,sqlite_fts5` 和 CGO 构建后端 | `backend/navidrome.exe` |

管理界面使用的 Workbox 文件为 `sw`、`core`、`strategies`、`routing`、`navigation-preload`、`precaching`，构建脚本从已安装依赖复制到管理界面的生成目录。

音乐站和管理界面随 Go 程序嵌入；更新前端后，按完整顺序构建再启动后端。生成文件、本机工具、音乐数据和运行日志由 Git 忽略。

## 配置与启动

`backend/ndfork.example.toml` 提供本地配置样例。从 `backend/` 启动时，音乐位于 `music/`，数据位于 `data/`：

```powershell
./navidrome.exe --configfile ndfork.example.toml
```

| 配置 | 作用 |
|---|---|
| `MusicFolder` | 音乐文件目录 |
| `DataFolder` | SQLite、图片内容、缓存与其他本站数据目录 |
| `Address`、`Port` | 监听地址与端口 |
| `BaseURL` | 站点前缀或外部基础地址 |
| `EnableExternalServices = false` | 浏览使用本地标签和已保存信息，统一关闭外部集成 |
| `EnableInsightsCollector = false` | 本地配置关闭上游使用统计采集 |
| `LastFM.Enabled = false`、`ListenBrainz.Enabled = false` | 本地配置关闭对应外部集成 |

启用外部元数据匹配与播放记录上报的产品流程安排在后续阶段；现有文件中的 MusicBrainz 等标签继续保留在音乐元数据中。

## 本机运行

2026-11-17，本次交互验证采用本地账号：`.local/navidrome.toml` 中 `ServerManURL = ''`、`EnableRegistration = true`。音乐站登录页提供用户名密码登录与注册，注册账号使用音乐库的默认新用户权限。现有管理员 `Loopo` 继续使用原密码，普通验证账号为 `demo`，密码为 `demo12345`。注册开关默认关闭；配置中心站后，普通用户继续采用中心认证。

本次优先检查：管理员编辑曲目、专辑和歌手后重新扫描，确认覆写、搜索、歌手关联、歌词及封面一致；两个账号验证评论、回复、时间跳转、点赞与收藏可见性；两个浏览器验证一起听的播放同步、主持人接任、断线重连和个人队列恢复；下载专辑后断网重新打开，确认离线播放、定位、删除和账号隔离。基础浏览、连续播放、封面引用及媒体缓存作为回归检查。中心登录、账号绑定、线上 EdgeOne 与刮削服务另行验证。

本机配置为 `.local/navidrome.toml`：

多账号会话恢复统一使用请求中已验证的令牌及其账号；切换账号后的旧请求响应不再更新新账号的凭据或触发退出。浏览器已验证两个独立会话分别登录后刷新，以及 Cookie 属于另一账号时恢复原账号会话。

本地登录验证发现 Subsonic 客户端使用旧凭据拆分规则，`jwt` 参数未正确传递，用户信息请求认证失败并触发自动退出。客户端改用 `URLSearchParams` 读取凭据；自动退出保留离线音乐，清理提示仅用于主动退出。浏览器已验证注册后保持登录、刷新恢复会话、音乐库读取、音频 Range，以及认证失效时自动退出且不显示离线清理提示。

| 项目 | 值 |
|---|---|
| 音乐库 | `C:\Users\WRH\Music\share` |
| 数据目录 | `D:\PROJ\GIT\ndFork\.local\data` |
| 地址 | `127.0.0.1:4533` |
| 管理界面 | `http://127.0.0.1:4533/app/` |
| 音乐站 | `http://127.0.0.1:4533/music/` |
| 日志 | `.local/server.log`、`.local/server-error.log` |

从项目根目录启动开发服务（默认同时启动后端与 Vite 前端，也支持单独启动）：

```powershell
./dev.ps1        # 同时启动后端（4533）与 Web 前端（5173，已代理 /api、/auth、/rest、/media、/site、/settings.js 等）
./dev.ps1 api    # 仅启动 Go 后端（别名: backend）
./dev.ps1 web    # 仅启动 Web 前端（别名: frontend）
```

如需运行已构建的独立可执行文件，从项目根目录启动：

```powershell
./backend/navidrome.exe --configfile .local/navidrome.toml
```

首次访问管理界面创建管理员，随后在音乐站使用同一账号登录。启动时使用现有数据并按扫描配置更新音乐库，文件与用户记录继续保存在上述目录。

## 浏览器交互验收

打开 F12 的 Network，保留请求日志，并启用浏览器缓存。

| 操作 | 观察结果 |
|---|---|
| 登录 | `POST /auth/login`，原生接口使用 `x-nd-authorization`，媒体地址携带 `u`、`s`、`t` |
| 浏览专辑与曲目 | `/api/album`、`/api/song` 等请求返回当前数据，动态响应为 `no-store` |
| 查看同封面的专辑与曲目 | 曲目响应的 `coverArtId` 为 `al-{专辑ID}_{图片版本}`，同规格封面请求路径一致 |
| 查看独立曲目封面 | `coverArtId` 为对应的 `mf-` 引用，显示曲目独立图片 |
| 读取已有 `mf-` 媒体地址 | 图片与专辑一致时返回 `307`，随后读取相同尺寸与裁剪方式的 `al-` 地址 |
| 重复查看封面 | 已确认版本采用私有长期缓存，可从内存或磁盘读取；条件请求匹配时返回 `304` |
| 播放与调整进度 | 原始音频使用含文件版本的 `/media/stream/…/raw/0/0`；读取未缓冲区间时可见 Range 请求和 `206` |
| 收藏与取消收藏 | `/rest/star`、`/rest/unstar` 更新后，相关列表、详情和播放器显示当前状态 |
| 页面切换 | 个人队列与播放进度继续保留，页面使用 `/music/#/…` 路由 |
| 更新图片或音频并完成扫描 | 数据接口返回新的媒体版本，页面使用新版本路径 |

相同媒体路径以同一内容版本、尺寸、裁剪及音质为前提。浏览器查询参数中的会话凭据会影响完整 URL 的缓存条目。共享 CDN 命中率与后端性能测量安排在第二阶段，验收目标与统计方式见[分阶段待办](todo.md)。

## 代码入口

| 能力 | 文件 |
|---|---|
| 总路由注册 | `backend/cmd/root.go`、`backend/server/server.go` |
| 音乐站资源与配置 | `backend/server/music_ui.go` |
| 媒体路由、版本检查、封面别名 | `backend/server/subsonic/media.go` |
| 图片缓存响应 | `backend/server/imghttp/headers.go` |
| 曲目封面选择与批量图片读取 | `backend/model/mediafile.go`、`backend/persistence/artwork_hydration.go` |
| 前端封面请求 | `web/src/renderer/api/navidrome/media.ts` |
| 前端播放地址转换 | `web/src/renderer/api/navidrome/navidrome-controller.ts` |
| 前端曲目数据 | `web/src/shared/api/navidrome/navidrome-types.ts`、`navidrome-normalize.ts` |
| 播放版本传递 | `web/src/renderer/features/player/audio-player/hooks/use-stream-url.tsx` |
| Web 构建与 PWA | `web/web.vite.config.ts` |
