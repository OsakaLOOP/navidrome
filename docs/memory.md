# 项目入口

- 根目录为整体项目，后端源码位于 `backend/`，Feishin 前端源码位于 `web/`。
- 设计入口为 `README.md`、`docs/fork.md`、`docs/architecture.md`、`docs/design.md`、`docs/todo.md`；实际完成情况见 `docs/development.md`。
- 中心站源码位于相邻的 `../ServerMan/`，接入说明为其 `docs/integration.md`。本阶段沿用 Navidrome 账号。
- Navidrome 的曲目模型文件名为 `backend/model/mediafile.go`；封面版本与继承规则在 `backend/model/artwork_id.go` 和曲目模型中。
- Feishin 数据适配入口为 `web/src/renderer/api/navidrome/navidrome-controller.ts`；归一化模型位于 `web/src/shared/api/navidrome/navidrome-normalize.ts`。
- 本机交互验证使用 `C:\Users\WRH\Music\share`；配置为 `.local/navidrome.toml`，数据为 `.local/data/`。用户负责交互测试，后续验证以此流程进行。
- 曲目原生接口的 `coverArtId` 由 `backend/persistence/artwork_hydration.go` 在批量加载图片信息后生成，选择规则为 `MediaFile.CoverArtID()`；同内容封面使用专辑的 `al-` 引用，`/media/` 的已有 `mf-` 别名通过 307 转向统一地址。

