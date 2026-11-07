# Fork 方案

## 产品与选型

音乐站以音乐库浏览、连续播放、音乐整理和听友互动为主线。当前交付首先完成浏览与播放所需的前后端整合、媒体路径、封面统一和缓存语义。

| 部分 | 导入版本 | 复用职责 |
|---|---|---|
| Navidrome | v0.64.2，`101145742f4762164202cb4858c9126258bdc463` | Go 服务、SQLite、音乐扫描、音乐库权限、搜索、歌单、收藏、播放记录、图片处理、音频与转码 |
| Feishin | v1.17.0，`5c169aca8d550032c9aa6e8e2b9f624d03d42fec` | React、TypeScript、Mantine、Navidrome 数据适配、音乐库页面、Web 播放器、队列、歌词和多歌手展示 |
| ServerMan | 后续对接的自建中心服务 | OIDC 中心身份与音乐站账号绑定 |

Feishin 的 Web 版通过已有 Navidrome 适配接入本站，将完整浏览与播放流程建立在现有播放器和领域模型上。Navidrome 管理界面保留为初始管理员创建、用户管理和音乐库管理入口。

## 仓库组织

```text
ndFork/
  README.md              项目与文档入口
  backend/               Navidrome 源码、管理界面、后端配置样例
  web/                   Feishin 源码与本站媒体适配
  docs/                  当前架构、产品设计、阶段任务和开发记录
  scripts/build.ps1      统一构建入口
  sources.md             来源、导入版本和阅读索引
```

两套源码作为普通目录纳入同一个 Git 仓库，统一提交和发布。后端 Go module 继续使用 `github.com/navidrome/navidrome`，前端保留 Feishin 的包结构与锁文件。Navidrome 导入提交作为仓库基线，Feishin 导入版本记录在本文及来源记录中。

根目录文档描述本项目的实际设计。两套上游源码中的 README 与构建文件随源码保留，本站的统一构建与部署以 `scripts/build.ps1` 和[开发记录](development.md)为准。

## 本次改动的归属

| 模块 | 实现位置 | 本项目行为 |
|---|---|---|
| 前后端整合 | `backend/server/music_ui.go`、`web/web.vite.config.ts` | 后端提供 `/music/`，前端预设同源 Navidrome 服务 |
| 路由注册 | `backend/cmd/root.go`、`backend/server/server.go` | 同时注册管理、数据、兼容及媒体入口，根地址跳转音乐站 |
| 媒体服务 | `backend/server/subsonic/media.go` | 路径承载资源身份、版本、尺寸、裁剪和音质，复用现有认证、图片和音频服务 |
| 封面统一 | `backend/model/mediafile.go`、`backend/persistence/artwork_hydration.go` | 批量读取图片信息后生成统一 `coverArtId`，兼容接口共用引用规则 |
| 前端媒体适配 | `web/src/renderer/api/navidrome/`、`web/src/shared/api/navidrome/` | 页面使用统一封面引用，普通流地址转换为版本化媒体路径 |
| 缓存控制 | `backend/server/imghttp/headers.go` 及各入口的 `NoStore` 中间件 | 动态响应及时更新，确定版本的媒体采用私有长期缓存 |
| 构建 | `scripts/build.ps1` | 一次生成音乐站、管理界面和包含页面的后端程序 |

音乐扫描、数据库查询、图片工作队列、源站图片缓存和音频转码继续由原有模块承担。后续元数据、社交与一起听按所属服务扩展，并复用同一组曲目、专辑、歌手与用户 ID。

## 运行与入口

运行时为一个 Go 音乐服务，前端以构建后的静态资源形式随程序提供。

| 地址 | 用途 |
|---|---|
| `/music/` | 音乐站：浏览、播放、队列、歌词与个人收藏 |
| `/app/` | Navidrome 管理界面 |
| `/auth/`、`/api/` | 本站登录、原生数据与管理接口 |
| `/rest/` | Subsonic 兼容接口和专用转码 |
| `/media/` | 本站封面与基本音频播放 |

音乐库与用户数据保留在 Navidrome，ServerMan 后续通过身份绑定关联已有音乐站用户。浏览器私有缓存已随媒体接口交付，共享 CDN 缓存与边缘鉴权见第二阶段。

## 更新上游与许可证

更新上游时，以记录的导入版本比较音乐库、格式兼容、图片与播放器相关变化，再按上述实现位置合并本站行为。Navidrome 的导入基线和 Feishin 的版本标识提供后续比较依据。

两套源码均保留各自的 GPL-3.0 许可证、版权信息和依赖声明，分别位于 `backend/LICENSE` 与 `web/LICENSE`。
