// dict.js — 第三方免费词典（有道为主：中文释义 + 音标 + 中英双语例句）
// 兜底：dictionaryapi.dev（仅当有道无结果时，返回英文释义）
// 用户输入英文时，默认只显示中文释义，不显示英文释义

const YOUDAO_API = "https://dict.youdao.com/jsonapi?q=";
const DICT_API = "https://api.dictionaryapi.dev/api/v2/entries/en/";

// ---------- 有道：中文释义 + 音标 + 双语例句 ----------
function parseYoudao(j, word) {
  const ec = (j && j.ec) || {};
  const words = (ec.word || []).filter((w) => w && typeof w === "object");
  if (!words.length) return null;

  const w = words[0];
  const phonetic = (w.ukphone || w.usphone || "").trim();

  const items = [];
  (w.trs || []).forEach((t) => {
    (t.tr || []).forEach((tr) => {
      const arr = (tr.l && tr.l.i) || [];
      arr.forEach((raw) => {
        // raw 形如 "v. 抛弃，遗弃；..." 或 "n. 放任，放纵"
        const m = String(raw).match(/^\s*([a-zA-Z]+)[.\uFF0E\u3002]?\s*(.+)$/);
        items.push({
          pos: m ? m[1] : "",
          zh: m ? m[2].trim() : String(raw).trim(),
        });
      });
    });
  });

  // 双语例句（去重，最多 2 条，去掉 <b> 标签）
  const examples = [];
  const blng = (j && j.blng_sents_part) || {};
  const pairs = (blng["sentence-pair"] || []).slice(0, 4);
  pairs.forEach((p) => {
    const en = String((p["sentence-eng"] || p.sentence || "") || "")
      .replace(/<[^>]+>/g, "")
      .trim();
    const cn = String((p["sentence-translation"] || "") || "")
      .replace(/<[^>]+>/g, "")
      .trim();
    if (en && !examples.some((e) => e.en === en)) {
      examples.push({ en, cn });
    }
  });

  if (!items.length && !examples.length && !phonetic) return null;
  return { phonetic, items, examples };
}

// ---------- dictionaryapi：兜底英文 ----------
function parseEnglish(d, word) {
  if (!Array.isArray(d) || !d.length) return null;
  const first = d[0];

  let phonetic = first.phonetic || "";
  if (!phonetic) {
    const withText = (first.phonetics || []).find((p) => p.text);
    phonetic = withText ? withText.text : "";
  }
  phonetic = phonetic.replace(/\//g, "").trim();

  const items = [];
  (first.meanings || []).forEach((m) => {
    (m.definitions || []).forEach((df) => {
      items.push({
        pos: m.partOfSpeech || "",
        zh: df.definition || "",
      });
    });
  });
  if (!items.length && !phonetic) return null;
  return { phonetic, items, examples: [] };
}

// ---------- 查询：有道为主，英文兜底 ----------
async function DictLookup(word) {
  const w = word.toLowerCase().trim();
  let zh = null;
  let en = null;

  // 1) 有道（中文释义 + 双语例句）
  try {
    const res = await fetch(`${YOUDAO_API}${encodeURIComponent(w)}`, {
      headers: { Referer: "https://dict.youdao.com/" },
    });
    if (res.ok) {
      const j = await res.json();
      zh = parseYoudao(j, w);
    }
  } catch (e) {
    console.warn("youdao failed", e);
  }

  // 2) dictionaryapi（兜底）
  if (!zh) {
    try {
      const res = await fetch(`${DICT_API}${encodeURIComponent(w)}`);
      if (res.ok) {
        const j = await res.json();
        en = parseEnglish(j, w);
      }
    } catch (e) {
      console.warn("dictapi failed", e);
    }
  }

  const result = zh || en;
  if (!result || (!result.items.length && !result.examples.length)) {
    throw new Error("词典中未收录该单词");
  }

  return {
    word: w,
    phonetic: (zh && zh.phonetic) || (en && en.phonetic) || "",
    items: result.items || [],
    examples: result.examples || [],
  };
}
