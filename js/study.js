// study.js — 学习数据页（概览图表 / 易忘词 / 全量记录）
// 依赖 popup.js 提供的全局：$、hide、show、setText、escHtml、cacheGet、cacheSet、settings、STUDY_CACHE_KEY
"use strict";

const STUDY_CACHE_TTL = 6 * 3600 * 1000;  // 学习记录缓存 6 小时（全量拉取约 30 秒，频繁过期不值；页内有「刷新」可手动更新）

let studyRecords = null;   // 全量学习记录（分页拉取后缓存）
let studyLoading = false;  // 防止并发重复拉取

const studyState = {
  tab: "overview",          // overview | sticky | all
  page: 1,
  perPage: 50,
  sortKey: "voc_spelling",
  sortDir: 1,               // 1 升序 / -1 降序
  query: "",
};

// ---------- 视图切换 ----------
function openStudyView() {
  hide("topbar"); hide("homeView");
  show("studyView");
  // 拉取是长任务（约 30 秒），fire-and-forget 但必须兜底异常，避免界面卡在加载态
  loadStudyView(false).catch((e) => {
    console.warn("学习数据加载异常", e);
    hide("studyLoading");
    show("studyError");
    $("studyError").textContent = "加载学习数据失败：" + (e && e.message ? e.message : "未知错误") + "（可点右上角「刷新」重试）";
  });
}
function closeStudyView() {
  hide("studyView");
  show("homeView");
  show("topbar");
}

async function loadStudyView(force) {
  const loadEl = $("studyLoading");
  const errEl = $("studyError");
  hide("studyError");
  try {
    const recs = await ensureStudyData(force);
    hide("studyLoading");
    renderStudyAll(recs);
  } catch (e) {
    hide("studyLoading");
    show("studyError");
    errEl.textContent = "加载学习数据失败：" + e.message + "（可点右上角「刷新」重试）";
  }
}

async function ensureStudyData(force) {
  if (studyRecords && !force) return studyRecords;
  // 并发去重：等正在进行的拉取结束；若第一次失败（studyRecords 仍为空），则重新拉取而非返回空
  if (studyLoading) {
    while (studyLoading) await new Promise((r) => setTimeout(r, 150));
    if (studyRecords) return studyRecords;
  }
  if (!settings.token) throw new Error("请先在设置中填入墨墨 Token");
  if (!force) {
    const cached = await cacheGet(STUDY_CACHE_KEY);
    if (Array.isArray(cached) && cached.length) { studyRecords = cached; return studyRecords; }
  }
  studyLoading = true;
  const loadEl = $("studyLoading");
  const started = Date.now();
  try {
    const recs = await maimemoFetchAllStudyRecords(settings.token, (n, total) => {
      if (!total) { loadEl.textContent = `正在拉取学习记录… 已加载 ${n} 词`; return; }
      // 按进度估算剩余时间，让用户知道不是卡死
      const pct = Math.min(99, Math.round((n / total) * 100));
      const el = Date.now() - started;
      const per = el / Math.max(n, 1);
      const left = Math.max(0, Math.round((per * (total - n)) / 1000));
      loadEl.textContent = `正在拉取学习记录… ${n} / ${total} 词（${pct}%，约剩 ${left} 秒）`;
    });
    if (recs.length) {
      studyRecords = recs;
      await cacheSet(STUDY_CACHE_KEY, recs, STUDY_CACHE_TTL);
    }
    return studyRecords || [];
  } finally {
    studyLoading = false;
  }
}

function renderStudyAll(recs) {
  const tab = studyState.tab;
  if (tab === "overview") renderOverview(recs);
  else if (tab === "sticky") renderStickyList(recs);
  else renderTable(recs);
}

function switchStudyTab(tab) {
  studyState.tab = tab;
  document.querySelectorAll(".study-tab").forEach((b) => {
    b.classList.toggle("active", b.dataset.tab === tab);
  });
  ["overview", "sticky", "all"].forEach((t) => {
    const el = $("studyTab-" + t);
    if (el) el.classList.toggle("hidden", t !== tab);
  });
  if (studyRecords) renderStudyAll(studyRecords);
}

