import { getAssetFromKV } from "@cloudflare/kv-asset-handler";

const MAX_VIDEO_LIST = 20;
const SESSION_TTL = 60 * 60 * 24 * 7;
const TOKEN_TTL = 60 * 60;
const RESET_TTL = 30 * 60;
const PUBLIC_KEY_PREFIX = "https://app.example";

function toHex(buf) {
  return [...new Uint8Array(buf)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function fromHex(hex) {
  return new Uint8Array(hex.match(/.{1,2}/g).map((byte) => parseInt(byte, 16)));
}

async function hashPassword(password) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(password),
    { name: "PBKDF2" },
    false,
    ["deriveBits"],
  );
  const derived = await crypto.subtle.deriveBits(
    { name: "PBKDF2", hash: "SHA-256", salt, iterations: 120000 },
    key,
    256,
  );
  return `pbkdf2$120000$${toHex(salt)}$${toHex(derived)}`;
}

async function verifyPassword(password, stored) {
  if (!stored || typeof stored !== "string") return false;
  const parts = stored.split("$");
  if (parts.length !== 4 || parts[0] !== "pbkdf2") return false;
  const iterations = Number(parts[1]);
  const salt = fromHex(parts[2]);
  const expected = parts[3];
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(password),
    { name: "PBKDF2" },
    false,
    ["deriveBits"],
  );
  const derived = await crypto.subtle.deriveBits(
    { name: "PBKDF2", hash: "SHA-256", salt, iterations },
    key,
    256,
  );
  return toHex(derived) === expected;
}

function makeId() {
  return crypto.randomUUID().replace(/-/g, "");
}

function makeCacheRequest(key) {
  return new Request(`https://cache.local/${key}`);
}

async function cachePut(key, data, ttlSeconds = 60) {
  const response = new Response(JSON.stringify(data), {
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": `max-age=${ttlSeconds}, public`,
    },
  });
  await caches.default.put(makeCacheRequest(key), response);
}

async function cacheGet(key) {
  const response = await caches.default.match(makeCacheRequest(key));
  if (!response) return null;
  try {
    return await response.json();
  } catch {
    return null;
  }
}

async function kvJsonGet(env, key) {
  const value = await env.DATA.get(key);
  if (!value) return null;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

async function kvJsonGetMany(env, keys) {
  if (!keys.length) return [];
  if (typeof env.DATA.getMany === "function") {
    return await env.DATA.getMany(keys, { type: "json" });
  }
  return await Promise.all(keys.map((key) => kvJsonGet(env, key)));
}

async function kvJsonPut(env, key, data, ttl) {
  const options = ttl ? { expirationTtl: ttl } : undefined;
  await env.DATA.put(key, JSON.stringify(data), options);
}

function createCorsHeaders(request, env) {
  const allowed = new Set([
    env.PUBLIC_BASE_URL || "http://localhost:8787",
    ...(env.PUBLIC_ORIGINS
      ? env.PUBLIC_ORIGINS.split(",").map((item) => item.trim())
      : []),
  ]);
  const origin = request.headers.get("Origin");
  if (!origin) return {};
  const url = new URL(request.url);
  allowed.add(url.origin);
  const localHostPairs = [
    ["127.0.0.1:8787", "localhost:8787"],
    ["localhost:8787", "127.0.0.1:8787"],
  ];
  const originHost = origin.replace(/^https?:\/\//, "");
  const urlHost = url.origin.replace(/^https?:\/\//, "");
  if (localHostPairs.some(([a, b]) => originHost === a && urlHost === b)) {
    allowed.add(origin);
  }
  if (!allowed.has(origin)) return {};
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Credentials": "true",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
  };
}

function jsonResponse(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", ...headers },
  });
}

function textResponse(text, status = 200, headers = {}) {
  return new Response(text, { status, headers });
}

async function verifyTurnstile(token, env) {
  if (!env.TURNSTILE_SECRET) {
    return true;
  }
  if (!token) {
    return false;
  }
  const body = new URLSearchParams({
    secret: env.TURNSTILE_SECRET,
    response: token,
  });
  const res = await fetch(
    "https://challenges.cloudflare.com/turnstile/v0/siteverify",
    {
      method: "POST",
      body,
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
    },
  );
  const data = await res.json();
  return Boolean(data.success);
}

