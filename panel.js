/* Chrome接口导出器 1.0.0 - DevTools 面板逻辑
 * 捕获策略：请求完成后立即入列表；响应正文异步补充（getContent 回调可能延迟或永不触发，
 * 不能让它阻塞列表展示，否则表现为"插件不生效"）。
 * 导出策略：只有一种格式——接口 JSON，文件名固定为「接口名.json」。
 */

const records = new Map();   // _id -> HAR entry
const selected = new Set();  // 勾选状态与渲染解耦，重绘不丢勾选
let visible = [];

// 下载诊断状态：通道可用性 + 上一次导出的真实结果，出问题时一键复制给开发排查
let lastExport = null;       // { name, savedAs, ok, degraded, cancelled, channel, channels[] }
let bgState = null;          // null 未知 / true 可达 / string 失败原因
let renameState = null;      // null 未尝试 / true 后台已收到改名登记 / false 后台不可达
const VERSION = (() => {
  try { return chrome.runtime.getManifest().version; } catch (err) { return "?"; }
})();

const $ = id => document.getElementById(id);
// HAR 条目本质是 JSON 数据（可能附带 getContent 函数），JSON 往返克隆可自动丢弃函数；
// 不能用 structuredClone，它遇到函数会抛 DataCloneError 导致导出失败。
const clone = x => {
  try { return JSON.parse(JSON.stringify(x)); }
  catch { return Object.assign({}, x); }
};

function keyOf(r) { return r.request.url + "|" + r.request.method + "|" + r.startedDateTime; }

/* ---------- 主题：跟随 DevTools 深浅色 ---------- */
function applyTheme(name) {
  const dark = name === "dark" ? true :
    name === "default" || name === "light" ? false :
    window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches;
  document.documentElement.dataset.theme = dark ? "dark" : "light";
}
try {
  const devTheme = chrome.devtools && chrome.devtools.panels && chrome.devtools.panels.themeName;
  applyTheme(devTheme);
} catch (err) { applyTheme(); }

// 类型过滤三档：xhr（默认）/ api（fetch+xhr）/ all；无类型标记时按响应 MIME 猜测
const TYPE_MODE_LABEL = { xhr: "仅 xhr", api: "仅 fetch/xhr", all: "全部类型" };
function guessApiMime(e) {
  const mime = (e.response && e.response.content && e.response.content.mimeType) || "";
  return /json|xml|text\/plain/i.test(mime);
}
function matchType(e) {
  const mode = $("typeFilter").value;
  if (mode === "all") return true;
  const t = String(e._resourceType || "").toLowerCase();
  if (t) return mode === "xhr" ? t === "xhr" : (t === "xhr" || t === "fetch");
  return guessApiMime(e);
}

function setStatus(text, isError) {
  const el = $("status");
  if (!el) return;
  el.textContent = text;
  el.classList.toggle("error", !!isError);
  el.classList.toggle("ok", !isError);
}

function captureStatus() {
  return (TYPE_MODE_LABEL[$("typeFilter").value] || TYPE_MODE_LABEL.xhr) + " · 已捕获 " + records.size + " 条";
}

function addEntry(e) {
  let x;
  try { x = clone(e); } catch { x = Object.assign({}, e); }
  if (!x || !x.request || !x.request.url) return;
  // 按所选类型档过滤，默认仅 xhr，image/stylesheet/script/fetch 等不展示
  if (!matchType(x)) return;
  x._id = keyOf(x);
  const old = records.get(x._id);
  // 同一请求重放时保留已异步补到的响应正文
  if (old && old.response && old.response.content && old.response.content.text !== undefined &&
      !(x.response && x.response.content && x.response.content.text !== undefined)) {
    x.response = x.response || {};
    x.response.content = old.response.content;
  }
  records.set(x._id, x);
  render();
}

// 异步补充响应正文：失败/挂起都不影响列表
function fillContent(entry, id) {
  let called = false;
  const done = (content, encoding) => {
    if (called) return;
    called = true;
    if (content === undefined || content === null) return;
    const rec = records.get(id);
    if (!rec) return;
    rec.response = rec.response || {};
    rec.response.content = rec.response.content || {};
    rec.response.content.text = content;
    if (encoding) rec.response.content.encoding = encoding;
  };
  try {
    if (typeof entry.getContent === "function") entry.getContent(done);
  } catch (err) { /* 部分资源类型不支持读取正文，忽略 */ }
}

function refresh() {
  try {
    chrome.devtools.network.getHAR(har => {
      ((har && har.entries) || []).forEach(addEntry);
      setStatus(captureStatus());
    });
  } catch (err) {
    setStatus("读取 Network HAR 失败：" + err.message, true);
  }
}