// ---------- 概览：KPI + 图表 ----------
function renderOverview(recs) {
  const n = recs.length;
  const sticky = recs.filter((r) => (r.tags || []).includes("STICKING")).length;
  const totalStudy = recs.reduce((s, r) => s + (r.study_count || 0), 0);
  // 7 日到期（含今天，next_study_date ≤ 今天+7 且 ≥ 今天）
  const nowKey = bjDayNum(new Date());
  const due7 = recs.filter((r) => {
    if (!r.next_study_date) return false;
    const d = new Date(r.next_study_date);
    if (isNaN(d.getTime())) return false;
    const k = bjDayNum(d);
    return k >= nowKey && k <= nowKey + 7 * 864e5;
  }).length;
  // 未来 30 天到期
  const due30 = recs.filter((r) => {
    if (!r.next_study_date) return false;
    const d = new Date(r.next_study_date);
    if (isNaN(d.getTime())) return false;
    const k = bjDayNum(d);
    return k >= nowKey && k <= nowKey + 30 * 864e5;
  }).length;

  $("studyKpis").innerHTML =
    `<div class="skpi skpi-main"><div class="skpi-label">计划总词数</div><div class="skpi-value">${n}</div></div>` +
    `<div class="skpi skpi-warn"><div class="skpi-label">易忘词</div><div class="skpi-value">${sticky}</div></div>` +
    `<div class="skpi skpi-hot"><div class="skpi-label">7 日到期</div><div class="skpi-value">${due7}</div></div>` +
    `<div class="skpi"><div class="skpi-label">30 日到期</div><div class="skpi-value">${due30}</div></div>` +
    `<div class="skpi"><div class="skpi-label">累计学习次数</div><div class="skpi-value">${totalStudy}</div></div>`;

  drawDueChart(recs);
  drawStatusChart(recs);
  drawTrendChart(recs);
}

// 未来 30 天复习到期分布（柱状图）
function drawDueChart(recs) {
  const days = 30;
  const now = new Date();
  const nowKey = bjDayNum(now);
  const map = {};
  for (const r of recs) {
    if (!r.next_study_date) continue;
    const d = new Date(r.next_study_date);
    if (isNaN(d.getTime())) continue;
    const diff = Math.round((bjDayNum(d) - nowKey) / 864e5);
    if (diff >= 0 && diff < days) map[diff] = (map[diff] || 0) + 1;
  }
  const labels = [], counts = [];
  for (let i = 0; i < days; i++) {
    const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() + i);
    labels.push(`${d.getMonth() + 1}/${d.getDate()}`);
    counts.push(map[i] || 0);
  }
  drawSvgBars("chartDue", labels, counts, { color: "#db663c", labelEvery: 5, height: 210 });
}

// 学习状态分布（环形图）
function drawStatusChart(recs) {
  const defs = [
    { key: "WELL_FAMILIAR", label: "熟知", color: "#7da994" },
    { key: "FAMILIAR", label: "认识", color: "#db663c" },
    { key: "VAGUE", label: "模糊", color: "#5b8db8" },
    { key: "FORGET", label: "忘记", color: "#c1503c" },
  ];
  const count = (k) => recs.filter((r) => r.last_response === k).length;
  const items = defs.map((d) => ({ ...d, value: count(d.key) }));
  const none = recs.length - items.reduce((s, i) => s + i.value, 0);
  if (none > 0) items.push({ label: "未测", value: none, color: "#b8bdb9" });
  drawSvgDonut("chartStatus", items, { height: 240 });
}

// 近 12 个月学习量趋势（按首次学习月份）
function drawTrendChart(recs) {
  const months = [];
  const now = new Date();
  for (let i = 11; i >= 0; i--) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    months.push({ key: `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`, label: `${d.getMonth() + 1}月` });
  }
  const counts = months.map(() => 0);
  for (const r of recs) {
    const src = r.first_study_date || r.add_date;
    if (!src) continue;
    const k = src.slice(0, 7);
    const idx = months.findIndex((m) => m.key === k);
    if (idx >= 0) counts[idx]++;
  }
  drawSvgBars("chartTrend", months.map((m) => m.label), counts, { color: "#7da994", labelEvery: 2, height: 200 });
}

