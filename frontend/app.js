const state = {
  user: null,
  currentView: "home",
};

const elements = {
  content: document.getElementById("content"),
  message: document.getElementById("message"),
  logoutBtn: document.getElementById("logoutBtn"),
  navButtons: document.querySelectorAll("nav button[data-view]"),
};

function showMessage(text, type = "success") {
  elements.message.textContent = text;
  elements.message.className = `message ${type}`;
  elements.message.classList.remove("hidden");
}

function hideMessage() {
  elements.message.classList.add("hidden");
}

async function apiFetch(path, options = {}) {
  const headers = {
    ...(options.headers || {}),
  };
  if (options.body) {
    headers["Content-Type"] = "application/json";
  }

  const response = await fetch(path, {
    credentials: "include",
    headers,
    ...options,
  });
  const data = await response.json().catch(() => null);
  if (!response.ok) {
    throw data || { error: "请求失败" };
  }
  return data;
}

function bindNav() {
  elements.navButtons.forEach((button) => {
    button.addEventListener("click", () => {
      state.currentView = button.dataset.view;
      render();
    });
  });
  elements.logoutBtn.addEventListener("click", async () => {
    try {
      await apiFetch("/api/auth/logout", { method: "POST" });
      state.user = null;
      elements.logoutBtn.classList.add("hidden");
      showMessage("已退出登录", "success");
      render();
    } catch (err) {
      showMessage(err.error || "退出失败", "error");
    }
  });
}

async function fetchCurrentUser() {
  const data = await apiFetch("/api/auth/me");
  state.user = data.user;
  if (state.user) {
    elements.logoutBtn.classList.remove("hidden");
  } else {
    elements.logoutBtn.classList.add("hidden");
  }
}

function renderHome() {
  elements.content.innerHTML = `
    <div class="panel">
      <h2>最新视频</h2>
      <div id="videoList" class="grid"></div>
    </div>
  `;
  loadVideoList();
}

function formatDate(dateString) {
  return new Date(dateString).toLocaleString();
}

async function loadVideoList() {
  try {
    const data = await apiFetch("/api/videos");
    const list = document.getElementById("videoList");
    list.innerHTML = "";
    if (!data.items.length) {
      list.innerHTML = "<p>暂无已审核视频。</p>";
      return;
    }
    data.items.forEach((video) => {
      const card = document.createElement("div");
      card.className = "card video-card";
      card.innerHTML = `
        <h3>${video.title || "未命名视频"}</h3>
        <p>${video.platform.toUpperCase()} · ${formatDate(video.createdAt)}</p>
        <div>${video.embedCode || `<iframe src="${buildEmbedUrl(video)}" loading="lazy" allowfullscreen></iframe>`}</div>
      `;
      list.appendChild(card);
    });
  } catch (err) {
    showMessage(err.error || "加载视频失败", "error");
  }
}

function buildEmbedUrl(video) {
  const id = encodeURIComponent(video.videoId);
  if (video.platform === "youtube")
    return `https://www.youtube.com/embed/${id}`;
  if (video.platform === "vimeo") return `https://player.vimeo.com/video/${id}`;
  if (video.platform === "bilibili")
    return `https://player.bilibili.com/player.html?bvid=${id}`;
  return video.url || "";
}

function renderRegister() {
  elements.content.innerHTML = `
    <div class="panel">
      <h2>注册</h2>
      <form id="registerForm" class="form-section">
        <label>邮箱<input name="email" type="email" required /></label>
        <label>密码<input name="password" type="password" required minlength="8" /></label>
        <button type="submit">注册</button>
      </form>
    </div>
  `;
  const form = document.getElementById("registerForm");
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    hideMessage();
    const formData = new FormData(form);
    try {
      await apiFetch("/api/auth/register", {
        method: "POST",
        body: JSON.stringify({
          email: formData.get("email"),
          password: formData.get("password"),
        }),
      });
      showMessage("注册成功，请查收邮箱完成验证。", "success");
      state.currentView = "verify-wait";
      render();
    } catch (err) {
      showMessage(err.error || "注册失败", "error");
    }
  });
}