/* ---------- 列表渲染 ---------- */
function methodTag(method) {
  const m = String(method || "").toUpperCase();
  const cls = m === "GET" ? "m-get" : m === "POST" ? "m-post" : m === "PUT" || m === "PATCH" ? "m-put"
    : m === "DELETE" ? "m-del" : "m-other";
  const el = document.createElement("span");
  el.className = "tag " + cls;
  el.textContent = m || "—";
  return el;
}

function statusCell(status) {
  const el = document.createElement("span");
  const s = Number(status) || 0;
  el.className = "code " + (s >= 200 && s < 300 ? "ok" : s >= 300 && s < 400 ? "redir" : s >= 400 ? "err" : "none");
  el.textContent = s ? String(s) : "—";
  return el;
}

function urlCell(url) {
  const wrap = document.createElement("span");
  wrap.className = "url";
  let host = "", rest = url || "";
  try {
    const u = new URL(url);
    host = u.host;
    rest = (u.pathname || "/") + (u.search || "");
  } catch (err) { /* 非法 URL 原样展示 */ }
  if (host) {
    const h = document.createElement("span");
    h.className = "host";
    h.textContent = host;
    wrap.append(h);
  }
  const p = document.createElement("span");
  p.className = "path";
  p.textContent = rest;
  wrap.append(p);
  return wrap;
}

function emptyRow(html) {
  const tr = document.createElement("tr");
  const td = document.createElement("td");
  td.colSpan = 6;
  td.className = "empty";
  td.innerHTML = html;
  tr.append(td);
  return tr;
}

function render() {
  const q = $("filter").value.trim().toLowerCase();
  visible = [...records.values()].filter(r => {
    const s = [r.request.method, r.response && r.response.status, r._resourceType, r.request.url].join(" ").toLowerCase();
    return !q || s.includes(q);
  });
  $("total").textContent = records.size;
  const body = $("requests");
  const frag = document.createDocumentFragment();

  if (!visible.length) {
    frag.append(emptyRow(records.size
      ? "<b>没有匹配的请求</b><span>换个关键词，或把类型切到「全部类型」</span>"
      : "<b>等待接口请求……</b><span>默认仅捕获 xhr：先打开本面板，再刷新页面或触发操作</span>"));
  } else {
    for (const r of visible) {
      const tr = document.createElement("tr");
      if (selected.has(r._id)) tr.classList.add("picked");

      // 勾选框
      const td0 = document.createElement("td");
      const cb = document.createElement("input");
      cb.type = "checkbox"; cb.className = "rowcheck"; cb.dataset.id = r._id;
      cb.checked = selected.has(r._id);
      cb.addEventListener("change", () => {
        if (cb.checked) selected.add(r._id); else selected.delete(r._id);
        tr.classList.toggle("picked", cb.checked);
        updateSelected();
      });
      td0.append(cb);
      tr.append(td0);

      // 方法
      const td1 = document.createElement("td");
      td1.append(methodTag(r.request.method));
      tr.append(td1);

      // 状态码
      const td2 = document.createElement("td");
      const st = statusCell(r.response && r.response.status);
      td2.append(st);
      tr.append(td2);

      // 类型
      const td3 = document.createElement("td");
      const typeEl = document.createElement("span");
      typeEl.className = "type";
      typeEl.textContent = r._resourceType || (r.response && r.response.content && r.response.content.mimeType) || "—";
      td3.append(typeEl);
      tr.append(td3);

      // URL
      const td4 = document.createElement("td");
      const uc = urlCell(r.request.url);
      td4.append(uc);
      td4.title = r.request.url;
      tr.append(td4);

      // 耗时
      const td5 = document.createElement("td");
      td5.className = "time";
      td5.textContent = r.time ? Math.round(r.time) + " ms" : "—";
      tr.append(td5);

      // 点行任意位置即可勾选/取消（不打断文本选择）
      tr.addEventListener("click", ev => {
        if (ev.target.closest("input,a,button")) return;
        if (String(window.getSelection())) return;
        cb.checked = !cb.checked;
        cb.dispatchEvent(new Event("change"));
      });

      frag.append(tr);
    }
  }
  body.innerHTML = "";
  body.append(frag);
  updateSelected();
}

function updateSelected() {
  $("selected").textContent = selected.size;
  const all = $("selectAll");
  all.checked = visible.length > 0 && visible.every(r => selected.has(r._id));
  all.indeterminate = !all.checked && visible.some(r => selected.has(r._id));
  $("exportSelected").disabled = selected.size === 0;
}

