# 视频分享网站实现文档

## 整体架构
- **前端**：Cloudflare Pages 托管静态资源，通过 `fetch` 调用 Workers API。
- **后端**：Cloudflare Workers 提供 RESTful API。
- **存储**：Workers KV 存储所有视频条目、用户数据、会话令牌、验证令牌。
- **邮件服务**：Resend 发送验证邮件。
- **视频源**：不存储视频文件，只存储用户提交的视频链接或嵌入代码，前端渲染安全的播放器。

## 前端 (Pages)
- 纯客户端渲染，页面包含表单（提交视频）、视频列表、登录/注册界面。
- 视频渲染：根据后端返回的平台和视频ID动态拼接 `<iframe>` 代码，仅允许可信域名（如 youtube.com、vimeo.com、bilibili.com 等），彻底避免 XSS。
- API 请求统一携带凭证（Cookie），并处理登录/注册流程。

## 后端 (Workers) API 设计

### 公开接口
- `GET /api/videos?cursor=xxx` – 分页获取已审核视频列表。
- `GET /api/videos/:id` – 获取单个视频详情。
- `POST /api/auth/register` – 注册，需 Turnstile 验证。
- `POST /api/auth/verify-email` – 邮箱验证。
- `POST /api/auth/login` – 登录。
- `POST /api/auth/logout` – 登出。
- `GET /api/auth/me` – 获取当前登录用户信息。
- `POST /api/auth/forgot-password` – 发送密码重置邮件。
- `POST /api/auth/reset-password` – 执行密码重置。

### 管理接口（需管理员身份验证）
- `POST /api/admin/approve/:videoId` – 审核通过视频。

### 安全措施
- 所有提交/注册接口强制启用 Cloudflare Turnstile 人机验证。
- API 频率限制：基于 IP 和 User ID，使用 Worker 内计数器（可存于 KV 或全局变量，配合 `fetch` 外部存储）。
- CORS 仅允许 Pages 域名。

## KV 数据模型与键名设计

### 视频条目
- Key：`video:<ulid>` 或 `video:<k-sortable-timestamp>`（如 `video:0001734567890`，使用字典序倒序时间戳以便列表按时间倒序）。
- Value（JSON）：
  ```json
  {
    "id": "ulid",
    "url": "原始链接",
    "platform": "youtube", // vimeo, bilibili 等
    "videoId": "dQw4w9WgXcQ",
    "title": "用户提交标题（可选）",
    "embedCode": null,      // 如果允许嵌入代码，则存放净化后的代码
    "submitterId": "user_xxx",
    "status": "pending",    // pending | approved | rejected
    "createdAt": "2026-04-25T12:00:00Z"
  }
  ```

### 用户资料
- Key：`user:<email_lowercase>`
- Value（JSON）：
  ```json
  {
    "id": "ulid",
    "email": "user@example.com",
    "passwordHash": "bcrypt_hash",
    "emailVerified": false,
    "createdAt": "..."
  }
  ```

### 邮箱验证令牌
- Key：`verify:<random_token>`
- Value：`{ "email": "user@example.com", "expiresAt": "..." }`
- TTL：1 小时（通过 KV 元数据 TTL 设置）

### 会话令牌
- Key：`session:<random_session_id>`
- Value：`{ "userId": "user_xxx", "createdAt": "..." }`
- TTL：7 天

### 密码重置令牌
- Key：`pwreset:<random_token>`
- Value：`{ "email": "user@example.com", "expiresAt": "..." }`
- TTL：30 分钟

## 视频提交与安全实现

1. **仅接受链接**：要求用户输入视频链接，Worker 使用正则或专用解析库提取平台与视频 ID。支持的平台白名单：YouTube、Vimeo、Bilibili、Youku 等。
2. **嵌入代码处理**（若选择支持）：在 Worker 中对嵌入代码做白名单过滤，只保留 `<iframe>` 标签，移除所有事件属性、`<script>`、`javascript:` 协议，最终存储净化后的 `embedCode`。
3. **审核流**：新提交视频 `status` 设为 `pending`。对外 `GET /api/videos` 只返回 `status:"approved"` 的条目。管理员调用审批接口将状态改为 `approved`。
4. **列表与分页**：
   - 使用 KV 的 `list()` 操作，`prefix: "video:"`，`limit=20`，利用 `cursor` 分页。
   - 键名采用字典序倒序时间戳（如 `video:9999999999999-<timestamp_ms>` 使用字符串比较，较新项目排在前面）。
   - 每次请求只返回键名列表，再批量 `get()` 取出内容（需注意一次 `list` 最多 1000 键，可利用游标循环）。为提高效率，可在写入时为索引 key 存储少量元数据，避免二次批量读取，但对简单场景直接批量读取可接受。

## 用户系统实现（全部基于 KV）

