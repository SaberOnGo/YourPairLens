/* PairLens popup. */
'use strict';
const $ = id => document.getElementById(id);
const send = msg => new Promise(r => chrome.runtime.sendMessage(msg, r));
let tabId = null, page = { candidates: [], loggedIn: false }, selected = null, queue = { items: [], recent: [], maxJobs: 5 };
let dialogFor = null;

chrome.runtime.connect({ name: 'popup' }); // lets the background skip notifications while the popup is open

// ---------- friendly wording ----------
const STAGES = [
  [/查询服务器缓存/, '看看是否已有分析结果…'],
  [/核对主页是否有更新/, '已有结果，确认 TA 最近有没有新动态…'],
  [/采集公开资料|读取主页资料/, '正在打开 TA 的主页资料…'],
  [/读取本人回答与关注关系/, '正在阅读 TA 的回答和关注…'],
  [/核对求偶帖评论者/, '正在看求偶帖下的互动…'],
  [/核对互关者的公开内容/, '正在了解 TA 的互关好友…'],
  [/整理资料/, '正在整理资料…'],
  [/服务器评分/, '综合判断中（含 AI 复核）…'],
  [/^开始$/, '准备中…']
];
const friendlyStage = s => { for (const [re, t] of STAGES) if (re.test(s || '')) return t; return s || '分析中…'; };
const SCORE_ROWS = [
  ['risk', '风险度', '越低越好', v => v >= 75 ? 'var(--bad)' : v >= 40 ? 'var(--warn)' : 'var(--good)'],
  ['authenticity', '真实度', '像不像真人真资料', v => v >= 70 ? 'var(--good)' : v >= 40 ? 'var(--warn)' : 'var(--bad)'],
  ['sincerity', '真诚度', '表达是否具体坦诚', v => v >= 70 ? 'var(--good)' : v >= 40 ? 'var(--warn)' : 'var(--bad)'],
  ['interest', '择偶意愿', '现在想不想脱单', () => 'var(--brand)'],
  ['difficulty', '竞争激烈度', '追 TA 的人多不多', () => 'var(--brand)']
];
// Simple line icons (no emoji), drawn with currentColor so they follow the theme.
const ICONS = {
  check: '<path d="M5 12.5l4.2 4.2L19 7"/>',
  alert: '<path d="M12 4.5L21 19.5H3z"/><path d="M12 10v4.2"/><path d="M12 17.1v.1"/>',
  eye: '<path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12z"/><circle cx="12" cy="12" r="2.8"/>',
  info: '<circle cx="12" cy="12" r="8.5"/><path d="M12 11v5"/><path d="M12 7.9v.1"/>',
  search: '<circle cx="11" cy="11" r="6"/><path d="M15.5 15.5L20 20"/>',
  lock: '<rect x="5" y="10.5" width="14" height="9.5" rx="2"/><path d="M8.5 10.5V8a3.5 3.5 0 0 1 7 0v2.5"/>',
  up: '<path d="M6.5 14.5L12 9l5.5 5.5"/>',
  down: '<path d="M6.5 9.5L12 15l5.5-5.5"/>',
  x: '<path d="M7 7l10 10M17 7L7 17"/>'
};
function icon(name, size = 18) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24'); svg.setAttribute('width', size); svg.setAttribute('height', size);
  svg.setAttribute('fill', 'none'); svg.setAttribute('stroke', 'currentColor'); svg.setAttribute('stroke-width', '2');
  svg.setAttribute('stroke-linecap', 'round'); svg.setAttribute('stroke-linejoin', 'round'); svg.setAttribute('aria-hidden', 'true');
  svg.innerHTML = ICONS[name] || '';
  return svg;
}
document.querySelectorAll('[data-icon]').forEach(el => el.append(icon(el.dataset.icon, el.classList.contains('empty-icon') ? 26 : 15)));

