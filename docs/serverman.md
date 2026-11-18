# 身份接入

音乐站在原 Web 登录页接收 ServerMan 邮箱、密码及双重验证代码，由本站后端调用中心认证接口。普通用户统一使用中心身份；Navidrome 管理员保留本地登录。

## 配置

设置 ServerManURL 为中心站来源地址。中心站 trustedOrigins 配置应包含音乐站来源，以便浏览器使用已有中心 Cookie 请求身份令牌。

音乐站优先恢复本站保存的 HttpOnly 中心会话 Cookie；已有中心 Cookie 时，浏览器直接请求中心的 /api/auth/token，本站通过 /auth/exchange 验证 RS256 签名、issuer、audience 和有效期，随后建立本站会话。登录与身份恢复均在当前页面完成。

音乐站通过 /api/auth/sign-in/email、/api/auth/two-factor/verify-totp 和 /api/auth/two-factor/verify-backup-code 完成认证。中心登录异常会显示在登录页。用户主动退出后，本次页面会话停止自动恢复。

## 账号归属

site_identity 使用中心来源与稳定用户 ID 确定身份，关联 Navidrome 用户 ID。首次登录创建普通音乐账号并使用音乐库的默认新用户权限。每次恢复中心身份后同步邮箱与名称，音乐账号的管理员权限由本站维护。

用户在账号页输入已有音乐账号与密码完成归属核验。绑定继续使用该音乐账号的 ID，其收藏、歌单与播放记录保留。管理员可在账号页查看中心身份并调整音乐账号绑定；变更后相关账号的旧令牌失效。

普通音乐账号的密码登录入口关闭。兼容数据接口使用本站签发的 JWT，媒体另行签发 EdgeOne D 类型令牌。本站普通用户的 JWT 最长每 15 分钟重新核对中心身份，页面每 5 分钟刷新一次中心会话。

## 接口索引

| 入口 | 用途 |
|---|---|
| POST /auth/serverman | 邮箱登录或双重验证 |
| POST /auth/exchange | 交换已经验证的中心身份令牌 |
| GET /auth/session | 恢复会话并同步中心资料 |
| POST /auth/logout | 清理本站 Cookie |
| GET /site/identity | 当前账号绑定 |
| POST /site/identity/bind | 验证并绑定已有音乐账号 |
| GET、PUT /site/identities | 管理员维护绑定 |

接口应用本站 BaseURL 前缀。接入依据为相邻 ServerMan 仓库的 docs/integration.md、src/auth.ts 与 src/platform.ts。
