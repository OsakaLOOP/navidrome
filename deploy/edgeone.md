# EdgeOne 媒体分发

媒体授权采用 EdgeOne 原生 D 类型，签名为 MD5(Key + Path + timestamp)。token 为小写十六进制签名，t 为十进制 Unix 签发时间。完整路径包含资源版本与输出规格。

源站配置 MediaSigningKey 与 MediaPublicURL。EdgeOne 媒体规则启用 D 类型 URL 鉴权，密钥与源站一致，签名参数为 token，时间参数为 t，采用十进制时间，有效时长为 900 秒。每次媒体请求都执行鉴权，包括缓存命中。

缓存键忽略 token、t、v、c，保留完整路径。封面与原始音频按 CDN-Cache-Control 缓存，转码、占位图、重定向和错误响应采用 no-store。启用 Range 回源与分片缓存，并保留签名参数回源。

跨域媒体允许音乐站来源的 GET、HEAD，暴露 Content-Length、Content-Range、Accept-Ranges，设置 Timing-Allow-Origin。

验收时由两名用户预热相同专辑和音频，分别记录封面、音频的命中数、总请求数和首字节时间，并对照同环境 Navidrome 的源站日志。