const PALETTE = ['#6a6ae0', '#e0716a', '#3fa58a', '#d9932b', '#8a63d2', '#2f8fd8', '#c0567f', '#5a9e3a'];
function avatar(name, uid) {
  const el = document.createElement('div');
  el.className = 'avatar';
  let h = 0; for (const c of uid || name || '') h = (h * 31 + c.charCodeAt(0)) >>> 0;
  el.style.background = PALETTE[h % PALETTE.length];
  el.textContent = Array.from((name || uid || '?').trim())[0] || '?';
  return el;
}
// Group QR: read from the server first so it can be replaced without a new release; fall back to the bundled copy.
const QR_URL = 'https://yourlifebook.app/pairlens/v3/client/group-qr.jpg?d=' + new Date().toISOString().slice(0, 10);
let qrFolded = false; // remembered across the periodic re-render
function groupBlock(title, withQr, noteText) {
  if (!withQr) {
    const box = document.createElement('div'); box.className = 'group';
    const t = document.createElement('p'); t.className = 'group-title'; t.textContent = title; box.append(t);
    return box;
  }
  // Shown open by default; the arrow on the title folds the QR away.
  const box = document.createElement('details'); box.className = 'group'; box.open = !qrFolded;
  box.addEventListener('toggle', () => { qrFolded = !box.open; });
  const t = document.createElement('summary'); t.className = 'group-title'; t.textContent = title;
  const img = Object.assign(document.createElement('img'), { className: 'qr', alt: '群二维码', src: QR_URL });
  img.addEventListener('error', () => { if (!img.dataset.fallback) { img.dataset.fallback = '1'; img.src = 'images/group-qr.jpg'; } }, { once: false });
  const note = document.createElement('p'); note.className = 'group-note'; note.textContent = noteText || '群二维码过期后，请加微信 after5050，备注来由，邀您进群';
  box.append(t, img, note);
  return box;
}

const nameOf = uid => ((page.candidates || []).find(c => c.uid === uid) || (queue.items || []).find(q => q.uid === uid) || (queue.recent || []).find(q => q.uid === uid) || {}).name || uid;

// ---------- people ----------
function personHint(c) {
  if (c.kind === 'profile') return '你正在看 TA 的主页';
  if (c.kind === 'manual') return '你手动添加的';
  if (c.distance === 0) return '你正在看的这条回答';
  return c.visible ? '屏幕上的另一位回答者' : '页面上的其他回答者';
}
function renderPeople() {
  const box = $('candidates');
  box.textContent = '';
  const list = page.candidates || [];
  $('emptyPeople').hidden = list.length > 0;
  if (!page.onZhihu) $('emptyText').textContent = '请在知乎页面上打开识缘。';
  else if (!page.loggedIn) $('emptyText').textContent = '请先登录知乎，再打开识缘。';
  for (const c of list) {
    const row = document.createElement('label');
    row.className = 'person' + (selected === c.uid ? ' on' : '');
    const input = Object.assign(document.createElement('input'), { type: 'radio', name: 'person', value: c.uid, checked: selected === c.uid });
    input.addEventListener('change', () => select(c.uid));
    const who = document.createElement('div');
    who.className = 'who';
    const nm = document.createElement('div'); nm.className = 'nm'; nm.textContent = c.name || c.uid;
    const hint = document.createElement('div'); hint.className = 'hint'; hint.textContent = personHint(c);
    who.append(nm, hint);
    const check = document.createElement('div'); check.className = 'check';
    row.append(input, avatar(c.name, c.uid), who, check);
    box.append(row);
  }
}
function select(uid) { selected = uid; renderPeople(); renderQueue(); refresh(); }

