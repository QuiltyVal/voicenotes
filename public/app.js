// Voicenotes front end: records meetings in the browser, uploads them, shows notes.
// Plain ES module, no build step.

const app = document.getElementById("app");
const bannersEl = document.getElementById("banners");

// ---------------------------------------------------------------- helpers

/** Flattens children and drops null/false/"" so `cond && node` can be used inline. */
function nodes(...children) {
  return children
    .flat(Infinity)
    .filter((c) => c != null && c !== false && c !== "")
    .map((c) => (c instanceof Node ? c : String(c)));
}

function h(tag, props, ...children) {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(props ?? {})) {
    if (value == null || value === false) continue;
    if (key.startsWith("on") && typeof value === "function") el.addEventListener(key.slice(2).toLowerCase(), value);
    else if (key === "class") el.className = value;
    else if (key === "value" || key === "checked") el[key] = value;
    else el.setAttribute(key, value === true ? "" : value);
  }
  el.append(...nodes(children));
  return el;
}

function fill(el, ...children) {
  el.replaceChildren(...nodes(children));
}

function pad(n) {
  return String(n).padStart(2, "0");
}

function fmtClock(ms) {
  const s = Math.floor(ms / 1000);
  const hours = Math.floor(s / 3600);
  return `${hours ? `${hours}:` : ""}${pad(Math.floor((s % 3600) / 60))}:${pad(s % 60)}`;
}

function fmtTs(sec) {
  const s = Math.max(0, Math.floor(sec));
  return `${pad(Math.floor(s / 3600))}:${pad(Math.floor((s % 3600) / 60))}:${pad(s % 60)}`;
}

function parseTs(text) {
  const parts = String(text).match(/\d+/g)?.map(Number) ?? [];
  return parts.reduce((acc, n) => acc * 60 + n, 0);
}

function fmtMinutes(sec) {
  if (!sec) return "";
  const min = Math.max(1, Math.round(sec / 60));
  return min >= 60 ? `${Math.floor(min / 60)} ч ${min % 60} мин` : `${min} мин`;
}

