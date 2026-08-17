// content.js — 注入「可拖拽悬浮按钮」+「可拖拽/可缩放/带动画/记位置的浮层面板」
// 浮层内用 <iframe src="popup.html"> 复用现有全部功能（查词/看板/故事/设置）。
// 开关动画、拖动、缩放、位置记忆均由本脚本处理（独立系统窗口无法做开关动画，故用网页浮层）。
(function () {
  const KEY = "mymaimemo_ui";
  const POPUP_URL = chrome.runtime.getURL("popup.html");

  if (document.getElementById("mymaimemo-fab")) return; // 防重复注入

  // ---------- 存储（跨网站一致，用 chrome.storage 而非网页 localStorage）----------
  const ui = { fabX: null, fabY: null, panelX: null, panelY: null, panelW: 520, panelH: 720, open: false };
  function loadUI() {
    return new Promise((resolve) => {
      try {
        chrome.storage.local.get(KEY, (d) => {
          if (d && d[KEY]) Object.assign(ui, d[KEY]);
          resolve();
        });
      } catch (e) { resolve(); }
    });
  }
  function saveUI() {
    try { chrome.storage.local.set({ [KEY]: ui }); } catch (e) {}
  }

  // ---------- 通用拖拽 ----------
  // handle: 触发拖拽的元素；target: 被移动的元素；onEnd(moved): 结束回调
  function makeDraggable(handle, target, onEnd, axis) {
    handle.addEventListener("mousedown", (e) => {
      if (e.button !== 0) return;
      e.preventDefault();
      const r = target.getBoundingClientRect();
      const offX = e.clientX - r.left;
      const offY = e.clientY - r.top;
      if (axis !== "y") { target.style.right = "auto"; target.style.bottom = "auto"; }
      let moved = false;
      function move(ev) {
        if (Math.abs(ev.movementX) > 2 || Math.abs(ev.movementY) > 2) moved = true;
        if (axis !== "y") {
          let x = ev.clientX - offX;
          x = Math.max(0, Math.min(x, window.innerWidth - r.width));
          target.style.left = x + "px";
        }
        let y = ev.clientY - offY;
        y = Math.max(0, Math.min(y, window.innerHeight - r.height));
        target.style.top = y + "px";
      }
      function up() {
        document.removeEventListener("mousemove", move);
        document.removeEventListener("mouseup", up);
        if (onEnd) onEnd(moved);
      }
      document.addEventListener("mousemove", move);
      document.addEventListener("mouseup", up);
    });
  }

  // ---------- 创建悬浮按钮 ----------
  const fab = document.createElement("div");
  fab.id = "mymaimemo-fab";
  fab.title = "MyMaimemo";
  fab.setAttribute("aria-label", "打开 MyMaimemo");
  fab.innerHTML =
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" ' +
    'stroke-linecap="round" stroke-linejoin="round">' +
    '<path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"/>' +
    '<path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z"/>' +
    "</svg>";
  document.body.appendChild(fab);

  // ---------- 创建浮层面板 ----------
  const panel = document.createElement("div");
  panel.id = "mymaimemo-panel";
  panel.innerHTML =
    '<div class="mm-handle">' +
    '  <span class="mm-title">MyMaimemo</span>' +
    '  <button class="mm-close" title="关闭">×</button>' +
    "</div>" +
    '<iframe id="mymaimemo-frame" allow="clipboard-read; clipboard-write"></iframe>';
  document.body.appendChild(panel);
  const frame = panel.querySelector("#mymaimemo-frame");

  // 应用记忆的位置/尺寸
  function applyPositions() {
    // 悬浮图标：固定贴右侧，只允许上下移动（水平始终 right:14px）
    fab.style.right = "14px";
    fab.style.left = "auto";
    fab.style.bottom = "auto";
    fab.style.top = (ui.fabY != null ? ui.fabY : window.innerHeight / 2 - 24) + "px";
    if (ui.panelX != null && ui.panelY != null) {
      panel.style.left = ui.panelX + "px";
      panel.style.top = ui.panelY + "px";
      panel.style.right = "auto";
      panel.style.bottom = "auto";
    } else {
      panel.style.left = Math.max(12, window.innerWidth - 560) + "px";
      panel.style.top = Math.max(12, window.innerHeight - 760) + "px";
    }
    panel.style.width = ui.panelW + "px";
    panel.style.height = ui.panelH + "px";
  }

  // 让面板动画的「原点」精确指向悬浮图标中心（右侧 + 图标垂直位置），
  // 这样打开是从图标弹出、关闭是收回图标，而不是从屏幕中央淡入。
  function setPanelOriginToFab() {
    try {
      const fr = fab.getBoundingClientRect();
      const fabCY = fr.top + fr.height / 2;
      const panelTop = parseFloat(panel.style.top) || 0;
      const panelH = parseFloat(panel.style.height) || 600;
      let originY = fabCY - panelTop;
      originY = Math.max(0, Math.min(panelH, originY));
      panel.style.transformOrigin = `100% ${originY}px`;
    } catch (e) {}
  }

  // ---------- 开关面板（带动画：从悬浮图标弹出 / 收回悬浮图标）----------
  let closeTimer = null;
  function togglePanel(forceOpen) {
    const willOpen = forceOpen === undefined ? !panel.classList.contains("open") : forceOpen;
    setPanelOriginToFab(); // 动画原点始终对准悬浮图标（右侧）
    clearTimeout(closeTimer);
    if (willOpen) {
      if (!frame.getAttribute("src")) frame.setAttribute("src", POPUP_URL); // 懒加载，首次才加载
      panel.style.visibility = "visible"; // 上次关闭可能置为 hidden，重新打开前恢复
      // 打开：先回退到初始态(收在图标) -> 强制 reflow -> 下一帧加 .open，
      // 否则初态与终态同帧合并，transition 不触发（表现为“无动画”）
      panel.classList.remove("closing");
      panel.classList.remove("open");
      void panel.offsetWidth; // 强制同步重排
      requestAnimationFrame(() => panel.classList.add("open"));
      ui.open = true;
    } else {
      // 关闭：加 .closing 播放「向图标收回」动画，结束后再移除类隐藏
      panel.classList.add("closing");
      panel.classList.remove("open");
      ui.open = false;
      closeTimer = setTimeout(() => {
        panel.classList.remove("closing");
        if (!panel.classList.contains("open")) panel.style.visibility = "hidden";
      }, 250); // 略长于 transition 时长，确保动画完整播完
    }
    saveUI();
  }
  panel.querySelector(".mm-close").addEventListener("click", () => togglePanel(false));

  // ---------- 绑定拖拽 ----------
  // 悬浮按钮：拖拽=移动并保存；单击(未拖动)=打开/关闭浮层面板
  makeDraggable(fab, fab, (moved) => {
    if (moved) {
      ui.fabY = parseInt(fab.style.top, 10) || 0; // 仅记录垂直位置，水平始终贴右侧
      saveUI();
    } else {
      togglePanel();
    }
  }, "y");
  // 面板顶部把手：拖拽=移动面板并保存
  makeDraggable(panel.querySelector(".mm-handle"), panel, (moved) => {
    if (moved) {
      ui.panelX = parseInt(panel.style.left, 10) || 0;
      ui.panelY = parseInt(panel.style.top, 10) || 0;
      saveUI();
    }
  });
  // 面板缩放：监听尺寸变化并保存
  if (window.ResizeObserver) {
    const ro = new ResizeObserver(() => {
      ui.panelW = Math.round(panel.getBoundingClientRect().width);
      ui.panelH = Math.round(panel.getBoundingClientRect().height);
      saveUI();
    });
    ro.observe(panel);
  }

  // ---------- 接收 background 转发（工具栏图标点击）----------
  chrome.runtime.onMessage.addListener((msg) => {
    if (!msg) return;
    if (msg.action === "togglePanel") togglePanel();
    if (msg.action === "showStatus") showStatusPanel();
    if (msg.action === "stateChanged") applyEnabled();
  });

  // ---------- 启用状态控制（工具栏图标点击弹出） ----------
  // 状态：global 全局启用；pageDisabledHosts 为已在本页关闭注入的 host 集合
  const STATE_KEY = "mymaimemo_state";
  const st = { global: true, pageDisabledHosts: [] };
  function loadState() {
    return new Promise((resolve) => {
      try {
        chrome.storage.local.get(STATE_KEY, (d) => {
          if (d && d[STATE_KEY]) {
            if (typeof d[STATE_KEY].global === "boolean") st.global = d[STATE_KEY].global;
            if (Array.isArray(d[STATE_KEY].pageDisabledHosts)) st.pageDisabledHosts = d[STATE_KEY].pageDisabledHosts;
          }
          resolve();
        });
      } catch (e) { resolve(); }
    });
  }
  function saveState() {
    try { chrome.storage.local.set({ [STATE_KEY]: st }); } catch (e) {}
  }
  function currentHost() { return (location.hostname || "").toLowerCase(); }
  function pageEnabled() { return !st.pageDisabledHosts.includes(currentHost()); }
  // 应用启用状态：控制 FAB 与浮层显隐
  function applyEnabled() {
    const show = st.global && pageEnabled();
    fab.style.display = show ? "" : "none";
    if (!show) {
      // 停用当前页时收回浮层
      panel.classList.remove("open");
      ui.open = false;
      saveUI();
    }
  }

  // 状态控制面板（工具栏图标点击弹出于右上角）
  let statusEl = null;
  function showStatusPanel() {
    if (document.getElementById("mymaimemo-status")) return; // 已打开则不再重复

    statusEl = document.createElement("div");
    statusEl.id = "mymaimemo-status";
    statusEl.innerHTML =
      '<div class="mm-st-head">墨墨背单词 · 启用设置</div>' +
      '<div class="mm-st-row">' +
      '  <span class="mm-st-name">扩展已启用</span>' +
      '  <label class="mm-switch"><input type="checkbox" id="mm-st-global"><span class="mm-knob"></span></label>' +
      '</div>' +
      '<div class="mm-st-row">' +
      '  <span class="mm-st-name">当前窗口已启用</span>' +
      '  <label class="mm-switch"><input type="checkbox" id="mm-st-page"><span class="mm-knob"></span></label>' +
      '</div>' +
      '<div class="mm-st-foot">' +
      '  <button id="mm-st-panel" class="mm-st-btn">打开面板</button>' +
      '  <button id="mm-st-close" class="mm-st-btn mm-st-ghost">关闭</button>' +
      '</div>';
    document.body.appendChild(statusEl);

    const g = statusEl.querySelector("#mm-st-global");
    const p = statusEl.querySelector("#mm-st-page");
    g.checked = st.global;
    p.checked = pageEnabled();

    g.addEventListener("change", () => {
      st.global = g.checked;
      saveState();
      applyEnabled();
      p.disabled = !st.global;
    });
    p.addEventListener("change", () => {
      const host = currentHost();
      const i = st.pageDisabledHosts.indexOf(host);
      if (p.checked && i >= 0) st.pageDisabledHosts.splice(i, 1);
      if (!p.checked && i < 0) st.pageDisabledHosts.push(host);
      saveState();
      applyEnabled();
    });
    statusEl.querySelector("#mm-st-panel").addEventListener("click", () => {
      if (st.global) { togglePanel(true); hideStatusPanel(); }
    });
    statusEl.querySelector("#mm-st-close").addEventListener("click", hideStatusPanel);
    if (!st.global) p.disabled = true;
  }
  function toggleStatusPanel() { hideStatusPanel(); }
  function hideStatusPanel() { if (statusEl) { statusEl.remove(); statusEl = null; } }

  // ---------- 初始化 ----------
  // 新语义：打开新页面只展示悬浮图标，不自动展开浮层面板
  loadUI().then(async () => {
    await loadState();
    applyEnabled();
    applyPositions();
  });
})();