// ---------- action + progress ----------
function queuePos(uid) { const it = queue.items.find(q => q.uid === uid); return it ? it : null; }
function renderAction(st) {
  const btn = $('action'), txt = $('actionText');
  const q = queuePos(selected);
  btn.className = 'primary';
  btn.disabled = !selected || !page.loggedIn;
  if (q && q.status === 'running') { txt.textContent = '停止分析'; btn.classList.add('stop'); }
  else if (q) { txt.textContent = `排队中 · 第 ${q.position} 位（点击移出）`; btn.classList.add('queued'); }
  else if (queue.items.some(i => i.status === 'running')) txt.textContent = queue.items.length >= queue.maxJobs ? '队列已满（最多 5 位）' : '加入分析队列';
  else txt.textContent = st && st.status === 'done' ? '重新分析' : '开始了解 TA';
  if (!q && queue.items.length >= queue.maxJobs) btn.disabled = true;

  const running = q && q.status === 'running';
  $('progressWrap').hidden = !q;
  const pct = running ? Math.max(3, (st && st.pct) || 3) : 0;
  $('bar').style.width = pct + '%';
  document.querySelector('.progress').setAttribute('aria-valuenow', String(pct));
  const stage = $('stage');
  stage.textContent = '';
  if (running) { const sp = document.createElement('span'); sp.className = 'spinner'; stage.append(sp, document.createTextNode(friendlyStage(st && st.stage))); }
  else if (q) stage.textContent = q.position === 1 ? '下一个就轮到 TA' : `前面还有 ${q.position - 1} 位在等待`;

  const n = $('notice');
  n.hidden = true; n.className = 'notice';
  if (!q && st && st.status === 'quota') { n.hidden = false; n.textContent = '今天的新分析次数已用完，TA 暂时还没有分析结果。北京时间明早 8 点恢复。'; showQuota(true); }
  if (!q && st && st.status === 'error') { n.hidden = false; n.textContent = st.error; }
  else if (!q && st && st.status === 'stopped' && st.error) { n.hidden = false; n.className = 'notice ok'; n.textContent = /移除/.test(st.error) ? '已移出队列。' : '已停止，读到的资料已保留，可以随时继续。'; }
}
function showNotice(text, ok) { const n = $('notice'); n.hidden = false; n.className = 'notice' + (ok ? ' ok' : ''); n.textContent = text; }

