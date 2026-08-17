// background.js — 工具栏图标点击 → 转发给当前标签页的 content script
// 点击工具栏图标弹出「启用状态面板」（扩展是否启用 / 当前窗口是否启用）。
// 面板主体为「网页内浮层」（content.js 注入），以支持开关动画、拖动、缩放、位置记忆。
chrome.action.onClicked.addListener(async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab || tab.id == null) return;
  try {
    await chrome.tabs.sendMessage(tab.id, { action: "showStatus" });
  } catch (e) {
    // content script 未注入（如 chrome:// 内部页、PDF 查看器等）时静默忽略
  }
});
