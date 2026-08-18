// popup.js — MyMaimemo 主逻辑
"use strict";

const $ = (id) => document.getElementById(id);
const settingsKey = "mymaimemo_settings";
let settings = {};

// ---------- 存储 ----------
// 优先使用 chrome.storage.local；非插件环境（如本地预览）回退到 localStorage
const hasChromeStorage = typeof chrome !== "undefined" && chrome.storage && chrome.storage.local;
async function loadSettings() {
  if (hasChromeStorage) {
    const data = await chrome.storage.local.get(settingsKey);
    settings = data[settingsKey] || {};
  } else {
    try { settings = JSON.parse(localStorage.getItem(settingsKey)) || {}; } catch (e) { settings = {}; }
  }
  return settings;
}
async function saveSettings(next) {
  settings = { ...settings, ...next };
  if (hasChromeStorage) {
    await chrome.storage.local.set({ [settingsKey]: settings });
  } else {
    localStorage.setItem(settingsKey, JSON.stringify(settings));
  }
  return settings;
}

// ---------- 内容缓存（看板 / 查词 / 故事） ----------
// 统一存于 chrome.storage.local，带时间戳与 TTL，过期自动失效
const cachePrefix = "mymaimemo_cache_";
async function cacheSet(key, value, ttlMs) {
  const record = { value, ts: Date.now(), ttl: ttlMs || 0 };
  if (hasChromeStorage) {
    await chrome.storage.local.set({ [cachePrefix + key]: record });
  } else {
    try { localStorage.setItem(cachePrefix + key, JSON.stringify(record)); } catch (e) {}
  }
}
async function cacheGet(key) {
  let record = null;
  if (hasChromeStorage) {
    const data = await chrome.storage.local.get(cachePrefix + key);
    record = data[cachePrefix + key] || null;
  } else {
    try { record = JSON.parse(localStorage.getItem(cachePrefix + key)) || null; } catch (e) { record = null; }
  }
  if (!record || !record.value) return null;
  // TTL 检查（0 表示不过期）
  if (record.ttl && Date.now() - record.ts > record.ttl) return null;
  return record.value;
}
// 缓存常量
const CACHE = {
  BOARD: { key: "board", ttl: 5 * 60 * 1000 },        // 看板 5 分钟
  DICT: { key: "dict", ttl: 24 * 3600 * 1000 },        // 查词 24 小时
  STORY: { key: "story", ttl: 0 },                      // 故事不过期（按词表指纹判断）
};
function dictCacheKey(word) { return `${CACHE.DICT.key}_${word.toLowerCase()}`; }

// 学习数据页的全量学习记录缓存 key（study.js 共用；token 变更时需失效）
const STUDY_CACHE_KEY = "study_records";

// ---------- DOM 辅助 ----------
function show(id) { $(id).classList.remove("hidden"); }
function hide(id) { $(id).classList.add("hidden"); }
function setText(id, t) { $(id).textContent = t; }

