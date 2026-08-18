// api.js — 墨墨背单词 Open API 封装
// Base: https://open.maimemo.com/open/api/v1
const MAIMEMO_BASE = "https://open.maimemo.com/open/api/v1";

// ---------- 通用请求 ----------
async function maimemoFetch(path, { method = "GET", body = null, token } = {}) {
  const headers = {
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
  };
  const res = await fetch(`${MAIMEMO_BASE}${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    let msg = `HTTP ${res.status}`;
    try {
      const j = await res.json();
      msg = j.error || j.message || j.detail || msg;
    } catch (e) {}
    throw new Error(`墨墨接口错误：${msg}`);
  }
  const j = await res.json();
  // 墨墨返回信封 {errors, data, success}，直接解出 data
  if (j && j.success === false) {
    const firstErr =
      (Array.isArray(j.errors) && j.errors[0] && (j.errors[0].message || j.errors[0])) ||
      j.message ||
      "请求失败";
    throw new Error(`墨墨接口错误：${firstErr}`);
  }
  return j && j.data !== undefined ? j.data : j;
}

// ---------- 校验 token ----------
async function maimemoCheckToken(token) {
  const data = await maimemoFetch("/study/get_study_progress", {
    method: "POST",
    token,
  });
  return data;
}

// ---------- 解析单词 -> voc_id ----------
async function maimemoResolveWord(spelling, token) {
  const data = await maimemoFetch(
    `/vocabulary?spelling=${encodeURIComponent(spelling)}`,
    { token }
  );
  return data.voc || null; // { id, spelling }
}

// ---------- 今日进度 ----------
async function maimemoGetProgress(token) {
  const data = await maimemoFetch("/study/get_study_progress", {
    method: "POST",
    token,
  });
  return data.progress || { finished: 0, total: 0, study_time: 0 };
}

// ---------- 今日词列表 ----------
async function maimemoGetTodayItems(token, finished) {
  const body = { limit: 1000 };
  if (finished !== undefined) body.is_finished = finished;
  const data = await maimemoFetch("/study/get_today_items", {
    method: "POST",
    body,
    token,
  });
  return data.today_items || [];
}

// ---------- 计划总词数 ----------
async function maimemoGetPlanTotal(token) {
  const data = await maimemoFetch("/study/query_study_records", {
    method: "POST",
    body: { as_count: true },
    token,
  });
  return data.count || 0;
}

// ---------- 今日到期（继续学习，与墨墨 App 口径一致） ----------
// 返回 next_study_date ≤ 今天 23:59（北京时区）的记录数
async function maimemoGetDueToday(token) {
  const fmtCst = (d) => {
    // 转成北京时区(UTC+8)的 YYYY-MM-DD
    const utc8 = new Date(d.getTime() + 8 * 3600 * 1000);
    return utc8.toISOString().slice(0, 10) + "T23:59:59+08:00";
  };
  const data = await maimemoFetch("/study/query_study_records", {
    method: "POST",
    body: { next_study_date: { end: fmtCst(new Date()) }, as_count: true },
    token,
  });
  return data.count || 0;
}

// ---------- 今日新学词数（is_new=true） ----------
async function maimemoGetNewToday(token) {
  const data = await maimemoFetch("/study/get_today_items", {
    method: "POST",
    body: { is_new: true, limit: 1000 },
    token,
  });
  return (data.today_items || []).length;
}

// ---------- 7 日到期（复习压力，北京时区） ----------
async function maimemoGetDue7(token) {
  const fmtCst = (d) => {
    const utc8 = new Date(d.getTime() + 8 * 3600 * 1000);
    return utc8.toISOString().slice(0, 10) + "T00:00:00+08:00";
  };
  const now = new Date();
  // 北京时区今天的日期 + 7 天
  const end = new Date(now.getTime() + 7 * 24 * 3600 * 1000);
  const data = await maimemoFetch("/study/query_study_records", {
    method: "POST",
    body: { next_study_date: { end: fmtCst(end) }, as_count: true },
    token,
  });
  return data.count || 0;
}

// ---------- 按拼写查询学习记录 ----------
async function maimemoQueryBySpellings(spellings, token) {
  const batch = spellings.slice(0, 1000);
  if (!batch.length) return [];
  const data = await maimemoFetch("/study/query_study_records", {
    method: "POST",
    body: { spellings: batch, limit: 1000 },
    token,
  });
  return data.records || [];
}

// ---------- 云词本列表（我的收藏） ----------
async function maimemoListFavorites(token) {
  let offset = 0;
  const all = [];
  const LIMIT = 10; // 该接口单页上限为 10
  for (;;) {
    const data = await maimemoFetch(`/notepads?limit=${LIMIT}&offset=${offset}`, { token });
    const list = data.notepads || [];
    all.push(...list);
    if (list.length < LIMIT) break;
    offset += LIMIT;
  }
  return all.filter((n) => n.type === "FAVORITE");
}

// ---------- 列出账号下全部云词库（含“我的收藏”与自建词库，均可收藏单词） ----------
async function maimemoListCloudNotepads(token) {
  let offset = 0;
  const all = [];
  const LIMIT = 10; // 该接口单页上限为 10
  for (;;) {
    const data = await maimemoFetch(`/notepads?limit=${LIMIT}&offset=${offset}`, { token });
    const list = data.notepads || [];
    all.push(...list);
    if (list.length < LIMIT) break;
    offset += LIMIT;
  }
  // 收藏临时词本(FAVORITE)与自建词本(NOTEPAD)都可作为收藏目标
  return all.filter((n) => n.type === "FAVORITE" || n.type === "NOTEPAD");
}

// ---------- 获取收藏词本 ----------
// prefId: 用户当前选择的云词库 id（含“我的收藏”/自建词库）；未指定或失效时回退第一个云词库
async function maimemoGetFavorite(token, prefId) {
  const all = await maimemoListCloudNotepads(token);
  let target = null;
  if (prefId) target = all.find((n) => n.id === prefId) || null;
  if (!target) target = all.find((n) => n.type === "FAVORITE") || null; // 默认优先“我的收藏”
  if (!target && all.length) target = all[0];
  if (target) {
    return maimemoGetNotepad(target.id, token);
  }
  // 创建收藏词本（FAVORITE）
  const data = await maimemoFetch("/notepads", {
    method: "POST",
    body: {
      notepad: { title: "我的收藏", brief: "MyMaimemo 自动收藏", content: "", tags: [], status: "PUBLISHED" },
    },
    token,
  });
  return data.notepad || null;
}

// ---------- 读取词本 ----------
async function maimemoGetNotepad(id, token) {
  const data = await maimemoFetch(`/notepads/${id}`, { token });
  return data.notepad || null;
}

// ---------- 更新词本 ----------
async function maimemoUpdateNotepad(id, notepad, token) {
  const data = await maimemoFetch(`/notepads/${id}`, {
    method: "POST",
    body: { notepad },
    token,
  });
  return data.notepad || null;
}

// ---------- 追加单词到收藏词本 ----------
async function maimemoAddWordToFavorite(notepad, word, token) {
  if (!notepad) throw new Error("无收藏词本");
  const list = notepad.list || [];
  const inFav = list.some(
    (it) => (it.type === "WORD" || it.type === "DRAFT_WORD") && it.word === word
  );
  if (inFav) return notepad; // 已存在
  const content = ((notepad.content || "").trim() ? notepad.content.trim() + "\n" : "") + word;
  return maimemoUpdateNotepad(notepad.id, {
    title: notepad.title,
    brief: notepad.brief || "",
    content,
    tags: Array.isArray(notepad.tags) ? notepad.tags : ["我的收藏"],
    status: notepad.status || "PUBLISHED",
  }, token);
}

// ---------- 学习记录查询（学习数据页） ----------
async function maimemoQueryStudyRecords(token, body = {}) {
  const data = await maimemoFetch("/study/query_study_records", {
    method: "POST",
    body,
    token,
  });
  return data || { records: [], count: 0 };
}

// ---------- 分页拉取全部学习记录 ----------
// 接口特性（实测）：仅支持 next_study_date 过滤（start/end，均含边界），
// 默认按加入时间排序、无 offset、单页上限 1000。
// 策略：累计计数 + 二分定位窗口边界，保证每个窗口 (prevEnd, end] 内记录数 ≤ 1000，
// 从而一次拉取即可完整取走该窗口全部记录，无遗漏、无重复。
async function maimemoFetchAllStudyRecords(token, onProgress) {
  const DAY = 86400000;
  const addDays = (s, n) => {
    const [y, m, d] = s.split("-").map(Number);
    return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
  };
  const dayDiff = (a, b) => {
    const pa = a.split("-").map(Number), pb = b.split("-").map(Number);
    return Math.round((Date.UTC(pa[0], pa[1] - 1, pa[2]) - Date.UTC(pb[0], pb[1] - 1, pb[2])) / DAY);
  };
  const fmtEnd = (d) => `${d}T23:59:59+08:00`;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  const first = await maimemoQueryStudyRecords(token, { as_count: true });
  const total = first.count || 0;
  const all = [];
  const seen = new Set();
  const add = (recs) => {
    for (const r of recs) {
      if (r.voc_id && !seen.has(r.voc_id)) { seen.add(r.voc_id); all.push(r); }
    }
  };
  if (!total) return all;

  // 今天（北京时区）
  const u = new Date(new Date().getTime() + 8 * 3600 * 1000);
  const today = u.toISOString().slice(0, 10);
  const HI = "2126-12-31"; // 哨兵日期簇之外足够远的上限

  const countEnd = async (dStr) => {
    await sleep(300);
    const d = await maimemoQueryStudyRecords(token, {
      next_study_date: { end: fmtEnd(dStr) }, as_count: true,
    });
    return d.count || 0;
  };

  let prevEnd = null, prevC = 0, end = today;
  for (let guard = 0; guard < 60; guard++) {
    let c = await countEnd(end);
    let win = c - prevC;
    if (win > 1000) {
      // 二分收缩：找最大的 end，使 (prevEnd, end] 内记录数 ≤ 1000
      let lo = prevEnd || "2000-01-01", hi = end;
      while (true) {
        const span = dayDiff(hi, lo);
        if (span <= 1) break;
        const mid = addDays(lo, Math.floor(span / 2));
        const cm = await countEnd(mid);
        if (cm - prevC > 1000) hi = mid; else lo = mid;
      }
      end = lo;
      c = await countEnd(end);
      win = c - prevC;
    }
    // 拉取 (prevEnd, end]
    const body = { limit: 1000, next_study_date: { end: fmtEnd(end) } };
    // start 取 prevEnd 当天 23:59:59+08:00（含边界，靠 voc_id 去重兜底），避免窗口间漏记录
    if (prevEnd) body.next_study_date.start = fmtEnd(prevEnd);
    await sleep(300);
    const d = await maimemoQueryStudyRecords(token, body);
    add(d.records || []);
    if (onProgress) onProgress(all.length, total);
    if (c >= total) break;
    if (prevEnd && end === prevEnd) break; // 窗口无法前进，防死循环
    const span = prevEnd ? dayDiff(end, prevEnd) : 0;
    const dens = win / Math.max(span, 1);
    const step = win <= 0 ? 1825 : Math.max(1, Math.round(700 / Math.max(dens, 1e-9)));
    prevEnd = end; prevC = c;
    end = addDays(end, step);
    if (end > HI) end = HI;
  }
  return all;
}
