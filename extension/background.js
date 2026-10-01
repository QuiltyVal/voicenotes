// Service worker: keeps recording state, talks to the offscreen document that records.
// Recording itself must live in an offscreen document: service workers have no MediaRecorder.

const OFFSCREEN = "offscreen.html";

async function getState() {
  const { rec } = await chrome.storage.session.get("rec");
  return rec ?? { status: "idle" };
}

async function setState(rec) {
  await chrome.storage.session.set({ rec });
  const busy = rec.status === "recording" || rec.status === "uploading";
  await chrome.action.setBadgeText({ text: rec.status === "recording" ? "REC" : rec.status === "uploading" ? "↑" : "" });
  if (busy) await chrome.action.setBadgeBackgroundColor({ color: rec.status === "recording" ? "#e11d48" : "#4f46e5" });
}

async function ensureOffscreen() {
  const existing = await chrome.runtime.getContexts({ contextTypes: ["OFFSCREEN_DOCUMENT"] });
  if (existing.length) return;
  await chrome.offscreen.createDocument({
    url: OFFSCREEN,
    reasons: ["USER_MEDIA"],
    justification: "Записывает звук вкладки и микрофон",
  });
}

async function closeOffscreen() {
  const existing = await chrome.runtime.getContexts({ contextTypes: ["OFFSCREEN_DOCUMENT"] });
  if (existing.length) await chrome.offscreen.closeDocument();
}

async function start(tabId) {
  const state = await getState();
  if (state.status === "recording" || state.status === "uploading") throw new Error("Уже идёт запись");
  if (state.status === "failed") throw new Error("Сначала загрузи или удали прошлую запись");
  const { server } = await chrome.storage.local.get("server");
  if (!server?.url) throw new Error("Сначала укажи адрес сервера в настройках");

  const streamId = await chrome.tabCapture.getMediaStreamId({ targetTabId: tabId });
  await ensureOffscreen();
  const reply = await chrome.runtime.sendMessage({ target: "offscreen", type: "start", streamId });
  if (!reply?.ok) {
    await closeOffscreen();
    throw new Error(reply?.error || "Не удалось начать запись");
  }
  const tab = await chrome.tabs.get(tabId);
  await setState({ status: "recording", startedAt: Date.now(), tabTitle: tab.title ?? "", micWarning: reply.micWarning ?? "" });
}

async function stop() {
  const state = await getState();
  if (state.status !== "recording") return;
  const { server, notes, title } = await chrome.storage.local.get(["server", "notes", "title"]);
  await setState({ ...state, status: "uploading" });
  chrome.runtime.sendMessage({
    target: "offscreen",
    type: "stop",
    server,
    meta: {
      title: title || "",
      notes: notes || "",
      recordedAt: new Date(state.startedAt).toISOString(),
    },
  });
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.target !== "background") return;
  (async () => {
    try {
      if (msg.type === "start") {
        await start(msg.tabId);
        sendResponse({ ok: true });
      } else if (msg.type === "stop") {
        await stop();
        sendResponse({ ok: true });
      } else if (msg.type === "uploaded") {
        await chrome.storage.local.remove(["notes", "title"]);
        await setState({ status: "idle", lastMeetingUrl: msg.url });
        await closeOffscreen();
        chrome.tabs.create({ url: msg.url });
      } else if (msg.type === "failed") {
        // Keep the offscreen document: it still holds the recording for a retry.
        const state = await getState();
        await setState({ ...state, status: "failed", error: msg.error });
      } else if (msg.type === "retry") {
        const state = await getState();
        const { server, notes, title } = await chrome.storage.local.get(["server", "notes", "title"]);
        await setState({ ...state, status: "uploading", error: "" });
        chrome.runtime.sendMessage({
          target: "offscreen",
          type: "upload",
          server,
          meta: { title: title || "", notes: notes || "", recordedAt: new Date(state.startedAt).toISOString() },
        });
        sendResponse({ ok: true });
      } else if (msg.type === "discard") {
        await setState({ status: "idle" });
        await closeOffscreen();
        sendResponse({ ok: true });
      } else if (msg.type === "tab-ended") {
        await stop();
      }
    } catch (err) {
      sendResponse({ ok: false, error: err.message });
    }
  })();
  return true;
});