// ---------- 易忘词清单 ----------
// 范围：tags=STICKING（墨墨标记的易忘词）；按难度排序展示前 200 个
// 难度分 = 学习次数 × 10 + 最近反应权重（忘记>模糊>认识>熟知），学得多还记不住 = 更难
const RESP_DIFF_W = { FORGET: 4, VAGUE: 3, FAMILIAR: 1, WELL_FAMILIAR: 0 };
const RESP_CN = { WELL_FAMILIAR: "熟知", FAMILIAR: "认识", VAGUE: "模糊", FORGET: "忘记" };
function diffScore(r) {
  return (r.study_count || 0) * 10 + (RESP_DIFF_W[r.last_response] ?? 1);
}
function renderStickyList(recs) {
  const list = recs.filter((r) => (r.tags || []).includes("STICKING"));
  setText("stickyDesc", `易忘词共 ${list.length} 个，按难度排序（学习次数×10 + 最近反应权重），展示前 200 个`);
  const box = $("stickyList");
  box.innerHTML = "";
  if (!list.length) {
    box.innerHTML = `<div class="study-empty">暂无「易忘词」</div>`;
    return;
  }
  list.sort((a, b) => {
    const da = diffScore(b), db = diffScore(a);
    if (da !== db) return da - db;                                  // 难度分降序
    return (b.last_study_date || "").localeCompare(a.last_study_date || ""); // 同分按最近学习倒序
  });
  list.slice(0, 200).forEach((r) => {
    const chip = document.createElement("div");
    chip.className = "wchip";
    chip.innerHTML =
      `<span class="wchip-word">${escHtml(r.voc_spelling || "—")}</span>` +
      `<span class="wchip-meta">学 ${r.study_count || 0} 次 · ${RESP_CN[r.last_response] || "未测"}</span>`;
    box.appendChild(chip);
  });
  if (list.length > 200) {
    const more = document.createElement("div");
    more.className = "study-more";
    more.textContent = `… 还有 ${list.length - 200} 个`;
    box.appendChild(more);
  }
}

// ---------- 全量记录表格（搜索 / 排序 / 分页） ----------
function renderTable(recs) {
  const q = (studyState.query || "").trim().toLowerCase();
  let rows = recs;
  if (q) {
    rows = recs.filter((r) =>
      (r.voc_spelling || "").toLowerCase().includes(q) ||
      (r.last_response || "").toLowerCase().includes(q) ||
      (r.tags || []).some((t) => String(t).toLowerCase().includes(q))
    );
  }
  const key = studyState.sortKey, dir = studyState.sortDir;
  rows = rows.slice().sort((a, b) => {
    let va, vb;
    if (key === "next_study_date" || key === "last_study_date") {
      va = a[key] ? bjDayNum(new Date(a[key])) : (dir > 0 ? 9e15 : -9e15);
      vb = b[key] ? bjDayNum(new Date(b[key])) : (dir > 0 ? 9e15 : -9e15);
    } else if (key === "study_count") {
      va = a.study_count || 0; vb = b.study_count || 0;
    } else {
      va = String(a[key] || ""); vb = String(b[key] || "");
    }
    return va > vb ? dir : va < vb ? -dir : 0;
  });

  const totalPages = Math.max(1, Math.ceil(rows.length / studyState.perPage));
  studyState.page = Math.min(Math.max(1, studyState.page), totalPages);
  const start = (studyState.page - 1) * studyState.perPage;
  const pageRows = rows.slice(start, start + studyState.perPage);

  const tbody = $("studyTbody");
  tbody.innerHTML = "";
  if (!pageRows.length) {
    tbody.innerHTML = `<tr><td colspan="6" class="study-empty">无匹配记录</td></tr>`;
  } else {
    for (const r of pageRows) {
      const tr = document.createElement("tr");
      tr.innerHTML =
        `<td class="col-word">${escHtml(r.voc_spelling || "—")}</td>` +
        `<td class="col-num">${r.study_count || 0}</td>` +
        `<td>${respBadge(r.last_response)}</td>` +
        `<td class="col-date${isOverdue(r.next_study_date) ? " overdue" : ""}">${fmtIso(r.next_study_date)}</td>` +
        `<td class="col-date">${fmtIso(r.last_study_date)}</td>` +
        `<td>${tagChips(r.tags)}</td>`;
      tbody.appendChild(tr);
    }
  }

  const pager = $("studyPager");
  pager.innerHTML =
    `<button class="btn btn-ghost" id="pgPrev" ${studyState.page <= 1 ? "disabled" : ""}>上一页</button>` +
    `<span class="pager-info">第 ${studyState.page} / ${totalPages} 页 · 共 ${rows.length} 词</span>` +
    `<button class="btn btn-ghost" id="pgNext" ${studyState.page >= totalPages ? "disabled" : ""}>下一页</button>`;
  $("pgPrev").onclick = () => { studyState.page--; renderTable(recs); };
  $("pgNext").onclick = () => { studyState.page++; renderTable(recs); };
}