// ---------- 智能渲染：文本加粗 ----------
// text 应为已转义(escHtml)后的内容；words 为目标加粗词汇表
// 用哨兵标记避免 ** 与词表加粗重复包裹
function renderBold(text, words) {
  const S = "\u0001"; // 哨兵字符（不可见，避免与正文冲突）
  let t = String(text);
  // 1) 显式 ** 标记 -> 哨兵包裹
  t = t.replace(/\*\*(.+?)\*\*/g, `${S}B$1${S}E`);
  // 2) 词表加粗：只对未被哨兵包裹的词操作（词后面不紧跟哨兵E）
  if (words && words.length) {
    for (const w of words) {
      if (!w) continue;
      const re = new RegExp(`\\b(${escapeReg(w)})\\b(?!${S}E)`, "gi");
      t = t.replace(re, `${S}B$1${S}E`);
    }
  }
  // 3) 哨兵统一还原为 <strong>
  t = t.replace(/\u0001B(.+?)\u0001E/g, "<strong>$1</strong>");
  return t;
}
function escapeReg(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
// 安全转义 HTML（先转义原文，再在渲染层还原加粗）
function escHtml(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

// ---------- 设置 UI ----------
function initSettingsUI() {
  $("maimemoToken").value = settings.token || "";
  $("usernameInput").value = settings.username || "";
  $("llmProvider").value = settings.llmProvider || "deepseek";
  $("llmKey").value = settings.llmKey || "";
  // 加载保存过的 URL/模型（无则回填该服务商默认值）
  const prov = $("llmProvider").value;
  const preset = LLM_PRESETS[prov] || {};
  $("llmBaseUrl").value = settings.llmBaseUrl || preset.baseUrl || "";
  $("llmModel").value = settings.llmModel || preset.model || "";
  $("llmProvider")._prev = prov; // 标记当前，避免首次打开回填覆盖已保存值
  toggleCustomField();
}

function toggleCustomField() {
  const prov = $("llmProvider").value;
  const preset = LLM_PRESETS[prov] || {};
  // 仅在用户真正切换服务商时，回填该服务商默认 URL/模型（不覆盖已手动填写的值）
  if (($("llmProvider")._prev || "") !== prov) {
    if (preset.baseUrl) $("llmBaseUrl").value = preset.baseUrl;
    if (preset.model) $("llmModel").value = preset.model;
    $("llmProvider")._prev = prov;
  }

  // 更新提示文案
  const hintEl = $("llmHint");
  if (prov === "custom") {
    hintEl.textContent = "在下方填写任意 OpenAI 兼容接口的 Base URL、模型名与 Key。";
  } else if (preset) {
    hintEl.textContent = `${preset.label} · ${preset.hint}。地址与模型均已填入，可按需修改。`;
  }
}

async function onSaveSettings() {
  await saveSettings({
    token: $("maimemoToken").value.trim(),
    username: $("usernameInput").value.trim(),
    llmProvider: $("llmProvider").value,
    llmKey: $("llmKey").value.trim(),
    llmBaseUrl: $("llmBaseUrl").value.trim(),
    llmModel: $("llmModel").value.trim(),
  });
  applyUsername();
  populateFavPickers(); // 保存后若 Token 就绪，重新填充云词库下拉框
  // Token 可能变更：使学习记录缓存失效，下次打开学习数据页会重新拉取
  cacheSet(STUDY_CACHE_KEY, null, 0);
  const msg = $("settingsMsg");
  msg.textContent = "已保存";
  setTimeout(() => { msg.textContent = ""; }, 1800);
  refreshDashboard(false);
}

// 页面顶部显示用户名；未填写时回退为默认名 MyMaimemo
function applyUsername() {
  const name = (settings.username || "").trim();
  const titles = document.querySelectorAll(".logo-title");
  titles.forEach((el) => { el.textContent = name || "MyMaimemo"; });
  // 同步浏览器标签页标题
  if (document.title) document.title = `${name || "MyMaimemo"} · 查词 / 看板 / 单词故事`;
}

// ---------- 看板 ----------
// force=true 忽略缓存强制刷新；默认先显示缓存再静默刷新
async function refreshDashboard(force = false) {
  if (!settings.token) {
    hide("boardBody");
    show("boardError");
    $("boardError").textContent = "请先在设置中填入墨墨 Token";
    hide("favsBody"); hide("favsError"); hide("favsLoading");
    return;
  }

  // 先尝试缓存（不强制时）
  if (!force) {
    const cached = await cacheGet(CACHE.BOARD.key);
    if (cached) {
      hide("boardLoading"); hide("boardError");
      show("boardBody");
      renderBoard(cached);
      renderFavs(cached.favNotepad);
      // 静默后台刷新，更新缓存
      fetchBoardData().then((data) => {
        cacheSet(CACHE.BOARD.key, data, CACHE.BOARD.ttl);
        renderBoard(data);
        renderFavs(data.favNotepad);
      }).catch(() => {});
      return;
    }
  }

  if (force) { hide("boardLoading"); hide("boardError"); }
  else { show("boardLoading"); hide("boardBody"); hide("boardError"); }

  try {
    const data = await fetchBoardData();
    cacheSet(CACHE.BOARD.key, data, CACHE.BOARD.ttl);
    hide("boardLoading"); hide("boardError");
    show("boardBody");
    renderBoard(data);

    // 强制刷新（点「刷新」按钮）时，额外对收藏词做“已背清理”：
    // 仅针对“下拉当前选中的云词库”执行，账号下其它词库一律不动。
    let favNotepad = data.favNotepad;
    if (force) {
      try {
        setText("favsLoading", "正在检查收藏词是否已背过…");
        show("favsLoading"); hide("favsBody"); hide("favsError");
        // 以下拉选中的 id 为唯一目标，精确取出该词本后再清理
        const targetId = settings.favNotepadId || (favNotepad && favNotepad.id);
        const notepadForClean = targetId
          ? await maimemoGetNotepad(targetId, settings.token)
          : favNotepad;
        const before = (notepadForClean.list || [])
          .filter((it) => it.type === "WORD" || it.type === "DRAFT_WORD").length;
        favNotepad = await syncCleanFavorites(notepadForClean || favNotepad);
        const after = (favNotepad.list || [])
          .filter((it) => it.type === "WORD" || it.type === "DRAFT_WORD").length;
        cacheSet(CACHE.BOARD.key, { ...data, favNotepad }, CACHE.BOARD.ttl);
        renderFavs(favNotepad);
        if (after < before) {
          setText("favsLoading", `已移除 ${before - after} 个已背单词（仅当前云词库）`);
          show("favsLoading");
          setTimeout(() => hide("favsLoading"), 1800);
        }
      } catch (e) {
        console.warn("收藏词清理失败", e);
        renderFavs(favNotepad);
      }
    } else {
      renderFavs(data.favNotepad);
    }
  } catch (e) {
    hide("boardLoading"); hide("boardBody");
    show("boardError");
    $("boardError").textContent = "同步失败：" + e.message;
  }
}

// 拉取看板全部数据
async function fetchBoardData() {
  const [progress, planTotal, remain, newToday, due7, favNotepad] = await Promise.all([
    apiGetProgress(),
    apiGetPlanTotal(),
    apiGetRemain(),
    apiGetNewToday(),
    apiGetDue7(),
    apiGetFavorite(),
  ]);
  return { progress, planTotal, remain, newToday, due7, favNotepad };
}

// 渲染看板
function renderBoard(data) {
  const { progress, planTotal, remain, newToday, due7 } = data;
  const finished = progress.finished || 0;
  const total = progress.total || planTotal || 0;
  setText("kFinished", finished);
  setText("kTotal", total);
  const pct = total > 0 ? Math.round((finished / total) * 100) : 0;
  $("progressBar").style.width = pct + "%";
  setText("progressText", `${pct}% · 已学 ${formatTime(progress.study_time)}`);

  setText("kPlanTotal", planTotal);
  setText("kRemain", remain);
  setText("kNewToday", newToday);
  setText("kDue7", due7);
}

// 收藏词列表（今日看板下方单独显示：收藏词：每一个词）
function renderFavs(notepad) {
  const body = $("favsBody");
  const err = $("favsError");
  hide("favsLoading"); hide("favsError"); hide("favsBody");

  if (!notepad) {
    show("favsError");
    err.textContent = "暂无收藏词";
    return;
  }
  const words = (notepad.list || [])
    .filter((it) => it.type === "WORD" || it.type === "DRAFT_WORD")
    .map((it) => it.word);
  if (!words.length) {
    show("favsError");
    err.textContent = "暂无收藏词";
    return;
  }

  body.innerHTML = "";
  const label = document.createElement("div");
  label.className = "favs-label";
  label.textContent = "收藏词：";
  body.appendChild(label);

  const listEl = document.createElement("div");
  listEl.className = "favs-list";
  words.forEach((w) => {
    const span = document.createElement("span");
    span.className = "favs-chip";
    span.textContent = w;
    listEl.appendChild(span);
  });
  body.appendChild(listEl);
  show("favsBody");
}

function apiGetProgress() { return maimemoGetProgress(settings.token); }
function apiGetPlanTotal() { return maimemoGetPlanTotal(settings.token); }
function apiGetRemain() {
  // 继续学习 = 今日到期待复习的词数（与墨墨 App「继续学习」口径一致：next_study_date ≤ 今天）
  return maimemoGetDueToday(settings.token);
}
function apiGetNewToday() { return maimemoGetNewToday(settings.token); }
function apiGetDue7() { return maimemoGetDue7(settings.token); }
async function apiGetFavorite() {
  try { return await maimemoGetFavorite(settings.token, settings.favNotepadId); }
  catch (e) { return null; }
}

// 读取账号下所有云词库，填充下拉框；并按当前选择(settings.favNotepadId)高亮
async function populateFavPickers() {
  const sel = $("favNotepadSelect");
  if (!sel) return;
  // 未配置 Token 时不请求，默认显示"我的收藏"
  if (!settings.token) {
    sel.innerHTML = `<option value="">我的收藏</option>`;
    return;
  }
  try {
    const favs = await maimemoListCloudNotepads(settings.token);
    if (!favs || !favs.length) {
      sel.innerHTML = `<option value="">（暂无云词库）</option>`;
      return;
    }
    // 当前 id 失效时回退：优先“我的收藏”(FAVORITE)，否则第一个
    let cur = settings.favNotepadId;
    if (!favs.some((n) => n.id === cur)) {
      const fav = favs.find((n) => n.type === "FAVORITE");
      cur = fav ? fav.id : favs[0].id;
    }
    sel.innerHTML = favs
      .map((n) => `<option value="${escHtml(n.id)}">${escHtml(n.title || "未命名词库")}</option>`)
      .join("");
    sel.value = cur;
  } catch (e) {
    console.warn("加载云词库失败", e);
    sel.innerHTML = `<option value="">（加载云词库失败）</option>`;
  }
}

// 切换云词库：保存选择并刷新收藏词展示
async function onFavNotepadChange() {
  const sel = $("favNotepadSelect");
  settings.favNotepadId = sel.value || null;
  await saveSettings({ favNotepadId: settings.favNotepadId });
  // 重新拉当前词库并展示
  const favNotepad = await apiGetFavorite();
  renderFavs(favNotepad);
  // 让看板缓存也带上当前词库，避免后续脏读
  fetchBoardData().then((data) => cacheSet(CACHE.BOARD.key, data, CACHE.BOARD.ttl)).catch(() => {});
}

function formatTime(ms) {
  if (!ms) return "0 分钟";
  const min = Math.round(ms / 60000);
  if (min < 60) return `${min} 分钟`;
  return `${Math.floor(min / 60)}h${min % 60}m`;
}

// 收藏词本已背清理（同步逻辑）：把收藏中已背过的词移除出去
async function syncCleanFavorites(notepad) {
  if (!notepad) return notepad;
  const words = (notepad.list || [])
    .filter((it) => it.type === "WORD" || it.type === "DRAFT_WORD")
    .map((it) => it.word);
  if (!words.length) return notepad;

  const studied = new Set();
  // 分批查询（每批最多 1000，一般收藏不会超）
  const BATCH = 1000;
  for (let i = 0; i < words.length; i += BATCH) {
    const batch = words.slice(i, i + BATCH);
    const records = await maimemoQueryBySpellings(batch, settings.token);
    records.forEach((r) => studied.add(r.voc_spelling));
  }
  if (studied.size === 0) return notepad;

  // 保留未背过的词，生成新 content
  const kept = words.filter((w) => !studied.has(w));
  // 保留章节标记
  const chapters = (notepad.list || [])
    .filter((it) => it.type === "CHAPTER")
    .map((it) => it.chapter);
  const header = chapters.map((c) => `# ${c}`).join("\n");

  const newContent = (header ? header + "\n" : "") + kept.join("\n");
  if (newContent.trim() !== (notepad.content || "").trim()) {
    await maimemoUpdateNotepad(notepad.id, {
      title: notepad.title,
      brief: notepad.brief || "",
      content: newContent.trim(),
      tags: (Array.isArray(notepad.tags) ? notepad.tags : ["我的收藏"]),
      status: notepad.status || "PUBLISHED",
    }, settings.token);
    // 重新读取，确保 list/content 与云端一致（渲染依赖 .list）
    return await maimemoGetNotepad(notepad.id, settings.token);
  }
  return notepad;
}

// ---------- 查找 + 收藏 ----------
// 把输入拆成真实单词（忽略标点；多次空格/空 token 自然跳过）
function tokenizeWords(input) {
  const m = String(input || "").toLowerCase().match(/[a-z]+(?:['’][a-z]+)?/g) || [];
  return [...new Set(m)]; // 去重，避免一句里重复词反复查
}

async function doLookup() {
  const raw = $("wordInput").value.trim();
  if (!raw) return;
  if (!settings.token) {
    showLookupError("请先在设置中填入墨墨 Token");
    return;
  }

  const words = tokenizeWords(raw);
  // 整句/多词 → 走句子查询（逐词释义）
  if (words.length > 1) return doLookupSentence(raw, words);

  const word = words[0] || raw.toLowerCase();
  // 单次（一个词）查词

  // 收起上一次结果
  hide("lookupResult"); hide("lookupError");
  show("lookupLoading");
  $("lookupLoading").textContent = "查询词典中…";

  try {
    // 1) 免费词典（有缓存直接用，24 小时）
    let dict = await cacheGet(dictCacheKey(word));
    if (!dict) {
      dict = await DictLookup(word);
      await cacheSet(dictCacheKey(word), dict, CACHE.DICT.ttl);
    }
    $("lookupLoading").textContent = "已在词典找到，正在同步墨墨状态…";

    // 2) 墨墨：解析 voc_id + 判定是否已背
    let studied = false;
    let voc = null;
    try {
      voc = await maimemoResolveWord(word, settings.token);
      const records = await maimemoQueryBySpellings([word], settings.token);
      studied = records.length > 0;
    } catch (e) {
      // 墨墨接口失败不阻断查词
      console.warn("maimemo state check failed", e);
    }

    // 3) 收藏逻辑
    let collectMsg = "";
    let favNotepad = null;
    let inFav = false;
    try {
      favNotepad = await maimemoGetFavorite(settings.token, settings.favNotepadId);
      inFav = isInFavorite(favNotepad, word);
    } catch (e) { console.warn("fav get failed", e); }

    if (!studied && !inFav) {
      try {
        if (voc) {
          const updated = await maimemoAddWordToFavorite(favNotepad, word, settings.token);
          favNotepad = updated;
          collectMsg = "已加入收藏";
          // 同步清理收藏中已背过的词
          await syncCleanFavorites(favNotepad);
        } else {
          collectMsg = "词库中无此词，无法收藏";
        }
      } catch (e) {
        collectMsg = "收藏失败：" + e.message;
      }
    }

    // 两个独立状态，互不覆盖：① 是否背过 ② 是否加入词本
    const studiedTag = studied ? "已背过" : "未背过";
    const studiedClass = studied ? "picked" : "neutral";

    let favTag, favClass;
    if (inFav || collectMsg === "已加入收藏") {
      favTag = "已加入词本"; favClass = "faved";
    } else if (collectMsg) {
      favTag = collectMsg; favClass = "fail"; // 词库无此词 / 收藏失败等
    } else {
      favTag = "未加入词本"; favClass = "neutral";
    }

    hide("lookupLoading");
    renderLookupResult(dict, studiedTag, studiedClass, favTag, favClass);
    show("lookupResult");
    // 查词后刷新收藏词区块（若有新词入库则立即显示）
    if (inFav || collectMsg === "已加入收藏") refreshFavSection();
  } catch (e) {
    hide("lookupLoading");
    showLookupError("查词失败：" + e.message);
  }
}

// 轻量刷新收藏词区块：重拉当前云词库并渲染（不刷新整个看板）
async function refreshFavSection() {
  try {
    const favNotepad = await maimemoGetFavorite(settings.token, settings.favNotepadId);
    renderFavs(favNotepad);
  } catch (e) { console.warn("刷新收藏词失败", e); }
}

function showLookupError(msg) {
  hide("lookupResult"); show("lookupError");
  setText("lookupError", msg);
}
function isInFavorite(notepad, word) {
  if (!notepad) return false;
  return (notepad.list || []).some(
    (it) => (it.type === "WORD" || it.type === "DRAFT_WORD") && it.word === word
  );
}

function renderLookupResult(dict, studiedTag, studiedClass, favTag, favClass) {
  hide("sentenceHead");
  setText("resWord", dict.word);
  setText("resPhonetic", dict.phonetic ? `/${dict.phonetic}/` : "");
  const stEl = $("resTagStudied");
  stEl.textContent = studiedTag;
  stEl.className = "tag " + studiedClass;
  const favEl = $("resTagFav");
  favEl.textContent = favTag;
  favEl.className = "tag " + favClass;

  // 释义（中文为主，不显示英文释义）
  const defsEl = $("resDefs");
  defsEl.innerHTML = "";
  dict.items.forEach((it) => {
    const div = document.createElement("div");
    div.className = "def-item";
    const pos = it.pos ? `<span class="def-pos">${escHtml(it.pos)}</span>` : "";
    const zh = it.zh ? `<span class="def-zh">${escHtml(it.zh)}</span>` : "";
    div.innerHTML = `${pos}${zh}`;
    defsEl.appendChild(div);
  });

  // 中英双语例句
  (dict.examples || []).slice(0, 2).forEach((ex) => {
    const div = document.createElement("div");
    div.className = "def-item def-example-block";
    div.innerHTML =
      `<span class="def-ex-en">${escHtml(ex.en)}</span>` +
      `<span class="def-ex-cn">${escHtml(ex.cn)}</span>`;
    defsEl.appendChild(div);
  });

  // 保存当前词供 AI 释义用
  window._currentWord = dict.word;
  hide("aiDefArea");
}

// ---------- 句子查词（输入整句，逐词查释义） ----------
async function doLookupSentence(raw, words) {
  hide("lookupResult"); hide("lookupError");
  show("lookupLoading");
  $("lookupLoading").textContent = `正在查询 ${words.length} 个词…`;

  try {
    // 先取一次收藏词本（用于判断 inFav 与后续串行加入）
    let favNotepad = null;
    try { favNotepad = await maimemoGetFavorite(settings.token, settings.favNotepadId); } catch (e) { /* ignore */ }

    // 阶段①：并行查所有词的词典 + 墨墨状态（这里不做收藏，避免并行写词本产生竞态覆盖）
    const results = await Promise.all(words.map(async (w) => {
      let dict = await cacheGet(dictCacheKey(w));
      if (!dict) {
        dict = await DictLookup(w);
        if (dict && dict.word) await cacheSet(dictCacheKey(w), dict, CACHE.DICT.ttl);
      }
      let studied = false, hasVoc = false;
      try {
        const voc = await maimemoResolveWord(w, settings.token);
        hasVoc = !!voc;
        const records = await maimemoQueryBySpellings([w], settings.token);
        studied = records.length > 0;
      } catch (e) { /* 墨墨失败不阻断 */ }
      const inFav = isInFavorite(favNotepad, w);
      return { word: w, dict, studied, hasVoc, inFav, favTag: "", favClass: "neutral" };
    }));

    // 阶段②：串行自动加入收藏（未背过且未入词本且词库有词）。
    // 必须顺序执行；每步用最新完整词本（重新 GET 而非依赖上一次 POST 的不完整返回），
    // 否则并发/旧快照会互相覆盖，导致只有最后一个词或 0 个词真正落进收藏。
    for (const r of results) {
      if (r.studied) { r.favTag = "已背过"; r.favClass = "picked"; continue; }
      if (r.inFav) { r.favTag = "词本中"; r.favClass = "faved"; continue; }
      if (r.hasVoc) {
        try {
          // 每词加入前刷新一次完整词本（含最新内容与完整字段）
          favNotepad = await maimemoGetFavorite(settings.token, settings.favNotepadId);
          if (favNotepad) await maimemoAddWordToFavorite(favNotepad, r.word, settings.token);
          r.favTag = "已加入"; r.favClass = "added";
        } catch (e) {
          r.favTag = "收藏失败"; r.favClass = "fail";
        }
      } else {
        r.favTag = "词库无此词"; r.favClass = "fail";
      }
    }

    const ok = results.filter((r) => r.dict && r.dict.word);
    const miss = results.filter((r) => !r.dict || !r.dict.word).map((r) => r.word);
    if (!ok.length) {
      hide("lookupLoading");
      showLookupError(`词典中未找到这些词：${miss.join("、")}`);
      return;
    }

    // 同步清理词本：把词本中已经背过的词移除（与单词语义一致的第④步）
    if (favNotepad) {
      try {
        const cleaned = await syncCleanFavorites(favNotepad);
        if (cleaned) favNotepad = cleaned;
      } catch (e) { /* 清理失败不阻断展示 */ }
    }

    hide("lookupLoading");
    renderSentenceResult(ok, miss);
    show("lookupResult");

    // 记住第一个成功词，供 AI 释义按钮复用（句查时仅指向首个词）
    window._currentWord = ok[0].dict.word;
    hide("aiDefArea");
    // 句查可能自动加入了新词，刷新收藏词区块
    if (results.some((r) => r.favTag === "已加入")) refreshFavSection();
  } catch (e) {
    hide("lookupLoading");
    showLookupError("查词失败：" + e.message);
  }
}

function renderSentenceResult(ok, miss) {
  const head = $("sentenceHead");
  head.textContent = `整句 ${ok.length} 词释义：`;
  head.classList.remove("hidden");

  const titleEl = $("resWord");
  titleEl.textContent = "句子查词";
  setText("resPhonetic", "");
  const stEl = $("resTagStudied");
  stEl.className = "tag neutral";
  stEl.textContent = "";
  const favEl = $("resTagFav");
  favEl.className = "tag neutral";
  favEl.textContent = "";

  const defsEl = $("resDefs");
  defsEl.innerHTML = "";
  ok.forEach((r, i) => {
    const card = document.createElement("div");
    card.className = "sent-word";
    // 词头：单词 + 音标 + 背过/词本徽章（词本状态含自动加入结果）
    let badges = "";
    badges += r.studied
      ? `<span class="tag picked">已背过</span>`
      : `<span class="tag neutral">未背过</span>`;
    badges += `<span class="tag ${r.favClass || "neutral"}">${escHtml(r.favTag || "未入词本")}</span>`;

    const header = document.createElement("div");
    header.className = "sent-head";
    header.innerHTML =
      `<span class="sent-word-name">${escHtml(r.dict.word)}</span>` +
      (r.dict.phonetic ? `<span class="phonetic">/${escHtml(r.dict.phonetic)}/</span>` : "") +
      `<span class="tags">${badges}</span>`;
    card.appendChild(header);

    const items = document.createElement("div");
    items.className = "defs";
    r.dict.items.forEach((it) => {
      const div = document.createElement("div");
      div.className = "def-item";
      const pos = it.pos ? `<span class="def-pos">${escHtml(it.pos)}</span>` : "";
      const zh = it.zh ? `<span class="def-zh">${escHtml(it.zh)}</span>` : "";
      div.innerHTML = `${pos}${zh}`;
      items.appendChild(div);
    });
    card.appendChild(items);
    defsEl.appendChild(card);
  });

  if (miss.length) {
    const note = document.createElement("div");
    note.className = "def-item sent-miss";
    note.textContent = `未能识别：${miss.join("、")}`;
    defsEl.appendChild(note);
  }
}

// ---------- AI 释义 ----------
async function doAiDefinition() {
  const word = window._currentWord;
  if (!word) { showLookupError("请先查词"); return; }
  if (!resolveLLM(settings)) {
    showLookupError("请先在设置中填写 LLM Key");
    return;
  }
  const btn = $("aiDefBtn");
  const btnLabel = $("aiDefLabel");
  btn.disabled = true;
  if (btnLabel) btnLabel.textContent = "AI 生成中…";
  try {
    const r = await aiDefinition(settings, word);
    show("aiDefArea");
    const box = $("aiDefContent");
    box.innerHTML = "";
    const rows = [
      ["音标", r.phonetic],
      ["中文释义", r.cn],
      ["英文释义", r.en],
      ["例句", r.example],
    ];
    for (const [k, v] of rows) {
      if (!v) continue;
      const line = document.createElement("div");
      line.className = "ai-line";
      // 加粗模型输出中的目标词
      line.innerHTML = `<span class="ai-k">${escHtml(k)}：</span><span class="ai-v">${renderBold(escHtml(v), [word])}</span>`;
      box.appendChild(line);
    }
  } catch (e) {
    showLookupError("AI 释义失败：" + e.message);
  } finally {
    btn.disabled = false;
    if (btnLabel) btnLabel.textContent = "AI 释义";
  }
}

// ---------- 单词小文章 ----------
// 打开面板时调用：若已有缓存故事直接显示，不重新请求 LLM
async function showStoryCache() {
  const cached = await cacheGet(CACHE.STORY.key);
  if (cached && cached.pairs && cached.pairs.length) {
    renderStory(cached.pairs, cached.highlight, cached.meta);
  }
}

// 点按钮：重新生成并缓存
async function doStory() {
  if (!settings.token) { showStoryError("请先在设置中填入墨墨 Token"); return; }
  if (!resolveLLM(settings)) { showStoryError("请先在设置中填写 LLM Key"); return; }

  hide("storyError"); hide("storyMeta");
  show("storyLoading");
  $("storyLoading").textContent = "正在获取今日单词…";

  try {
    // 今日已背的词
    let doneItems = await maimemoGetTodayItems(settings.token, true);
    let words = doneItems.map((i) => i.voc_spelling).filter(Boolean);

    // 已背不足 3 个 => 回退为今日全部计划词
    let sourceLabel = "今日已背";
    if (words.length < 3) {
      const allItems = await maimemoGetTodayItems(settings.token);
      const all = allItems.map((i) => i.voc_spelling).filter(Boolean);
      // 去重（保持顺序）
      words = [...new Set(all)];
      sourceLabel = "今日全部计划词";
    }

    // 可能的：仍为空
    if (!words.length) {
      hide("storyLoading");
      showStoryError("今日暂无计划词，可先去查词收藏；或今日已背不足 3 个且无计划词。");
      return;
    }

    // 背诵目标 = 已背的词（若用了回退，则高亮所有词都做背诵重点；这里高亮已背词）
    const highlight = doneItems.map((i) => i.voc_spelling).filter(Boolean);

    $("storyLoading").textContent = `基于「${sourceLabel}」共 ${words.length} 词，AI 创作中…`;
    const text = await aiStory(settings, words, { highlight: highlight.length ? highlight : words });

    hide("storyLoading");
    const pairs = parseStoryPairs(text);
    if (!pairs.length) throw new Error("故事解析为空，请重试");

    // 缓存上一次生成的故事（不过期），打开面板时直接显示，无需重新调用 LLM
    const meta = `来源：${sourceLabel}（${words.length} 词）`;
    await cacheSet(CACHE.STORY.key, { pairs, highlight: highlight.length ? highlight : words, meta }, CACHE.STORY.ttl);

    renderStory(pairs, highlight.length ? highlight : words, meta);
  } catch (e) {
    hide("storyLoading");
    showStoryError("生成失败：" + e.message);
  }
}

// 渲染故事（含 meta + 逐句英中）
function renderStory(pairs, highlight, meta) {
  if (meta) {
    const metaEl = $("storyMeta");
    // 只显示来源类型与词数，不显示具体词列表（同时兼容旧缓存里带词的 meta）
    const sep = meta.indexOf("·");
    metaEl.textContent = sep >= 0 ? meta.slice(0, sep).trim() : meta;
    show("storyMeta");
  }
  const area = $("storyArea");
  area.innerHTML = "";
  for (const p of pairs) {
    if (!p.en) continue; // 跳过空英文
    const block = document.createElement("div");
    block.className = "story-block";
    block.innerHTML =
      `<div class="story-en">${renderBold(escHtml(p.en), highlight)}</div>` +
      (p.cn ? `<div class="story-cn">${renderBold(escHtml(p.cn), highlight)}</div>` : "");
    area.appendChild(block);
  }
  show("storyArea");
  show("storyCopyBtn"); // 有内容才显示复制
}

// 解析故事输出为 {en, cn} 数组
// 优先 XML 结构 <line><en>..</en><zh>..</zh></line>，失败则退回逐行交错
function parseStoryPairs(text) {
  const xmlPairs = parseXmlPairs(text);
  if (xmlPairs.length) return xmlPairs;
  return splitBilingual(text);
}

// XML 结构解析
function parseXmlPairs(text) {
  const pairs = [];
  const re = /<line>([\s\S]*?)<\/line>/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    const block = m[1];
    const enM = block.match(/<en>([\s\S]*?)<\/en>/);
    const zhM = block.match(/<zh>([\s\S]*?)<\/zh>/);
    if (enM) {
      pairs.push({
        en: enM[1].trim(),
        cn: zhM ? zhM[1].trim() : "",
      });
    }
  }
  return pairs;
}

// 切分“英文句/中文句”两两配对（兜底）
function splitBilingual(text) {
  const lines = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)
    // 去掉可能出现的行首序号（1. / 1、 / - 等）
    .map((l) => l.replace(/^\s*(?:\d+[\.\、\:：)]|[-•*])\s*/, "").trim());
  const pairs = [];
  let en = null;
  for (const line of lines) {
    // 含中文字符即视为中文行；纯英文（或几乎纯英文）视为英文行
    const cnCount = (line.match(/[\u4e00-\u9fff]/g) || []).length;
    const ascii = (line.match(/[A-Za-z]/g) || []).length;
    const isCn = cnCount > 0 && cnCount >= ascii * 0.5;
    if (!isCn) {
      if (en) pairs.push({ en, cn: "" });
      en = line;
    } else {
      if (en) { pairs.push({ en, cn: line }); en = null; }
      else pairs.push({ en: "", cn: line });
    }
  }
  if (en) pairs.push({ en, cn: "" });
  return pairs;
}

function showStoryError(msg) {
  hide("storyArea"); hide("storyCopyBtn"); show("storyError");
  setText("storyError", msg);
}

// ---------- 事件绑定 ----------
document.addEventListener("DOMContentLoaded", async () => {
  await loadSettings();
  initSettingsUI();
  applyUsername(); // 顶部显示用户名（无则 MyMaimemo）
  // 打开面板：看板读缓存（无则拉取）、故事读缓存，均不重复调用
  refreshDashboard(false);
  showStoryCache();
  populateFavPickers(); // 填充云词库下拉框

  // 设置子页：齿轮打开、返回主页；与主视图互斥切换
  $("settingsBtn").addEventListener("click", openSettings);
  $("backBtn").addEventListener("click", closeSettings);
  $("llmProvider").addEventListener("change", toggleCustomField);
  $("saveSettings").addEventListener("click", onSaveSettings);
  $("refreshBtn").addEventListener("click", () => refreshDashboard(true));
  $("lookupBtn").addEventListener("click", doLookup);
  $("wordInput").addEventListener("keydown", (e) => {
    if (e.key === "Enter") doLookup();
  });
  $("aiDefBtn").addEventListener("click", doAiDefinition);
  $("storyBtn").addEventListener("click", doStory);
  $("storyCopyBtn").addEventListener("click", copyStory);
  $("favNotepadSelect").addEventListener("change", onFavNotepadChange);
});

// ---------- 视图切换（主页 / 设置子页） ----------
function openSettings() {
  // 设置子页有独立的返回箭头标题栏，故同时隐藏顶部栏（含设置齿轮图标）
  hide("settingsBtn");
  hide("topbar");
  hide("homeView");
  show("settingsView");
}
function closeSettings() {
  hide("settingsView");
  show("homeView");
  show("settingsBtn");
  show("topbar");
}

// ---------- 复制故事全文 ----------
async function copyStory() {
  const area = $("storyArea");
  if (!area || area.classList.contains("hidden")) return;
  const blocks = area.querySelectorAll(".story-block");
  const lines = [];
  blocks.forEach((b) => {
    const en = b.querySelector(".story-en");
    const cn = b.querySelector(".story-cn");
    if (en) lines.push(en.textContent.trim());
    if (cn) lines.push(cn.textContent.trim());
    lines.push("");
  });
  const text = lines.join("\n").trim();
  if (!text) return;

  let ok = false;
  try {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      await navigator.clipboard.writeText(text);
      ok = true;
    }
  } catch (e) { /* 落到兜底 */ }
  if (!ok) {
    // 兜底：execCommand（部分环境无 clipboard 权限）
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.select();
    try { ok = document.execCommand("copy"); } catch (_) { ok = false; }
    document.body.removeChild(ta);
  }

  const btn = $("storyCopyLabel");
  const label = $("storyCopyBtn");
  btn.textContent = ok ? "已复制" : "复制失败";
  label.classList.add(ok ? "copied" : "");
  setTimeout(() => {
    btn.textContent = "复制";
    label.classList.remove("copied");
  }, 1500);
}
