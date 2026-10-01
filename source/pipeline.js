/*
 * PairLens analysis pipeline (shared by the extension background and the live test harness).
 *   1. Ask the server for a cached report (same strategy version).
 *   2. If present, read one Zhihu profile request (fingerprint); unchanged -> reuse, done.
 *   3. Otherwise collect via Zhihu JSON APIs and upload for scoring.
 * The caller injects `server` (getReport, analyze) and `zhihu` (fingerprint, collect) so the
 * same logic runs in a service worker (via messaging) or directly inside a Zhihu page.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.PairLensPipeline = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const STRATEGY_VERSION = '3.1.0';
  const HARD_LIMIT_MS = 120000;
  const COLLECT_BUDGET_MS = 95000;
  const REPORT_MAX_AGE_MS = 30 * 24 * 3600 * 1000;

  function withTimeout(promise, ms, msg) {
    let t;
    return Promise.race([promise, new Promise((_, rej) => { t = setTimeout(() => rej(Object.assign(new Error(msg), { code: 'TIMEOUT' })), ms); })]).finally(() => clearTimeout(t));
  }

  async function analyzeUser({ uid, server, zhihu, fresh = false, onProgress = () => {}, signal, pace, cacheOnly = false }) {
    const t0 = Date.now();
    const timings = {};
    const trace = { uid, fresh, mode: null, zhihuRequests: 0, cacheHit: false, startedAt: t0 };
    const left = () => HARD_LIMIT_MS - (Date.now() - t0);
    const check = () => { if (signal && signal.aborted) throw Object.assign(new Error('已停止分析'), { code: 'STOPPED' }); };

    const run = async () => {
      if (!fresh) {
        onProgress('查询服务器缓存', 5);
        let t = Date.now();
        const cached = await server.getReport(uid).catch(() => null);
        timings.cacheLookup = Date.now() - t;
        check();
        const aiDone = !(cached && cached.report && cached.report.ai && cached.report.ai.judged < cached.report.ai.wanted);
        if (cached && cached.report && aiDone && cached.strategyVersion === STRATEGY_VERSION && Date.now() - (cached.analyzedAt || 0) < REPORT_MAX_AGE_MS) {
          // A permanent high-risk record is shown at once (the user can choose 重新分析).
          if (cached.report.permanent) { trace.mode = 'record'; trace.cacheHit = true; onProgress('完成（已有记录）', 100); return cached.report; }
          onProgress('核对主页是否有更新', 40);
          t = Date.now();
          const fp = await zhihu.fingerprint(uid, { pace });
          timings.fingerprint = Date.now() - t;
          trace.zhihuRequests += (fp.stats && fp.stats.requests) || 1;
          check();
          if (!fp.unavailable && fp.key === cached.fingerprintKey) {
            trace.mode = 'cache';
            trace.cacheHit = true;
            onProgress('完成（服务器缓存）', 100);
            return cached.report;
          }
        }
      }
      // Daily quota used up: only existing results may be shown; do not collect from Zhihu.
      if (cacheOnly) throw Object.assign(new Error('今天的分析次数已用完'), { code: 'QUOTA' });
      onProgress('采集公开资料', 10);
      let t = Date.now();
      const bundle = await zhihu.collect(uid, { pace, budgetMs: Math.min(COLLECT_BUDGET_MS, left() - 15000), onProgress: (s, p) => onProgress(s, 10 + Math.round(p * 0.7)) });
      trace.pace = bundle.stats && bundle.stats.pace;
      timings.collect = Date.now() - t;
      trace.zhihuRequests += (bundle.stats && bundle.stats.requests) || 0;
      check();
      onProgress('服务器评分（规则 + JEV）', 85);
      t = Date.now();
      const res = await server.analyze(bundle, fresh);
      timings.analyze = Date.now() - t;
      trace.mode = 'collect';
      onProgress('完成', 100);
      return res.report;
    };

    const report = await withTimeout(run(), HARD_LIMIT_MS, '分析超过 120 秒，已停止');
    trace.totalMs = Date.now() - t0;
    trace.timings = timings;
    return { report, trace };
  }

  // Thin HTTP client for the PairLens server.
  function httpServer(base, { install, unlockToken, fetchImpl } = {}) {
    const f = fetchImpl || ((u, o) => fetch(u, o));
    const headers = () => Object.assign({ 'content-type': 'application/json' }, install ? { 'x-pairlens-install': install } : {}, unlockToken ? { 'x-pairlens-unlock': unlockToken } : {});
    const json = async r => { const b = await r.json().catch(() => ({})); if (!r.ok) throw Object.assign(new Error(b.error || ('服务器错误 ' + r.status)), { status: r.status, code: b.code || (r.status === 429 ? 'QUOTA' : undefined) }); return b; };
    return {
      getReport: async uid => { const r = await f(`${base}/report/${encodeURIComponent(uid)}`, { headers: headers() }); if (r.status === 404) return null; return json(r); },
      analyze: async (bundle, fresh) => json(await f(`${base}/analyze`, { method: 'POST', headers: headers(), body: JSON.stringify({ bundle, fresh: !!fresh }) })),
      unlock: async code => json(await f(`${base}/unlock`, { method: 'POST', headers: headers(), body: JSON.stringify({ code }) })),
      health: async () => json(await f(`${base}/health`))
    };
  }

  return { STRATEGY_VERSION, HARD_LIMIT_MS, analyzeUser, httpServer };
});