function sanitizeEmbedCode(html) {
  const iframeMatch = html.match(/<iframe[\s\S]*?<\/iframe>/i);
  if (!iframeMatch) return null;
  const iframe = iframeMatch[0];
  const attrs = Array.from(iframe.matchAll(/(\w+)=['"]([^'"]+)['"]/gi));
  const allowedAttrs = new Set([
    "src",
    "width",
    "height",
    "allowfullscreen",
    "frameborder",
    "loading",
    "referrerpolicy",
    "allow",
  ]);
  const attrStrings = [];
  let src = "";
  for (const [, name, value] of attrs) {
    const low = name.toLowerCase();
    if (!allowedAttrs.has(low)) continue;
    if (low === "src") {
      if (!/^https:\/\//i.test(value)) return null;
      src = value;
    }
    attrStrings.push(`${low}="${value.replace(/"/g, "&quot;")}"`);
  }
  if (!src) return null;
  return `<iframe ${attrStrings.join(" ")}></iframe>`;
}

function parseVideoInput(value) {
  if (!value) return null;
  const trimmed = value.trim();
  if (trimmed.startsWith("<iframe")) {
    const embedCode = sanitizeEmbedCode(trimmed);
    if (!embedCode) return null;
    return { platform: "embed", videoId: null, url: null, embedCode };
  }
  let url;
  try {
    url = new URL(trimmed);
  } catch {
    return null;
  }
  const hostname = url.hostname.replace(/^www\./, "").toLowerCase();

  if (hostname.includes("youtube.com") || hostname.includes("youtu.be")) {
    let id = null;
    if (hostname.includes("youtu.be")) {
      id = url.pathname.slice(1);
    } else {
      id = url.searchParams.get("v") || url.pathname.split("/").pop();
    }
    if (!id) return null;
    return {
      platform: "youtube",
      videoId: id,
      url: `https://www.youtube.com/watch?v=${id}`,
      embedCode: null,
    };
  }
  if (hostname.includes("vimeo.com")) {
    const id = url.pathname.split("/").filter(Boolean).pop();
    if (!id) return null;
    return { platform: "vimeo", videoId: id, url: trimmed, embedCode: null };
  }
  if (hostname.includes("bilibili.com")) {
    const match = trimmed.match(/(av|bv|cv|ep|ss)\d+/i) || trimmed.match(/\d+/);
    const id = match ? match[0] : null;
    if (!id) return null;
    return { platform: "bilibili", videoId: id, url: trimmed, embedCode: null };
  }
  if (hostname.includes("youku.com")) {
    return {
      platform: "youku",
      videoId: trimmed,
      url: trimmed,
      embedCode: null,
    };
  }
  return null;
}

function buildIframe(video) {
  if (video.embedCode) return video.embedCode;
  const id = encodeURIComponent(video.videoId);
  switch (video.platform) {
    case "youtube":
      return `<iframe src="https://www.youtube.com/embed/${id}" loading="lazy" frameborder="0" allowfullscreen allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"></iframe>`;
    case "vimeo":
      return `<iframe src="https://player.vimeo.com/video/${id}" loading="lazy" frameborder="0" allowfullscreen allow="autoplay; fullscreen; picture-in-picture"></iframe>`;
    case "bilibili":
      return `<iframe src="https://player.bilibili.com/player.html?bvid=${id}" loading="lazy" frameborder="0" allowfullscreen></iframe>`;
    case "youku":
      return `<iframe src="${video.url}" loading="lazy" frameborder="0" allowfullscreen></iframe>`;
    default:
      return "";
  }
}

function getCookieValue(request, name) {
  const cookie = request.headers.get("Cookie") || "";
  const parts = cookie.split(";").map((part) => part.trim());
  for (const part of parts) {
    if (part.startsWith(`${name}=`)) {
      return decodeURIComponent(part.slice(name.length + 1));
    }
  }
  return null;
}

function makeCookieHeader(name, value, options = {}) {
  const segments = [`${name}=${encodeURIComponent(value)}`];
  if (options.maxAge) segments.push(`Max-Age=${options.maxAge}`);
  if (options.path) segments.push(`Path=${options.path}`);
  if (options.httpOnly) segments.push("HttpOnly");
  if (options.secure) segments.push("Secure");
  if (options.sameSite) segments.push(`SameSite=${options.sameSite}`);
  return segments.join("; ");
}

async function getSessionData(sessionId, env) {
  if (!sessionId) return null;
  const cacheKey = `session:${sessionId}`;
  const cached = await cacheGet(cacheKey);
  if (cached) return cached;
  const session = await kvJsonGet(env, cacheKey);
  if (!session) return null;
  await cachePut(cacheKey, session, 60);
  return session;
}

async function getAuthenticatedUser(request, env) {
  const sessionId = getCookieValue(request, "session_id");
  const session = await getSessionData(sessionId, env);
  if (!session?.email) return null;
  const user = await kvJsonGet(env, `user:${session.email}`);
  return user;
}

async function ensureAdminUser(env, email, password) {
  const adminEmail = String(env.ADMIN_EMAIL || "")
    .trim()
    .toLowerCase();
  const adminPassword = String(env.ADMIN_PASSWORD || "").trim();
  if (!adminEmail || email !== adminEmail || !adminPassword) return null;
  const userKey = `user:${email}`;
  let user = await kvJsonGet(env, userKey);
  if (!user) {
    user = {
      id: makeId(),
      email,
      passwordHash: await hashPassword(String(password)),
      emailVerified: true,
      role: "admin",
      createdAt: new Date().toISOString(),
    };
    await kvJsonPut(env, userKey, user);
    return user;
  }
  let updated = false;
  if (user.role !== "admin") {
    user.role = "admin";
    updated = true;
  }
  if (!user.emailVerified) {
    user.emailVerified = true;
    updated = true;
  }
  if (updated) {
    await kvJsonPut(env, userKey, user);
  }
  return user;
}

async function getVideoById(id, env) {
  const indexKey = `video:id:${id}`;
  const videoKey = await env.DATA.get(indexKey);
  if (!videoKey) return null;
  return kvJsonGet(env, videoKey);
}

async function listVideos(env, cursor, limit = MAX_VIDEO_LIST) {
  let result;
  let collected = [];
  let nextCursor = cursor;
  const maxSearch = 100;
  let rounds = 0;
  while (collected.length < limit && rounds < 10) {
    result = await env.DATA.list({
      prefix: "video:item:",
      limit: Math.min(100, limit * 2),
      cursor: nextCursor,
    });
    const keys = result.keys.map((item) => item.name);
    if (!keys.length) break;
    const values = await kvJsonGetMany(env, keys);
    for (const video of values) {
      if (video && video.status === "approved") {
        collected.push(video);
      }
      if (collected.length >= limit) break;
    }
    nextCursor = result.cursor;
    if (!nextCursor) break;
    rounds += 1;
  }
  return { items: collected.slice(0, limit), cursor: nextCursor || null };
}

async function listPendingVideos(env) {
  const result = await env.DATA.list({ prefix: "video:item:", limit: 1000 });
  const keys = result.keys.map((item) => item.name);
  if (!keys.length) return [];
  const values = await kvJsonGetMany(env, keys);
  return values.filter((video) => video && video.status === "pending");
}

async function sendResendEmail(env, recipient, subject, html) {
  if (!env.RESEND_API_KEY) {
    return;
  }
  await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.RESEND_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from: env.EMAIL_FROM,
      to: recipient,
      subject,
      html,
    }),
  });
}

