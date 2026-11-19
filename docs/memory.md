# 项目入口

- 根目录为整体项目，后端源码位于 `backend/`，Feishin 前端源码位于 `web/`。
- 评论表情入口为 `web/src/renderer/features/site/discussion-emoji.tsx`，素材和清单位于 `web/src/renderer/public/emoji/`，与博客 `public/emoji/` 使用同一套标识。
- 设计入口为 `README.md`、`docs/fork.md`、`docs/architecture.md`、`docs/design.md`、`docs/todo.md`；实际完成情况见 `docs/development.md`。
- 中心站源码位于相邻的 `../ServerMan/`，接入说明为其 `docs/integration.md`，当前认证实现为 `src/auth.ts` 与 `src/platform.ts`。本仓库接入说明为 `docs/serverman.md`。
- Navidrome 的曲目模型文件名为 `backend/model/mediafile.go`；封面版本与继承规则在 `backend/model/artwork_id.go` 和曲目模型中。
- Feishin 数据适配入口为 `web/src/renderer/api/navidrome/navidrome-controller.ts`；归一化模型位于 `web/src/shared/api/navidrome/navidrome-normalize.ts`。
- 本机交互验证使用 `C:\Users\WRH\Music\share`；配置为 `.local/navidrome.toml`，数据为 `.local/data/`。用户负责交互测试，后续验证以此流程进行。
- 曲目原生接口的 `coverArtId` 由 `backend/persistence/artwork_hydration.go` 在批量加载图片信息后生成，选择规则为 `MediaFile.CoverArtID()`；同内容封面使用专辑的 `al-` 引用，`/media/` 的已有 `mf-` 别名通过 307 转向统一地址。
- 本站功能入口为 `backend/server/site.go` 与 `web/src/renderer/features/site/`，覆盖账号绑定、元数据、评论、一起听与离线管理。
- 评论区、一起听和标签编辑分别由 `discussion-panel.tsx`、`room.tsx` 和 `metadata-editor.tsx` 提供。相关后端入口为 `backend/server/site_social.go`、`backend/server/site_room.go` 与 `backend/server/site_metadata.go`。
- 用户广场位于 `web/src/renderer/features/site/account-page.tsx` 与 `community.tsx`，时间线、好友、头像和播放记录接口位于 `backend/server/site_community.go`。收藏、评分与收听里程碑由 `backend/db/migrations/20261119000100_community.sql` 写入动态表。
- Feishin 的全局字体回退配置位于 `web/src/shared/styles/global.css`，字体设置由 `web/src/renderer/themes/use-app-theme.ts` 应用。
- 持久化覆写合并位于 `backend/persistence/metadata_overrides.go`；`source_updated_at` 保存文件时间，`updated_at` 保存对外有效版本，扫描器依据文件时间检查变化。
- 标签写入入口为 `backend/server/site_metadata.go` 的 `editFileTags`，使用现有 TagLib 依赖修改并回读待替换的副本。
- 站内媒体授权位于 `backend/server/media_grant.go`，采用 EdgeOne D 类型，部署说明为 `deploy/edgeone.md`。

