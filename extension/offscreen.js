// Records tab audio + microphone. Lives as long as a recording (or a failed upload) exists.
let recorder = null;
let chunks = [];
let streams = [];
let ctx = null;
let blob = null;

function stopStreams() {
  streams.flatMap((s) => s.getTracks()).forEach((t) => t.stop());
  streams = [];
  ctx?.close().catch(() => {});
  ctx = null;
}

async function start(streamId) {
  const tab = await navigator.mediaDevices.getUserMedia({
    audio: { mandatory: { chromeMediaSource: "tab", chromeMediaSourceId: streamId } },
    video: false,
  });
  streams = [tab];
  ctx = new AudioContext();
  const destination = ctx.createMediaStreamDestination();
  const tabSource = ctx.createMediaStreamSource(tab);
  tabSource.connect(destination);
  tabSource.connect(ctx.destination); // capturing mutes the tab; play it back so the call stays audible

  // A suspended AudioContext silently records nothing; make sure it runs.
  if (ctx.state !== "running") await ctx.resume().catch(() => {});

  let micWarning = "";
  try {
    const mic = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    });
    streams.push(mic);
    ctx.createMediaStreamSource(mic).connect(destination);
  } catch {
    micWarning = "Микрофон не разрешён — пишется только звук вкладки.";
  }

  tab.getAudioTracks()[0].addEventListener("ended", () => {
    chrome.runtime.sendMessage({ target: "background", type: "tab-ended" });
  });

  chunks = [];
  blob = null;
  // If the context still isn't running, record the tab stream directly (without the microphone)
  // rather than a silent mix.
  const mixOk = ctx.state === "running";
  if (!mixOk) micWarning = "Микрофон не подмешан (браузер не дал обработать звук) — пишется только вкладка.";
  recorder = new MediaRecorder(mixOk ? destination.stream : tab, { mimeType: "audio/webm;codecs=opus", audioBitsPerSecond: 64000 });
  recorder.ondataavailable = (e) => e.data.size && chunks.push(e.data);
  recorder.start(5000);
  return { ok: true, micWarning };
}

function stopRecorder() {
  return new Promise((resolve) => {
    if (!recorder || recorder.state === "inactive") return resolve();
    recorder.onstop = () => resolve();
    recorder.stop();
  });
}

async function upload(server, meta) {
  const base = server.url.replace(/\/+$/, "");
  const headers = { "Content-Type": blob.type || "audio/webm" };
  if (server.password) headers.Authorization = `Basic ${btoa(unescape(encodeURIComponent(`voicenotes:${server.password}`)))}`;
  const params = new URLSearchParams({ title: meta.title, recordedAt: meta.recordedAt, filename: "tab.webm" });

  const res = await fetch(`${base}/api/meetings?${params}`, { method: "POST", headers, body: blob });
  if (res.status === 401) throw new Error("Неверный пароль (проверь настройки расширения)");
  const body = await res.json().catch(() => null);
  if (!res.ok) throw new Error(body?.error || `Сервер ответил ${res.status}`);

  if (meta.notes.trim()) {
    await fetch(`${base}/api/meetings/${body.id}`, {
      method: "PATCH",
      headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify({ userNotes: meta.notes }),
    }).catch(() => {});
  }
  return `${base}/#/m/${body.id}`;
}

async function uploadAndReport(server, meta) {
  try {
    const url = await upload(server, meta);
    blob = null;
    chrome.runtime.sendMessage({ target: "background", type: "uploaded", url });
  } catch (err) {
    const message = err instanceof TypeError ? "Нет связи с сервером" : err.message;
    chrome.runtime.sendMessage({ target: "background", type: "failed", error: message });
  }
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.target !== "offscreen") return;
  if (msg.type === "start") {
    start(msg.streamId).then(sendResponse, (err) => {
      stopStreams();
      sendResponse({ ok: false, error: err.message });
    });
    return true;
  }
  if (msg.type === "stop") {
    (async () => {
      await stopRecorder();
      stopStreams();
      blob = new Blob(chunks, { type: "audio/webm" });
      chunks = [];
      await uploadAndReport(msg.server, msg.meta);
    })();
  }
  if (msg.type === "upload" && blob) {
    uploadAndReport(msg.server, msg.meta);
  }
});
