// llm.js — 兼容 OpenAI Chat Completions 的 LLM 调用
// 支持预设：DeepSeek、智谱 GLM；自定义(OpenAI 兼容)：可填任意 baseUrl+model
// 适用于 小米 memo、opencode go 等一切 OpenAI 兼容接口

const LLM_PRESETS = {
  deepseek: {
    label: "DeepSeek",
    baseUrl: "https://api.deepseek.com",
    model: "deepseek-v4-flash",
    hint: "DeepSeek 官方 API（V4 Flash，已关闭思考模式）",
  },
  glm: {
    label: "智谱 GLM",
    baseUrl: "https://open.bigmodel.cn/api/paas/v4",
    model: "glm-4-flash",
    hint: "智谱开放平台",
  },
  mimo: {
    label: "小米 memo (MiMo)",
    baseUrl: "https://api.xiaomimimo.com/v1",
    model: "mimo-v2-flash",
    hint: "米墨 MiMo 开放平台，兼容 OpenAI",
  },
  opencodego: {
    label: "opencode go",
    baseUrl: "https://opencode.ai/zen/go/v1",
    model: "glm-5.2",
    hint: "opencode go 低价订阅，选 OpenAI 兼容模型",
  },
  custom: {
    label: "自定义 (OpenAI 兼容)",
    baseUrl: "",
    model: "",
    hint: "可填任意兼容接口的 Base URL 与模型名",
  },
};

// 从 settings 解析出可用的 LLM 配置
// 注意：非 custom 预设也允许用户覆盖 URL/模型（设置里已保存的值优先）
function resolveLLM(settings) {
  const provider = settings.llmProvider || "deepseek";
  const key = (settings.llmKey || "").trim();
  if (!key) return null;

  const preset = LLM_PRESETS[provider] || LLM_PRESETS.deepseek;
  const baseUrl = (settings.llmBaseUrl || "").trim() || preset.baseUrl;
  const model = (settings.llmModel || "").trim() || preset.model;
  if (!baseUrl || !model) return null;
  return { baseUrl, model, key };
}