// ---------- result ----------
function renderReport(rep, st) {
  renderReport.last = rep;
  $('result').hidden = !rep;
  $('saveImage').disabled = !rep;
  if (!rep) return;
  const risk = rep.scores.risk;
  const tone = risk == null ? 'unknown' : risk >= 75 ? 'bad' : risk >= 40 ? 'mid' : 'good';
  $('verdict').className = 'verdict ' + tone;
  $('verdictIcon').replaceChildren(icon({ bad: 'alert', mid: 'eye', good: 'check', unknown: 'info' }[tone], 20));
  $('resName').textContent = rep.name || rep.uid;
  $('resLabel').textContent = rep.label || '';
  const isSelf = page.currentUserId && rep.profileId && page.currentUserId === rep.profileId;
  const box = $('scores'); box.textContent = '';
  for (const [k, label, help, color] of SCORE_ROWS) {
    // Locked difficulty is shown only as the unlock box below, not as an empty bar.
    if (k === 'difficulty' && (isSelf || rep.scores.difficulty == null)) continue;
    const v = rep.scores[k];
    const wrap = document.createElement('div');
    const head = document.createElement('div'); head.className = 'score-head';
    const l = document.createElement('span'); l.className = 'lbl'; l.textContent = label;
    const s = document.createElement('small'); s.textContent = help; l.append(s);
    const val = document.createElement('span'); val.className = 'val' + (v == null ? ' na' : '');
    val.textContent = v == null ? (k === 'difficulty' ? '需验证码' : '资料不足，无法判断') : v + '%';
    head.append(l, val);
    const meter = document.createElement('div'); meter.className = 'meter';
    const fill = document.createElement('div'); if (v != null) { fill.style.width = Math.max(2, v) + '%'; fill.style.background = color(v); }
    meter.append(fill); wrap.append(head, meter); box.append(wrap);
  }
  // Answers that are only pictures cannot be read yet: invite to the group for advanced features.
  const imgs = rep.imageOnlyPosts || [];
  $('imageOnly').hidden = !imgs.length;
  if (imgs.length) {
    const t = $('imageOnlyText'); t.textContent = `TA 有 ${imgs.length} 篇择偶回答是图片形式，识缘暂时无法识别图片内容。`;
    for (const p of imgs.slice(0, 2)) if (/^https:\/\/(www|zhuanlan)\.zhihu\.com\//.test(p.url || '')) t.append(Object.assign(document.createElement('a'), { href: p.url, target: '_blank', rel: 'noopener', textContent: ' 查看原文' }));
    $('imageOnlyGroup').replaceChildren(groupBlock('加入LifeBook 交友 & 识缘反馈群，获取高级功能', true));
  }
  $('unlock').hidden = isSelf || !rep.difficultyLocked;
  if (!$('unlock').hidden) $('unlockGroup').replaceChildren(groupBlock(imgs.length ? '在上方群里获取验证码，即可查看。' : '加入LifeBook 交友&PairLens群，获取更多 & 交友', !imgs.length));
  const ul = $('reasons'); ul.textContent = '';
  for (const r of rep.reasons || []) {
    const li = document.createElement('li');
    li.className = r.kind || 'info';
    li.append(document.createTextNode(r.text));
    for (const s of (r.sources || []).slice(0, 3)) {
      if (!/^https:\/\/(www|zhuanlan)\.zhihu\.com\//.test(s.url || '')) continue;
      li.append(Object.assign(document.createElement('a'), { href: s.url, target: '_blank', rel: 'noopener', textContent: `查看原文${s.date ? '（' + s.date + '）' : ''}` }));
    }
    ul.append(li);
  }
  if (rep.permanent && st && st.trace && st.trace.cacheHit && !st.queued) {
    const d = new Date(rep.analyzedAt || Date.now()).toLocaleDateString('zh-CN');
    showNotice(`此为 ${d} 的分析结果：高风险。如有疑问，可点「重新分析」重新核对。`);
  }
  const t = st && st.trace;
  const when = new Date(rep.analyzedAt || Date.now()).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });
  $('meta').textContent = `分析于 ${when}` + (t && t.totalMs ? ` · 用时 ${(t.totalMs / 1000).toFixed(1)} 秒` : '') + (t && t.cacheHit ? ' · 使用已有结果' : '') + ` · 策略 ${rep.strategyVersion}`;
}

