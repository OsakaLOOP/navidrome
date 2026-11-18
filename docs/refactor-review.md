# 重构提交审查与遗留问题清单

本文对照 [迭代审查清单](iteration-review.md) 及产品交互要求，逐模块核查 `741dc7e`（一起听）、`afb34be` / `0f2deb2`（评论区与表情）、`9be5fa5`（标签编辑）的当前源码实现，梳理仍存在的功能缺口、状态冲突与实现漏洞。

---

## 一、一起听（`741dc7e`）

### 1. 播放栏模式指示、快捷交互与独立播放列表

- **播放栏缺少模式切换、状态标识与直达退出**：
  [RoomPlayerButton](file:///d:/PROJ/GIT/ndFork/web/src/renderer/features/site/room.tsx#L202-L238) 仅以 `variant={joined ? 'light' : 'subtle'}` 区分是否加入，桌面端（[right-controls.tsx](file:///d:/PROJ/GIT/ndFork/web/src/renderer/features/player/components/right-controls.tsx#L93-L108)）、移动端迷你栏（[mobile-playerbar.tsx](file:///d:/PROJ/GIT/ndFork/web/src/renderer/features/player/components/mobile-playerbar.tsx#L229-L230)）和移动全屏底部栏（[mobile-fullscreen-player-bottom-controls.tsx](file:///d:/PROJ/GIT/ndFork/web/src/renderer/features/player/components/mobile-fullscreen-player-bottom-controls.tsx#L40-L42)）均未提供明显的「一起听模式 / 普通模式」状态标签或一键退出入口；未加入时 Tooltip 仅显示静态标题，无法预览房间当前曲目/播放状态/在线人数；加入后需点开 Modal 再点击退出，无法在播放栏直接退出或快速切歌/点歌。
- **播放栏队列按钮被隐藏，且多处队列视图未切换为共享队列**：
  加入一起听后，[right-controls.tsx](file:///d:/PROJ/GIT/ndFork/web/src/renderer/features/player/components/right-controls.tsx#L106) 直接隐藏 `<QueueButton />`，未将其替换为独立的共享队列弹窗（类似 [PopoverPlayQueue](file:///d:/PROJ/GIT/ndFork/web/src/renderer/features/now-playing/components/popover-play-queue.tsx#L19-L77)）。同时，右侧边栏队列（[sidebar-play-queue.tsx](file:///d:/PROJ/GIT/ndFork/web/src/renderer/features/now-playing/components/sidebar-play-queue.tsx#L89-L280)）、悬停抽屉队列（[drawer-play-queue.tsx](file:///d:/PROJ/GIT/ndFork/web/src/renderer/features/now-playing/components/drawer-play-queue.tsx#L9-L33)）以及正在播放页 `/now-playing`（[now-playing-route.tsx](file:///d:/PROJ/GIT/ndFork/web/src/renderer/features/now-playing/routes/now-playing-route.tsx#L10-L25)）均未判断 `useRoomActive()`，仍渲染个人 `<PlayQueue />`（仅显示 `syncSharedSong` 注入的 1 首单曲伪队列），导致查看队列不一致且操作失效。
- **播放栏其他控件在共享模式下状态割裂**：
  - [center-controls.tsx](file:///d:/PROJ/GIT/ndFork/web/src/renderer/features/player/components/center-controls.tsx#L59) 在共享模式下仍保留 `<StopButton />`，点击会触发 `mediaStop` 并向房间发送 `pause` 暂停所有成员；`<PlayerConfig />`（倍速、过渡等）仍可操作但被 `player.store.ts` 静默忽略，界面反馈与实际行为不一致。
  - [RoomPlayerButton](file:///d:/PROJ/GIT/ndFork/web/src/renderer/features/site/room.tsx#L224-L235) 弹窗内的 `<RoomQueue />` 点击歌手链接跳转时未关闭弹窗（未透传 `onNavigate`）。

### 2. 普通播放与一起听的隔离及状态同步漏洞

- **`clearQueue` 漏加共享模式拦截**：
  [player.store.ts](file:///d:/PROJ/GIT/ndFork/web/src/renderer/store/player.store.ts#L808-L815) 中 `clearQueue` 未检查 `if (sharedPlayback) return;`。若用户在侧栏、抽屉或 `/now-playing` 触发清空队列，会清空当前播放状态并触发 `web-player.tsx` 的 `onQueueCleared -> player.mediaStop()`，进而向服务端发送 `pause` 暂停整个房间。
- **AutoDJ 与队列自动保存污染共享/个人状态**：
  - [use-auto-dj.ts](file:///d:/PROJ/GIT/ndFork/web/src/renderer/features/player/hooks/use-auto-dj.ts#L39-L147) 监听个人队列剩余曲目数；共享模式下 `syncSharedSong` 只在 `queue.default` 放 1 首歌（`remaining === 0`），只要用户开启了 AutoDJ，每次切歌都会自动触发并调用 `addToQueueByData(..., Play.LAST)`，将随机推荐曲目强行插入共享房间队列。
  - [use-autosave.ts](file:///d:/PROJ/GIT/ndFork/web/src/renderer/features/player/hooks/use-autosave.ts#L15-L28) 未屏蔽共享模式，继续按曲数将 1 首单曲伪队列写入服务端个人保存队列（`savePlayQueue`），覆盖用户原有的服务端个人队列。
- **刷新/重连后个人队列恢复与设备生命周期缺口**：
  - `personalPlayback` 仅保存在 [player.store.ts](file:///d:/PROJ/GIT/ndFork/web/src/renderer/store/player.store.ts#L40) 的内存变量中，[useRoom](file:///d:/PROJ/GIT/ndFork/web/src/renderer/features/site/room.tsx#L67-L72) 的 `member` 也未持久化。用户在一起听期间刷新或关闭标签页后，客户端会静默回到未加入状态，本地 `personalPlayback` 无法走统一的恢复流程，而服务端 `Devices` 仍需等待 30s 超时才清理旧设备。
  - 进房时未对原普通播放先执行明确的暂停/保存提示或状态切换校验；且 [useRoom](file:///d:/PROJ/GIT/ndFork/web/src/renderer/features/site/room.tsx#L131-L139) 轮询单次失败即立刻把本地播放器强制置为 `playing: false`（`syncSharedSong(..., false)`），网络轻微抖动即中断音频。
- **切歌/进房初始进度在异步取流后丢失（音画跳变）**：
  [RoomBridge](file:///d:/PROJ/GIT/ndFork/web/src/renderer/features/site/room.tsx#L114-L130) 在切歌或带进度加入房间时调用 `syncSharedSong(song, position, playing)`，同时调用 `setTimestampStore(position)` 和 `seekToTimestamp`。但 [use-stream-url.tsx](file:///d:/PROJ/GIT/ndFork/web/src/renderer/features/player/audio-player/hooks/use-stream-url.tsx#L19-L46) 通过异步 `useQuery` 获取流地址，[web-player.tsx](file:///d:/PROJ/GIT/ndFork/web/src/renderer/features/player/audio-player/web-player.tsx#L312-L343) 收到首次 `onPlayerSeekToTimestamp` 时新音频源尚未加载完毕，seek 被丢弃，导致音频先从 `0:00` 起播后再在下一轮 450ms 轮询时二次跳转，产生明显卡顿与跳音。
- **从曲库点歌/替换队列的交互冲突**：
  - [player-context.tsx](file:///d:/PROJ/GIT/ndFork/web/src/renderer/features/player/context/player-context.tsx#L313-L315) 在共享模式下执行 `Play.NOW` / `Play.SHUFFLE` 仍会弹出「替换当前队列」确认框，而实际 [dispatchPlayerCommand](file:///d:/PROJ/GIT/ndFork/web/src/renderer/features/site/room.tsx#L345-L360) 将其映射为追加到共享队列末尾（`add`），既不替换也不立即插播；`addToQueueByUniqueId` 同样忽略插入位置直接追加；`TrackPage`（[track-page.tsx](file:///d:/PROJ/GIT/ndFork/web/src/renderer/features/site/track-page.tsx#L49)）甚至绕过 `PlayerProvider` 直接调用 `setQueue`。
  - [song-context-menu.tsx](file:///d:/PROJ/GIT/ndFork/web/src/renderer/features/context-menu/menus/song-context-menu.tsx#L59-L68) 仅有「加入一起听」（无「下一首一起听」），且未加入房间时仍显示该入口；专辑右键菜单（`album-context-menu.tsx`）缺少批量加入一起听入口。

### 3. 队列页交互与服务端边界问题

- **共享队列仅支持上下按钮，不支持拖拽排序**：
  [RoomQueue](file:///d:/PROJ/GIT/ndFork/web/src/renderer/features/site/room.tsx#L240-L336) 仅提供上移/下移按钮，未实现拖拽排序，且 [RoomContents](file:///d:/PROJ/GIT/ndFork/web/src/renderer/features/site/room.tsx#L479-L534) 在弹窗/页面播放区缺少封面图、总时长/当前进度 `mm:ss` 显示及可跳转歌手链接。
- **不同音乐库权限用户混听阻断整个房间**：
  [site_room.go](file:///d:/PROJ/GIT/ndFork/backend/server/site_room.go#L74-L82) 的 `canHearRoom` 对无权访问房间内任意曲目的用户直接返回 `403`，缺乏更细粒度的权限提示或自动跳过处理；另外 `previous` 在空队列时仍自增 `room.Version`，`next` 在队尾停止时未将 `room.Position` 归零或对齐曲目时长。

---

## 二、评论区、表情与社交资料（`afb34be`、`0f2deb2`）

### 1. 对标主流音乐软件的评论区体验与状态问题

- **缺少排序、热评区与筛选维度**：
  [site_social.go](file:///d:/PROJ/GIT/ndFork/backend/server/site_social.go#L38) 仅支持按 `c.id DESC`（时间倒序）单一分页返回，无「最热 / 精彩评论（按点赞数）」置顶或切换、无「按时间点评论」筛选，难以在长讨论中快速发现高质量评论。
- **回复关系未形成可展开的楼中楼，跨页引用定位体验受限**：
  当前所有回复均平铺在主时间线，仅以单行截断的 `.quote` 块展示被回复内容；不支持在一条主评论下直接折叠/展开其回复列表，点击跨页引用时仅弹出只读单条弹窗（[anchor Modal](file:///d:/PROJ/GIT/ndFork/web/src/renderer/features/site/discussion-panel.tsx#L577-L585)），无法在弹窗内继续查看完整上下文或顺畅定位。`locate` 设置的高亮状态 `highlight`（[discussion-panel.tsx](file:///d:/PROJ/GIT/ndFork/web/src/renderer/features/site/discussion-panel.tsx#L148)）也没有定时自动淡出。
- **点赞及操作锁阻塞全局交互，无乐观更新**：
  [discussion-panel.tsx](file:///d:/PROJ/GIT/ndFork/web/src/renderer/features/site/discussion-panel.tsx#L104-L118) 与 [renderCard](file:///d:/PROJ/GIT/ndFork/web/src/renderer/features/site/discussion-panel.tsx#L266) 在 `busy` 非空时全局禁用所有评论的点赞、引用和跳转按钮；每次点赞/取消赞后调用 `client.invalidateQueries({ queryKey: key })` 全量重拉已加载的所有分页，既产生闪烁与多余流量，又阻塞用户连续浏览/点赞操作。
- **发表、编辑与快捷键体验不完整**：
  - 输入框未支持 `Ctrl+Enter` / `Cmd+Enter` 快捷发送；发布成功后仅在底部显示静态文本提示 `discussion.posted`，未平滑定位/高亮新评论，长列表下反馈感弱。
  - 已发布评论仅支持删除，不支持编辑（或时间窗内修改）；发表前插入表情仅写入 `(pack_name)` 纯文本短码，写模式下不渲染缩略预览，必须切换至「预览」页签才能确认效果。
  - 评论时间戳仅使用 `Intl.DateTimeFormat(..., { dateStyle: 'medium', timeStyle: 'short' })` 固定长格式，未对近期评论使用「刚刚 / N 分钟前」等相对时间（Tooltip 保留完整时间），在移动全屏播放页较占空间。

### 2. 播放页讨论与时间点定位衔接问题

- **时间点附带静态冻结，跳转在切歌场景下丢失**：
  - 发评时勾选 `site.attachTime`（[discussion-panel.tsx](file:///d:/PROJ/GIT/ndFork/web/src/renderer/features/site/discussion-panel.tsx#L438-L455)）只在勾选瞬间读取一次当前时间戳，歌曲继续播放或拖动后不会同步刷新，也缺乏手动调整/重新抓取按钮。
  - 点击评论时间点 `jump(time)`（[discussion-panel.tsx](file:///d:/PROJ/GIT/ndFork/web/src/renderer/features/site/discussion-panel.tsx#L159-L173)）在当前未播该曲时调用 `setQueue([song], 0, time)` + `mediaSeekToTimestamp(time)`，但因 [use-stream-url.tsx](file:///d:/PROJ/GIT/ndFork/web/src/renderer/features/player/audio-player/hooks/use-stream-url.tsx#L19-L46) 异步取流，[web-player.tsx](file:///d:/PROJ/GIT/ndFork/web/src/renderer/features/player/audio-player/web-player.tsx#L312-L343) 在音频就绪前即执行 seek 被忽略，曲目会从 `0:00` 开始播放而非指定时间点；同时直接调用 `setQueue` 绕过了 `PlayerProvider` 的过滤与队列替换确认逻辑。
- **桌面与移动全屏播放页入口/导航不一致**：
  - 桌面全屏控制栏（[full-screen-player-queue.tsx](file:///d:/PROJ/GIT/ndFork/web/src/renderer/features/player/components/full-screen-player-queue.tsx#L116-L120)）讨论 Tab 图标误用 `info`，而移动端（[mobile-fullscreen-player-bottom-controls.tsx](file:///d:/PROJ/GIT/ndFork/web/src/renderer/features/player/components/mobile-fullscreen-player-bottom-controls.tsx#L70)）使用 `discussion` 图标，图标语义不统一，且均未展示当前曲目评论数角标。
  - 移动端讨论页顶栏（[mobile-fullscreen-player.tsx](file:///d:/PROJ/GIT/ndFork/web/src/renderer/features/player/components/mobile-fullscreen-player.tsx#L634-L650)）只有返回播放器与收起全屏按钮，缺少直接切到歌词或队列的入口。
  - 桌面全屏页在电台模式（`isRadioActive`）下，讨论 Tab 未针对非曲目场景屏蔽或提示。

### 3. 曲目详情、收藏公开资料与社区安全缺口

- **收藏名单与个人资料页未完成分页与状态区分（对应 S3）**：
  - [site_social.go](file:///d:/PROJ/GIT/ndFork/backend/server/site_social.go#L106) 收藏名单 `people` 与 [siteProfile](file:///d:/PROJ/GIT/ndFork/backend/server/site_social.go#L263) 公开收藏均硬编码 `LIMIT 100` 无分页，前端弹窗及资料页也无截断提示；`siteProfile` 还存在逐条调用 `s.metadataObject` 的 N+1 查询。
  - [ProfilePage](file:///d:/PROJ/GIT/ndFork/web/src/renderer/features/site/account-page.tsx#L135-L174) 未区分 `visibility !== 'public'`（未公开）与公开但暂无收藏（`favorites.length === 0`），两种情况均只显示标题与空白；且未按曲目/专辑/歌手分类展示，仅渲染为一串文本按钮，未复用原生列表组件。
- **曲目详情页未与原生详情页对齐（对应 07）**：
  [TrackPage](file:///d:/PROJ/GIT/ndFork/web/src/renderer/features/site/track-page.tsx#L19-L78) 缺少 `LibraryHeaderBar`、封面图、专辑跳转链接、时长/格式等基础信息；播放按钮直接调用 `usePlayerStoreBase.getState().setQueue([data])`，跳过了 `PlayerProvider` 校验与队列替换确认。
- **缺少举报与内容治理入口（对应 `iteration-review.md` 第 04 节验收要求）**：
  目前评论区与服务端均未提供评论举报接口、举报菜单项及管理员审核处理界面。
- **TypeScript 类型检查报错**：
  `pnpm --dir web typecheck` 中 [discussion-panel.tsx](file:///d:/PROJ/GIT/ndFork/web/src/renderer/features/site/discussion-panel.tsx#L88-L95) 的 `useInfiniteQuery` 未显式标注响应泛型/返回类型，导致 `last`、`page` 推断为 `unknown` 及 `first.commentCount` / `favoriteCount` / `people` 报类型错误（同时当前工作区原有的 `site-api.ts` 与 `media.ts` 亦有未通过 `tsc` 的类型错误）。

---

## 三、标签编辑、封面覆写与扫描同步（`9be5fa5`）

### 1. 数据一致性与服务端逻辑漏洞

- **专辑覆写恢复（`restore`）后无法还原下属无独立记录曲目的数据库字段**：
  在 [site_metadata.go](file:///d:/PROJ/GIT/ndFork/backend/server/site_metadata.go#L329-L336) 中，恢复专辑的 `name` 或 `albumArtist` 覆写后，遍历专辑曲目时调用 [RestoreMetadataSource](file:///d:/PROJ/GIT/ndFork/backend/persistence/metadata_overrides.go#L69-L82)。若某首曲目此前从未单独创建过 `site_metadata` 记录，`RestoreMetadataSource` 因 `sql.ErrNoRows` 直接返回 `nil`；曲目实体仍保留上次继承写入 `media_file` 表的旧覆写值，随后 `inheritMetadata` 也不再覆盖该字段，导致专辑恢复原值后曲目仍残留旧专辑名/专辑歌手，且因文件 `mtime` 未变，常规增量扫描（`info.ModTime().After(dbTrack.SourceUpdatedAt)`）也不会自动修正。
- **继承路径未重算排序字段，破坏按名/歌手排序**：
  [applyMetadata](file:///d:/PROJ/GIT/ndFork/backend/persistence/metadata_overrides.go#L95-L97) 对没有独立 `site_metadata` 记录的对象直接跳转 `inheritMetadata`，跳过了第 134–142 行的 `OrderTitle`、`OrderArtistName`、`OrderAlbumArtistName`、`OrderAlbumName` 重算逻辑；而 [inheritMetadata](file:///d:/PROJ/GIT/ndFork/backend/persistence/metadata_overrides.go#L231-L255) 仅更新展示字段（`Artist`、`AlbumArtist`、`Album`）而未同步重算对应的 `Order*` 字段。修改歌手名或专辑歌手覆写后，曲目与专辑排序索引出现陈旧值。
- **Go `json.Unmarshal` 复用已有结构体导致 `Participants` map 残留旧角色键**：
  [site_metadata.go](file:///d:/PROJ/GIT/ndFork/backend/server/site_metadata.go#L247-L251) 先将 `mergedData` 反序列化到 `item` 校验，再执行 `_ = json.Unmarshal(sourceData, item)` 试图还原 `item`。但 Go 的 `json.Unmarshal` 反序列化 map 时仅合并覆盖出现的键、不会删除原 map 中已存在但 JSON 中缺失的键（如从 `albumartist` 等角色恢复时 `source["participants"]` 为 `{}` 或缺少该角色）。叠加后续 `Put` 中同样直接向 `value` 反序列化，可能使已删除或恢复的参与者角色残留至下次持久化。
- **先建 DB 覆写后写音频文件时，旧覆写会继续遮蔽新文件标签**：
  在 [site_metadata.go](file:///d:/PROJ/GIT/ndFork/backend/server/site_metadata.go#L252-L298) 的 `edit`（写入文件）模式下，文件写入并触发扫描后，`mfRepo.Put` 会更新 `site_metadata.source`，但仍会将数据库里已有的 `site_metadata.overrides` 叠加上去。若该曲目或专辑此前存在对应字段的数据库覆写，界面不会提示或清理旧覆写，用户写入文件后看到的仍然是旧的数据库覆写值。
- **合并专辑 / 多文件夹专辑改标签时的主键冲突与迁移失效**：
  - [phase_1_folders.go](file:///d:/PROJ/GIT/ndFork/backend/scanner/phase_1_folders.go#L411-L435) 仅在目标 `album.ID` 不存在（`ErrNotFound`）且 `entry.tracks`（单个文件夹内的曲目）数量等于旧专辑全部曲目时迁移站点数据；若多碟/多文件夹专辑分属不同目录，或编辑标签使专辑与另一张已有专辑合并（目标 `album.ID` 已存在），[MoveSiteAlbum](file:///d:/PROJ/GIT/ndFork/backend/persistence/metadata_overrides.go#L32-L45) 无法安全合并（若直接 `UPDATE` 还会触发 `site_metadata`/`site_artwork` 主键冲突），原专辑的评论、封面覆写与元数据覆写会被孤立。
- **封面接口缺少维护锁与空覆写记录副作用**：
  - [site_cover.go](file:///d:/PROJ/GIT/ndFork/backend/server/site_cover.go#L65-L66) 上传与恢复封面仅加 `siteMetadataMu`，未像 `saveMetadata` 一样调用 `scanner.LockForMaintenance()`，可能与正在运行的库扫描产生并发写冲突。
  - [touchArtworkMetadata](file:///d:/PROJ/GIT/ndFork/backend/server/site_cover.go#L156-L170) 调用 `TouchMetadata` 会为原本没有元数据覆写的曲目/专辑插入 `overrides='{}'` 的 `site_metadata` 占位行，并刷新 `revision`；若上传失败发生在 `Write` 之后、`WithTx` 之前，ImageStore 会残留孤立图片文件。

### 2. 文件写入能力与格式边界漏洞

- **文件标签写入对 Ogg/Opus 流级标签与非标准字段存在兼容缺口**：
  [editFileTags](file:///d:/PROJ/GIT/ndFork/backend/server/site_metadata.go#L583-L595) 对所有格式（`.mp3/.flac/.m4a/.ogg/.opus`）统一采用 `ffmpeg -map 0 -c copy -metadata key=val`。对于 `.ogg` / `.opus`，VorbisComment 标签属于音频流元数据（通常需 `-metadata:s:a:0`），全局 `-metadata` 在部分版本 FFmpeg 封装时会被忽略或写入容器层；同时文件写入模式仅支持 8 个基础字段（曲目）/ 4 个字段（专辑），不支持内嵌歌词、流派（`genre`）、合辑标记、排序标签（`sortTitle` 等）及 `.wav` / `.aiff` / `.wv` / `.ape` 等常见无损格式。
- **专辑 `fileYear` 在文件写入表单中始终为空且可能误清标签**：
  [model/metadata.go](file:///d:/PROJ/GIT/ndFork/backend/model/metadata.go#L10) 为专辑文件模式定义了 `fileYear`，但 `MetadataFields("album")`（第 42 行）不含 `fileYear`，导致 [metadata-editor.tsx](file:///d:/PROJ/GIT/ndFork/web/src/renderer/features/site/metadata-editor.tsx#L280) 打开专辑文件写入模式时 `fileYear` 默认显示为空白而非现有年份；若管理员清空数字输入框（提交 `0`），[site_metadata.go](file:///d:/PROJ/GIT/ndFork/backend/server/site_metadata.go#L588-L590) 会将 `"0"` 转为空串 `-metadata date=` 直接抹除所有文件的年份标签。
- **批量文件写入前缺少格式预检**：
  若专辑中混有 1 首不支持写入的文件格式（如 `.wav`），前端不会在确认前标出不可写文件，服务端需逐个调用 FFmpeg 生成前 N 个临时文件后才在 [site_metadata.go](file:///d:/PROJ/GIT/ndFork/backend/server/site_metadata.go#L573-L575) 报错中止。

### 3. 前端编辑表单与工作流缺口

- **多选批量编辑曲目被禁用**：
  [edit-metadata-action.tsx](file:///d:/PROJ/GIT/ndFork/web/src/renderer/features/context-menu/actions/edit-metadata-action.tsx#L49-L51) 强制限制 `(albumIds?.length ?? songItems?.length) !== 1` 时禁用「编辑元数据」，无法在歌曲列表多选后批量修改相同标签（如批量改专辑、年份或专辑歌手），与原版 Feishin 多选编辑能力相比存在倒退。
- **歌手选择与角色管理受限（对应 D3）**：
  - [ArtistField](file:///d:/PROJ/GIT/ndFork/web/src/renderer/features/site/metadata-editor.tsx#L67-L73) 仅查询 `albumArtistLimit: 18`，可能漏掉仅作为曲目歌手、未归为专辑歌手的已有艺人；且 `matches.some(...)` 与后端 [site_metadata.go](file:///d:/PROJ/GIT/ndFork/backend/server/site_metadata.go#L478-L480) 禁止创建与已有歌手同名的新建项，无法真正新建同名歌手。
  - 当前仅覆盖 `artist`、`albumArtist` 两个字段，不支持编曲、作词、演奏者等其他 `participants` 角色编辑；文件写入模式下 `artist`/`albumArtist` 退化为纯文本输入，既无搜索辅助，也未说明多歌手分隔符规则（`; ` vs ` / `）。
- **歌词编辑与时间轴试听缺陷（对应 D4）**：
  - [LyricsField](file:///d:/PROJ/GIT/ndFork/web/src/renderer/features/site/metadata-editor.tsx#L475-L615) 无法新增、删除歌词语言/版本或修改 `lang`/`kind`；当原多版本歌词被恢复为单版本或空歌词时，状态 `index` 未随列表长度钳位，会导致 `lyrics[index]` 越界为空白。
  - 歌词时间轴预览点击试听 `seek(ms)`（第 540–556 行）同样在切歌时直接调用 `setQueue([song], 0, ms / 1000)` + `mediaSeekToTimestamp`，存在与评论区相同的队列确认跳过和异步取流初始 seek 丢失问题。
- **表单脏值判断与恢复交互细节**：
  [metadata-editor.tsx](file:///d:/PROJ/GIT/ndFork/web/src/renderer/features/site/metadata-editor.tsx#L137-L138) 修改字段后即使手动改回原值，`draft` 中仍保留该键，导致「保存」按钮可提交无实际变更的覆写；此外点击「恢复原值」无二次确认，且部分字段在文件模式与覆写模式之间仍缺乏明确的语义提示。