function renderVerifyWait() {
  elements.content.innerHTML = `
    <div class="panel">
      <h2>注册成功</h2>
      <p>我们已向您的邮箱发送了验证邮件。请点击邮件中的链接完成邮箱验证。</p>
      <p>验证完成后，您就可以登录使用了。</p>
      <button id="loginBtn">前往登录</button>
    </div>
  `;
  document.getElementById("loginBtn").addEventListener("click", () => {
    state.currentView = "login";
    render();
  });
}

function renderLogin() {
  elements.content.innerHTML = `
    <div class="panel">
      <h2>登录</h2>
      <form id="loginForm" class="form-section">
        <label>邮箱<input name="email" type="email" required /></label>
        <label>密码<input name="password" type="password" required /></label>
        <button type="submit">登录</button>
      </form>
      <p><a href="#" id="forgotLink">忘记密码？</a></p>
    </div>
  `;
  document.getElementById("forgotLink").addEventListener("click", (event) => {
    event.preventDefault();
    state.currentView = "forgot";
    render();
  });
  const form = document.getElementById("loginForm");
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    hideMessage();
    const formData = new FormData(form);
    try {
      await apiFetch("/api/auth/login", {
        method: "POST",
        body: JSON.stringify({
          email: formData.get("email"),
          password: formData.get("password"),
        }),
      });
      await fetchCurrentUser();
      showMessage("登录成功", "success");
      state.currentView = "home";
      render();
    } catch (err) {
      showMessage(err.error || "登录失败", "error");
    }
  });
}

function renderSubmit() {
  if (!state.user) {
    elements.content.innerHTML = `
      <div class="panel">
        <h2>提交视频</h2>
        <p>您需要先登录才能提交视频。</p>
        <button id="goLoginBtn">前往登录</button>
      </div>
    `;
    document.getElementById("goLoginBtn").addEventListener("click", () => {
      state.currentView = "login";
      render();
    });
    return;
  }

  elements.content.innerHTML = `
    <div class="panel">
      <h2>提交视频</h2>
      <form id="submitForm" class="form-section">
        <label>视频链接或 iframe 代码<textarea name="url" required></textarea></label>
        <label>标题（可选）<input name="title" type="text" maxlength="200" /></label>
        <button type="submit">提交审核</button>
      </form>
    </div>
  `;
  const form = document.getElementById("submitForm");
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    hideMessage();
    const formData = new FormData(form);
    try {
      await apiFetch("/api/videos", {
        method: "POST",
        body: JSON.stringify({
          url: formData.get("url"),
          title: formData.get("title"),
        }),
      });
      state.currentView = "home";
      render();
      showMessage("提交成功，视频正在审核中。", "success");
    } catch (err) {
      showMessage(err.error || "提交失败", "error");
    }
  });
}

function renderForgot() {
  elements.content.innerHTML = `
    <div class="panel">
      <h2>忘记密码</h2>
      <form id="forgotForm" class="form-section">
        <label>请输入注册邮箱<input name="email" type="email" required /></label>
        <button type="submit">发送重置邮件</button>
      </form>
    </div>
  `;
  const form = document.getElementById("forgotForm");
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    hideMessage();
    const formData = new FormData(form);
    try {
      await apiFetch("/api/auth/forgot-password", {
        method: "POST",
        body: JSON.stringify({ email: formData.get("email") }),
      });
      showMessage("如果邮箱已注册，已发送重置邮件。", "success");
      state.currentView = "home";
      render();
    } catch (err) {
      showMessage(err.error || "发送失败", "error");
    }
  });
}

function renderAdmin() {
  if (!state.user || state.user.role !== "admin") {
    elements.content.innerHTML = `
      <div class="panel">
        <h2>管理页面</h2>
        <p>只有管理员可以访问此页面。</p>
      </div>
    `;
    return;
  }
  elements.content.innerHTML = `
    <div class="panel">
      <h2>审核视频</h2>
      <div id="pendingList" class="grid"></div>
    </div>
  `;
  loadPendingList();
}

