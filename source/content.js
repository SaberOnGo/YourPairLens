/* PairLens content script: lists Zhihu users on the page and runs the collector on request. */
(function () {
  'use strict';
  if (window.__pairlensContent) return;
  window.__pairlensContent = true;

  const TOKEN_RE = /\/people\/([A-Za-z0-9._-]{1,80})/;

  function pageOwner() {
    const m = location.pathname.match(/^\/people\/([A-Za-z0-9._-]{1,80})/);
    if (!m) return null;
    const name = (document.querySelector('.ProfileHeader-name') || {}).textContent || '';
    return { uid: m[1], name: name.trim().split(/\s/)[0] || m[1], kind: 'profile', distance: 0 };
  }

  // Answer authors on question/answer pages, nearest to the viewport centre first.
  function answerAuthors() {
    const out = new Map();
    const mid = innerHeight / 2;
    for (const item of document.querySelectorAll('.AnswerItem, .ContentItem.AnswerItem, [itemprop="answer"]')) {
      const link = item.querySelector('.AuthorInfo a[href*="/people/"], a.UserLink-link[href*="/people/"]');
      if (!link) continue;
      const m = link.getAttribute('href').match(TOKEN_RE);
      if (!m) continue;
      const r = item.getBoundingClientRect();
      if (r.height === 0) continue;
      const visible = r.bottom > 0 && r.top < innerHeight;
      // The answer under the viewport's centre line is the "core" one (distance 0).
      const distance = r.top <= mid && r.bottom >= mid ? 0 : Math.min(Math.abs(r.top - mid), Math.abs(r.bottom - mid)) + (visible ? 0 : innerHeight);
      const metaName = item.querySelector('.AuthorInfo meta[itemprop="name"]');
      const nameEl = item.querySelector('.AuthorInfo-name .UserLink-link, .AuthorInfo-name');
      const name = ((metaName && metaName.getAttribute('content')) || (nameEl && nameEl.textContent) || link.textContent || m[1]).trim() || m[1];
      let answerUrl = '';
      const meta = item.querySelector('meta[itemprop="url"]');
      if (meta) answerUrl = meta.getAttribute('content') || '';
      const prev = out.get(m[1]);
      if (!prev || distance < prev.distance) out.set(m[1], { uid: m[1], name, kind: 'answer', visible, distance, answerUrl });
    }
    return [...out.values()].sort((a, b) => a.distance - b.distance).slice(0, 12);
  }

  function currentUserId() {
    try { return JSON.parse(document.getElementById('js-initialData').textContent).initialState.currentUser || ''; } catch (_) { return ''; }
  }

  function candidates() {
    const owner = pageOwner();
    const list = answerAuthors();
    const all = owner ? [owner, ...list.filter(x => x.uid !== owner.uid)] : list;
    return { url: location.href, loggedIn: !!currentUserId() || !!document.querySelector('.AppHeader-profile, .AppHeader-userInfo'), currentUserId: currentUserId(), candidates: all };
  }

  let active = null; // { uid, ctl }

  chrome.runtime.onMessage.addListener((msg, sender, reply) => {
    if (!msg || !msg.pl) return;
    if (msg.pl === 'ping') { reply({ ok: true }); return; }
    if (msg.pl === 'candidates') { reply(candidates()); return; }
    if (msg.pl === 'fingerprint') {
      PairLensCollector.fingerprint(msg.uid, { pace: msg.pace }).then(r => reply({ ok: true, r }), e => reply({ ok: false, error: e.message, code: e.code }));
      return true;
    }
    if (msg.pl === 'collect') {
      if (active) active.ctl.abort();
      const ctl = new AbortController();
      active = { uid: msg.uid, ctl };
      let lastStage = '采集公开资料', lastPct = 0;
      // Heartbeat keeps the service worker alive and the progress bar moving.
      const beat = setInterval(() => chrome.runtime.sendMessage({ pl: 'progress', uid: msg.uid, stage: lastStage, pct: lastPct }).catch(() => {}), 4000);
      PairLensCollector.collect(msg.uid, {
        budgetMs: msg.budgetMs, pace: msg.pace, signal: ctl.signal,
        onProgress: (stage, pct) => { lastStage = stage; lastPct = pct; chrome.runtime.sendMessage({ pl: 'progress', uid: msg.uid, stage, pct }).catch(() => {}); }
      }).then(r => reply({ ok: true, r }), e => reply({ ok: false, error: e.message, code: e.code }))
        .finally(() => { clearInterval(beat); if (active && active.ctl === ctl) active = null; });
      return true;
    }
    if (msg.pl === 'abort') { if (active && (!msg.uid || active.uid === msg.uid)) active.ctl.abort(); reply({ ok: true }); }
  });
})();
