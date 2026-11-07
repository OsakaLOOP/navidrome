# 来源记录

本项目的设计与开发入口见根目录 README。以下记录用于追溯选型与接口事实。

## Navidrome

- 仓库：https://github.com/navidrome/navidrome
- 导入版本：v0.64.2，提交 `101145742f4762164202cb4858c9126258bdc463`。
- 版本：https://github.com/navidrome/navidrome/releases/tag/v0.64.2
- 许可证：`backend/LICENSE`，GPL-3.0。
- 阅读入口：`backend/README.md`、`backend/go.mod`、`backend/Makefile`、`backend/Dockerfile`。

### README 索引

- Live Demo
- Installation
- Cloud Hosting
- Features
- Translations
- Documentation
  - Overview
  - Installation
    - Docker
    - Binaries
    - Build from source
  - Development
  - Subsonic API Compatibility
- Screenshots

### 已核实的源码

- 路由注册与静态界面：`backend/server/server.go`、`backend/cmd/root.go`、`backend/server/serve_index.go`。
- 兼容接口与认证：`backend/server/subsonic/api.go`、`backend/server/subsonic/middlewares.go`。
- 音频与转码：`backend/server/subsonic/stream.go`、`backend/server/subsonic/transcode.go`。
- 图片版本与条件请求：`backend/model/artwork_id.go`、`backend/model/artwork.go`、`backend/core/artwork/artwork.go`、`backend/server/imghttp/headers.go`。
- 曲目封面继承：`backend/model/mediafile.go` 的 `CoverArtID`、`DiscCoverArtID`、`AlbumCoverArtID`。
- 图片信息批量读取：`backend/persistence/artwork_hydration.go`；曲目、专辑和歌单曲目共用已有图片数据，本站新增读取字段 `coverArtId`。
- 本站媒体协议与缓存：`backend/server/subsonic/media.go`、`backend/server/music_ui.go`；实际接口说明见 `docs/architecture.md`。

## Feishin

- 仓库：https://github.com/jeffvli/feishin
- 导入版本：v1.17.0，提交 `5c169aca8d550032c9aa6e8e2b9f624d03d42fec`。
- 版本：https://github.com/jeffvli/feishin/releases/tag/v1.17.0
- 许可证：`web/LICENSE`，GPL-3.0。
- 阅读入口：`web/README.md`、`web/package.json`、`web/web.vite.config.ts`。

### README 索引

- Features
- Screenshots
- Getting Started
  - Desktop
    - macOS Notes
    - Linux Notes
  - Web and Docker
    - Docker Compose
  - Configuration
- FAQ
  - MPV 播放问题
  - 支持的音乐服务
  - Linux sandbox helper 问题
  - 自定义主题
- Development
- Translation
- License

### 已核实的源码与开发指引

- Web 构建与进程边界：`web/web.vite.config.ts`、`web/docs/agents/architecture.md`。
- 数据适配：`web/docs/agents/api.md`、`web/src/renderer/api/navidrome/`、`web/src/renderer/api/subsonic/`。
- 领域模型：`web/src/shared/types/domain-types.ts`、`web/src/shared/api/navidrome/`。
- 前端约定：`web/docs/agents/frontend.md`、`web/docs/agents/commits.md`。

## ServerMan

- 本地源码：`../ServerMan/`。
- 阅读入口：`docs/memory.md`、`docs/design.md`、`docs/integration.md`。
- 已确认：自建服务使用 OIDC，子站维护中心身份与本站账号的关联。

### 接入说明索引

- 接入布局
- 可执行样板
- 只读资源
- 签名命令与任务
- OSS 与订阅
- 原有站点迁移

## 本机开发工具

- Go 下载：https://go.dev/dl/ 。后端声明 Go 1.27，验证环境使用对应工具链。
- Windows C 编译器：https://github.com/skeeto/w64devkit/releases/tag/v2.11.0 。用于 SQLite 所需的 CGO 构建。