function selectedEntries() {
  return [...records.values()].filter(r => selected.has(r._id));
}

/* ---------- 文件名：接口名.json ---------- */
function sanitizeName(name) { return String(name || "").replace(/[\\/:*?"<>|\s]+/g, "-").replace(/^-+|-+$/g, ""); }

// 接口名 = URL 路径最后一段：/api/v1/user/getUserProfile -> getUserProfile
function interfaceNameOf(entry) {
  let p;
  try { p = new URL(entry.request.url).pathname; } catch (err) { return "unknown"; }
  const segs = p.split("/").filter(Boolean);
  if (!segs.length) return "root";
  let name = segs[segs.length - 1];
  name = name.replace(/\.(json|html?|do|action|jsp|php|aspx?)$/i, ""); // 去掉路径里的尾巴扩展名
  return sanitizeName(name).slice(0, 60) || "root";
}

// 单条/同接口：接口名；多接口：前面几个拼接，超过 3 个加「等N个接口」
function exportBaseName(entries) {
  if (entries.length === 1) return interfaceNameOf(entries[0]);
  const names = [...new Set(entries.map(interfaceNameOf))];
  if (names.length === 1) return names[0];
  let base = names.slice(0, 3).join("+");
  if (names.length > 3) base += "等" + names.length + "个接口";
  return sanitizeName(base).slice(0, 120);
}

function fileNameFor(entries) { return exportBaseName(entries) + ".json"; }

/* ---------- 下载 ----------
 * 文件名必须由我们保证，不能指望 DevTools 面板里的下载通道：
 * 实测面板内 chrome.downloads 与后台代下都可能失败，一降级到 <a download>，DevTools 就把
 * download 属性丢掉，Chrome 改用 blob URL 的 UUID 段当文件名（xxxxxxxx-….json）或「下载.json」。
 * 通道顺序（前一级失败才走下一级）：
 * 1) 系统另存为 showSaveFilePicker：只在顶层窗口尝试；面板是跨源 iframe，浏览器直接禁止，
 *    必然失败，所以 iframe 内直接跳过，不计为失败原因；
 * 2) 面板 chrome.downloads（blob URL → data URL）：面板里的主力通道，filename 由下载 API 保证；
 * 3) 后台 service worker 代下（blob URL → data URL）；
 * 4) 锚点兜底 + 通知后台用 onDeterminingFilename 把名字改回来。
 * 每次尝试都会记进 channels[]，供诊断面板展示「哪一级用了/跳过/失败」。
 * 用户在对话框点「取消」时不再降级，避免连弹第二个对话框。
 */
const CHANNEL = {
  picker: "系统另存为",
  downloads: "直接下载",
  background: "后台 worker",
  fallback: "锚点兜底"
};

function fallbackDownload(name, blob) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = name;
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

const isCancel = reason => /cancel|取消|AbortError/i.test(String(reason || ""));

function downloadsAvailable() {
  try { return !!(chrome.downloads && typeof chrome.downloads.download === "function"); }
  catch (err) { return false; }
}

function blobToDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => resolve(fr.result);
    fr.onerror = () => reject(new Error("读取文件内容失败"));
    fr.readAsDataURL(blob);
  });
}

// 通道 1：系统另存为（File System Access）。suggestedName 一定被采用，且不经过下载管理器。
async function saveViaFilePicker(filename, blob) {
  if (typeof window.showSaveFilePicker !== "function") {
    return { ok: false, reason: "showSaveFilePicker 不可用" };
  }
  const run = async opts => {
    const handle = await window.showSaveFilePicker(opts);
    const writable = await handle.createWritable();
    await writable.write(blob);
    await writable.close();
    return handle.name || filename;
  };
  try {
    let savedAs;
    try {
      savedAs = await run({
        suggestedName: filename,
        types: [{ description: "JSON 文件", accept: { "application/json": [".json"] } }]
      });
    } catch (err) {
      // types 校验不过（TypeError）时退回只给 suggestedName，别把对话框弹第二次
      if (!(err instanceof TypeError)) throw err;
      savedAs = await run({ suggestedName: filename });
    }
    return { ok: true, channel: "系统另存为", savedAs };
  } catch (err) {
    if (err && (err.name === "AbortError" || isCancel(err.message))) {
      return { ok: false, cancelled: true, reason: "用户取消" };
    }
    return { ok: false, reason: (err && err.message) || String(err) };
  }
}

