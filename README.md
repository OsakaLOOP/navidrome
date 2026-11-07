# ndFork

基于 Navidrome 和 Feishin 的音乐站。围绕浏览、播放、整理音乐与听友互动，逐步完成统一媒体地址、移动端离线播放、元数据编辑和一起听。

## 阅读顺序

1. [Fork 方案](docs/fork.md)：选型、复用范围和目录组织。
2. [开发架构](docs/architecture.md)：当前模块、认证、数据结构、媒体协议和缓存实现。
3. [产品设计](docs/design.md)：已交付的浏览与播放流程、封面规则及后续功能设计。
4. [分阶段待办](docs/todo.md)：每阶段的交付内容与验收流程。

本项目的设计以上述文档为准。[开发记录](docs/development.md)记录实际完成范围、启动方式和验证结果，[来源记录](sources.md)保存上游出处与阅读索引。

## 目录

| 目录 | 内容 |
|---|---|
| `backend/` | Navidrome 后端、管理界面与 Subsonic 兼容接口 |
| `web/` | 基于 Feishin 的音乐站前端 |
| `docs/` | 本项目设计、待办和开发记录 |

当前阶段沿用 Navidrome 账号。ServerMan 身份绑定与边缘鉴权在后续阶段对接。

已交付音乐站与管理界面整合、版本化媒体路径、曲目与专辑封面统一和浏览器缓存。构建及本机启动方式见[开发记录](docs/development.md)。