async function loadPendingList() {
  try {
    const list = document.getElementById("pendingList");
    list.innerHTML = "";
    const data = await apiFetch("/api/admin/pending");
    if (!data.items.length) {
      list.innerHTML = "<p>当前没有待审核视频。</p>";
      return;
    }
    data.items.forEach((video) => {
      const card = document.createElement("div");
      card.className = "card video-card";
      card.innerHTML = `
        <h3>${video.title || "未命名视频"}</h3>
        <p>${video.platform.toUpperCase()} · ${formatDate(video.createdAt)}</p>
        <div>${video.embedCode || `<iframe src="${buildEmbedUrl(video)}" loading="lazy" allowfullscreen></iframe>`}</div>
        <div class="video-actions"><button data-id="${video.id}">通过审核</button></div>
      `;
      list.appendChild(card);
      card
        .querySelector("button")
        .addEventListener("click", () => approveVideo(video.id));
    });
  } catch (err) {
    showMessage(err.error || "加载审核列表失败", "error");
  }
}

async function approveVideo(id) {
  try {
    await apiFetch(`/api/admin/approve/${id}`, { method: "POST" });
    showMessage("视频已审核通过", "success");
    loadPendingList();
  } catch (err) {
    showMessage(err.error || "审核失败", "error");
  }
}

function parseQueryParams() {
  const params = new URLSearchParams(window.location.search);
  if (params.has("verify")) {
    return { view: "verify", token: params.get("verify") };
  }
  if (params.has("reset")) {
    return { view: "reset", token: params.get("reset") };
  }
  return null;
}

async function renderVerify(token) {
  elements.content.innerHTML = `
    <div class="panel">
      <h2>邮箱验证</h2>
      <p>正在验证，请稍候...</p>
    </div>
  `;
  try {
    await apiFetch("/api/auth/verify-email", {
      method: "POST",
      body: JSON.stringify({ token }),
    });
    showMessage("邮箱验证成功，请登录。", "success");
    history.replaceState(null, "", window.location.pathname);
    state.currentView = "login";
    render();
  } catch (err) {
    showMessage(err.error || "验证失败", "error");
    state.currentView = "home";
    render();
  }
}

function renderReset(token) {
  elements.content.innerHTML = `
    <div class="panel">
      <h2>重置密码</h2>
      <form id="resetForm" class="form-section">
        <input type="hidden" name="token" value="${token}" />
        <label>新密码<input name="password" type="password" required minlength="8" /></label>
        <button type="submit">重置密码</button>
      </form>
    </div>
  `;
  const form = document.getElementById("resetForm");
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    hideMessage();
    const formData = new FormData(form);
    try {
      await apiFetch("/api/auth/reset-password", {
        method: "POST",
        body: JSON.stringify({
          token: formData.get("token"),
          password: formData.get("password"),
        }),
      });
      showMessage("密码已重置，请登录。", "success");
      state.currentView = "login";
      render();
    } catch (err) {
      showMessage(err.error || "重置失败", "error");
    }
  });
}

function render() {
  hideMessage();
  const params = parseQueryParams();
  if (params) {
    if (params.view === "verify") {
      renderVerify(params.token);
      return;
    }
    if (params.view === "reset") {
      renderReset(params.token);
      return;
    }
  }
  if (state.currentView === "register") return renderRegister();
  if (state.currentView === "verify-wait") return renderVerifyWait();
  if (state.currentView === "login") return renderLogin();
  if (state.currentView === "submit") return renderSubmit();
  if (state.currentView === "forgot") return renderForgot();
  if (state.currentView === "admin") return renderAdmin();
  renderHome();
}

async function init() {
  bindNav();
  try {
    await fetchCurrentUser();
  } catch (err) {
    console.error("fetchCurrentUser failed:", err);
  }
  render();
}

init();