function respBadge(r) {
  const map = {
    WELL_FAMILIAR: ["熟知", "ok"],
    FAMILIAR: ["认识", "ok2"],
    VAGUE: ["模糊", "warn"],
    FORGET: ["忘记", "bad"],
  };
  const m = map[r] || ["未测", "none"];
  return `<span class="resp resp-${m[1]}">${m[0]}</span>`;
}
function tagChips(tags) {
  if (!Array.isArray(tags) || !tags.length) return "—";
  return tags
    .map((t) =>
      t === "STICKING" ? `<span class="tchip tchip-sticky">易忘</span>`
      : t === "WELL_FAMILIAR" ? `<span class="tchip tchip-ok">熟词</span>`
      : `<span class="tchip">${escHtml(t)}</span>`
    )
    .join(" ");
}

// ---------- 日期工具（北京时区） ----------
function bjKey(d) {
  const u = new Date(d.getTime() + 8 * 3600 * 1000);
  return u.toISOString().slice(0, 10);
}
function bjDayNum(d) {
  const [y, m, day] = bjKey(d).split("-").map(Number);
  return Date.UTC(y, m - 1, day);
}
function fmtIso(iso) {
  if (!iso) return "—";
  const d = new Date(iso);
  return isNaN(d.getTime()) ? "—" : bjKey(d);
}
function isOverdue(iso) {
  if (!iso) return false;
  const d = new Date(iso);
  return !isNaN(d.getTime()) && bjDayNum(d) < bjDayNum(new Date());
}

// ---------- SVG 图表 ----------
function svgEl(tag, attrs) {
  const el = document.createElementNS("http://www.w3.org/2000/svg", tag);
  for (const k in attrs) el.setAttribute(k, attrs[k]);
  return el;
}

function niceCeil(v) {
  if (v <= 0) return 5;
  if (v <= 5) return 5;
  const p = Math.pow(10, Math.floor(Math.log10(v)));
  for (const m of [1, 2, 5, 10]) if (v <= m * p) return m * p;
  return 10 * p;
}

// 柱状图
function drawSvgBars(containerId, labels, counts, opts) {
  const W = 520, H = opts.height || 210;
  const padL = 36, padR = 8, padT = 14, padB = 26;
  const plotW = W - padL - padR, plotH = H - padT - padB;
  const max = counts.reduce((m, c) => Math.max(m, c), 0);
  const niceMax = niceCeil(max);
  const container = $(containerId);
  if (!container) return;
  container.innerHTML = "";
  const svg = svgEl("svg", { viewBox: `0 0 ${W} ${H}`, width: "100%", class: "svg-chart" });

  const steps = 4;
  for (let i = 0; i <= steps; i++) {
    const v = Math.round((niceMax * i) / steps);
    const y = padT + plotH - (v / niceMax) * plotH;
    svg.appendChild(svgEl("line", { x1: padL, x2: W - padR, y1: y, y2: y, stroke: "#e8eae9", "stroke-width": 1 }));
    const t = svgEl("text", { x: padL - 6, y: y + 3.5, "text-anchor": "end", "font-size": 10, fill: "#8a8d8c" });
    t.textContent = v;
    svg.appendChild(t);
  }

  const n = counts.length;
  const step = plotW / n;
  const bw = Math.min(26, step * 0.72);
  counts.forEach((c, i) => {
    const h = (c / niceMax) * plotH;
    const x = padL + step * i + (step - bw) / 2;
    const y = padT + plotH - h;
    const rect = svgEl("rect", {
      x, y,
      width: bw,
      height: c > 0 ? Math.max(h, 1) : 0,
      rx: 2,
      fill: opts.color || "#db663c",
      opacity: c > 0 ? 1 : 0.22,
      class: "bar",
    });
    rect.dataset.tip = `${labels[i]}：${c} 词`;
    svg.appendChild(rect);
    if (opts.labelEvery && i % opts.labelEvery === 0) {
      const t = svgEl("text", { x: x + bw / 2, y: H - 8, "text-anchor": "middle", "font-size": 9.5, fill: "#8a8d8c" });
      t.textContent = labels[i];
      svg.appendChild(t);
    }
  });
  container.appendChild(svg);
}

