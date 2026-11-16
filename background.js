/* Chrome接口导出器 后台 service worker
 * 两件事：
 * 1) 受面板委托代下载（面板下载能力受限时的备用通道，chrome.downloads + saveAs + filename）；
 * 2) 改名兜底：面板最后只能用 <a download> 兜底时，DevTools 会丢掉 download 属性，
 *    Chrome 就拿 blob URL 的 UUID 段当文件名（xxxxxxxx-….json）。面板点下载前先发一条
 *    api-exporter-rename 消息，这里用 onDeterminingFilename 把名字改回接口名。
 */
const RENAME_TTL = 20000;   // 待改名任务的有效期，避免误改用户自己的下载
const pendingNames = [];

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg && msg.type === "api-exporter-rename" && msg.filename) {
    pendingNames.push({
      name: String(msg.filename),
      url: String(msg.url || ""),           // 精确对应这一次下载，devtools 里 blob URL 可能是 blob:null/…
      ts: Date.now()
    });
    sendResponse({ ok: true });
  }
  return false;
});

if (chrome.downloads && chrome.downloads.onDeterminingFilename) {
  chrome.downloads.onDeterminingFilename.addListener((item, suggest) => {
    try {
      const url = String((item && item.url) || "");
      // data URL 一律认领；blob URL 也认领（面板 iframe 的 blob 可能是 blob:null/<uuid>，
      // 不能只认 blob:chrome-extension:// 前缀），但必须有刚登记过的目标文件名
      const own = url.startsWith("data:application/json") || url.startsWith("blob:");
      if (!own) return false;               // 不是本扩展的下载，交给浏览器自己决定

      const now = Date.now();
      while (pendingNames.length && now - pendingNames[0].ts > RENAME_TTL) pendingNames.shift();
      if (!pendingNames.length) return false;

      // 优先按 URL 精确匹配；Chrome 改写过 URL 时退回最早一条登记
      let idx = pendingNames.findIndex(p => p.url && p.url === url);
      if (idx < 0) idx = 0;
      const { name } = pendingNames.splice(idx, 1)[0];
      suggest({ filename: name, conflictAction: "uniquify" });
      return true;                          // 认领这条下载
    } catch (err) {
      return false;                         // 出任何异常都不认领，绝不影响浏览器正常下载
    }
  });
}

chrome.runtime.onConnect.addListener(port => {
  if (port.name !== "api-exporter-download") return;
  port.onMessage.addListener(msg => {
    if (!msg) return;
    port.postMessage({ ack: true }); // 先回执，面板撤销看门狗
    const filename = String(msg.filename || "export.json");
    const finish = (ok, error) => {
      try { port.postMessage({ done: true, ok: !!ok, error: error || null }); } catch (err) { /* 端口已关 */ }
    };
    const start = url => {
      try {
        chrome.downloads.download({ url, filename, saveAs: true }, () => {
          const err = chrome.runtime.lastError;
          finish(!err, err ? err.message : null);
        });
      } catch (err) { finish(false, err.message); }
    };
    const toDataUrl = blob => new Promise((resolve, reject) => {
      const fr = new FileReader();
      fr.onload = () => resolve(fr.result);
      fr.onerror = () => reject(new Error("FileReader 读取失败"));
      fr.readAsDataURL(blob);
    });
    if (msg.dataUrl) { start(msg.dataUrl); return; }
    if (msg.url) {
      // blob URL 的作用域属于创建它的面板文档，service worker 里 fetch 通常拿不到；
      // 面板发现失败后会改传 data URL，这里如实回报错误即可。
      fetch(msg.url).then(r => {
        if (!r.ok) throw new Error("HTTP " + r.status);
        return r.blob();
      }).then(toDataUrl).then(start).catch(err => finish(false, String((err && err.message) || err)));
      return;
    }
    finish(false, "缺少下载内容");
  });
});