// 每一次真正发起下载前都要登记改名规则：onDeterminingFilename 会把 Chrome 最终落盘名
// 钉成接口名。登记是队列消费式的，重试一次就得登记一次，否则第二次又变回 UUID。
async function requestRename(filename, url) {
  let ok = false;
  try {
    await new Promise(resolve => {
      chrome.runtime.sendMessage({ type: "api-exporter-rename", filename, url: url || "" }, () => {
        ok = !chrome.runtime.lastError;
        void chrome.runtime.lastError;
        resolve();
      });
    });
  } catch (err) { ok = false; }
  renameState = ok;
  return ok;
}

// 通道 2：面板内直接下载。回调式 API，lastError 必须在回调里同步读。
async function saveViaDownloads(url, filename) {
  await requestRename(filename, url);
  return new Promise(resolve => {
    try {
      chrome.downloads.download({ url, filename, saveAs: true }, id => {
        const err = chrome.runtime.lastError;
        if (err) {
          const reason = err.message || "下载失败";
          return resolve({ ok: false, reason, cancelled: isCancel(reason) });
        }
        resolve(id ? { ok: true, channel: CHANNEL.downloads, id } : { ok: false, reason: "未返回下载 ID" });
      });
    } catch (err) { resolve({ ok: false, reason: err.message }); }
  });
}

// 回读真实落盘文件名：用户在另存为对话框里改过名、或系统补了 (1) 都能反映出来
function confirmSavedName(id) {
  return new Promise(resolve => {
    try {
      if (!id || !chrome.downloads || typeof chrome.downloads.search !== "function") return resolve(null);
    } catch (err) { return resolve(null); }
    let tries = 0;
    const tick = () => {
      try {
        chrome.downloads.search({ id }, items => {
          void chrome.runtime.lastError;
          const full = items && items[0] && items[0].filename;
          if (full) return resolve(String(full).split(/[\\/]/).pop());
          if (++tries >= 4) return resolve(null);
          setTimeout(tick, 200);
        });
      } catch (err) { resolve(null); }
    };
    tick();
  });
}

// 落盘名校验：另存为对话框若还是被塞了 UUID / "下载"，直接调 downloads.rename 改回来
function looksLikeFallbackName(base) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.json$/i.test(base)
    || /^(下载|download)(\s*\(\d+\))?\.json$/i.test(base);
}

async function fixSavedName(id, desired) {
  const base = await confirmSavedName(id);
  if (!base || !looksLikeFallbackName(base)) return base;
  try {
    if (!chrome.downloads || typeof chrome.downloads.rename !== "function") return base;
    await new Promise(resolve => {
      chrome.downloads.rename(id, desired, () => { void chrome.runtime.lastError; resolve(); });
    });
    return desired;
  } catch (err) { return base; }
}

// 通道 3：后台 service worker 代下。ack 撤销看门狗，done 才判定成败。
async function saveViaBackground(payload) {
  await requestRename(payload.filename, payload.dataUrl || payload.url || "");
  return new Promise(resolve => {
    let finished = false, acked = false, timer = null, port = null;
    const finish = (ok, reason) => {
      if (finished) return;
      finished = true;
      bgState = ok ? true : (reason || "无响应");
      if (timer) clearTimeout(timer);
      try { if (port) port.disconnect(); } catch (err) { /* 忽略 */ }
      resolve(ok ? { ok: true, channel: CHANNEL.background }
        : { ok: false, reason: reason || "后台无响应", cancelled: isCancel(reason) });
    };
    try {
      port = chrome.runtime.connect({ name: "api-exporter-download" });
      port.onMessage.addListener(m => {
        if (!m) return;
        if (m.ack) { acked = true; if (timer) clearTimeout(timer); return; }
        if (m.done) finish(m.ok, m.error);
      });
      port.onDisconnect.addListener(() => finish(false, "后台连接已断开"));
      timer = setTimeout(() => { if (!acked) finish(false, "后台未响应（扩展可能未重新加载）"); }, 3000);
      port.postMessage(payload);
    } catch (err) { finish(false, err.message); }
  });
}

