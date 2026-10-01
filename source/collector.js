/*
 * PairLens collector (strategy 3.0).
 * Runs inside a logged-in www.zhihu.com page (content script or injected test harness)
 * and reads Zhihu's own same-origin JSON endpoints. No tab navigation, no DOM scraping.
 * Exposes PairLensCollector.collect(uid, options) -> raw bundle (plain JSON).
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.PairLensCollector = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const SCHEMA = 'pairlens.raw/3';
  const LIMITS = Object.freeze({
    summaries: 30,          // own answers/articles/pins examined
    fulltexts: 5,           // strongly related bodies kept in full
    fulltextsExtended: 10,  // when conflicts / regions / risk found
    relationSample: 20,     // followees & followers first N each
    mutualProbe: 5,         // mutual followers inspected (no own dating post)
    mutualPosts: 2,         // related bodies per mutual
    commenterMin: 5,
    commenterMax: 15,
    commentPages: 5,        // root-comment pages per post (20 per page)
    childWaitMs: 3000,      // total child-comment wait per post
    followingQuestions: 50,          // default scan of followed questions
    followingQuestionsDeep: 100      // only without own or mutuals' dating posts
  });

  // Words that make a post "strongly related" to mate seeking.
  const DATING_RE = /择偶|找对象|征友|相亲|脱单|男朋友|女朋友|男友|女友|对象|结婚|婚恋|交友|伴侣|另一半|单身|恋爱|嫁|娶|老公|老婆|处对象|奔现|佳偶|红娘|配偶|彩礼/;
  const DATING_TITLE_RE = /择偶|找对象|征友|相亲|脱单|男朋友|女朋友|男友|女友|结婚|婚恋|交友|伴侣|另一半|单身|恋爱|对象|嫁|娶/;

  const sleep = ms => new Promise(r => setTimeout(r, ms));

  function stripHtml(html) {
    return String(html || '')
      .replace(/<br\s*\/?>(?!\n)/gi, '\n')
      .replace(/<\/(p|div|li|h\d|blockquote|figure)>/gi, '\n')
      .replace(/<img[^>]*>/gi, '[图片]')
      .replace(/<[^>]+>/g, '')
      .replace(/&nbsp;/g, ' ').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&')
      .replace(/[ \t ]+/g, ' ')
      .replace(/\n\s*\n+/g, '\n')
      .trim();
  }

  function countImages(html) { return (String(html || '').match(/<img\b/gi) || []).length; }

  class Budget {
    constructor(ms, signal) { this.start = Date.now(); this.ms = ms; this.signal = signal; }
    get elapsed() { return Date.now() - this.start; }
    get left() { return this.ms - this.elapsed; }
    check() { if (this.signal && this.signal.aborted) throw Object.assign(new Error('用户已停止分析'), { code: 'STOPPED' }); }
  }

  // Requests are paced like normal browsing (Zhihu rate-limits bursts with 403/10003).
  // Default 3 in flight / 250ms between starts; the caller may pass a slower `pace` chosen from
  // recent history (recommendPace), and the limiter slows itself on slow or 429/5xx responses.
  const DEFAULT_PACE = Object.freeze({ concurrency: 3, gapMs: 250 });
  const MAX_GAP_MS = 2000;

  // history: [{ t: ms, requests: n, rateLimited: bool }] from recent analyses.
  function recommendPace(history, now = Date.now()) {
    const recent = (history || []).filter(h => now - h.t < 10 * 60000);
    const limited = (history || []).some(h => h.rateLimited && now - h.t < 30 * 60000);
    if (limited) return { concurrency: 1, gapMs: 1000, reason: '30 分钟内触发过知乎限流' };
    const n = recent.reduce((s, h) => s + (h.requests || 0), 0);
    if (n > 400) return { concurrency: 2, gapMs: 800, reason: `最近 10 分钟已请求 ${n} 次` };
    if (n > 200) return { concurrency: 2, gapMs: 400, reason: `最近 10 分钟已请求 ${n} 次` };
    return { ...DEFAULT_PACE, reason: '默认节奏' };
  }

  function makeLimiter(pace) {
    const p = { concurrency: Math.max(1, Math.min(3, (pace && pace.concurrency) || DEFAULT_PACE.concurrency)), gapMs: Math.max(DEFAULT_PACE.gapMs, (pace && pace.gapMs) || DEFAULT_PACE.gapMs) };
    let active = 0, last = 0; const queue = [];
    const pump = () => {
      if (active >= p.concurrency || !queue.length) return;
      const wait = Math.max(0, last + p.gapMs - Date.now());
      if (wait) { setTimeout(pump, wait); return; }
      last = Date.now(); active++;
      const { fn, resolve, reject } = queue.shift();
      Promise.resolve().then(fn).then(resolve, reject).finally(() => { active--; pump(); });
      pump();
    };
    const run = fn => new Promise((resolve, reject) => { queue.push({ fn, resolve, reject }); pump(); });
    run.slowDown = () => { p.concurrency = 1; p.gapMs = Math.min(MAX_GAP_MS, p.gapMs * 2); };
    run.pace = p;
    return run;
  }

  function makeFetcher(opts, stats) {
    const fetchImpl = opts.fetch || ((u, o) => fetch(u, o));
    const base = opts.origin || 'https://www.zhihu.com';
    const limit = makeLimiter(opts.pace);
    stats.pace = limit.pace;
    let blocked = null;
    return async function getJson(path, { timeoutMs = 10000, tries = 2 } = {}) {
      if (blocked) throw blocked;
      const url = path.startsWith('http') ? path.replace(/^http:/, 'https:') : base + path;
      let lastErr;
      for (let i = 0; i < tries; i++) {
        const ctl = typeof AbortController !== 'undefined' ? new AbortController() : null;
        let timer = null;
        const t0 = Date.now();
        try {
          const res = await limit(() => { if (blocked) throw blocked; stats.requests++; timer = ctl ? setTimeout(() => ctl.abort(), timeoutMs) : null; return fetchImpl(url, { credentials: 'include', signal: ctl && ctl.signal, headers: { 'x-requested-with': 'fetch' } }); });
          stats.networkMs += Date.now() - t0;
          if (Date.now() - t0 > 3000 || res.status === 429 || res.status >= 500) { limit.slowDown(); stats.slowDowns = (stats.slowDowns || 0) + 1; }
          if (res.status === 401 || res.status === 403) {
            const body = await res.text().catch(() => '');
            if (/10003|升级客户端|请求参数异常|频繁/.test(body)) blocked = Object.assign(new Error('知乎暂时限制了请求频率，请几分钟后再试'), { code: 'RATE_LIMIT', status: res.status });
            else blocked = Object.assign(new Error(/验证|captcha|unhuman/i.test(body) ? '知乎要求安全验证，请在知乎页面完成验证后再试' : '知乎未登录或无权限'), { code: 'AUTH', status: res.status });
            throw blocked;
          }
          if (res.status === 404 || res.status === 410) return { __missing: true, status: res.status };
          if (!res.ok) throw Object.assign(new Error('知乎接口返回 ' + res.status), { code: 'HTTP', status: res.status });
          return await res.json();
        } catch (e) {
          lastErr = e;
          if (e.code === 'AUTH' || e.code === 'RATE_LIMIT') throw e;
          if (i + 1 < tries) await sleep(400 * (i + 1));
        } finally { if (timer) clearTimeout(timer); }
      }
      stats.failures.push(String(lastErr && lastErr.message || lastErr).slice(0, 120) + ' @ ' + path.slice(0, 80));
      return { __failed: true, error: String(lastErr && lastErr.message || lastErr) };
    };
  }

  const MEMBER_INCLUDE = [
    'follower_count', 'following_count', 'answer_count', 'articles_count', 'pins_count', 'question_count',
    'voteup_count', 'thanked_count', 'favorited_count', 'following_question_count', 'ip_info', 'gender',
    'headline', 'description', 'location', 'business', 'employments', 'educations', 'badge_v2', 'account_status',
    'is_following', 'is_followed', 'mutual_followees_count', 'logs_count', 'marked_answers_count', 'zvideo_count'
  ].join(',');

  function pickProfile(m) {
    if (!m || m.__missing || m.__failed) return null;
    const names = arr => (Array.isArray(arr) ? arr : []).map(x => x && (x.name || (x.company && x.company.name) || (x.school && x.school.name) || (x.job && x.job.name))).filter(Boolean);
    return {
      id: m.id, urlToken: m.url_token, name: m.name || '', headline: m.headline || '', description: stripHtml(m.description || ''),
      gender: m.gender, ipInfo: m.ip_info || '', isOrg: !!m.is_org, useDefaultAvatar: !!m.use_default_avatar,
      avatarUrl: m.avatar_url || '',
      followerCount: m.follower_count ?? null, followingCount: m.following_count ?? null,
      answerCount: m.answer_count ?? null, articlesCount: m.articles_count ?? null, pinsCount: m.pins_count ?? null,
      questionCount: m.question_count ?? null, voteupCount: m.voteup_count ?? null, thankedCount: m.thanked_count ?? null,
      favoritedCount: m.favorited_count ?? null, followingQuestionCount: m.following_question_count ?? null,
      zvideoCount: m.zvideo_count ?? null,
      business: m.business ? m.business.name : '',
      employments: (Array.isArray(m.employments) ? m.employments : []).map(e => [e.company && e.company.name, e.job && e.job.name].filter(Boolean).join(' · ')).filter(Boolean),
      educations: (Array.isArray(m.educations) ? m.educations : []).map(e => [e.school && e.school.name, e.major && e.major.name].filter(Boolean).join(' · ')).filter(Boolean),
      locations: names(m.location),
      badges: ((m.badge_v2 && m.badge_v2.detail_badges) || []).map(b => b.title || b.description).filter(Boolean),
      accountStatus: (Array.isArray(m.account_status) ? m.account_status : []).map(s => s.name || s.reason || '').filter(Boolean),
      viewerFollows: !!m.is_following, followsViewer: !!m.is_followed
    };
  }

  function relevance(item) {
    const title = item.title || '';
    const text = (item.text || item.excerpt || '').slice(0, 3000);
    let s = 0;
    if (DATING_TITLE_RE.test(title)) s += 3;
    if (/择偶标准|找对象|征友|脱单|相亲/.test(title)) s += 2;
    const hits = (text.match(new RegExp(DATING_RE.source, 'g')) || []).length;
    s += Math.min(4, hits * 0.5);
    if (/(本人|坐标|身高|体重|\d{2}年|\d{2}后|年龄|学历|工作|收入|性格|爱好|希望你|希望他|希望她|要求|微信|vx|企鹅|QQ)/i.test(text)) s += 1;
    return s;
  }

  function normalizeAnswer(a) {
    const html = a.content || '';
    return {
      kind: 'answer', id: String(a.id), questionId: a.question ? String(a.question.id) : '', title: a.question ? a.question.title : '',
      url: a.question ? `https://www.zhihu.com/question/${a.question.id}/answer/${a.id}` : `https://www.zhihu.com/answer/${a.id}`,
      created: a.created_time || 0, updated: a.updated_time || a.created_time || 0,
      voteup: a.voteup_count ?? null, comments: a.comment_count ?? null, ipInfo: a.ip_info || '',
      excerpt: stripHtml(a.excerpt || '').slice(0, 300), text: stripHtml(html), images: countImages(html),
      authorToken: a.author ? a.author.url_token : ''
    };
  }

  function normalizeArticle(a) {
    const html = a.content || '';
    return {
      kind: 'article', id: String(a.id), questionId: '', title: a.title || '', url: `https://zhuanlan.zhihu.com/p/${a.id}`,
      created: a.created || 0, updated: a.updated || a.created || 0, voteup: a.voteup_count ?? null, comments: a.comment_count ?? null,
      ipInfo: a.ip_info || '', excerpt: stripHtml(a.excerpt || '').slice(0, 300), text: stripHtml(html), images: countImages(html),
      authorToken: a.author ? a.author.url_token : ''
    };
  }

  function normalizePin(p) {
    const parts = (Array.isArray(p.content) ? p.content : []).map(c => c.type === 'text' ? stripHtml(c.content || c.own_text || '') : c.type === 'image' ? '[图片]' : '').filter(Boolean);
    const text = parts.join('\n') || stripHtml(p.excerpt_title || '');
    return {
      kind: 'pin', id: String(p.id), questionId: '', title: '', url: `https://www.zhihu.com/pin/${p.id}`,
      created: p.created || 0, updated: p.updated || p.created || 0, voteup: p.like_count ?? p.reaction_count ?? null, comments: p.comment_count ?? null,
      ipInfo: p.ip_info || '', excerpt: text.slice(0, 300), text, images: parts.filter(x => x === '[图片]').length,
      authorToken: p.author ? p.author.url_token : ''
    };
  }

  function pickUser(u) {
    return u && { id: u.id, urlToken: u.url_token, name: u.name || '', headline: u.headline || '', gender: u.gender,
      answerCount: u.answer_count ?? null, followerCount: u.follower_count ?? null, isOrg: !!u.is_org };
  }

  async function listPaged(getJson, path, max, pageSize, budget) {
    const out = []; let offset = 0; let total = null; let complete = false; let failed = false;
    while (out.length < max && budget.left > 0) {
      budget.check();
      const sep = path.includes('?') ? '&' : '?';
      const j = await getJson(`${path}${sep}limit=${pageSize}&offset=${offset}`);
      if (!j || j.__failed) { failed = true; break; }
      if (j.__missing) { complete = true; break; }
      const data = Array.isArray(j.data) ? j.data : [];
      if (j.paging && typeof j.paging.totals === 'number') total = j.paging.totals;
      out.push(...data);
      offset += data.length;
      if (!data.length || (j.paging && j.paging.is_end)) { complete = true; break; }
    }
    return { items: out.slice(0, max), total, complete: complete || (total != null && out.length >= total), failed };
  }

  async function collectOwnContent(getJson, uid, profile, budget, limit) {
    const tok = encodeURIComponent(uid);
    const ansInclude = 'data%5B*%5D.content,excerpt,voteup_count,comment_count,created_time,updated_time,ip_info,question';
    const wantAnswers = Math.min(limit, profile && profile.answerCount != null ? profile.answerCount : limit);
    const tasks = [
      wantAnswers > 0 ? listPaged(getJson, `/api/v4/members/${tok}/answers?include=${ansInclude}&sort_by=created`, wantAnswers, 20, budget) : Promise.resolve({ items: [], total: 0, complete: true }),
      profile && profile.articlesCount ? listPaged(getJson, `/api/v4/members/${tok}/articles?include=data%5B*%5D.content,excerpt,voteup_count,comment_count,created,updated,ip_info&sort_by=created`, Math.min(10, profile.articlesCount), 10, budget) : Promise.resolve({ items: [], total: 0, complete: true }),
      profile && profile.pinsCount ? listPaged(getJson, `/api/v4/members/${tok}/pins`, Math.min(10, profile.pinsCount), 10, budget) : Promise.resolve({ items: [], total: 0, complete: true })
    ];
    const [ans, art, pins] = await Promise.all(tasks);
    const items = [
      ...ans.items.map(normalizeAnswer), ...art.items.map(normalizeArticle), ...pins.items.map(normalizePin)
    ].filter(x => !x.authorToken || x.authorToken === uid);
    return { items, coverage: { answers: { read: ans.items.length, total: ans.total, complete: ans.complete, failed: !!ans.failed }, articles: { read: art.items.length, total: art.total, complete: art.complete }, pins: { read: pins.items.length, total: pins.total, complete: pins.complete } } };
  }

  // Pick which bodies to keep in full: 5 by relevance with region diversity, up to 10 when
  // regions conflict (>= 2 provinces) or risky markers appear.
  function selectFulltexts(items) {
    const scored = items.map(x => ({ x, s: relevance(x) })).filter(o => o.s >= 3).sort((a, b) => b.s - a.s || b.x.created - a.x.created);
    const chosen = []; const regions = new Set();
    const regionOf = it => (String(it.title).match(/(北京|上海|天津|重庆|深圳|广州|杭州|南京|成都|武汉|西安|苏州|长沙|郑州|东莞|佛山|厦门|青岛|合肥|宁波|昆明|大连|沈阳|济南|福州|无锡|广东|广西|浙江|江苏|四川|湖北|湖南|河南|河北|山东|山西|陕西|福建|安徽|江西|云南|贵州|辽宁|吉林|黑龙江|海南|甘肃|青海|宁夏|新疆|西藏|内蒙古|香港|澳门|台湾)/) || [])[1] || '';
    // First pass: region diversity.
    for (const o of scored) {
      const r = regionOf(o.x);
      if (chosen.length < LIMITS.fulltexts && r && !regions.has(r)) { chosen.push(o.x); regions.add(r); }
    }
    for (const o of scored) if (chosen.length < LIMITS.fulltexts && !chosen.includes(o.x)) { chosen.push(o.x); const r = regionOf(o.x); if (r) regions.add(r); }
    const risky = scored.some(o => /投稿|帮发|代发|转发|邦发|bang发|帮fa|企鹅|🐧|QQ|扣扣|加群|进群/i.test(o.x.text + o.x.title));
    const extend = regions.size >= 2 || risky;
    if (extend) for (const o of scored) { if (chosen.length >= LIMITS.fulltextsExtended) break; if (!chosen.includes(o.x)) { chosen.push(o.x); const r = regionOf(o.x); if (r) regions.add(r); if (regions.size >= 3 && chosen.length >= LIMITS.fulltexts) break; } }
    return { ids: new Set(chosen.map(x => x.id)), extended: extend, regions: [...regions] };
  }

  async function collectRelations(getJson, uid, budget) {
    const tok = encodeURIComponent(uid);
    const n = LIMITS.relationSample;
    const fqPath = o => `/api/v4/members/${tok}/following-questions?include=data%5B*%5D.created,answer_count,follower_count&limit=20&offset=${o}`;
    const [fe, fr, fq] = await Promise.all([
      getJson(`/api/v4/members/${tok}/followees?include=data%5B*%5D.answer_count,follower_count,gender,headline&limit=${n}&offset=0`),
      getJson(`/api/v4/members/${tok}/followers?include=data%5B*%5D.answer_count,follower_count,gender,headline&limit=${n}&offset=0`),
      getJson(fqPath(0))
    ]);
    let questions = (fq && Array.isArray(fq.data)) ? fq.data : [];
    const fqTotal = fq && fq.paging && typeof fq.paging.totals === 'number' ? fq.paging.totals : questions.length;
    if (fq && fq.paging && !fq.paging.is_end) {
      // Remaining pages are offset-addressed, so fetch them in parallel (capped).
      const offsets = [];
      for (let o = 20; o < Math.min(fqTotal, LIMITS.followingQuestions); o += 20) offsets.push(o);
      const pages = await Promise.all(offsets.map(o => getJson(fqPath(o))));
      for (const p of pages) if (p && Array.isArray(p.data)) questions = questions.concat(p.data);
    }
    questions = questions.slice(0, LIMITS.followingQuestions);
    const ok = x => x && !x.__failed && !x.__missing && Array.isArray(x.data);
    const followees = ok(fe) ? fe.data.map(pickUser) : [];
    const followers = ok(fr) ? fr.data.map(pickUser) : [];
    const followerSet = new Set(followers.map(u => u.urlToken));
    return {
      followees, followers,
      followeeTotal: ok(fe) && fe.paging ? fe.paging.totals : null,
      followerTotal: ok(fr) && fr.paging ? fr.paging.totals : null,
      mutuals: followees.filter(u => followerSet.has(u.urlToken)).map(u => u.urlToken),
      followingQuestions: questions.map(q => ({ id: String(q.id), title: q.title || '', answers: q.answer_count ?? null, followers: q.follower_count ?? null })),
      followingQuestionTotal: fqTotal,
      complete: { followees: ok(fe), followers: ok(fr), questions: ok(fq) }
    };
  }

  async function membersOfFollowList(getJson, who, kind, pages, budget) {
    const set = new Set();
    for (let p = 0; p < pages && budget.left > 2000; p++) {
      const j = await getJson(`/api/v4/members/${encodeURIComponent(who)}/${kind}?limit=20&offset=${p * 20}`);
      if (!j || !Array.isArray(j.data)) break;
      j.data.forEach(u => set.add(u.url_token));
      if (!j.data.length || (j.paging && j.paging.is_end)) break;
    }
    return set;
  }

  // Commenters on the target's own dating posts; author-replied commenters first.
  async function collectCommenters(getJson, uid, profile, posts, budget, maxCheck) {
    const result = { posts: [], commenters: [], checked: [] };
    const targetId = profile && profile.id;
    await Promise.all(posts.slice(0, 3).map(async post => {
      const rec = { id: post.id, kind: post.kind, totalComments: post.comments, rootRead: 0, childRead: 0, complete: false, childTimeouts: 0 };
      result.posts.push(rec);
      const type = post.kind === 'article' ? 'articles' : post.kind === 'pin' ? 'pins' : 'answers';
      let next = `/api/v4/comment_v5/${type}/${post.id}/root_comment?order_by=ts&limit=20`;
      const childDeadline = Date.now() + LIMITS.childWaitMs;
      for (let page = 0; page < LIMITS.commentPages && next && budget.left > 8000; page++) {
        budget.check();
        const j = await getJson(next, { timeoutMs: 6000 });
        if (!j || j.__failed || j.__missing || !Array.isArray(j.data)) break;
        for (const c of j.data) {
          rec.rootRead++;
          const a = c.author || {};
          const replied = (c.child_comments || []).some(ch => (ch.author && ch.author.id === targetId) || ch.is_author);
          result.commenters.push({ token: a.url_token, name: a.name, postId: post.id, text: stripHtml(c.content).slice(0, 200), created: c.created_time, authorReplied: replied, likes: c.like_count || 0, children: c.child_comment_count || 0 });
          for (const ch of (c.child_comments || [])) {
            rec.childRead++;
            const ca = ch.author || {};
            if (ca.url_token && ca.url_token !== uid) result.commenters.push({ token: ca.url_token, name: ca.name, postId: post.id, text: stripHtml(ch.content).slice(0, 200), created: ch.created_time, authorReplied: false, child: true });
          }
          // Expand hidden child threads only within the short per-post wait.
          if ((c.child_comment_count || 0) > (c.child_comments || []).length && Date.now() < childDeadline) {
            const cj = await getJson(`/api/v4/comment_v5/comment/${c.id}/child_comment?order_by=ts&limit=20`, { timeoutMs: Math.max(500, childDeadline - Date.now()), tries: 1 });
            if (cj && Array.isArray(cj.data)) {
              for (const ch of cj.data) {
                rec.childRead++;
                if ((ch.author && ch.author.id === targetId) || ch.is_author) {
                  const last = result.commenters.find(x => x.token === a.url_token && x.postId === post.id && !x.child);
                  if (last) last.authorReplied = true;
                }
              }
            } else rec.childTimeouts++;
          } else if ((c.child_comment_count || 0) > (c.child_comments || []).length) rec.childTimeouts++;
        }
        const end = !j.paging || j.paging.is_end;
        if (end) { rec.complete = true; break; }
        next = j.paging.next;
      }
    }));
    // Distinct commenters, author-replied first, excluding the target.
    const seen = new Map();
    for (const c of result.commenters) {
      if (!c.token || c.token === uid || c.token === '0') continue;
      const prev = seen.get(c.token);
      if (!prev) seen.set(c.token, { ...c }); else prev.authorReplied = prev.authorReplied || c.authorReplied;
    }
    const ranked = [...seen.values()].sort((a, b) => (b.authorReplied - a.authorReplied) || (b.likes || 0) - (a.likes || 0));
    result.distinctCommenters = ranked.length;
    // Mutual check: does target follow them and do they follow target? Use the target's
    // followee and follower lists (paged) — cheaper than visiting each commenter.
    const budgetLeft = budget.left;
    const n = Math.max(LIMITS.commenterMin, Math.min(maxCheck, Math.floor(budgetLeft / 4000)));
    const toCheck = ranked.slice(0, n);
    if (toCheck.length) {
      const [fe, fr] = await Promise.all([
        membersOfFollowList(getJson, uid, 'followees', 5, budget),
        membersOfFollowList(getJson, uid, 'followers', 5, budget)
      ]);
      for (const c of toCheck) result.checked.push({ token: c.token, name: c.name, authorReplied: c.authorReplied, targetFollows: fe.has(c.token), followsTarget: fr.has(c.token), mutual: fe.has(c.token) && fr.has(c.token), text: c.text });
    }
    result.commenters = ranked.slice(0, 40).map(c => ({ token: c.token, name: c.name, postId: c.postId, text: c.text, authorReplied: c.authorReplied }));
    return result;
  }

  async function collectMutualEvidence(getJson, tokens, budget, cache) {
    const out = [];
    const probe = tokens.slice(0, LIMITS.mutualProbe);
    await Promise.all(probe.map(async tok => {
      if (cache && cache[tok]) { out.push({ ...cache[tok], fromCache: true }); return; }
      const [m, list] = await Promise.all([
        getJson(`/api/v4/members/${encodeURIComponent(tok)}?include=answer_count,articles_count,follower_count,gender,headline,ip_info`),
        getJson(`/api/v4/members/${encodeURIComponent(tok)}/answers?include=data%5B*%5D.content,excerpt,voteup_count,comment_count,created_time,question&limit=20&offset=0&sort_by=created`)
      ]);
      const items = list && Array.isArray(list.data) ? list.data.map(normalizeAnswer) : [];
      const related = items.map(x => ({ x, s: relevance(x) })).filter(o => o.s >= 3).sort((a, b) => b.s - a.s || b.x.created - a.x.created).slice(0, LIMITS.mutualPosts).map(o => o.x);
      out.push({ token: tok, profile: pickProfile(m), answersRead: items.length, posts: related.map(p => ({ ...p, text: p.text.slice(0, 4000) })) });
    }));
    return out;
  }

  /**
   * collect(uid, options)
   * options: { budgetMs=100000, signal, onProgress(stage, pct), fetch, mutualCache, quick }
   */
  async function collect(uid, options = {}) {
    if (!/^[\w.-]{1,80}$/.test(uid || '')) throw new Error('无效的知乎用户ID');
    const stats = { requests: 0, networkMs: 0, failures: [] };
    const getJson = makeFetcher(options, stats);
    const budget = new Budget(options.budgetMs || 100000, options.signal);
    const progress = (stage, pct) => { try { options.onProgress && options.onProgress(stage, pct); } catch (_) {} };
    const timings = {};
    const mark = (k, t0) => { timings[k] = Date.now() - t0; };

    progress('读取主页资料', 5);
    let t0 = Date.now();
    const m = await getJson(`/api/v4/members/${encodeURIComponent(uid)}?include=${MEMBER_INCLUDE}`);
    if (m && m.__missing) return { schema: SCHEMA, uid, collectedAt: Date.now(), unavailable: true, status: m.status, stats, timings };
    const profile = pickProfile(m);
    if (!profile) throw Object.assign(new Error('无法读取该用户主页资料'), { code: 'PROFILE' });
    mark('profile', t0);

    progress('读取本人回答与关注关系', 15);
    t0 = Date.now();
    const [own, rel] = await Promise.all([
      collectOwnContent(getJson, uid, profile, budget, LIMITS.summaries),
      collectRelations(getJson, uid, budget)
    ]);
    mark('ownAndRelations', t0);

    own.items.sort((a, b) => b.created - a.created);
    const items = own.items.slice(0, LIMITS.summaries + 20);
    const sel = selectFulltexts(items);
    // The answer list omits voteup/favorite counts; read them for the selected bodies only.
    t0 = Date.now();
    await Promise.all(items.filter(x => sel.ids.has(x.id) && x.kind === 'answer').map(async x => {
      const d = await getJson(`/api/v4/answers/${x.id}?include=voteup_count,comment_count,favlists_count`, { timeoutMs: 6000 });
      if (d && !d.__failed && !d.__missing) { x.voteup = d.voteup_count ?? x.voteup; x.comments = d.comment_count ?? x.comments; x.favorites = d.favlists_count ?? null; }
    }));
    mark('postStats', t0);
    const ownItems = items.map(x => sel.ids.has(x.id) ? { ...x, full: true } : { ...x, text: x.text.slice(0, 600), full: false, truncated: x.text.length > 600 });

    // Own dating posts, by relevance; used to decide commenter check vs mutual propagation.
    const datingPosts = items.filter(x => sel.ids.has(x.id)).sort((a, b) => (b.comments || 0) - (a.comments || 0));
    const result = {
      schema: SCHEMA, uid, collectedAt: Date.now(), profile, items: ownItems, coverage: { ...own.coverage, fulltext: { selected: sel.ids.size, extended: sel.extended, regions: sel.regions } },
      relations: rel, commenters: null, mutualEvidence: [], stats, timings
    };

    if (options.quick) return result;

    progress(datingPosts.length ? '核对求偶帖评论者' : '核对互关者的公开内容', 45);
    t0 = Date.now();
    if (datingPosts.length) {
      result.commenters = await collectCommenters(getJson, uid, profile, datingPosts, budget, LIMITS.commenterMax);
    }
    // Mutual propagation (strategy 2.2.24): only when no own dating post among strongly related.
    if (!datingPosts.length && rel.mutuals.length) {
      result.mutualEvidence = await collectMutualEvidence(getJson, rel.mutuals, budget, options.mutualCache);
    }
    // Without own dating posts or mutuals' dating posts, weak interest can only show in followed questions: scan deeper
    // (paced, sequential pages) up to followingQuestionsDeep.
    const mutualDatingEvidence = result.mutualEvidence.some(m => (m.posts || []).length);
    if (!datingPosts.length && !mutualDatingEvidence && (rel.followingQuestionTotal || 0) > rel.followingQuestions.length) {
      const tok = encodeURIComponent(uid);
      for (let o = rel.followingQuestions.length; o < Math.min(rel.followingQuestionTotal, LIMITS.followingQuestionsDeep) && budget.left > 10000; o += 20) {
        const p = await getJson(`/api/v4/members/${tok}/following-questions?include=data%5B*%5D.created,answer_count,follower_count&limit=20&offset=${o}`);
        if (!p || !Array.isArray(p.data) || !p.data.length) break;
        rel.followingQuestions.push(...p.data.map(q => ({ id: String(q.id), title: q.title || '', answers: q.answer_count ?? null, followers: q.follower_count ?? null })));
        if (p.paging && p.paging.is_end) break;
      }
      rel.followingQuestions = rel.followingQuestions.slice(0, LIMITS.followingQuestionsDeep);
      rel.deepQuestionScan = true;
    }
    mark('secondary', t0);
    progress('整理资料', 90);
    result.elapsedMs = budget.elapsed;
    return result;
  }

  // Lightweight fingerprint used by warm runs to decide whether a cached report is still current.
  async function fingerprint(uid, options = {}) {
    const stats = { requests: 0, networkMs: 0, failures: [] };
    const getJson = makeFetcher(options, stats);
    const m = await getJson(`/api/v4/members/${encodeURIComponent(uid)}?include=${MEMBER_INCLUDE}`);
    if (m && m.__missing) return { uid, unavailable: true, stats };
    const p = pickProfile(m);
    if (!p) throw new Error('无法读取该用户主页资料');
    return { uid, profile: p, key: fingerprintKey(p), stats };
  }

  function fingerprintKey(p) {
    return [p.answerCount, p.articlesCount, p.pinsCount, p.questionCount, p.name, p.headline].join('|');
  }

  return { SCHEMA, LIMITS, DEFAULT_PACE, recommendPace, collect, fingerprint, fingerprintKey, stripHtml, relevance };
});