// ---------- queue ----------
function pill(status, position) {
  const p = document.createElement('span');
  if (status === 'running') { p.className = 'pill run'; const sp = document.createElement('span'); sp.className = 'spinner'; p.append(sp, '分析中'); }
  else if (status === 'queued') { p.className = 'pill wait'; p.textContent = `第 ${position} 位`; }
  else if (status === 'done') { p.className = 'pill done'; p.textContent = '已完成'; }
  else { p.className = 'pill err'; p.textContent = status === 'stopped' ? '已停止' : '未完成'; }
  return p;
}
function iconBtn(name, title, onClick, disabled, extra) {
  const b = Object.assign(document.createElement('button'), { type: 'button', className: 'icon-btn' + (extra ? ' ' + extra : ''), title, disabled: !!disabled });
  b.append(icon(name, 15));
  b.setAttribute('aria-label', title);
  b.addEventListener('click', e => { e.stopPropagation(); onClick(); });
  return b;
}
function renderQueue() {
  const items = queue.items || [], recent = (queue.recent || []).filter(r => !items.some(i => i.uid === r.uid));
  $('queueCard').hidden = !items.length && !recent.length;
  const ol = $('queue'); ol.textContent = '';
  const queued = items.filter(i => i.status === 'queued');
  for (const it of items) {
    const li = document.createElement('li'); li.className = 'qi' + (it.uid === selected ? ' sel' : '');
    const nm = document.createElement('span'); nm.className = 'nm'; nm.textContent = it.name || it.uid; nm.title = '查看进度';
    nm.addEventListener('click', () => { ensureCandidate(it.uid, it.name); select(it.uid); });
    li.append(avatar(it.name, it.uid), nm, pill(it.status, it.position));
    if (it.status === 'queued') {
      const qi = queued.indexOf(it);
      li.append(iconBtn('up', '提前', () => send({ pl: 'move', uid: it.uid, delta: -1 }).then(loadQueue), qi === 0),
                iconBtn('down', '延后', () => send({ pl: 'move', uid: it.uid, delta: 1 }).then(loadQueue), qi === queued.length - 1),
                iconBtn('x', '移出队列', () => send({ pl: 'remove', uid: it.uid }).then(loadQueue), false, 'x'));
    } else li.append(iconBtn('x', '停止分析', () => askStop(it.uid), false, 'x'));
    ol.append(li);
  }
  $('recentBox').hidden = !recent.length;
  const ul = $('recent'); ul.textContent = '';
  for (const r of recent) {
    const li = document.createElement('li'); li.className = 'qi' + (r.uid === selected ? ' sel' : '');
    const nm = document.createElement('span'); nm.className = 'nm'; nm.textContent = r.name || r.uid; nm.title = '查看结果';
    nm.addEventListener('click', () => { ensureCandidate(r.uid, r.name); select(r.uid); });
    li.append(avatar(r.name, r.uid), nm, pill(r.status));
    ul.append(li);
  }
}
function ensureCandidate(uid, name) {
  if (!(page.candidates || []).some(c => c.uid === uid)) { page.candidates = [...(page.candidates || []), { uid, name: name || uid, kind: 'manual' }]; renderPeople(); }
}
async function loadQueue() { queue = (await send({ pl: 'queue' })) || queue; renderQueue(); refresh(); }

// ---------- usage ----------
async function loadUsage() {
  const u = await send({ pl: 'usage' });
  if (!u || !u.ok || !u.limits) { $('usage').textContent = ''; return; }
  const left = typeof u.left === 'number' ? u.left : Math.max(0, u.limits.noAi - (u.usage.noAi + u.usage.withAi));
  $('usage').textContent = left > 0 ? `今天至少还能分析 ${Math.min(left, u.limits.noAi)} 位 · 已有分析结果不占次数` : `今天的新分析次数已用完，北京时间明早 8 点恢复 · 已有分析结果仍可查看`;
  showQuota(left <= 0);
}

// Daily analyses used up: invite to the group (QR + WeChat note).
function showQuota(on) {
  const box = $('quotaBox');
  box.hidden = !on;
  if (on && !box.firstChild) box.append(groupBlock('今天的新分析次数已用完。加入 LifeBook 交友&识缘反馈群，获取更多次数和交友机会', true, '群满可加微信 after5050，注明来由，邀请您进群'));
}

// ---------- refresh ----------
async function refresh() {
  if (!selected) { renderAction(null); renderReport(null); return; }
  const st = await send({ pl: 'getState', uid: selected });
  renderAction(st);
  renderReport(st && st.report, st);
}