async function download(name, text, mime) {
  const filename = /\.json$/i.test(name) ? sanitizeName(name) : sanitizeName(name) + ".json";
  const blob = new Blob([text], { type: mime || "application/json" });
  const channels = [];
  // status: used / failed / skipped / cancelled / unused
  const track = (key, status, detail) => channels.push({ key, name: CHANNEL[key], status, detail: detail || "" });
  const done = extra => Object.assign({ channels }, extra);

  // 1) 系统另存为：DevTools 面板是跨源 iframe，Chrome 明确禁止在此弹文件选择器。
  //    既然必然失败，就不要调用——省掉一次异常，诊断里也不会再冒出吓人的"失败原因"。
  if (inIframe()) {
    track("picker", "skipped", "面板是跨源 iframe，浏览器禁止在此弹文件选择器");
  } else {
    const picker = await saveViaFilePicker(filename, blob);
    if (picker.ok) {
      track("picker", "used", "File System Access，文件名由 suggestedName 指定，不经过下载管理器");
      return done({ ok: true, channel: CHANNEL.picker, savedAs: picker.savedAs });
    }
    if (picker.cancelled) {
      track("picker", "cancelled", "你在另存为对话框点了取消");
      return done({ ok: false, cancelled: true, channel: CHANNEL.picker });
    }
    track("picker", "failed", picker.reason);
  }

  // 2) 面板内 chrome.downloads
  //    关键：优先用 data URL。blob URL 的路径段就是 xxxxxxxx-… 这种 UUID，
  //    DevTools 面板里下载 API 的 filename 一旦被忽略，Chrome 就拿它当文件名。
  const blobUrl = URL.createObjectURL(blob);   // 只留给最后的锚点兜底
  let dataUrl = "";
  try { dataUrl = await blobToDataUrl(blob); } catch (err) { /* 转 data URL 失败就走 blob URL */ }

  let result = { ok: false };
  if (!downloadsAvailable()) {
    track("downloads", "skipped", "当前上下文没有 chrome.downloads 权限");
  } else {
    const candidates = [];
    if (dataUrl) candidates.push({ label: "data URL", url: dataUrl });
    candidates.push({ label: "blob URL", url: blobUrl });
    const errors = [];
    for (const c of candidates) {
      result = await saveViaDownloads(c.url, filename);   // 内部每次都会重新登记改名规则
      if (result.cancelled) {
        track("downloads", "cancelled", "你在另存为对话框点了取消");
        URL.revokeObjectURL(blobUrl);
        return done({ ok: false, cancelled: true, channel: CHANNEL.downloads });
      }
      if (result.ok) {
        track("downloads", "used", c.label + " + filename=" + filename + "，另存为对话框可选位置；"
          + (renameState ? "已登记后台改名" : "后台改名未登记，已改用落盘后纠正"));
        result.confirmed = await fixSavedName(result.id, filename);
        break;
      }
      errors.push(c.label + "：" + result.reason);
    }
    if (!result.ok && errors.length) track("downloads", "failed", errors.join("；"));
  }

  // 3) 后台 service worker 代下：直接传 data URL，service worker 取不到面板建的 blob URL
  if (result.ok) {
    track("background", "unused", "上一级已成功");
  } else {
    const candidates = [];
    if (dataUrl) candidates.push({ label: "data URL", payload: { dataUrl, filename } });
    candidates.push({ label: "blob URL", payload: { url: blobUrl, filename } });
    const errors = [];
    for (const c of candidates) {
      const bg = await saveViaBackground(c.payload);       // 内部每次都会重新登记改名规则
      if (bg.cancelled) {
        track("background", "cancelled", "你在另存为对话框点了取消");
        URL.revokeObjectURL(blobUrl);
        return done({ ok: false, cancelled: true, channel: CHANNEL.background });
      }
      if (bg.ok) {
        result = bg;
        track("background", "used", c.label + " + filename=" + filename + "，后台直下；已登记后台改名");
        break;
      }
      errors.push(c.label + "：" + bg.reason);
    }
    if (!result.ok && errors.length) track("background", "failed", errors.join("；"));
  }

  // 4) 最后兜底：DevTools 会丢 download 属性，先让后台备好改名规则再点
  if (!result.ok) {
    await requestRename(filename, blobUrl);
    fallbackDownload(filename, blob);
    track("fallback", "used", "已请求后台改名 → " + filename + "（锚点下载会被 DevTools 丢掉 download 属性）");
    result = { ok: true, degraded: true };
  } else {
    track("fallback", "unused", "上一级已成功");
  }

  setTimeout(() => URL.revokeObjectURL(blobUrl), 20000);
  return done(result);
}

/* ---------- 接口 JSON ---------- */
// 浏览器自动附加的噪声头与 HTTP/2 伪头（:authority 等）不属于接口定义，导出时过滤
const NOISE_HEADERS = new Set([
  "accept-encoding", "accept-language", "user-agent", "priority", "connection",
  "content-length", "host", "origin", "referer", "cache-control", "pragma",
  "sec-ch-ua", "sec-ch-ua-mobile", "sec-ch-ua-platform",
  "sec-fetch-dest", "sec-fetch-mode", "sec-fetch-site"
]);
function cleanHeaders(headers) {
  return (headers || []).filter(h => {
    const n = String(h.name || "").toLowerCase();
    return !n.startsWith(":") && !NOISE_HEADERS.has(n);
  });
}

