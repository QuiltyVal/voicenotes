const main = document.getElementById("main");
const settingsEl = document.getElementById("settings");
const urlInput = document.getElementById("url");
const passwordInput = document.getElementById("password");
const settingsStatus = document.getElementById("settings-status");
document.getElementById("version").textContent = `v${chrome.runtime.getManifest().version}`;

function h(tag, props = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (v == null || v === false) continue;
    if (k.startsWith("on")) el.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k === "class") el.className = v;
    else if (k === "value") el.value = v;
    else el.setAttribute(k, v === true ? "" : v);
  }
  el.append(...children.flat().filter((c) => c != null && c !== false));
  return el;
}

function clock(ms) {
  const s = Math.floor(ms / 1000);
  const pad = (n) => String(n).padStart(2, "0");
  return `${s >= 3600 ? `${Math.floor(s / 3600)}:` : ""}${pad(Math.floor((s % 3600) / 60))}:${pad(s % 60)}`;
}

function send(type, extra = {}) {
  return chrome.runtime.sendMessage({ target: "background", type, ...extra });
}

async function micGranted() {
  try {
    return (await navigator.permissions.query({ name: "microphone" })).state === "granted";
  } catch {
    return false;
  }
}

// ------------------------------------------------------------------ settings

async function loadSettings() {
  const { server } = await chrome.storage.local.get("server");
  urlInput.value = server?.url ?? "";
  passwordInput.value = server?.password ?? "";
  if (!server?.url) settingsEl.hidden = false;
  return server;
}

document.getElementById("toggle-settings").addEventListener("click", () => {
  settingsEl.hidden = !settingsEl.hidden;
});

document.getElementById("save").addEventListener("click", async () => {
  let url;
  try {
    url = new URL(urlInput.value.trim().includes("://") ? urlInput.value.trim() : `https://${urlInput.value.trim()}`);
  } catch {
    settingsStatus.textContent = "Неверный адрес";
    return;
  }
  // http:// on a real domain is redirected to https, which drops the password.
  if (url.protocol === "http:" && !["localhost", "127.0.0.1"].includes(url.hostname)) url.protocol = "https:";
  const origin = url.origin;
  urlInput.value = origin;
  const server = { url: origin, password: passwordInput.value.trim() };
  await chrome.storage.local.set({ server });
  settingsStatus.textContent = "Проверяю…";
  try {
    const headers = server.password
      ? { Authorization: `Basic ${btoa(unescape(encodeURIComponent(`voicenotes:${server.password}`)))}` }
      : {};
    const res = await fetch(`${origin}/api/status`, { headers });
    if (res.status === 401) throw new Error("сервер не принял пароль (логин не нужен, только пароль от приложения)");
    if (!res.ok) throw new Error(`сервер ответил ${res.status}`);
    settingsStatus.textContent = "✓ Подключено";
    setTimeout(() => (settingsEl.hidden = true), 700);
    render();
  } catch (err) {
    settingsStatus.textContent = `Не получилось: ${err instanceof TypeError ? "сервер недоступен" : err.message}`;
  }
});

// ------------------------------------------------------------------ main view

let ticker = null;
let lastStatus = null;

async function notesField() {
  const { notes = "", title = "" } = await chrome.storage.local.get(["notes", "title"]);
  return [
    h("input", {
      type: "text",
      placeholder: "Название (необязательно)",
      value: title,
      onInput: (e) => chrome.storage.local.set({ title: e.target.value }),
    }),
    h("textarea", {
      rows: 5,
      placeholder: "Заметки по ходу встречи — Claude дополнит их по записи",
      value: notes,
      onInput: (e) => chrome.storage.local.set({ notes: e.target.value }),
    }),
  ];
}

async function render() {
  const { rec = { status: "idle" } } = await chrome.storage.session.get("rec");
  if (rec.status === lastStatus && rec.status !== "failed") return;
  lastStatus = rec.status;
  clearInterval(ticker);
  const { server } = await chrome.storage.local.get("server");
  const items = [];

  if (rec.status === "recording") {
    const timer = h("div", { class: "timer" }, clock(Date.now() - rec.startedAt));
    ticker = setInterval(() => (timer.textContent = clock(Date.now() - rec.startedAt)), 500);
    items.push(
      timer,
      h("div", { class: "tab" }, `Пишу: ${rec.tabTitle}`),
      rec.micWarning && h("div", { class: "warn" }, rec.micWarning),
      ...(await notesField()),
      h("button", { class: "btn rec", onClick: () => send("stop").then(render) }, "■ Остановить и отправить"),
      h("p", { class: "muted" }, "Окно можно закрыть — запись продолжится. Значок REC на панели значит, что идёт запись."),
    );
  } else if (rec.status === "uploading") {
    items.push(h("div", { class: "timer" }, "↑"), h("div", { class: "tab" }, "Отправляю запись на сервер…"));
  } else if (rec.status === "failed") {
    items.push(
      h("div", { class: "error" }, `Не отправилось: ${rec.error}`),
      h(
        "div",
        { class: "row" },
        h("button", { class: "btn primary", onClick: () => send("retry").then(() => ((lastStatus = null), render())) }, "Повторить"),
        h(
          "button",
          {
            class: "btn",
            onClick: () => confirm("Удалить запись безвозвратно?") && send("discard").then(() => ((lastStatus = null), render())),
          },
          "Удалить",
        ),
      ),
    );
  } else {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (rec.error) items.push(h("div", { class: "error" }, rec.error));
    if (!(await micGranted())) {
      items.push(
        h(
          "div",
          { class: "warn" },
          "Чтобы в запись попадал твой голос, ",
          h("a", { href: "#", onClick: (e) => (e.preventDefault(), chrome.tabs.create({ url: "mic.html" })) }, "разреши микрофон"),
          ".",
        ),
      );
    }
    items.push(
      h("div", { class: "tab" }, `Будет записан звук вкладки: ${tab?.title ?? ""}`),
      ...(await notesField()),
      h(
        "button",
        {
          class: "btn rec",
          disabled: !server?.url,
          onClick: async (e) => {
            e.target.disabled = true;
            const reply = await send("start", { tabId: tab.id });
            if (!reply?.ok) {
              e.target.disabled = false;
              await chrome.storage.session.set({ rec: { status: "idle", error: reply?.error || "Не удалось начать" } });
            }
            lastStatus = null;
            render();
          },
        },
        "● Записать эту вкладку",
      ),
      h("p", { class: "muted" }, "Открой вкладку созвона (Meet, Zoom, Telegram Web…) и нажми кнопку. Предупреди участников о записи."),
      rec.lastMeetingUrl && h("a", { href: rec.lastMeetingUrl, target: "_blank" }, "Открыть последнюю встречу"),
    );
  }
  main.replaceChildren(...items.filter(Boolean));
}

await loadSettings();
await render();
setInterval(render, 1000);