// 环形图
function drawSvgDonut(containerId, items, opts) {
  const W = 520, H = opts.height || 240;
  const cx = 118, cy = H / 2, r = 78, sw = 30;
  const total = items.reduce((s, i) => s + i.value, 0);
  const container = $(containerId);
  if (!container) return;
  container.innerHTML = "";
  const svg = svgEl("svg", { viewBox: `0 0 ${W} ${H}`, width: "100%", class: "svg-chart" });

  if (total <= 0) {
    const t = svgEl("text", { x: cx, y: cy, "text-anchor": "middle", "font-size": 13, fill: "#8a8d8c" });
    t.textContent = "暂无数据";
    svg.appendChild(t);
    container.appendChild(svg);
    return;
  }

  const C = 2 * Math.PI * r;
  let acc = 0;
  items.forEach((it) => {
    if (!it.value) return;
    const frac = it.value / total;
    const seg = svgEl("circle", {
      cx, cy, r,
      fill: "none",
      stroke: it.color,
      "stroke-width": sw,
      "stroke-dasharray": `${Math.max(frac * C - 2, 0.5)} ${C - Math.max(frac * C - 2, 0.5)}`,
      "stroke-dashoffset": -acc * C,
      transform: `rotate(-90 ${cx} ${cy})`,
      class: "seg",
    });
    seg.dataset.tip = `${it.label}：${it.value} 词（${((it.value / total) * 100).toFixed(1)}%）`;
    svg.appendChild(seg);
    acc += frac;
  });

  const t1 = svgEl("text", { x: cx, y: cy - 2, "text-anchor": "middle", "font-size": 24, "font-weight": 700, fill: "#2f3231" });
  t1.textContent = total;
  svg.appendChild(t1);
  const t2 = svgEl("text", { x: cx, y: cy + 17, "text-anchor": "middle", "font-size": 10, fill: "#8a8d8c" });
  t2.textContent = "计划词数";
  svg.appendChild(t2);

  let ly = 16;
  items.forEach((it) => {
    if (!it.value) return;
    const g = svgEl("g", { transform: `translate(232 ${ly})` });
    g.appendChild(svgEl("rect", { x: 0, y: 0, width: 12, height: 12, rx: 3, fill: it.color }));
    const lb = svgEl("text", { x: 20, y: 10, "font-size": 12, fill: "#3a3d3c" });
    lb.textContent = it.label;
    g.appendChild(lb);
    const pct = svgEl("text", { x: 208, y: 10, "text-anchor": "end", "font-size": 12, "font-weight": 600, fill: "#3a3d3c" });
    pct.textContent = `${it.value} · ${((it.value / total) * 100).toFixed(1)}%`;
    g.appendChild(pct);
    svg.appendChild(g);
    ly += 30;
  });
  container.appendChild(svg);
}

// ---------- 悬浮提示 ----------
let tipEl = null;
function getTip() {
  if (!tipEl) {
    tipEl = document.createElement("div");
    tipEl.id = "chartTip";
    document.body.appendChild(tipEl);
  }
  return tipEl;
}
function showTip(e, html) {
  const t = getTip();
  t.innerHTML = html;
  t.style.display = "block";
  const x = e.clientX + 14, y = e.clientY + 14;
  const r = t.getBoundingClientRect();
  t.style.left = (x + r.width > window.innerWidth ? x - r.width - 24 : x) + "px";
  t.style.top = (y + r.height > window.innerHeight ? y - r.height - 24 : y) + "px";
}
function hideTip() { if (tipEl) tipEl.style.display = "none"; }
function bindChartTip(containerId) {
  const c = $(containerId);
  if (!c) return;
  c.addEventListener("mousemove", (e) => {
    const t = e.target.closest ? e.target.closest("[data-tip]") : null;
    if (!t) { hideTip(); return; }
    showTip(e, t.dataset.tip);
  });
  c.addEventListener("mouseleave", hideTip);
}

// ---------- 事件绑定 ----------
document.addEventListener("DOMContentLoaded", () => {
  $("dataBtn").addEventListener("click", openStudyView);
  $("studyBackBtn").addEventListener("click", closeStudyView);
  $("studyRefreshBtn").addEventListener("click", () => loadStudyView(true));

  document.querySelectorAll(".study-tab").forEach((b) => {
    b.addEventListener("click", () => switchStudyTab(b.dataset.tab));
  });

  document.querySelectorAll("#studyTable th[data-sort]").forEach((th) => {
    th.addEventListener("click", () => {
      const k = th.dataset.sort;
      if (studyState.sortKey === k) studyState.sortDir *= -1;
      else { studyState.sortKey = k; studyState.sortDir = 1; }
      studyState.page = 1;
      renderTable(studyRecords || []);
    });
  });

  let searchTimer = null;
  $("studySearch").addEventListener("input", () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => {
      studyState.query = $("studySearch").value;
      studyState.page = 1;
      renderTable(studyRecords || []);
    }, 250);
  });

  bindChartTip("chartDue");
  bindChartTip("chartStatus");
  bindChartTip("chartTrend");
});