// 正文解析：JSON 解析为对象，base64 先解码，非 JSON 保留原文
function parseMaybeJson(text, encoding) {
  if (text === undefined || text === null || text === "") return null;
  let s = text;
  if (encoding === "base64") {
    try { s = decodeURIComponent(escape(atob(text))); }
    catch (err) { try { s = atob(text); } catch (err2) { return text; } }
  }
  try { return JSON.parse(s); } catch (err) { return s; }
}

// 干净接口 JSON：只保留接口名/URL/方法/状态码/业务请求头/请求体/响应体
function cleanEntry(e) {
  const req = e.request || {}, res = e.response || {};
  const content = res.content || {};
  return {
    interface: interfaceNameOf(e),
    url: req.url,
    method: req.method,
    status: res.status || 0,
    requestHeaders: Object.fromEntries(cleanHeaders(req.headers).map(h => [h.name, h.value])),
    request: parseMaybeJson(req.postData && req.postData.text),
    response: parseMaybeJson(content.text, content.encoding)
  };
}

async function exportAs(scope, singleId) {
  let entries;
  if (scope === "all") entries = [...records.values()];
  else if (scope === "single") entries = singleId && records.has(singleId) ? [records.get(singleId)] : [];
  else entries = selectedEntries();
  if (!entries.length) {
    alert(scope === "all" ? "当前没有可导出的请求" : "请先勾选要导出的接口");
    return;
  }
  const name = fileNameFor(entries);
  try {
    const obj = entries.length === 1 ? cleanEntry(entries[0]) : entries.map(cleanEntry);
    const res = await download(name, JSON.stringify(obj, null, 2), "application/json");
    lastExport = {
      name,
      savedAs: res.savedAs || res.confirmed || "",
      ok: !!res.ok,
      degraded: !!res.degraded,
      cancelled: !!res.cancelled,
      channel: res.channel || (res.degraded ? CHANNEL.fallback : "—"),
      channels: res.channels || []
    };
    if (res.cancelled) setStatus("已取消导出（文件名应为 " + name + "）");
    else if (res.degraded) {
      setStatus("已导出 " + entries.length + " 条，但走的是浏览器兜底通道、文件名可能被改写（点「诊断」看通道）", true);
      showDiag(true);
    } else {
      const saved = res.savedAs || res.confirmed || name;
      setStatus("已导出 " + entries.length + " 条 → " + saved + (saved !== name ? "（另存为时改过名）" : ""));
    }
    // 诊断面板开着的话同步刷新，不用关了重开
    if (!$("diagPanel").hidden) showDiag(true);
  } catch (err) {
    lastExport = { name, savedAs: "", ok: false, degraded: false, cancelled: false, channel: "—", channels: [] };
    setStatus("导出失败：" + err.message, true);
    showDiag(true);
  }
}

/* ---------- 下载诊断（出问题时让用户一键复制给开发） ---------- */
function inIframe() {
  try { return window.top !== window.self; } catch (err) { return true; }
}

const CH_MARK = { used: "✅", failed: "❌", skipped: "·", cancelled: "⛔", unused: "·" };
const CH_TONE = { used: "v-good", failed: "v-bad", skipped: "v-dim", cancelled: "v-warn", unused: "v-dim" };

// 顶栏状态：成功是绿的，降级/取消是橙的，失败才是红的
function exportState() {
  if (!lastExport) return null;
  if (lastExport.cancelled) return { cls: "warn", text: "上次导出已取消" };
  if (!lastExport.ok) return { cls: "err", text: "上次导出失败" };
  if (lastExport.degraded) return { cls: "warn", text: "已降级到兜底通道" };
  return { cls: "ok", text: "上次导出成功" };
}