async function handleApiRequest(request, env) {
  const url = new URL(request.url);
  let path = url.pathname.replace(/\/+$/, "");
  if (path.startsWith("/api/")) {
    path = path.slice(4);
  }
  const segments = path.split("/").filter(Boolean);
  const method = request.method.toUpperCase();
  const corsHeaders = createCorsHeaders(request, env);

  if (method === "OPTIONS") {
    return new Response(null, { status: 204, headers: { ...corsHeaders } });
  }

  if (segments.length === 0) {
    return jsonResponse({ error: "Not found" }, 404, corsHeaders);
  }

  if (segments[0] === "videos") {
    if (segments.length === 1) {
      if (method === "GET") {
        const { cursor } = Object.fromEntries(url.searchParams.entries());
        const result = await listVideos(env, cursor);
        return jsonResponse(result, 200, corsHeaders);
      }
      if (method === "POST") {
        const user = await getAuthenticatedUser(request, env);
        if (!user) {
          return jsonResponse({ error: "Unauthorized" }, 401, corsHeaders);
        }
        const body = await request.json();
        const video = parseVideoInput(body.url);
        if (!video) {
          return jsonResponse(
            { error: "Unsupported or invalid video link" },
            400,
            corsHeaders,
          );
        }
        const id = makeId();
        const reverseTs = String(9999999999999 - Date.now()).padStart(13, "0");
        const key = `video:item:${reverseTs}-${id}`;
        const record = {
          id,
          url: video.url,
          platform: video.platform,
          videoId: video.videoId,
          title: body.title ? String(body.title).slice(0, 200) : "",
          embedCode: video.embedCode || null,
          submitterId: user.id,
          status: "pending",
          createdAt: new Date().toISOString(),
        };
        await kvJsonPut(env, key, record);
        await env.DATA.put(`video:id:${id}`, key);
        return jsonResponse({ success: true, video: record }, 201, corsHeaders);
      }
    }

    if (segments.length === 2) {
      const videoId = segments[1];
      if (method === "GET") {
        const user = await getAuthenticatedUser(request, env);
        const video = await getVideoById(videoId, env);
        if (!video) {
          return jsonResponse({ error: "Not found" }, 404, corsHeaders);
        }
        if (video.status !== "approved" && (!user || user.role !== "admin")) {
          return jsonResponse({ error: "Not found" }, 404, corsHeaders);
        }
        return jsonResponse(video, 200, corsHeaders);
      }
    }
  }

  if (segments[0] === "auth") {
    if (segments[1] === "register" && method === "POST") {
      const body = await request.json();
      const { email, password, turnstileToken } = body;
      if (!email || !password) {
        return jsonResponse(
          { error: "Email and password are required" },
          400,
          corsHeaders,
        );
      }
      const normalizedEmail = String(email).trim().toLowerCase();
      const adminEmail = String(env.ADMIN_EMAIL || "")
        .trim()
        .toLowerCase();
      if (adminEmail && normalizedEmail === adminEmail) {
        return jsonResponse(
          { error: "Admin email is reserved" },
          403,
          corsHeaders,
        );
      }
      const passed = await verifyTurnstile(turnstileToken, env);
      if (!passed) {
        return jsonResponse(
          { error: "Turnstile verification failed" },
          400,
          corsHeaders,
        );
      }
      const userKey = `user:${normalizedEmail}`;
      const existing = await kvJsonGet(env, userKey);
      if (existing && existing.emailVerified) {
        return jsonResponse(
          { error: "Email already registered" },
          409,
          corsHeaders,
        );
      }
      const passwordHash = await hashPassword(String(password));
      const id = existing?.id || makeId();
      const user = {
        id,
        email: normalizedEmail,
        passwordHash,
        emailVerified: false,
        role: existing?.role || "user",
        createdAt: existing?.createdAt || new Date().toISOString(),
      };
      await kvJsonPut(env, userKey, user);
      const token = makeId();
      await kvJsonPut(
        env,
        `verify:${token}`,
        {
          email: normalizedEmail,
          expiresAt: new Date(Date.now() + TOKEN_TTL * 1000).toISOString(),
        },
        TOKEN_TTL,
      );
      await cachePut(
        `verify:${token}`,
        {
          email: normalizedEmail,
          expiresAt: new Date(Date.now() + TOKEN_TTL * 1000).toISOString(),
        },
        TOKEN_TTL,
      );
      const verifyUrl = `${env.PUBLIC_BASE_URL}/?verify=${token}`;
      try {
        await sendResendEmail(
          env,
          normalizedEmail,
          "请验证你的邮箱",
          `<p>请点击下面链接完成验证：</p><p><a href="${verifyUrl}">${verifyUrl}</a></p>`,
        );
      } catch (error) {
        console.error("Failed to send verification email:", error);
        return jsonResponse(
          {
            error: "Failed to send verification email. Please try again later.",
          },
          500,
          corsHeaders,
        );
      }
      return jsonResponse({ success: true }, 201, corsHeaders);
    }

    if (segments[1] === "verify-email" && method === "POST") {
      const body = await request.json();
      const token = body.token || url.searchParams.get("token");
      if (!token) {
        return jsonResponse({ error: "Missing token" }, 400, corsHeaders);
      }
      const cached = await cacheGet(`verify:${token}`);
      const payload = cached || (await kvJsonGet(env, `verify:${token}`));
      if (!payload) {
        return jsonResponse(
          { error: "Invalid or expired token" },
          400,
          corsHeaders,
        );
      }
      const userKey = `user:${payload.email}`;
      const user = await kvJsonGet(env, userKey);
      if (!user) {
        return jsonResponse({ error: "User not found" }, 404, corsHeaders);
      }
      user.emailVerified = true;
      await kvJsonPut(env, userKey, user);
      await env.DATA.delete(`verify:${token}`);
      await caches.default.delete(makeCacheRequest(`verify:${token}`));
      return jsonResponse({ success: true }, 200, corsHeaders);
    }

    if (segments[1] === "login" && method === "POST") {
      const body = await request.json();
      const { email, password, turnstileToken } = body;
      if (!email || !password) {
        return jsonResponse(
          { error: "Email and password are required" },
          400,
          corsHeaders,
        );
      }
      const passed = await verifyTurnstile(turnstileToken, env);
      if (!passed) {
        return jsonResponse(
          { error: "Turnstile verification failed" },
          400,
          corsHeaders,
        );
      }
      const normalizedEmail = String(email).trim().toLowerCase();
      const userKey = `user:${normalizedEmail}`;
      let user = await kvJsonGet(env, userKey);
      const adminEmail = String(env.ADMIN_EMAIL || "")
        .trim()
        .toLowerCase();
      const adminPassword = String(env.ADMIN_PASSWORD || "").trim();
      const isAdminLogin =
        adminEmail &&
        normalizedEmail === adminEmail &&
        adminPassword &&
        String(password).trim() === adminPassword;
      let valid = false;
      if (isAdminLogin) {
        user = await ensureAdminUser(env, normalizedEmail, password);
        if (user) {
          if (
            user.passwordHash &&
            !(await verifyPassword(String(password), user.passwordHash))
          ) {
            user.passwordHash = await hashPassword(String(password));
            await kvJsonPut(env, userKey, user);
          }
          valid = true;
        }
      } else if (user && user.emailVerified) {
        valid = await verifyPassword(String(password), user.passwordHash);
      }
      if (!valid || !user) {
        return jsonResponse(
          { error: "Invalid email or password" },
          401,
          corsHeaders,
        );
      }
      const sessionId = makeId();
      const session = {
        email: user.email,
        createdAt: new Date().toISOString(),
      };
      await kvJsonPut(env, `session:${sessionId}`, session, SESSION_TTL);
      await cachePut(`session:${sessionId}`, session, 60);
      return new Response(
        JSON.stringify({
          success: true,
          user: { email: user.email, id: user.id, role: user.role },
        }),
        {
          status: 200,
          headers: {
            "Content-Type": "application/json",
            "Set-Cookie": makeCookieHeader("session_id", sessionId, {
              path: "/",
              httpOnly: true,
              secure: env.PUBLIC_BASE_URL?.startsWith("https://"),
              sameSite: "Lax",
              maxAge: SESSION_TTL,
            }),
            ...corsHeaders,
          },
        },
      );
    }

    if (segments[1] === "logout" && method === "POST") {
      const sessionId = getCookieValue(request, "session_id");
      if (sessionId) {
        await env.DATA.delete(`session:${sessionId}`);
        await caches.default.delete(makeCacheRequest(`session:${sessionId}`));
      }
      return new Response(JSON.stringify({ success: true }), {
        status: 200,
        headers: {
          "Content-Type": "application/json",
          "Set-Cookie": makeCookieHeader("session_id", "", {
            path: "/",
            httpOnly: true,
            secure: env.PUBLIC_BASE_URL?.startsWith("https://"),
            sameSite: "Lax",
            maxAge: 0,
          }),
          ...corsHeaders,
        },
      });
    }

    if (segments[1] === "me" && method === "GET") {
      const user = await getAuthenticatedUser(request, env);
      if (!user) {
        return jsonResponse({ user: null }, 200, corsHeaders);
      }
      return jsonResponse(
        { user: { email: user.email, role: user.role, id: user.id } },
        200,
        corsHeaders,
      );
    }

    if (segments[1] === "forgot-password" && method === "POST") {
      const body = await request.json();
      const email = body.email && String(body.email).trim().toLowerCase();
      if (!email) {
        return jsonResponse({ error: "Email is required" }, 400, corsHeaders);
      }
      const user = await kvJsonGet(env, `user:${email}`);
      if (!user || !user.emailVerified) {
        return jsonResponse({ success: true }, 200, corsHeaders);
      }
      const token = makeId();
      await kvJsonPut(
        env,
        `pwreset:${token}`,
        {
          email,
          expiresAt: new Date(Date.now() + RESET_TTL * 1000).toISOString(),
        },
        RESET_TTL,
      );
      await cachePut(
        `pwreset:${token}`,
        {
          email,
          expiresAt: new Date(Date.now() + RESET_TTL * 1000).toISOString(),
        },
        RESET_TTL,
      );
      const resetUrl = `${env.PUBLIC_BASE_URL}/?reset=${token}`;
      await sendResendEmail(
        env,
        email,
        "重置密码",
        `<p>请点击下面链接重置密码：</p><p><a href="${resetUrl}">${resetUrl}</a></p>`,
      );
      return jsonResponse({ success: true }, 200, corsHeaders);
    }

    if (segments[1] === "reset-password" && method === "POST") {
      const body = await request.json();
      const token = body.token;
      const password = body.password;
      if (!token || !password) {
        return jsonResponse(
          { error: "Token and password are required" },
          400,
          corsHeaders,
        );
      }
      const cached = await cacheGet(`pwreset:${token}`);
      const payload = cached || (await kvJsonGet(env, `pwreset:${token}`));
      if (!payload || !payload.email) {
        return jsonResponse(
          { error: "Invalid or expired token" },
          400,
          corsHeaders,
        );
      }
      const userKey = `user:${payload.email}`;
      const user = await kvJsonGet(env, userKey);
      if (!user) {
        return jsonResponse({ error: "User not found" }, 404, corsHeaders);
      }
      user.passwordHash = await hashPassword(String(password));
      await kvJsonPut(env, userKey, user);
      await env.DATA.delete(`pwreset:${token}`);
      await caches.default.delete(makeCacheRequest(`pwreset:${token}`));
      return jsonResponse({ success: true }, 200, corsHeaders);
    }
  }

  if (segments[0] === "admin") {
    if (segments[1] === "pending" && method === "GET") {
      const user = await getAuthenticatedUser(request, env);
      if (!user || user.role !== "admin") {
        return jsonResponse({ error: "Unauthorized" }, 401, corsHeaders);
      }
      try {
        const pending = await listPendingVideos(env);
        return jsonResponse({ items: pending }, 200, corsHeaders);
      } catch (error) {
        console.error("Failed to load pending videos", error);
        return jsonResponse(
          { error: "Failed to load pending videos" },
          500,
          corsHeaders,
        );
      }
    }
    if (segments[1] === "approve" && segments[2] && method === "POST") {
      const user = await getAuthenticatedUser(request, env);
      if (!user || user.role !== "admin") {
        return jsonResponse({ error: "Unauthorized" }, 401, corsHeaders);
      }
      const videoId = segments[2];
      const indexKey = `video:id:${videoId}`;
      const videoKey = await env.DATA.get(indexKey);
      if (!videoKey) {
        return jsonResponse({ error: "Video not found" }, 404, corsHeaders);
      }
      const video = await kvJsonGet(env, videoKey);
      if (!video) {
        return jsonResponse({ error: "Video not found" }, 404, corsHeaders);
      }
      video.status = "approved";
      video.approvedAt = new Date().toISOString();
      await kvJsonPut(env, videoKey, video);
      return jsonResponse({ success: true, video }, 200, corsHeaders);
    }
  }

  return jsonResponse({ error: "Not found" }, 404, corsHeaders);
}

async function serveStaticAsset(request, env) {
  const event = {
    request,
    waitUntil: (promise) => promise,
  };

  try {
    return await getAssetFromKV(event, {
      ASSET_NAMESPACE: env.__STATIC_CONTENT,
    });
  } catch (err) {
    const url = new URL(request.url);
    if (url.pathname === "/" || url.pathname === "/index.html") {
      return new Response("Not found", { status: 404 });
    }
    const indexRequest = new Request(`${url.origin}/index.html`, request);
    try {
      return await getAssetFromKV(
        { request: indexRequest, waitUntil: event.waitUntil },
        { ASSET_NAMESPACE: env.__STATIC_CONTENT },
      );
    } catch (error) {
      return new Response("Not found", { status: 404 });
    }
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname.startsWith("/api/")) {
      return handleApiRequest(request, env);
    }

    return await serveStaticAsset(request, env);
  },
};