// 通用 chat 调用
async function chat(settings, messages, { maxTokens = 500 } = {}) {
  const cfg = resolveLLM(settings);
  if (!cfg) {
    throw new Error("LLM 未配置或 Key 缺失");
  }
  // 兼容两种填法：完整端点（已含 /chat/completions）或前缀（如 .../v1）
  let url = cfg.baseUrl.trim();
  if (!/\/chat\/completions$/i.test(url)) {
    url = url.replace(/\/+$/, "") + "/chat/completions";
  }
  // 请求体
  const body = {
    model: cfg.model,
    messages,
    temperature: 0.7,
    max_tokens: maxTokens,
    // DeepSeek 等新版兼容 max_completion_tokens
    max_completion_tokens: maxTokens,
  };
  // DeepSeek V4 系列默认开启思考模式（返回 reasoning_content 思考过程）。
  // 本插件只需要正文输出，显式关闭思考，避免思考内容混入结果。
  if (/deepseek/i.test(cfg.model)) {
    body.thinking = { type: "disabled" };
  }
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${cfg.key}`,
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    let msg = `HTTP ${res.status}`;
    try {
      const j = await res.json();
      msg = j.error?.message || j.message || msg;
    } catch (e) {}
    throw new Error(`LLM 请求失败：${msg}`);
  }
  const data = await res.json();
  const choice = data.choices?.[0] || {};
  const message = choice.message || {};
  // 只取正式输出 content。reasoning_content 是模型思考过程，绝不作为正文返回。
  let text = message.content || "";
  if (!text && Array.isArray(message.content) && message.content.length) {
    // OpenAI 多模态返回数组格式
    text = message.content
      .map((c) => (typeof c === "string" ? c : c.text || ""))
      .join("");
  }
  if (!text) {
    // 给出更具体的错误，便于排查（不含原始内容，只含结构提示）
    const hasChoices = Array.isArray(data.choices);
    const keys = message ? Object.keys(message).join(",") : "无";
    const finish = choice.finish_reason || "未知";
    throw new Error(
      `LLM 返回为空（choices=${hasChoices ? data.choices.length : 0}，finish=${finish}，message字段=${keys}）`
    );
  }
  return text.trim();
}

// ---------- AI 释义（四行格式） ----------
async function aiDefinition(settings, word) {
  const prompt =
    `你是专业的英语教师。请为单词「${word}」输出以下固定四行格式（每行以对应前缀开头，冒号后接内容）：\n` +
    `音标：\n中文释义：\n英文释义：\n例句：\n` +
    `要求：音标用斜杠包裹如 /faɪn/；中文释义简洁准确；英文释义用简单英语；例句为1句地道的英文例句。只输出这四行，不要多余解释，不要任何思考过程。`;
  const text = await chat(settings, [{ role: "user", content: prompt }], {
    maxTokens: 400,
  });
  return parseFourLines(text);
}

// 把四行文本解析为对象，并识别哪些是我们查词的词（供加粗渲染）
function parseFourLines(text) {
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const result = { phonetic: "", cn: "", en: "", example: "" };
  for (const line of lines) {
    if (/^音标[:：]/.test(line)) result.phonetic = line.replace(/^音标[:：]/g, "").trim();
    else if (/^中文释义[:：]/.test(line)) result.cn = line.replace(/^中文释义[:：]/g, "").trim();
    else if (/^英文释义[:：]/.test(line)) result.en = line.replace(/^英文释义[:：]/g, "").trim();
    else if (/^例句[:：]/.test(line)) result.example = line.replace(/^例句[:：]/g, "").trim();
    else if (/^phonetic[:：]/i.test(line)) result.phonetic = line.replace(/^phonetic[:：]/gi, "").trim();
    else if (/^cn[:：]/i.test(line)) result.cn = line.replace(/^cn[:：]/gi, "").trim();
    else if (/^en[:：]/i.test(line)) result.en = line.replace(/^en[:：]/gi, "").trim();
    else if (/^example[:：]/i.test(line)) result.example = line.replace(/^example[:：]/gi, "").trim();
  }
  return result;
}

// ---------- 单词小文章（逐句中英对照，背过的词高亮） ----------
async function aiStory(settings, words, { highlight } = {}) {
  const wordList = words.join("、");
  const hlList = (highlight && highlight.length ? highlight : words)
    .map((w) => `「${w}」`)
    .join(" ");
  const prompt =
    `你是一位英语写作教练兼讲故事高手。请用给定单词创作一个连贯自然、有趣的小故事。\n` +
    `\n` +
    `【最重要的一条】你的输出必须 ONLY 是故事正文的 <line> 内容，除此之外什么都不要输出：\n` +
    `- 不要任何开场白、寒暄、解释，例如"好的""以下是故事""我来创作"等一律禁止；\n` +
    `- 不要任何思考过程、内心独白、推理说明；\n` +
    `- 不要标题、不要小标题、不要序号、不要列表；\n` +
    `- 不要结尾总结、不要"希望你喜欢"之类的话；\n` +
    `- 你的回答从第一个 <line> 开始，到最后一个 </line> 结束，中间没有其他文字。\n` +
    `\n` +
    `一、故事要求：\n` +
    `1. 故事长度不限，围绕一个完整小情节展开，有开头、发展、结尾，读起来像真实英文短文，不堆砌单词；内容完整后自然收尾即可。\n` +
    `2. 必须用上所有单词：${wordList}\n` +
    `3. 背诵重点词：${hlList}。这些词在英文句中出现时用 **双星号** 包裹（如 He showed great **courage**.），其余英文单词不包裹；对应的中文翻译里，表示这些词的对应中文词也要用 **双星号** 包裹（如 “他展现了巨大的**勇气**.”），其余中文词不包裹。\n` +
    `\n` +
    `二、输出格式（每个句子一对）：\n` +
    `<line>\n<en>英文句子（含**背诵词**）</en>\n<zh>该句地道的中文翻译（含对应**中文词**）</zh>\n</line>\n` +
    `<line>\n<en>英文句子2</en>\n<zh>中文翻译2</zh>\n</line>\n` +
    `有多少句就输出多少个 <line> 块，数量不限，但必须一句英文配一句中文，句子间顺序不乱。\n` +
    `\n` +
    `三、中文翻译要求：自然地道、不逐字直译。`;
  const text = await chat(settings, [{ role: "user", content: prompt }], {
    maxTokens: 1600,
  });
  return text.trim();
}