// 诊断内容先组织成「小节 + 行」的结构，文本版给复制、DOM 版给面板，两边同源不打架
function diagModel() {
  const secs = [];
  if (lastExport) {
    const e = lastExport;
    const rows = [{ label: "目标文件名", value: e.name, tone: "v-strong" }];
    if (e.savedAs) {
      rows.push({
        label: "实际落盘",
        value: e.savedAs + (e.savedAs === e.name ? "" : "（与目标不同，另存为时改过名）"),
        tone: e.savedAs === e.name ? "v-good" : "v-warn"
      });
    }
    rows.push({
      label: "结果",
      value: e.cancelled ? "已取消" : e.ok ? (e.degraded ? "成功，但文件名可能被浏览器改写" : "成功") : "失败",
      tone: e.cancelled ? "v-warn" : e.ok ? (e.degraded ? "v-warn" : "v-good") : "v-bad"
    });
    rows.push({ label: "使用的通道", value: e.channel, tone: "" });
    secs.push({ title: "上次导出", rows });
  }
  const tried = lastExport ? lastExport.channels.filter(c => c.status !== "unused") : [];
  if (tried.length) {
    secs.push({
      title: "通道尝试（自上而下逐级降级）",
      rows: tried.map(c => ({
        label: c.name,
        marker: c.status,
        value: c.detail || "—",
        tone: CH_TONE[c.status] || ""
      }))
    });
  }
  const iframe = inIframe();
  const dl = downloadsAvailable();
  const pickerOk = typeof window.showSaveFilePicker === "function";
  secs.push({
    title: "运行环境",
    rows: [
      {
        label: "运行位置",
        value: (iframe ? "iframe 内（DevTools 面板即如此）" : "顶层窗口")
          + " ｜ 列表 " + records.size + " 条，已勾选 " + selected.size + " 条"
      },
      { label: "chrome.downloads", value: dl ? "可用" : "不可用", tone: dl ? "v-good" : "v-bad" },
      {
        label: "showSaveFilePicker",
        value: iframe ? "受限制（跨源 iframe 不允许弹选择器）" : pickerOk ? "可用" : "不可用",
        tone: iframe ? "v-dim" : pickerOk ? "v-good" : "v-bad"
      },
      {
        label: "后台 worker",
        value: bgState === null ? "未尝试" : bgState === true ? "可达" : "不可达（" + bgState + "）",
        tone: bgState === true ? "v-good" : bgState === null ? "v-dim" : "v-bad"
      },
      {
        label: "改名规则登记",
        value: renameState === null ? "未尝试" : renameState ? "后台已收到" : "后台未收到（文件名可能退回 UUID）",
        tone: renameState === true ? "v-good" : renameState === null ? "v-dim" : "v-bad"
      },
    ]
  });
  return secs;
}

function diagPlainText() {
  const lines = ["Chrome接口导出器 v" + VERSION];
  diagModel().forEach(sec => {
    lines.push("");
    lines.push("[" + sec.title + "]");
    sec.rows.forEach(r => {
      const mark = r.marker ? (CH_MARK[r.marker] || "") + " " : "";
      lines.push("  " + r.label + "：" + mark + (r.value || ""));
    });
  });
  return lines.join("\n");
}

function renderDiag() {
  const host = $("diagText");
  if (!host) return;
  host.textContent = "";
  diagModel().forEach(sec => {
    const box = document.createElement("div");
    box.className = "diag-sec";
    const title = document.createElement("span");
    title.className = "t";
    title.textContent = sec.title;
    box.append(title);
    sec.rows.forEach(r => {
      const row = document.createElement("div");
      row.className = "diag-row";
      if (r.marker) {
        const mk = document.createElement("span");
        mk.className = "mk";
        mk.textContent = CH_MARK[r.marker] || "";
        row.append(mk);
      }
      const lb = document.createElement("span");
      lb.className = "lb";
      lb.textContent = r.label;
      const vl = document.createElement("span");
      vl.className = "vl " + (r.tone || "");
      vl.textContent = r.value || "—";
      row.append(lb, vl);
      box.append(row);
    });
    host.append(box);
  });
  const st = exportState();
  const chip = $("diagState");
  if (chip) {
    chip.hidden = !st;
    chip.className = "diag-state" + (st ? " " + st.cls : "");
    chip.textContent = st ? st.text : "";
  }
}

function showDiag(on) {
  const panel = $("diagPanel");
  if (!panel) return;
  if (on) renderDiag();
  panel.hidden = !on;
}

/* ---------- 右键菜单 ---------- */
const ctxMenu = $("ctxMenu");

function closeCtxMenu() { ctxMenu.hidden = true; }

function copyText(text, okMsg) {
  const ok = () => setStatus(okMsg || "已复制 URL");
  const fail = () => setStatus("复制失败，请选中文本手动复制", true);
  const legacy = () => {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.style.position = "fixed"; ta.style.opacity = "0";
    document.body.append(ta); ta.select();
    let done = false;
    try { done = document.execCommand("copy"); } catch (err) { /* 忽略 */ }
    ta.remove();
    return done;
  };
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(text).then(ok).catch(() => (legacy() ? ok() : fail()));
  } else {
    legacy() ? ok() : fail();
  }
}

function toggleRow(id) {
  if (selected.has(id)) selected.delete(id); else selected.add(id);
  render();
}

