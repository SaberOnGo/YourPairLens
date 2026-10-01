/* PairLens background service worker (MV3). */
importScripts('pipeline.js', 'collector.js');

const DEFAULT_SERVER = 'https://yourlifebook.app/pairlens/v3';
const MAX_JOBS = 5;

// ---------- settings & state ----------
async function settings() {
  const s = await chrome.storage.local.get(['install', 'server', 'unlockToken', 'unlockExpires', 'notify']);
  if (!s.install) { s.install = crypto.randomUUID(); await chrome.storage.local.set({ install: s.install }); }
  if (s.unlockExpires && s.unlockExpires < Date.now()) s.unlockToken = '';
  return { install: s.install, server: s.server || DEFAULT_SERVER, unlockToken: s.unlockToken || '', notify: s.notify !== false };
}

async function setState(uid, patch) {
  const key = 'job:' + uid;
  const cur = (await chrome.storage.local.get(key))[key] || {};
  const next = Object.assign(cur, patch, { updatedAt: Date.now() });
  await chrome.storage.local.set({ [key]: next });
  chrome.runtime.sendMessage({ pl: 'state', uid, state: next }).catch(() => {});
  return next;
}

// Recent Zhihu request volume, used to pick a gentler pace after heavy use or a rate limit.
async function paceHistory() { return (await chrome.storage.local.get('paceHistory')).paceHistory || []; }
async function recordPace(entry) {
  const now = Date.now();
  const h = (await paceHistory()).filter(x => now - x.t < 60 * 60000);
  h.push(Object.assign({ t: now }, entry));
  await chrome.storage.local.set({ paceHistory: h.slice(-200) });
}

// ---------- Zhihu tab messaging (never reloads the user's page) ----------
async function ensureContent(tabId) {
  const ping = await new Promise(r => chrome.tabs.sendMessage(tabId, { pl: 'ping' }, x => { void chrome.runtime.lastError; r(x); }));
  if (ping && ping.ok) return;
  await chrome.scripting.executeScript({ target: { tabId }, files: ['collector.js', 'content.js'] });
}

