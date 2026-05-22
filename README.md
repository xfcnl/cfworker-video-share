## 这就是依托史山，我半成品爱用谁用，我不会更新这个项目了，我会 **Archive this repository**

# cfworker-video-share

这是一个基于 Cloudflare Workers + Pages 的视频分享平台成品，实现了：

- 用户注册 / 登录 / 注销
- 邮箱验证、忘记密码与重置密码
- 视频链接/嵌入代码提交
- 管理员审核视频
- KV 存储用户、会话、视频和令牌数据
- 安全的跨域与 Cookie 管理

## 目录结构

- `worker/src/index.js` - Cloudflare Workers API 实现
- `frontend/index.html` - 静态前端页面
- `frontend/app.js` - 前端交互逻辑
- `frontend/style.css` - 样式
- `wrangler.toml` - Wrangler 配置
- `package.json` - 本地开发依赖

## 运行与调试

1. 安装依赖：

   ```bash
   npm install
   ```

2. 编辑 `wrangler.toml`，配置 KV 命名空间 ID 和环境变量：
   - `DATA` KV 命名空间 ID
   - `PUBLIC_BASE_URL`：前端部署地址
   - `PUBLIC_ORIGINS`：允许访问 API 的页面域名
   - `EMAIL_FROM`：发送邮件的发件人
   - `ADMIN_EMAIL`：管理员邮箱
   - `RESEND_API_KEY`：Resend API Key（可选，但建议配置）
   - `TURNSTILE_SECRET`：Cloudflare Turnstile 密钥（本地测试可留空）

3. 本地调试 Workers：

   ```bash
   npm run dev
   ```

> 注意：静态前端文件不在 `wrangler dev` 中自动托管。如果需要本地预览，请直接打开 `frontend/index.html` 或使用简单静态服务器。

## 部署

- 使用 `wrangler publish` 发布 Worker API。
- 静态页面可部署到 Cloudflare Pages 或任意静态托管服务。

## API 说明

- `GET /api/videos`：分页获取已审核视频列表
- `GET /api/videos/:id`：获取视频详情
- `POST /api/videos`：提交视频（需登录）
- `POST /api/auth/register`：注册并发送邮箱验证
- `POST /api/auth/verify-email`：邮箱验证
- `POST /api/auth/login`：登录
- `POST /api/auth/logout`：登出
- `GET /api/auth/me`：获取当前登录用户
- `POST /api/auth/forgot-password`：发送重置密码邮件
- `POST /api/auth/reset-password`：执行密码重置
- `GET /api/admin/pending`：管理员查看待审核视频
- `POST /api/admin/approve/:videoId`：管理员审核通过视频

## 说明

- 前端页面已经支持登录、投稿、管理员审核等基本功能。
- 后端使用 KV 存储所有数据，并提供缓存机制保障令牌与会话一致性。
- 视频提交仅允许可信平台链接与 `<iframe>` 嵌入代码。