function fmtDate(iso) {
  return new Date(iso).toLocaleString("ru-RU", {
    day: "numeric",
    month: "long",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function toast(message) {
  const el = h("div", { class: "toast", role: "status" }, message);
  document.body.append(el);
  setTimeout(() => el.remove(), 2600);
}

async function api(path, options = {}) {
  const res = await fetch(path, {
    ...options,
    headers: options.body ? { "Content-Type": "application/json", ...options.headers } : options.headers,
  });
  if (res.status === 204) return null;
  const body = await res.json().catch(() => null);
  if (!res.ok) throw new Error(body?.error || `Ошибка ${res.status}`);
  return body;
}

const STATUS = {
  uploaded: { text: "В очереди", cls: "busy", long: "В очереди на обработку…" },
  transcribing: { text: "Расшифровка", cls: "busy", long: "Расшифровываю речь… Час записи обычно занимает пару минут." },
  structuring: { text: "Конспект", cls: "busy", long: "Составляю конспект…" },
  done: { text: "Готово", cls: "done" },
  error: { text: "Ошибка", cls: "error" },
};
const isBusy = (status) => status === "uploaded" || status === "transcribing" || status === "structuring";

function statusBadge(status) {
  const s = STATUS[status] ?? { text: status, cls: "" };
  return h("span", { class: `badge ${s.cls}` }, isBusy(status) && h("span", { class: "spinner" }), s.text);
}

function speakerName(label, speakers) {
  return speakers?.[label]?.trim() || `Спикер ${label.replace(/^S/, "")}`;
}

function speakerClass(label) {
  return `spk-${(Number(label.replace(/\D/g, "")) - 1 + 6) % 6}`;
}

// ---------------------------------------------------------------- settings

const SETTINGS_KEY = "voicenotes.settings";
const settings = { notesLanguage: "ru", language: "", glossary: "", mode: "mic" };
let serverStatus = null;

try {
  Object.assign(settings, JSON.parse(localStorage.getItem(SETTINGS_KEY) ?? "{}"));
} catch {
  // Private mode or corrupted value: defaults are fine.
}

function saveSettings() {
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
  } catch {
    // Not persisted; still applies for this session.
  }
}

const settingsDialog = document.getElementById("settings");
document.getElementById("settings-btn").addEventListener("click", () => {
  const form = settingsDialog.querySelector("form");
  form.notesLanguage.value = settings.notesLanguage;
  form.language.value = settings.language;
  form.glossary.value = settings.glossary;
  document.getElementById("settings-models").textContent = serverStatus
    ? `Расшифровка: ${serverStatus.transcriptionModel ?? "не настроена"} · Конспект: ${serverStatus.claudeModel}`
    : "";
  settingsDialog.showModal();
});
settingsDialog.addEventListener("close", () => {
  if (settingsDialog.returnValue !== "save") return;
  const form = settingsDialog.querySelector("form");
  settings.notesLanguage = form.notesLanguage.value;
  settings.language = form.language.value;
  settings.glossary = form.glossary.value;
  saveSettings();
  toast("Настройки сохранены");
});

// ---------------------------------------------------------------- IndexedDB: unsent recordings
// Every 5 s of audio is written to IndexedDB, so a crash, closed tab or failed upload
// never loses a meeting. Entries are removed only after a successful upload.

let dbPromise;

function openDb() {
  dbPromise ??= new Promise((resolve, reject) => {
    const req = indexedDB.open("voicenotes", 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      db.createObjectStore("recordings", { keyPath: "id" });
      db.createObjectStore("chunks", { autoIncrement: true }).createIndex("recId", "recId");
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

function requestDone(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function safeDb(fn, fallback) {
  try {
    return await fn(await openDb());
  } catch (err) {
    console.warn("IndexedDB unavailable", err);
    return fallback;
  }
}

const localRecordings = {
  put: (meta) => safeDb((db) => requestDone(db.transaction("recordings", "readwrite").objectStore("recordings").put(meta))),
  addChunk: (recId, seq, blob) =>
    safeDb((db) => requestDone(db.transaction("chunks", "readwrite").objectStore("chunks").add({ recId, seq, blob }))),
  list: () => safeDb((db) => requestDone(db.transaction("recordings").objectStore("recordings").getAll()), []),
  async blob(meta) {
    const rows = await safeDb(
      (db) => requestDone(db.transaction("chunks").objectStore("chunks").index("recId").getAll(meta.id)),
      [],
    );
    rows.sort((a, b) => a.seq - b.seq);
    return new Blob(rows.map((r) => r.blob), { type: meta.mime });
  },
  remove: (recId) =>
    safeDb(
      (db) =>
        new Promise((resolve, reject) => {
          const tx = db.transaction(["recordings", "chunks"], "readwrite");
          tx.objectStore("recordings").delete(recId);
          const cursorReq = tx.objectStore("chunks").index("recId").openKeyCursor(IDBKeyRange.only(recId));
          cursorReq.onsuccess = () => {
            const cursor = cursorReq.result;
            if (!cursor) return;
            tx.objectStore("chunks").delete(cursor.primaryKey);
            cursor.continue();
          };
          tx.oncomplete = () => resolve();
          tx.onerror = () => reject(tx.error);
        }),
    ),
};

// ---------------------------------------------------------------- upload

function uploadBlob(blob, params, onProgress) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", `/api/meetings?${new URLSearchParams(params)}`);
    xhr.setRequestHeader("Content-Type", blob.type || "application/octet-stream");
    xhr.upload.onprogress = (e) => e.lengthComputable && onProgress?.(e.loaded / e.total);
    xhr.onload = () => {
      let body = null;
      try {
        body = JSON.parse(xhr.responseText);
      } catch {
        // Non-JSON error page.
      }
      if (xhr.status === 201) resolve(body);
      else reject(new Error(body?.error || `Ошибка загрузки (${xhr.status})`));
    };
    xhr.onerror = () => reject(new Error("Нет связи с сервером"));
    xhr.send(blob);
  });
}

function uploadParams(meta, extra = {}) {
  return {
    title: meta.title ?? "",
    context: meta.context ?? "",
    language: meta.settings?.language ?? settings.language,
    notesLanguage: meta.settings?.notesLanguage ?? settings.notesLanguage,
    glossary: meta.settings?.glossary ?? settings.glossary,
    recordedAt: meta.startedAt ?? new Date().toISOString(),
    ...extra,
  };
}

// ---------------------------------------------------------------- recorder

const rec = {
  state: "idle", // idle | starting | recording | paused | uploading
  title: "",
  context: "",
  warning: "",
  progress: 0,
  media: null,
  ctx: null,
  analyser: null,
  streams: [],
  chunks: [],
  seq: 0,
  meta: null,
  elapsed: 0,
  resumedAt: 0,
  ticker: null,
  wakeLock: null,
  lastFailed: null, // { meta, blob } kept in memory in case IndexedDB is unavailable
};

const canCaptureTab = Boolean(navigator.mediaDevices?.getDisplayMedia) && !/Android|iPhone|iPad/i.test(navigator.userAgent);
if (!canCaptureTab) settings.mode = "mic";

function elapsedMs() {
  return rec.elapsed + (rec.state === "recording" ? performance.now() - rec.resumedAt : 0);
}

function friendlyError(err) {
  if (err?.name === "NotAllowedError") {
    return settings.mode === "mix"
      ? "Нет доступа: разреши микрофон и выбери вкладку или экран для захвата звука."
      : "Нет доступа к микрофону. Разреши его в настройках браузера для этого сайта.";
  }
  if (err?.name === "NotFoundError") return "Микрофон не найден.";
  if (err?.name === "NotReadableError") return "Микрофон занят другим приложением.";
  return err?.message || String(err);
}

async function acquireWakeLock() {
  try {
    rec.wakeLock = await navigator.wakeLock?.request("screen");
  } catch {
    // Not supported or denied: recording still works, the screen may just turn off.
  }
}

document.addEventListener("visibilitychange", () => {
  const active = rec.state === "recording" || rec.state === "paused";
  if (document.visibilityState === "visible" && active && (!rec.wakeLock || rec.wakeLock.released)) acquireWakeLock();
});

window.addEventListener("beforeunload", (e) => {
  if (rec.state !== "idle") {
    e.preventDefault();
    e.returnValue = "";
  }
});

function startTicker() {
  stopTicker();
  const samples = new Uint8Array(512);
  rec.ticker = setInterval(() => {
    const timer = document.getElementById("rec-timer");
    if (timer) timer.textContent = fmtClock(elapsedMs());
    const meter = document.getElementById("rec-meter");
    if (meter && rec.analyser) {
      rec.analyser.getByteTimeDomainData(samples);
      let sum = 0;
      for (const v of samples) sum += ((v - 128) / 128) ** 2;
      const level = rec.state === "recording" ? Math.min(1, Math.sqrt(sum / samples.length) * 4) : 0;
      meter.style.width = `${Math.round(level * 100)}%`;
    }
  }, 120);
}

function stopTicker() {
  clearInterval(rec.ticker);
  rec.ticker = null;
}

function releaseMedia() {
  stopTicker();
  rec.streams.flatMap((s) => s.getTracks()).forEach((t) => t.stop());
  rec.streams = [];
  rec.ctx?.close().catch(() => {});
  rec.ctx = null;
  rec.analyser = null;
  rec.wakeLock?.release().catch(() => {});
  rec.wakeLock = null;
}

async function startRecording() {
  if (rec.state !== "idle") return;
  // Created synchronously inside the click handler, so the browser lets it run.
  const ctx = new AudioContext();
  const streams = [];
  rec.state = "starting";
  rec.warning = "";
  renderRecorder();

  try {
    let display = null;
    if (settings.mode === "mix") {
      // Ask for the tab/screen first: the browser only allows this right after a click.
      display = await navigator.mediaDevices.getDisplayMedia({
        video: true,
        audio: true,
        systemAudio: "include",
        selfBrowserSurface: "exclude",
      });
      streams.push(display);
      if (!display.getAudioTracks().length) {
        throw new Error(
          "Звук не захвачен. Выбери вкладку созвона и включи «Поделиться звуком вкладки» " +
            "(для всего экрана — «Поделиться системным звуком»).",
        );
      }
    }
    const mic = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    });
    streams.push(mic);

    const analyser = ctx.createAnalyser();
    analyser.fftSize = 1024;
    const micSource = ctx.createMediaStreamSource(mic);
    micSource.connect(analyser);

    let recordStream = mic;
    if (display) {
      // Mix microphone + call audio into one track.
      const destination = ctx.createMediaStreamDestination();
      micSource.connect(destination);
      const callSource = ctx.createMediaStreamSource(new MediaStream(display.getAudioTracks()));
      callSource.connect(destination);
      callSource.connect(analyser);
      recordStream = destination.stream;
      for (const track of display.getTracks()) {
        track.addEventListener("ended", () => {
          if (rec.state === "recording" || rec.state === "paused") {
            rec.warning = "Демонстрация вкладки остановлена — дальше пишется только микрофон.";
            renderRecorder();
          }
        });
      }
    }
    if (ctx.state === "suspended") await ctx.resume().catch(() => {});

    const mimeType =
      ["audio/webm;codecs=opus", "audio/webm", "audio/mp4", "audio/ogg;codecs=opus"].find((t) =>
        MediaRecorder.isTypeSupported(t),
      ) ?? "";
    const media = new MediaRecorder(recordStream, { ...(mimeType && { mimeType }), audioBitsPerSecond: 64000 });

    const startedAt = new Date();
    rec.meta = {
      id: `rec-${startedAt.getTime()}`,
      startedAt: startedAt.toISOString(),
      mime: media.mimeType || mimeType || "audio/webm",
      durationMs: 0,
      title: rec.title,
      context: rec.context,
      settings: { language: settings.language, notesLanguage: settings.notesLanguage, glossary: settings.glossary },
    };
    Object.assign(rec, { media, ctx, analyser, streams, chunks: [], seq: 0, elapsed: 0, resumedAt: performance.now() });

    media.ondataavailable = (e) => {
      if (!e.data?.size) return;
      rec.chunks.push(e.data);
      const meta = rec.meta;
      meta.durationMs = Math.round(elapsedMs());
      localRecordings.addChunk(meta.id, rec.seq++, e.data);
      localRecordings.put({ ...meta, title: rec.title, context: rec.context });
    };
    media.onstop = () => finishRecording();

    await localRecordings.put(rec.meta);
    media.start(5000);
    rec.state = "recording";
    acquireWakeLock();
    startTicker();
  } catch (err) {
    streams.flatMap((s) => s.getTracks()).forEach((t) => t.stop());
    ctx.close().catch(() => {});
    rec.state = "idle";
    rec.warning = friendlyError(err);
  }
  renderRecorder();
  renderBanners();
}

function pauseRecording() {
  if (rec.state !== "recording") return;
  rec.media.pause();
  rec.elapsed += performance.now() - rec.resumedAt;
  rec.state = "paused";
  renderRecorder();
}

function resumeRecording() {
  if (rec.state !== "paused") return;
  rec.media.resume();
  rec.resumedAt = performance.now();
  rec.state = "recording";
  renderRecorder();
}

function stopRecording() {
  if (rec.state !== "recording" && rec.state !== "paused") return;
  rec.elapsed = elapsedMs();
  rec.state = "uploading";
  rec.progress = 0;
  renderRecorder();
  rec.media.stop(); // fires the last dataavailable, then onstop -> finishRecording
}

async function finishRecording() {
  releaseMedia();
  const meta = { ...rec.meta, title: rec.title, context: rec.context, durationMs: Math.round(rec.elapsed) };
  const blob = new Blob(rec.chunks, { type: meta.mime });
  rec.chunks = [];
  await localRecordings.put(meta);
  await uploadRecording(meta, blob);
}

async function uploadRecording(meta, blob) {
  rec.state = "uploading";
  rec.progress = 0;
  renderRecorder();
  try {
    const meeting = await uploadBlob(blob, uploadParams(meta), (p) => {
      rec.progress = p;
      const bar = document.getElementById("upload-bar");
      if (bar) bar.style.width = `${Math.round(p * 100)}%`;
    });
    await localRecordings.remove(meta.id);
    rec.lastFailed = null;
    rec.title = "";
    rec.context = "";
    rec.state = "idle";
    location.hash = `#/m/${meeting.id}`;
  } catch (err) {
    rec.lastFailed = { meta, blob };
    rec.state = "idle";
    rec.warning = `Не удалось загрузить: ${err.message}. Запись сохранена в браузере — можно повторить.`;
    renderRecorder();
  }
  renderBanners();
}

async function uploadFile(file) {
  if (rec.state !== "idle") return;
  rec.warning = "";
  rec.state = "uploading";
  rec.progress = 0;
  rec.elapsed = 0;
  renderRecorder();
  try {
    const meta = {
      title: rec.title,
      context: rec.context,
      startedAt: new Date(file.lastModified || Date.now()).toISOString(),
    };
    const meeting = await uploadBlob(file, uploadParams(meta, { filename: file.name }), (p) => {
      const bar = document.getElementById("upload-bar");
      if (bar) bar.style.width = `${Math.round(p * 100)}%`;
    });
    rec.title = "";
    rec.context = "";
    rec.state = "idle";
    location.hash = `#/m/${meeting.id}`;
  } catch (err) {
    rec.state = "idle";
    rec.warning = `Не удалось загрузить файл: ${err.message}`;
    renderRecorder();
  }
}

function renderRecorder() {
  const card = document.getElementById("recorder");
  if (!card) return;

  const warning = rec.warning && h("div", { class: "banner error", style: "margin:0 0 12px" }, rec.warning);
  const details = h(
    "details",
    { class: "details", open: Boolean(rec.title || rec.context) || undefined },
    h("summary", {}, "Название и контекст (необязательно)"),
    h(
      "label",
      {},
      "Название",
      h("input", {
        type: "text",
        value: rec.title,
        placeholder: "Например: Планёрка с командой",
        onInput: (e) => (rec.title = e.target.value),
      }),
    ),
    h(
      "label",
      {},
      "О чём встреча — поможет точнее составить конспект",
      h("textarea", {
        rows: 2,
        value: rec.context,
        placeholder: "Например: созвон с клиентом про запуск нового сайта",
        onInput: (e) => (rec.context = e.target.value),
      }),
    ),
  );

  if (rec.state === "uploading") {
    fill(card, 
      rec.elapsed > 0 && h("div", { class: "timer" }, fmtClock(rec.elapsed)),
      h("p", { class: "muted" }, "Загружаю запись…"),
      h("div", { class: "progress" }, h("div", { id: "upload-bar", style: `width:${Math.round(rec.progress * 100)}%` })),
    );
    return;
  }

  if (rec.state === "recording" || rec.state === "paused" || rec.state === "starting") {
    const recording = rec.state === "recording";
    fill(card, 
      warning || "",
      h("div", { class: "timer", id: "rec-timer" }, fmtClock(elapsedMs())),
      h("div", { class: "muted" }, rec.state === "starting" ? "Запрашиваю доступ…" : recording ? "Идёт запись" : "Пауза"),
      h("div", { class: "meter" }, h("div", { id: "rec-meter" })),
      h(
        "button",
        {
          class: `rec-button stop ${recording ? "recording" : ""}`,
          title: "Остановить и обработать",
          "aria-label": "Остановить запись",
          disabled: rec.state === "starting",
          onClick: stopRecording,
        },
        h("span", { class: "dot" }),
      ),
      h(
        "div",
        { class: "row", style: "justify-content:center" },
        rec.state !== "starting" &&
          h(
            "button",
            { class: "btn", onClick: recording ? pauseRecording : resumeRecording },
            recording ? "Пауза" : "Продолжить",
          ),
      ),
      settings.mode === "mix" &&
        rec.state !== "starting" &&
        h("p", { class: "muted consent" }, "Можно переключиться на вкладку или приложение созвона — запись продолжится."),
      details,
    );
    return;
  }

  // idle
  const modeButton = (mode, label) =>
    h(
      "button",
      {
        "aria-pressed": String(settings.mode === mode),
        onClick: () => {
          settings.mode = mode;
          saveSettings();
          renderRecorder();
        },
      },
      label,
    );
  const fileInput = h("input", {
    type: "file",
    accept: "audio/*,video/*,.m4a,.mp3,.wav,.webm,.ogg,.mp4,.mov",
    hidden: true,
    onChange: (e) => e.target.files?.[0] && uploadFile(e.target.files[0]),
  });

  fill(card, 
    warning || "",
    rec.lastFailed &&
      h(
        "div",
        { class: "row", style: "justify-content:center;margin-bottom:12px" },
        h("button", { class: "btn primary", onClick: () => uploadRecording(rec.lastFailed.meta, rec.lastFailed.blob) }, "Повторить загрузку"),
      ),
    canCaptureTab &&
      h("div", { class: "segmented", role: "group" }, modeButton("mic", "Вживую"), modeButton("mix", "Онлайн-созвон")),
    h(
      "p",
      { class: "muted mode-hint" },
      settings.mode === "mix"
        ? "Выбери вкладку созвона (Meet, Zoom в браузере) или весь экран и включи «Поделиться звуком». Твой голос пишется с микрофона. Лучше в наушниках — без эха."
        : "Пишет с микрофона. Положи телефон или ноутбук поближе к собеседникам.",
    ),
    h(
      "button",
      { class: "rec-button", title: "Начать запись", "aria-label": "Начать запись", onClick: startRecording },
      h("span", { class: "dot" }),
    ),
    h("div", { class: "muted" }, "Начать запись"),
    details,
    h("p", { class: "muted consent" }, "Перед записью предупреди участников и получи их согласие."),
    h(
      "div",
      { class: "upload-link muted" },
      "или ",
      h("button", { onClick: () => fileInput.click() }, "загрузить готовую запись"),
      fileInput,
    ),
  );
}

// ---------------------------------------------------------------- banners

async function renderBanners() {
  const items = [];
  if (serverStatus && !serverStatus.transcriptionConfigured) {
    items.push(
      h("div", { class: "banner error" }, "Не задан ключ для расшифровки (OPENAI_API_KEY или MISTRAL_API_KEY в .env) — расшифровка не заработает."),
    );
  }
  if (serverStatus && !serverStatus.anthropicConfigured) {
    items.push(h("div", { class: "banner error" }, "На сервере не задан ANTHROPIC_API_KEY — конспекты не заработают. См. README."));
  }
  if ((rec.state === "recording" || rec.state === "paused") && location.hash.startsWith("#/m/")) {
    items.push(
      h("div", { class: "banner" }, h("span", { class: "grow" }, "Идёт запись."), h("a", { class: "btn small", href: "#/" }, "Открыть")),
    );
  }

  const activeId = rec.state !== "idle" ? rec.meta?.id : rec.lastFailed?.meta.id;
  const pending = (await localRecordings.list()).filter((m) => m.id !== activeId);
  for (const meta of pending) {
    const label = h(
      "span",
      { class: "grow" },
      `Незагруженная запись от ${fmtDate(meta.startedAt)}${meta.durationMs ? ` (${fmtClock(meta.durationMs)})` : ""}`,
    );
    const uploadBtn = h(
      "button",
      {
        class: "btn small primary",
        onClick: async () => {
          uploadBtn.disabled = true;
          try {
            const blob = await localRecordings.blob(meta);
            if (!blob.size) throw new Error("Запись пустая");
            const meeting = await uploadBlob(blob, uploadParams(meta), (p) => {
              uploadBtn.textContent = `${Math.round(p * 100)}%`;
            });
            await localRecordings.remove(meta.id);
            location.hash = `#/m/${meeting.id}`;
          } catch (err) {
            toast(err.message);
            uploadBtn.disabled = false;
            uploadBtn.textContent = "Загрузить";
          }
          renderBanners();
        },
      },
      "Загрузить",
    );
    const removeBtn = h(
      "button",
      {
        class: "btn small ghost",
        onClick: async () => {
          if (!confirm("Удалить эту запись безвозвратно?")) return;
          await localRecordings.remove(meta.id);
          renderBanners();
        },
      },
      "Удалить",
    );
    items.push(h("div", { class: "banner" }, label, uploadBtn, removeBtn));
  }
  bannersEl.replaceChildren(...items);
}

// ---------------------------------------------------------------- home

let routeToken = 0;

function renderHome() {
  const token = routeToken;
  const list = h("div", { class: "list" }, h("div", { class: "empty" }, "Загрузка…"));
  app.replaceChildren(
    h("section", { id: "recorder", class: "card recorder" }),
    h("h2", { style: "margin-top:28px" }, "Встречи"),
    list,
  );
  renderRecorder();

  const refresh = async () => {
    if (token !== routeToken) return;
    let meetings;
    try {
      meetings = await api("/api/meetings");
    } catch (err) {
      list.replaceChildren(h("div", { class: "empty" }, `Не удалось загрузить список: ${err.message}`));
      return;
    }
    if (token !== routeToken) return;
    list.replaceChildren(
      ...(meetings.length
        ? meetings.map((m) =>
            h(
              "a",
              { class: "list-item", href: `#/m/${m.id}` },
              h(
                "div",
                {},
                h("div", { class: "title" }, m.title || "Без названия"),
                h("div", { class: "meta" }, [fmtDate(m.createdAt), fmtMinutes(m.durationSec)].filter(Boolean).join(" · ")),
              ),
              statusBadge(m.status),
            ),
          )
        : [h("div", { class: "empty" }, "Пока нет встреч. Нажми красную кнопку, чтобы записать первую.")]),
    );
    if (meetings.some((m) => isBusy(m.status))) setTimeout(refresh, 4000);
  };
  refresh();
}

// ---------------------------------------------------------------- meeting page

const audioCache = new Map();

function audioFor(id) {
  if (!audioCache.has(id)) {
    audioCache.clear();
    audioCache.set(id, h("audio", { controls: true, preload: "metadata", src: `/api/meetings/${id}/audio` }));
  }
  return audioCache.get(id);
}

function seek(audio, seconds) {
  audio.currentTime = seconds;
  audio.play().catch(() => {});
}

function tsButton(audio, seconds) {
  return h("button", { class: "ts", title: "Слушать с этого места", onClick: () => seek(audio, seconds) }, fmtTs(seconds));
}

function mergeTurns(segments, maxTurnSeconds = 90) {
  const turns = [];
  for (const seg of segments) {
    const last = turns.at(-1);
    if (last && last.speaker === seg.speaker && seg.end - last.start <= maxTurnSeconds) {
      last.text += ` ${seg.text}`;
      last.end = seg.end;
    } else {
      turns.push({ ...seg });
    }
  }
  return turns;
}

function speakerLabels(transcript) {
  const num = (label) => Number(label.replace(/\D/g, ""));
  return [...new Set(transcript.segments.map((s) => s.speaker))].sort((a, b) => num(a) - num(b));
}

function ownerName(owner, speakers) {
  return /^S\d+$/.test(owner) ? speakerName(owner, speakers) : owner;
}

function taskKey(id, index) {
  return `voicenotes.task.${id}.${index}`;
}

function renderNotes(meeting, notes, audio) {
  const section = (title, ...content) => h("section", {}, h("h2", {}, title), ...content);
  const bullets = (items) => h("ul", {}, items.map((t) => h("li", {}, t)));
  const participants = notes.participants.map((p) => {
    const name = meeting.speakers[p.speaker]?.trim() || p.name || speakerName(p.speaker);
    return h("li", {}, h("strong", { class: speakerClass(p.speaker) }, name), p.role ? ` — ${p.role}` : "", h("span", { class: "muted" }, ` (${p.speaker})`));
  });

  return h(
    "div",
    { class: "notes" },
    section("Кратко", h("p", { class: "summary" }, notes.summary)),
    notes.decisions.length > 0 && section("Решения", bullets(notes.decisions)),
    notes.action_items.length > 0 &&
      section(
        "Задачи",
        h(
          "ul",
          { class: "tasks" },
          notes.action_items.map((task, i) => {
            let checked = false;
            try {
              checked = localStorage.getItem(taskKey(meeting.id, i)) === "1";
            } catch {}
            return h(
              "li",
              {},
              h("input", {
                type: "checkbox",
                checked,
                "aria-label": "Сделано",
                onChange: (e) => {
                  try {
                    localStorage.setItem(taskKey(meeting.id, i), e.target.checked ? "1" : "0");
                  } catch {}
                },
              }),
              h(
                "div",
                {},
                h("div", {}, task.task),
                (task.owner || task.due) &&
                  h("div", { class: "who" }, [task.owner && ownerName(task.owner, meeting.speakers), task.due && `срок: ${task.due}`].filter(Boolean).join(" · ")),
              ),
            );
          }),
        ),
      ),
    notes.topics.length > 0 &&
      section(
        "Темы",
        notes.topics.map((topic) =>
          h(
            "div",
            { class: "topic" },
            h("h3", {}, topic.start && tsButton(audio, parseTs(topic.start)), topic.title),
            bullets(topic.points),
          ),
        ),
      ),
    notes.open_questions.length > 0 && section("Открытые вопросы", bullets(notes.open_questions)),
    participants.length > 0 && section("Участники", h("ul", {}, participants)),
  );
}

function renderTranscript(meeting, transcript, audio, onSaved) {
  const labels = speakerLabels(transcript);
  const inputs = Object.fromEntries(
    labels.map((label) => [label, h("input", { type: "text", value: meeting.speakers[label] ?? "", placeholder: "Имя" })]),
  );

  const save = async (regenerate) => {
    const speakers = Object.fromEntries(labels.map((l) => [l, inputs[l].value.trim()]));
    try {
      await api(`/api/meetings/${meeting.id}`, { method: "PATCH", body: JSON.stringify({ speakers }) });
      if (regenerate) await api(`/api/meetings/${meeting.id}/regenerate`, { method: "POST" });
      toast(regenerate ? "Пересобираю конспект…" : "Имена сохранены");
      onSaved();
    } catch (err) {
      toast(err.message);
    }
  };

  return h(
    "div",
    {},
    h(
      "details",
      { class: "card", style: "margin-top:0" },
      h("summary", { style: "cursor:pointer;font-weight:600" }, "Кто есть кто"),
      h("p", { class: "muted", style: "font-size:14px" }, "Спикеры размечены автоматически. Впиши имена — они появятся в расшифровке, а при пересборке и в конспекте."),
      h(
        "div",
        { class: "speakers-editor" },
        labels.map((label) => [h("strong", { class: speakerClass(label) }, label), inputs[label]]),
      ),
      h(
        "div",
        { class: "row" },
        h("button", { class: "btn", onClick: () => save(false) }, "Сохранить имена"),
        h("button", { class: "btn primary", onClick: () => save(true), disabled: isBusy(meeting.status) }, "Сохранить и пересобрать конспект"),
      ),
    ),
    mergeTurns(transcript.segments).map((turn) =>
      h(
        "div",
        { class: "turn" },
        tsButton(audio, turn.start),
        h("div", { class: `who ${speakerClass(turn.speaker)}` }, speakerName(turn.speaker, meeting.speakers)),
        h("div", { class: "text" }, turn.text),
      ),
    ),
  );
}

function toMarkdown(meeting, notes, transcript, withTranscript) {
  const lines = [`# ${meeting.title || notes?.title || "Встреча"}`, ""];
  lines.push(`*${[fmtDate(meeting.createdAt), fmtMinutes(meeting.durationSec)].filter(Boolean).join(" · ")}*`, "");
  if (notes) {
    lines.push("## Кратко", "", notes.summary, "");
    if (notes.decisions.length) lines.push("## Решения", "", ...notes.decisions.map((d) => `- ${d}`), "");
    if (notes.action_items.length) {
      lines.push(
        "## Задачи",
        "",
        ...notes.action_items.map((t) => {
          const extra = [t.owner && ownerName(t.owner, meeting.speakers), t.due && `срок: ${t.due}`].filter(Boolean).join(", ");
          return `- [ ] ${t.task}${extra ? ` — ${extra}` : ""}`;
        }),
        "",
      );
    }
    if (notes.topics.length) {
      lines.push("## Темы", "");
      for (const topic of notes.topics) {
        lines.push(`### ${topic.start ? `[${topic.start}] ` : ""}${topic.title}`, "", ...topic.points.map((p) => `- ${p}`), "");
      }
    }
    if (notes.open_questions.length) lines.push("## Открытые вопросы", "", ...notes.open_questions.map((q) => `- ${q}`), "");
    if (notes.participants.length) {
      lines.push(
        "## Участники",
        "",
        ...notes.participants.map((p) => {
          const name = meeting.speakers[p.speaker]?.trim() || p.name || speakerName(p.speaker);
          return `- ${name}${p.role ? ` — ${p.role}` : ""}`;
        }),
        "",
      );
    }
  }
  if (withTranscript && transcript) {
    lines.push("## Расшифровка", "");
    for (const turn of mergeTurns(transcript.segments)) {
      lines.push(`**[${fmtTs(turn.start)}] ${speakerName(turn.speaker, meeting.speakers)}:** ${turn.text}`, "");
    }
  }
  return lines.join("\n");
}

function download(filename, text) {
  const url = URL.createObjectURL(new Blob([text], { type: "text/markdown;charset=utf-8" }));
  const a = h("a", { href: url, download: filename });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

async function renderMeeting(id) {
  const token = routeToken;
  let tab = "notes";
  let lastStatus = null;

  const draw = (data) => {
    const { meeting, transcript, notes } = data;
    const audio = audioFor(meeting.id);
    const hasContent = Boolean(notes || transcript);
    if (!notes && transcript) tab = "transcript";

    const titleInput = h("input", {
      type: "text",
      class: "title-input",
      value: meeting.title,
      placeholder: "Без названия",
      "aria-label": "Название встречи",
      onChange: async (e) => {
        try {
          await api(`/api/meetings/${meeting.id}`, { method: "PATCH", body: JSON.stringify({ title: e.target.value }) });
          toast("Название сохранено");
        } catch (err) {
          toast(err.message);
        }
      },
    });

    let statusEl = null;
    if (isBusy(meeting.status)) {
      statusEl = h("div", { class: "status-line" }, h("span", { class: "spinner" }), STATUS[meeting.status].long);
    } else if (meeting.status === "error") {
      statusEl = h(
        "div",
        { class: "status-line error" },
        h("span", { class: "grow" }, meeting.error || "Что-то пошло не так"),
        h(
          "button",
          {
            class: "btn small",
            onClick: async () => {
              try {
                await api(`/api/meetings/${meeting.id}/retry`, { method: "POST" });
                poll();
              } catch (err) {
                toast(err.message);
              }
            },
          },
          "Повторить",
        ),
      );
    }

    const tabButton = (name, label) =>
      h(
        "button",
        {
          role: "tab",
          "aria-selected": String(tab === name),
          onClick: () => {
            tab = name;
            draw(data);
          },
        },
        label,
      );

    let body = null;
    if (tab === "notes" && notes) body = renderNotes(meeting, notes, audio);
    else if (transcript) body = renderTranscript(meeting, transcript, audio, () => poll());

    const filename = `${(meeting.title || "встреча").replace(/[\\/:*?"<>|]+/g, " ").trim()}.md`;

    fill(app,
      h("a", { href: "#/", class: "back" }, "← Все встречи"),
      h(
        "section",
        { class: "card" },
        titleInput,
        h(
          "div",
          { class: "muted", style: "font-size:14px" },
          [fmtDate(meeting.createdAt), fmtMinutes(meeting.durationSec), meeting.detectedLanguage?.toUpperCase()].filter(Boolean).join(" · "),
        ),
        statusEl && h("div", { style: "margin-top:14px" }, statusEl),
        meeting.status !== "uploaded" && audio,
      ),
      hasContent &&
        h(
          "section",
          { class: "card" },
          h("div", { class: "tabs", role: "tablist" }, notes && tabButton("notes", "Конспект"), transcript && tabButton("transcript", "Расшифровка")),
          body,
          h(
            "div",
            { class: "actions" },
            notes &&
              h(
                "button",
                {
                  class: "btn",
                  onClick: () =>
                    navigator.clipboard
                      .writeText(toMarkdown(meeting, notes, transcript, false))
                      .then(() => toast("Конспект скопирован"), () => toast("Не удалось скопировать")),
                },
                "Скопировать конспект",
              ),
            h("button", { class: "btn", onClick: () => download(filename, toMarkdown(meeting, notes, transcript, true)) }, "Скачать .md"),
            notes &&
              !isBusy(meeting.status) &&
              h(
                "button",
                {
                  class: "btn",
                  onClick: async () => {
                    try {
                      await api(`/api/meetings/${meeting.id}/regenerate`, { method: "POST" });
                      poll();
                    } catch (err) {
                      toast(err.message);
                    }
                  },
                },
                "Пересобрать конспект",
              ),
          ),
        ),
      h(
        "div",
        { class: "actions" },
        h(
          "button",
          {
            class: "btn danger ghost",
            onClick: async () => {
              if (!confirm("Удалить встречу вместе с записью, расшифровкой и конспектом?")) return;
              try {
                await api(`/api/meetings/${meeting.id}`, { method: "DELETE" });
                audioCache.clear();
                location.hash = "#/";
              } catch (err) {
                toast(err.message);
              }
            },
          },
          "Удалить встречу",
        ),
      ),
    );
  };

  async function poll() {
    if (token !== routeToken) return;
    let data;
    try {
      data = await api(`/api/meetings/${id}`);
    } catch (err) {
      app.replaceChildren(h("a", { href: "#/", class: "back" }, "← Все встречи"), h("div", { class: "empty" }, err.message));
      return;
    }
    if (token !== routeToken) return;
    // Redraw only when something changed, so the page doesn't jump while reading.
    if (data.meeting.status !== lastStatus || !isBusy(data.meeting.status)) {
      lastStatus = data.meeting.status;
      draw(data);
    }
    if (isBusy(data.meeting.status)) setTimeout(poll, 3000);
  }

  app.replaceChildren(h("div", { class: "empty" }, "Загрузка…"));
  await poll();
}

// ---------------------------------------------------------------- router & start

function route() {
  routeToken++;
  window.scrollTo(0, 0);
  const match = location.hash.match(/^#\/m\/([a-z0-9-]+)$/);
  if (match) renderMeeting(match[1]);
  else renderHome();
  renderBanners();
}

window.addEventListener("hashchange", route);
route();

api("/api/status")
  .then((status) => {
    serverStatus = status;
    let saved = null;
    try {
      saved = localStorage.getItem(SETTINGS_KEY);
    } catch {}
    if (!saved) settings.notesLanguage = status.notesLanguage;
    renderBanners();
  })
  .catch(() => {});

if ("serviceWorker" in navigator) {
  navigator.serviceWorker.register("/sw.js").catch(() => {});
}