// The job's own tab may have been closed while it waited in the queue: use another open Zhihu tab.
async function liveZhihuTab(job) {
  try { const t = await chrome.tabs.get(job.tabId); if (/^https:\/\/(www|zhuanlan)\.zhihu\.com\//.test(t.url || '')) return job.tabId; } catch (_) {}
  const [other] = await chrome.tabs.query({ url: ['https://www.zhihu.com/*', 'https://zhuanlan.zhihu.com/*'] });
  if (!other) throw new Error('没有打开的知乎页面，请打开任意知乎页面后重新分析');
  job.tabId = other.id;
  return other.id;
}

async function toTab(job, msg) {
  const tabId = await liveZhihuTab(job);
  await ensureContent(tabId);
  return new Promise((resolve, reject) => {
    chrome.tabs.sendMessage(tabId, msg, r => {
      if (chrome.runtime.lastError) return reject(new Error('无法连接知乎页面'));
      if (!r || !r.ok) return reject(Object.assign(new Error((r && r.error) || '采集失败'), { code: r && r.code }));
      resolve(r.r);
    });
  });
}

// ---------- queue: first clicked, first served; one job talks to Zhihu at a time ----------
const jobs = new Map(); // uid -> { uid, name, tabId, url, ctl, status: 'queued'|'running', addedAt }
const order = [];       // uids in queue order; order[0] is the running job when busy
let recent = [];        // recently finished [{ uid, name, status, finishedAt }]
let busy = false;

function queueView() {
  return {
    maxJobs: MAX_JOBS,
    items: order.map((uid, i) => { const j = jobs.get(uid); return { uid, name: j.name, status: j.status, position: j.status === 'queued' ? order.filter(u => jobs.get(u).status === 'queued').indexOf(uid) + 1 : 0, index: i }; }),
    recent
  };
}

function broadcastQueue() {
  const v = queueView();
  chrome.runtime.sendMessage({ pl: 'queue', queue: v }).catch(() => {});
  chrome.action.setBadgeText({ text: order.length ? String(order.length) : '' });
  chrome.action.setBadgeBackgroundColor({ color: '#2f6fde' });
  let ahead = 0;
  for (const uid of order) {
    const j = jobs.get(uid);
    if (j.status === 'queued') setState(uid, { status: 'running', queued: true, stage: `已加入队列，前面还有 ${ahead} 个账号`, pct: 1 });
    ahead++;
  }
}

async function enqueue(tabId, uid, fresh, name, url) {
  if (jobs.has(uid)) return { ok: true, already: true, queue: queueView() };
  if (jobs.size >= MAX_JOBS) {
    const names = [...jobs.values()].map(j => j.name).join('、');
    return { ok: false, error: `最多同时分析 ${MAX_JOBS} 个账号。当前队列：${names}。请等其中一个完成，或在队列中移除一个后再加入。` };
  }
  const job = { uid, name: name || uid, tabId, url: url || `https://www.zhihu.com/people/${uid}`, fresh, ctl: new AbortController(), status: 'queued', addedAt: Date.now() };
  jobs.set(uid, job);
  order.push(uid);
  await setState(uid, { status: 'running', queued: true, stage: '已加入队列', pct: 1, error: '', startedAt: Date.now(), report: null, trace: null, name: job.name });
  broadcastQueue();
  pump();
  return { ok: true, queued: busy, position: order.length, queue: queueView() };
}

function pump() {
  if (busy) return;
  const next = order.find(uid => jobs.get(uid).status === 'queued');
  if (!next) return;
  busy = true;
  // Keep the running job at the front of the visible order.
  order.splice(order.indexOf(next), 1); order.unshift(next);
  run(jobs.get(next)).finally(() => { busy = false; pump(); });
}

function removeJob(uid) {
  const j = jobs.get(uid);
  if (!j) return false;
  j.ctl.abort();
  if (j.status === 'queued') {
    jobs.delete(uid); order.splice(order.indexOf(uid), 1);
    setState(uid, { status: 'stopped', queued: false, error: '已从队列移除', pct: 0 });
    broadcastQueue();
  }
  return true;
}

function moveJob(uid, delta) {
  const i = order.indexOf(uid);
  const j = jobs.get(uid);
  if (i < 0 || !j || j.status !== 'queued') return false;
  const k = i + delta;
  if (k < 0 || k >= order.length || jobs.get(order[k]).status !== 'queued') return false;
  [order[i], order[k]] = [order[k], order[i]];
  broadcastQueue();
  return true;
}

async function run(job) {
  const { uid, ctl } = job;
  job.status = 'running';
  broadcastQueue();
  await setState(uid, { status: 'running', queued: false, stage: '开始', pct: 2, startedAt: Date.now() });
  const s = await settings();
  const server = PairLensPipeline.httpServer(s.server, { install: s.install, unlockToken: s.unlockToken });
  const pace = PairLensCollector.recommendPace(await paceHistory());
  // The daily limit counts only analyses that need new AI calls; the server decides, so the
  // extension always runs (cached results and rule-only analyses stay free).
  const cacheOnly = false;
  let requests = 0;
  const zhihu = {
    fingerprint: (u, o) => toTab(job, { pl: 'fingerprint', uid: u, pace: o && o.pace }).then(r => { requests += (r.stats && r.stats.requests) || 1; return r; }),
    collect: (u, o) => toTab(job, { pl: 'collect', uid: u, budgetMs: o.budgetMs, pace: o.pace }).then(r => { requests += (r.stats && r.stats.requests) || 0; return r; })
  };
  const onAbort = () => chrome.tabs.sendMessage(job.tabId, { pl: 'abort', uid }, () => void chrome.runtime.lastError);
  ctl.signal.addEventListener('abort', onAbort);
  let outcome;
  try {
    const { report, trace } = await PairLensPipeline.analyzeUser({ uid, server, zhihu, fresh: job.fresh && !cacheOnly, cacheOnly, pace, signal: ctl.signal, onProgress: (stage, pct) => { setState(uid, { stage, pct }); } });
    await recordPace({ requests, rateLimited: false });
    await setState(uid, { status: 'done', queued: false, stage: '完成', pct: 100, report, trace: Object.assign(trace, { paceReason: pace.reason }) });
    outcome = { status: 'done', report };
  } catch (e) {
    // A failed collect still sent requests; count a typical cold run when the exact number is unknown.
    await recordPace({ requests: requests || 30, rateLimited: e.code === 'RATE_LIMIT' });
    const status = e.code === 'STOPPED' ? 'stopped' : e.code === 'QUOTA' ? 'quota' : 'error';
    await setState(uid, { status, queued: false, error: e.message, pct: 0 });
    outcome = { status, error: e.message };
  } finally {
    jobs.delete(uid);
    order.splice(order.indexOf(uid), 1);
    recent = [{ uid, name: job.name, status: outcome ? outcome.status : 'error', finishedAt: Date.now() }, ...recent.filter(r => r.uid !== uid)].slice(0, 5);
    broadcastQueue();
  }
  if (outcome.status !== 'stopped') notifyDone(job, outcome);
}

// ---------- completion notice: system notification + short chime when the popup is closed ----------
let popupPorts = 0;
chrome.runtime.onConnect.addListener(port => {
  if (port.name !== 'popup') return;
  popupPorts++;
  port.onDisconnect.addListener(() => { popupPorts--; });
});

async function notifyDone(job, outcome) {
  const s = await settings();
  if (!s.notify || popupPorts > 0) return;
  const r = outcome.report;
  const message = outcome.status === 'done'
    ? `${r.label || '分析完成'}｜风险 ${r.scores.risk ?? '无法判断'}，真实度 ${r.scores.authenticity ?? '—'}，择偶意愿 ${r.scores.interest ?? '—'}`
    : `分析未完成：${outcome.error}`;
  chrome.notifications.create('pl:' + job.uid, { type: 'basic', iconUrl: 'icons/icon-128.png', title: `PairLens：${job.name}`, message, priority: 1, silent: true });
  playChime().catch(() => {});
}

async function playChime() {
  if (!(await chrome.offscreen.hasDocument())) {
    await chrome.offscreen.createDocument({ url: 'offscreen.html', reasons: ['AUDIO_PLAYBACK'], justification: '分析完成时播放提示音' });
  }
  await chrome.runtime.sendMessage({ pl: 'chime' });
}

chrome.notifications.onClicked.addListener(async id => {
  if (!id.startsWith('pl:')) return;
  const uid = id.slice(3);
  chrome.notifications.clear(id);
  await chrome.storage.local.set({ focusUid: uid });
  // Open the analysed account in a new tab (never navigate the user's current page).
  chrome.tabs.create({ url: `https://www.zhihu.com/people/${uid}` });
});

// ---------- messages ----------
chrome.runtime.onMessage.addListener((msg, sender, reply) => {
  if (!msg || !msg.pl) return;
  if (msg.pl === 'progress' && msg.uid && jobs.has(msg.uid)) { setState(msg.uid, { stage: msg.stage, pct: 10 + Math.round((msg.pct || 0) * 0.7) }); return; }
  if (msg.pl === 'candidates') {
    ensureContent(msg.tabId).then(() => chrome.tabs.sendMessage(msg.tabId, { pl: 'candidates' }, x => { void chrome.runtime.lastError; reply(x || null); }), () => reply(null));
    return true;
  }
  if (msg.pl === 'start') { enqueue(msg.tabId, msg.uid, !!msg.fresh, msg.name, msg.url).then(reply); return true; }
  if (msg.pl === 'stop' || msg.pl === 'remove') { reply({ ok: removeJob(msg.uid) }); return; }
  if (msg.pl === 'move') { reply({ ok: moveJob(msg.uid, msg.delta) }); return; }
  if (msg.pl === 'queue') { reply(queueView()); return; }
  if (msg.pl === 'usage') {
    settings().then(s => fetch(`${s.server}/usage`, { headers: { 'x-pairlens-install': s.install } }).then(r => r.json()))
      .then(u => reply({ ok: true, usage: u.usage, limits: u.limits, left: u.left, running: jobs.size, maxJobs: MAX_JOBS }), () => reply({ ok: false, running: jobs.size, maxJobs: MAX_JOBS }));
    return true;
  }
  if (msg.pl === 'getState') { chrome.storage.local.get('job:' + msg.uid).then(r => reply(r['job:' + msg.uid] || null)); return true; }
  if (msg.pl === 'setNotify') { chrome.storage.local.set({ notify: !!msg.on }).then(() => reply({ ok: true })); return true; }
  if (msg.pl === 'unlock') {
    settings().then(s => PairLensPipeline.httpServer(s.server, { install: s.install }).unlock(msg.code))
      .then(async r => { await chrome.storage.local.set({ unlockToken: r.token, unlockExpires: r.expiresAt }); reply({ ok: true }); }, e => reply({ ok: false, error: e.message }));
    return true;
  }
  if (msg.pl === 'refreshReport') {
    // Re-read a finished report with the unlock token so difficulty becomes visible.
    settings().then(s => PairLensPipeline.httpServer(s.server, { install: s.install, unlockToken: s.unlockToken }).getReport(msg.uid))
      .then(async r => { if (r && r.report) await setState(msg.uid, { report: r.report }); reply({ ok: true }); }, e => reply({ ok: false, error: e.message }));
    return true;
  }
});

// Unfinished jobs after a browser/worker restart are marked stopped; only the user restarts them.
async function markInterrupted(reason) {
  const all = await chrome.storage.local.get(null);
  for (const [k, v] of Object.entries(all)) if (k.startsWith('job:') && v && v.status === 'running' && !jobs.has(k.slice(4))) await chrome.storage.local.set({ [k]: Object.assign(v, { status: 'stopped', queued: false, error: reason }) });
}
chrome.runtime.onStartup.addListener(() => markInterrupted('浏览器重启，分析已暂停，可重新加入队列'));
markInterrupted('插件已重新加载，分析已暂停，可重新加入队列');
