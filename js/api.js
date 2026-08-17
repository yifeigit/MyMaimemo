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