function openCtxMenu(x, y, id) {
  const rec = records.get(id);
  if (!rec) return;
  const selCount = selected.size, allCount = records.size;
  const items = [
    { label: "导出该条（" + interfaceNameOf(rec) + ".json）", act: () => exportAs("single", id) },
    { label: "导出选中（" + selCount + " 条）", act: () => exportAs("selected"), disabled: !selCount },
    { label: "导出全部（" + allCount + " 条）", act: () => exportAs("all"), disabled: !allCount },
    { sep: true },
    { label: "复制 URL", act: () => copyText(rec.request.url) },
    { label: selected.has(id) ? "取消勾选该条" : "勾选该条", act: () => toggleRow(id) }
  ];
  ctxMenu.innerHTML = "";
  for (const it of items) {
    if (it.sep) {
      const d = document.createElement("div");
      d.className = "sep";
      ctxMenu.append(d);
      continue;
    }
    const b = document.createElement("button");
    b.type = "button";
    b.textContent = it.label;
    b.disabled = !!it.disabled;
    b.addEventListener("click", ev => { ev.stopPropagation(); closeCtxMenu(); it.act(); });
    ctxMenu.append(b);
  }
  ctxMenu.hidden = false;
  const mw = ctxMenu.offsetWidth, mh = ctxMenu.offsetHeight;
  ctxMenu.style.left = Math.max(4, Math.min(x, window.innerWidth - mw - 4)) + "px";
  ctxMenu.style.top = Math.max(4, Math.min(y, window.innerHeight - mh - 4)) + "px";
}

function onRowContextMenu(e) {
  const tr = e.target.closest("tr");
  if (!tr) return;
  const cb = tr.querySelector("input.rowcheck");
  if (!cb || !cb.dataset.id) return;
  e.preventDefault();
  const id = cb.dataset.id;
  // 右键未勾选的行时自动勾选，保证"导出选中"包含它
  if (!selected.has(id)) { selected.add(id); cb.checked = true; tr.classList.add("picked"); updateSelected(); }
  openCtxMenu(e.clientX, e.clientY, id);
}

/* ---------- 事件绑定与初始化 ---------- */
$("refresh").addEventListener("click", refresh);
$("clear").addEventListener("click", () => {
  records.clear(); selected.clear(); render();
  setStatus("列表已清空，继续捕获中");
});
$("filter").addEventListener("input", render);
$("typeFilter").addEventListener("change", () => {
  if ($("typeFilter").value !== "all") {
    // 收紧档位时清理不符合的记录，保持列表与导出口径一致
    for (const [id, r] of [...records]) {
      if (!matchType(r)) { records.delete(id); selected.delete(id); }
    }
  }
  render();
  setStatus(captureStatus());
});
$("selectAll").addEventListener("change", e => {
  visible.forEach(r => { if (e.target.checked) selected.add(r._id); else selected.delete(r._id); });
  render();
});
$("exportSelected").addEventListener("click", () => exportAs("selected"));
$("exportAll").addEventListener("click", () => exportAs("all"));
$("diagBtn").addEventListener("click", () => showDiag($("diagPanel").hidden));
$("diagClose").addEventListener("click", () => showDiag(false));
$("diagCopy").addEventListener("click", () => copyText(diagPlainText(), "已复制诊断信息"));
$("requests").addEventListener("contextmenu", onRowContextMenu);
document.addEventListener("click", closeCtxMenu);
document.addEventListener("keydown", e => { if (e.key === "Escape") closeCtxMenu(); });
document.addEventListener("contextmenu", e => { if (!e.target.closest || !e.target.closest("#requests")) closeCtxMenu(); });
document.querySelector("main").addEventListener("scroll", closeCtxMenu);
window.addEventListener("blur", closeCtxMenu);
window.addEventListener("resize", closeCtxMenu);
window.addEventListener("error", ev => setStatus("面板错误：" + ev.message, true));

if (chrome.devtools && chrome.devtools.network) {
  chrome.devtools.network.onRequestFinished.addListener(entry => {
    try {
      addEntry(entry); // 先入列表，不等待正文
      fillContent(entry, keyOf(entry));
      setStatus(captureStatus());
    } catch (err) {
      setStatus("捕获异常：" + err.message, true);
    }
  });
  refresh();
  setStatus(captureStatus());
} else {
  setStatus("未检测到 DevTools 环境：请在 F12 开发者工具中打开本面板", true);
  $("requests").innerHTML = "";
  $("requests").append(emptyRow("<b>未检测到 DevTools 环境</b><span>请关闭后重新按 F12 打开开发者工具，再切换到 Chrome接口导出器 面板</span>"));
}