// ---------- events ----------
$('action').addEventListener('click', async () => {
  const q = queuePos(selected);
  if (q) return askStop(selected);
  const cand = (page.candidates || []).find(c => c.uid === selected);
  // "重新分析" after a finished result means the user wants a fresh look: skip every cache.
  const prev = await send({ pl: 'getState', uid: selected });
  const fresh = !!(prev && prev.status === 'done');
  const r = await send({ pl: 'start', tabId, uid: selected, name: cand && cand.name, fresh });
  if (r && !r.ok) { showNotice(r.error); return; }
  if (r && r.queue) queue = r.queue;
  renderQueue(); await refresh(); loadUsage();
  if (r && r.queued) showNotice(`已加入分析队列，排在第 ${queuePos(selected) ? queuePos(selected).position : r.position} 位。完成后会提醒你。`, true);
});
function askStop(uid) {
  dialogFor = uid;
  const q = queuePos(uid);
  const queued = q && q.status === 'queued';
  $('stopDialog').querySelector('h3').textContent = queued ? `把「${nameOf(uid)}」移出队列？` : `停止分析「${nameOf(uid)}」？`;
  $('stopText').textContent = queued ? '移出后可以随时重新加入。' : '已经读到的资料会保留，下次可以接着分析。';
  $('confirmStop').textContent = queued ? '移出' : '停止';
  $('cancelStop').textContent = queued ? '保留' : '继续分析';
  $('stopDialog').showModal();
  $('cancelStop').focus();
}
$('cancelStop').addEventListener('click', () => $('stopDialog').close());
$('confirmStop').addEventListener('click', async () => { $('stopDialog').close(); await send({ pl: 'stop', uid: dialogFor }); loadQueue(); });
$('manualAdd').addEventListener('click', async () => {
  const m = ($('manualUrl').value || '').match(/zhihu\.com\/people\/([A-Za-z0-9._-]{1,80})/);
  if (!m) { showNotice('请粘贴形如 https://www.zhihu.com/people/… 的主页链接。'); return; }
  const manual = (await chrome.storage.local.get('manual')).manual || [];
  if (!manual.some(x => x.uid === m[1])) manual.unshift({ uid: m[1], name: m[1] });
  await chrome.storage.local.set({ manual: manual.slice(0, 5) });
  page.candidates = [{ uid: m[1], name: m[1], kind: 'manual' }, ...(page.candidates || []).filter(c => c.uid !== m[1])];
  $('manualUrl').value = '';
  select(m[1]);
});
$('unlockBtn').addEventListener('click', async () => {
  const r = await send({ pl: 'unlock', code: $('code').value.trim() });
  $('unlockMsg').textContent = r.ok ? '已解锁，24 小时内有效。' : r.error;
  if (r.ok) { await send({ pl: 'refreshReport', uid: selected }); refresh(); }
});
// ---------- save the result as a picture ----------
// Draws a copy of the header + result card through an SVG foreignObject, so no extra library or permission is needed.
const toDataUrl = async src => {
  const b = await (await fetch(src)).blob();
  return new Promise((ok, bad) => { const fr = new FileReader(); fr.onload = () => ok(fr.result); fr.onerror = bad; fr.readAsDataURL(b); });
};
async function saveImage(hideName) {
  const css = (await (await fetch('popup.css')).text()).replace(/html, body \{/g, '.snap {').replace(/^body \{/gm, '.snap {');
  const snap = document.createElement('div');
  snap.className = 'snap';
  snap.style.cssText = 'position:fixed;left:-10000px;top:0;width:380px;padding-bottom:12px';
  const head = document.querySelector('header.top').cloneNode(true);
  const res = $('result').cloneNode(true);
  res.removeAttribute('id'); res.querySelectorAll('[id]').forEach(e => e.removeAttribute('id'));
  res.style.margin = '0 12px';
  // A folded QR stays folded in the picture: drop its content, keep only the title line.
  for (const d of res.querySelectorAll('details.group:not([open])')) for (const c of [...d.children]) if (c.tagName !== 'SUMMARY') c.remove();
  const live = $('code'), code = res.querySelector('input'); if (code && live) code.setAttribute('value', live.value);
  const foot = document.createElement('p'); foot.className = 'tiny';
  foot.style.cssText = 'text-align:center;margin:10px 0 0';
  foot.textContent = '识缘 PairLens · github.com/SaberOnGo/YourPairLens';
  snap.append(head, res, foot);
  let name = $('resName').textContent;
  if (hideName && name) {
    const uid = (renderReport.last && renderReport.last.uid) || '';
    const walker = document.createTreeWalker(res, NodeFilter.SHOW_TEXT);
    for (let n; (n = walker.nextNode());) for (const k of [name, uid]) if (k && n.nodeValue.includes(k)) n.nodeValue = n.nodeValue.split(k).join('＊＊＊');
    name = '';
  }
  for (const img of snap.querySelectorAll('img')) {
    const src = document.querySelector(`img[src="${img.getAttribute('src')}"]`);
    try { img.src = await toDataUrl((src && src.currentSrc) || img.src); }
    catch { try { img.src = await toDataUrl('images/group-qr.jpg'); } catch { img.remove(); } }
  }
  document.body.append(snap);
  const h = Math.ceil(snap.scrollHeight) + 12;
  snap.removeAttribute('style'); snap.style.cssText = 'width:380px;padding-bottom:12px';
  snap.remove();
  const style = document.createElement('style'); style.textContent = css;
  snap.prepend(style);
  const xhtml = new XMLSerializer().serializeToString(snap);
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="380" height="${h}"><foreignObject width="100%" height="100%">${xhtml}</foreignObject></svg>`;
  const img = new Image();
  img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);
  await img.decode();
  const scale = 2, canvas = document.createElement('canvas');
  canvas.width = 380 * scale; canvas.height = h * scale;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = getComputedStyle(document.body).backgroundColor || '#fff'; ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.scale(scale, scale); ctx.drawImage(img, 0, 0);
  const blob = await new Promise(r => canvas.toBlob(r, 'image/png'));
  const day = new Date().toLocaleDateString('zh-CN').replace(/\//g, '-');
  const a = Object.assign(document.createElement('a'), { href: URL.createObjectURL(blob), download: `识缘-${(name || '分析结果').replace(/[\/:*?"<>|]/g, '')}-${day}.png` });
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 60000);
}
$('saveImage').addEventListener('click', () => $('saveDialog').showModal());
for (const [id, hide] of [['savePlain', false], ['saveHidden', true]]) {
  $(id).addEventListener('click', async () => {
    $('saveDialog').close();
    try { await saveImage(hide); } catch (e) { showNotice('保存图片失败，请再试一次。'); console.error(e); }
  });
}
$('notify').addEventListener('change', e => send({ pl: 'setNotify', on: e.target.checked }));
chrome.runtime.onMessage.addListener(msg => {
  if (!msg) return;
  if (msg.pl === 'queue') { queue = msg.queue; renderQueue(); refresh(); }
  if (msg.pl === 'state' && msg.uid === selected) { renderAction(msg.state); renderReport(msg.state.report, msg.state); }
});

// ---------- startup ----------
async function loadPage() {
  // ?tab=<id> lets automated tests open the popup as a page bound to a specific Zhihu tab.
  const forced = +new URLSearchParams(location.search).get('tab');
  const [tab] = forced ? [await chrome.tabs.get(forced)] : await chrome.tabs.query({ active: true, currentWindow: true });
  tabId = tab && tab.id;
  const onZhihu = !!tab && /^https:\/\/(www|zhuanlan)\.zhihu\.com\//.test(tab.url || '');
  page = onZhihu ? ((await send({ pl: 'candidates', tabId })) || { candidates: [], loggedIn: false }) : { candidates: [], loggedIn: false };
  page.onZhihu = onZhihu;
  const manual = (await chrome.storage.local.get('manual')).manual || [];
  for (const m of manual) if (!page.candidates.some(c => c.uid === m.uid)) page.candidates.push({ ...m, kind: 'manual' });
  selected = page.candidates[0] ? page.candidates[0].uid : null;
  const { focusUid, notify } = await chrome.storage.local.get(['focusUid', 'notify']);
  $('notify').checked = notify !== false;
  if (focusUid) { await chrome.storage.local.remove('focusUid'); ensureCandidate(focusUid); selected = focusUid; }
}

(async () => {
  await loadPage();
  renderPeople();
  queue = (await send({ pl: 'queue' })) || queue;
  renderQueue();
  await refresh();
  loadUsage();
  setInterval(refresh, 1500);
})();