### 注册
- 校验 Turnstile token。
- 将邮箱转为小写作为唯一标识。
- 检查锁 key：`lock:email:<email>` 若存在（TTL 10秒）返回“操作频繁”；若无，写入该锁（值为 "1"，TTL 10s），继续。
- 检查 `user:<email>` 是否已存在，若存在且已验证则返回“邮箱已注册”；若存在但未验证可覆盖（考虑重发验证）。
- 生成 `userId`（ULID），使用 `argon2` 或 `bcryptjs`（Wasen） 哈希密码。
- 写入 `user:<email>` 数据，`emailVerified: false`。
- 生成随机验证令牌，存入 `verify:<token>`，设置 TTL 1小时。
- 调用 Resend API 发送邮件，内含链接 `https://你的域名/api/auth/verify-email?token=xxx`。
- **立即一致性补偿**：在 Worker 上下文中，利用 Cache API 将 `verify:<token>` 缓存一份（cache.put），key 为相同令牌，过期时间 1小时。后续验证接口会先查 Cache 再查 KV，可大幅降低 KV 写入延迟导致的“令牌不存在”问题。
- 返回成功，提醒用户查收邮件。

### 邮箱验证
- 接收 `token` 参数。
- 先查询 Cache API（`caches.default.match(token)`），若命中则直接使用。
- 若未命中，查询 KV `verify:<token>`。若不存在或已过期，返回“链接无效或已过期，请重新发送”。
- 存在则读取对应用户 key，将 `emailVerified` 设为 `true`，更新用户数据。
- 删除 KV 中的 `verify:<token>` 及对应 Cache。
- 展示验证成功页面。

### 登录
- 接收 email 和 password，查找 `user:<email>`，验证密码。
- 检查 `emailVerified` 是否为 `true`，否则提示去验证。
- 生成随机会话 ID，写入 `session:<sessionId>`，TTL 7天。
- **会话即时可用处理**：为防止登录后立即跳转时 KV 未同步，在 Set-Cookie 的同时，在响应中附带一个临时的一次性 token（或直接将会话 ID 写入 Cache API 并返回给前端，前端在首次加载时用该会话 ID 直接调用 `/api/auth/me`，若失败则重试一次，并同时查询 Cache 作为备选）。更可靠的方式：登录接口在返回前，将 `session:<sessionId>` 同时写入 Cache（TTL 设为较短如 60s），后续认证中间件查询会话时按顺序：Cache -> KV。这样即使 KV 未及时复制，Cache 仍可命中。
- Set-Cookie：`session_id=<sessionId>; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=604800`。

### 认证中间件
- 每个需认证的 API 从 Cookie 获取 `session_id`。
- 用上述 Cache -> KV 顺序查询 session 数据，获取 userId 并注入请求上下文。
- 若不存在，返回 401。

### 登出
- 从 Cookie 获得 sessionId，删除 KV `session:<sessionId>`，同时清除 Cache 中的对应条目。
- 清除 Cookie。

### 忘记密码 / 重置密码
- 用户输入邮箱，检查是否存在已验证用户。
- 生成 `pwreset:<token>` 存入 KV 与 Cache（同验证令牌），TTL 30分钟，发送 Reend 邮件。
- 重置页面接收 token，查询令牌（Cache 优先），若有效则允许设置新密码，更新 `user:<email>` 中的 `passwordHash`，删除令牌。

## 一致性问题处理总结（当前使用技巧）
- **邮箱验证/密码重置令牌**：写入 KV 后立即使用 Cache API 存储同一份数据，读取时 Cache 优先。令牌仅一次性使用，读取后删除两者。
- **注册锁**：使用短暂的 KV 锁 key 降低并发重复注册概率（非 100% 原子，可接受）。
- **登录后会话**：同时将新会话写入 Cache API（TTL 60s），认证逻辑优先查 Cache，确保刚登录的请求在 KV 未全局同步前依然有效。
- **用户资料更新**：如邮箱验证状态变更，直接更新 KV，读时若发现数据不一致可短期容忍（例如已验证用户再次登录时可能短暂显示未验证，此时登录接口返回错误促使用户重试，大部分情况不会出现）。
- 所有写入操作使用 `ctx.waitUntil` 保证邮件发送等异步任务继续执行。

## 注意事项与限制
- **并发邮箱唯一性**：没有原子条件写，极小概率发生账号覆盖。对于提交中的并发场景，依靠短暂的锁 key 和 UUID 碰撞概率极低来保证。
- **最终一致性延迟**：令牌写入后最长 60 秒才全局可读，Cache 旁路已能解决绝大多数实时访问场景。用户可能在极边缘情况下看到“链接无效”，此时引导重新发送。
- **密码哈希性能**：免费 Workers CPU 时间 10ms 可能无法完成 bcrypt，使用 `@tsndr/cloudflare-worker-jwt` 等轻量库或 `scrypt` 替代，也可使用 Wasm 版 bcrypt 并限制强度，或选用 argon2 的轻量配置。
- **KV 成本**：以每日 1 万活跃用户，每次访问 10 次 API 计算，视像列表 + 会话查询约 15 万 KV 读取/天，略微超过免费配额，成本极低（$0.5/百万读取）。写入量很小。
- **管理后台**：简单的 HTML 页面+JS，使用管理员账号登录后调用审核 API，通过单独的管理员标志判断权限（可在用户数据中添加 `role: "admin"` 字段）。

## 部署与域名
- Workers 绑定 KV 命名空间，部署 API 子域（如 `api.example.com`）。
- Pages 部署前端，构建输出为静态文件。
- 开启 Cloudflare 的 SSL/TLS 完全（严格）模式。
- Resend 配置发件域名验证（DKIM、SPF）。

该文档完全聚焦当前即刻实施的方案，明确利用 KV 存储，并给出了针对一致性和并发问题的即时解决技巧，未涉及任何未来扩展或升级建议。