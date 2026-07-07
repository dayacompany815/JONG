/**
 * 다야냉장팀 작업현황 — 공통 API 연동
 * - NAS(/api) · 원격(daya.sudalife.net) · Firebase 백업을 하나의 fetch로 통합
 * - 모든 HTML에서 동일한 FB_URL / API 사용
 */
(function (global) {
  'use strict';

  var DEFAULT_API = 'https://daya.sudalife.net/api';
  var FB_BACKUP = 'https://ice-work-d8045-default-rtdb.asia-southeast1.firebasedatabase.app';
  var STORAGE_KEY = 'daya_api_base';

  function resolveApiBase() {
    try {
      if (global.localStorage) {
        var keys = [STORAGE_KEY, 'dashboard_fb_url', 'sys_fb_url'];
        for (var ki = 0; ki < keys.length; ki++) {
          var stored = global.localStorage.getItem(keys[ki]);
          if (stored) return stored.replace(/\/+$/, '');
        }
      }
    } catch (e) {}
    try {
      var loc = global.location;
      if (loc && (loc.protocol === 'http:' || loc.protocol === 'https:')) {
        var host = loc.hostname;
        if (host === 'daya.sudalife.net' || host === 'localhost' || host === '127.0.0.1') {
          return (loc.origin + '/api').replace(/\/+$/, '');
        }
      }
    } catch (e) {}
    return DEFAULT_API;
  }

  function isApiUrl(url) {
    if (typeof url !== 'string') return false;
    if (url.indexOf('/api') === 0) return true;
    var base = resolveApiBase();
    return url.indexOf(base) === 0 || url.indexOf(DEFAULT_API) === 0;
  }

  function toFullApiUrl(url) {
    if (typeof url !== 'string') return url;
    if (url.indexOf('/api') === 0) return resolveApiBase() + url.slice(4);
    if (url.indexOf(DEFAULT_API) === 0) {
      var cur = resolveApiBase();
      return cur === DEFAULT_API ? url : url.replace(DEFAULT_API, cur);
    }
    return url;
  }

  function toFbPath(fullApiUrl) {
    var base = resolveApiBase();
    var p = fullApiUrl.replace(base, '').split('?')[0];
    if (!p) p = '/';
    return p.endsWith('/') ? FB_BACKUP + p.slice(0, -1) + '.json' : FB_BACKUP + p;
  }

  /** 동기화·직접 fetch용 — 현재 호스트에 맞는 API URL */
  function apiRel(path) {
    path = path.charAt(0) === '/' ? path : '/' + path;
    var base = resolveApiBase();
    try {
      if (global.location && global.location.origin && base.indexOf(global.location.origin) === 0) {
        return '/api' + path;
      }
    } catch (e) {}
    return base + path;
  }

  function fetchWithTimeout(url, opt, ms) {
    ms = ms || 8000;
    var _f = global.__dayaOrigFetch;
    var ctrl = new AbortController();
    var tid = setTimeout(function () { ctrl.abort(); }, ms);
    var merged = Object.assign({}, opt || {}, { signal: ctrl.signal });
    return _f(url, merged).finally(function () { clearTimeout(tid); });
  }

  async function fbGet(fullUrl) {
    var p = fullUrl.replace(resolveApiBase(), '').split('?')[0];
    var isDir = p.endsWith('/');
    var r = await fetchWithTimeout(toFbPath(fullUrl) + '?t=' + Date.now(), {}, 10000);
    if (!isDir) return r;
    var d = await r.clone().json().catch(function () { return null; });
    var keys = d ? Object.keys(d).sort().reverse() : [];
    return new Response(JSON.stringify(keys), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }

  function installFetch() {
    if (global.__dayaFetchInstalled) return;
    global.__dayaFetchInstalled = true;
    global.__dayaOrigFetch = global.fetch.bind(global);
    var _f = global.__dayaOrigFetch;

    global.fetch = async function (url, opt) {
      if (!isApiUrl(url) || (typeof url === 'string' && url.indexOf('/stream') >= 0)) {
        return _f(url, opt);
      }
      var full = toFullApiUrl(url);
      var method = (((opt && opt.method) || 'GET') + '').toUpperCase();

      if (method === 'GET') {
        try {
          var r = await fetchWithTimeout(full, opt, 8000);
          if (r.ok) return r;
        } catch (e) {}
        return fbGet(full).catch(function () {
          return new Response('null', { status: 200, headers: { 'Content-Type': 'application/json' } });
        });
      }

      var fo = Object.assign({}, opt || {}, {
        headers: Object.assign({ 'Content-Type': 'application/json' }, (opt && opt.headers) || {})
      });
      // NAS·Firebase 양쪽에 동시 저장
      var wr = await Promise.all([
        fetchWithTimeout(full, fo, 8000).catch(function () { return null; }),
        fetchWithTimeout(toFbPath(full), fo, 8000).catch(function () { return null; })
      ]);
      var r1 = wr[0], r2 = wr[1];
      if (r1 && r1.ok) return r1;
      if (r2 && r2.ok) return r2;
      return new Response('{"error":"both failed"}', { status: 500 });
    };
  }

  function liveTs(d) {
    if (!d) return 0;
    return d.savedAt || d.timestamp || 0;
  }

  /** NAS + Firebase live.json 병합 (관리자 PC·모바일 동일 데이터) */
  function mergeLiveSources(d1, d2) {
    if (!d1 && !d2) return null;
    if (!d1) return d2;
    if (!d2) return d1;
    var ts1 = liveTs(d1);
    var ts2 = liveTs(d2);
    var newer = ts2 >= ts1 ? d2 : d1;
    var older = ts2 >= ts1 ? d1 : d2;
    var out = Object.assign({}, older, newer);
    var o1 = d1.주문로그 && Object.keys(d1.주문로그).length > 0;
    var o2 = d2.주문로그 && Object.keys(d2.주문로그).length > 0;
    if (o1 && o2) out.주문로그 = ts2 >= ts1 ? d2.주문로그 : d1.주문로그;
    else if (o2) out.주문로그 = d2.주문로그;
    else if (o1) out.주문로그 = d1.주문로그;
    out.종근당 = Object.assign({}, older.종근당 || {}, newer.종근당 || {});
    // 배치 데이터 보존: newer에 배치가 없으면 older 것 유지
    if (!(out.종근당.배치 && Object.keys(out.종근당.배치).length > 0)) {
      var _ob = (older.종근당 || {}).배치;
      if (_ob && Object.keys(_ob).length > 0) {
        out.종근당.배치 = _ob;
        out.종근당.배치예측 = (older.종근당).배치예측 || 0;
      }
    }
    if (!out.totalQty) out.totalQty = d1.totalQty || d2.totalQty;
    if (!out.worker) out.worker = newer.worker || d1.worker || d2.worker;
    if (!out.date) out.date = newer.date || d1.date || d2.date;
    out.savedAt = Math.max(ts1, ts2);
    return out;
  }

  async function dayaFetchLive() {
    var _f = global.__dayaOrigFetch;
    if (!_f) return null;
    var base = resolveApiBase();
    var results = await Promise.allSettled([
      _f(base + '/live.json?t=' + Date.now()).then(function (r) { return r.ok ? r.json() : null; }).catch(function () { return null; }),
      _f(FB_BACKUP + '/live.json?t=' + Date.now()).then(function (r) { return r.ok ? r.json() : null; }).catch(function () { return null; })
    ]);
    var d1 = results[0].status === 'fulfilled' ? results[0].value : null;
    var d2 = results[1].status === 'fulfilled' ? results[1].value : null;
    return mergeLiveSources(d1, d2);
  }

  function dayaJsonTs(d) {
    if (!d) return 0;
    return d.savedAt || d.updatedAt || d.ts || d.timestamp || 0;
  }

  async function dayaFetchLatestJson(path) {
    var _f = global.__dayaOrigFetch;
    if (!_f) return null;
    var base = resolveApiBase();
    var p = path.charAt(0) === '/' ? path : '/' + path;
    var fbPath = p.endsWith('.json') ? FB_BACKUP + p : FB_BACKUP + p + '.json';
    var results = await Promise.allSettled([
      _f(base + p + '?t=' + Date.now()).then(function (r) { return r.ok ? r.json() : null; }).catch(function () { return null; }),
      _f(fbPath + '?t=' + Date.now()).then(function (r) { return r.ok ? r.json() : null; }).catch(function () { return null; })
    ]);
    var d1 = results[0].status === 'fulfilled' ? results[0].value : null;
    var d2 = results[1].status === 'fulfilled' ? results[1].value : null;
    if (!d1) return d2;
    if (!d2) return d1;
    return dayaJsonTs(d2) >= dayaJsonTs(d1) ? d2 : d1;
  }

  async function dayaWriteLive(patch, baseFallback) {
    var current = (await dayaFetchLive()) || baseFallback || {};
    var merged = Object.assign({}, current);
    Object.keys(patch || {}).forEach(function (k) {
      if (k === '종근당' && patch.종근당 && typeof patch.종근당 === 'object') {
        merged.종근당 = Object.assign({}, current.종근당 || {}, patch.종근당);
      } else if (k === '출근부' && patch.출근부 && typeof patch.출근부 === 'object') {
        // 출근부는 덮어쓰되, patch에 없으면 기존 값 보존 (race condition 방지)
        merged.출근부 = Object.assign({}, current.출근부 || {}, patch.출근부);
      } else {
        // patch에 출근부 없으면 기존 출근부 무조건 보존
        if (k !== '출근부') merged[k] = patch[k];
      }
    });
    // patch에 출근부 없으면 current 값 유지
    if (!patch.hasOwnProperty('출근부') && current.출근부) {
      merged.출근부 = current.출근부;
    }
    merged.savedAt = patch.savedAt || Date.now();
    var _f = global.__dayaOrigFetch;
    var base = resolveApiBase();
    var body = JSON.stringify(merged);
    var headers = { 'Content-Type': 'application/json' };
    await Promise.all([
      _f(base + '/live.json', { method: 'PUT', headers: headers, body: body }).catch(function () {}),
      _f(FB_BACKUP + '/live.json', { method: 'PUT', headers: headers, body: body }).catch(function () {})
    ]);
    return merged;
  }

  async function dayaPutJson(path, data) {
    var _f = global.__dayaOrigFetch;
    if (!_f) return;
    var base = resolveApiBase();
    var p = path.charAt(0) === '/' ? path : '/' + path;
    var fbPath = p.endsWith('.json') ? FB_BACKUP + p : FB_BACKUP + p + '.json';
    var body = JSON.stringify(data);
    var headers = { 'Content-Type': 'application/json' };
    await Promise.all([
      _f(base + p, { method: 'PUT', headers: headers, body: body }).catch(function () {}),
      _f(fbPath, { method: 'PUT', headers: headers, body: body }).catch(function () {})
    ]);
  }

  async function syncPath(_f, p) {
    try {
      var nr = await _f(apiRel(p) + '?t=' + Date.now()).then(function (r) { return r.ok ? r.json() : null; }).catch(function () { return null; });
      var fr = await _f(FB_BACKUP + p + '?t=' + Date.now()).then(function (r) { return r.ok ? r.json() : null; }).catch(function () { return null; });
      var nSaved = (nr && (nr.savedAt || nr.ts || 0)) || 0;
      var fSaved = (fr && (fr.savedAt || fr.ts || 0)) || 0;
      if (fr && fSaved > nSaved) {
        await _f(apiRel(p), { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(fr) });
      } else if (nr && nSaved >= fSaved && (!fr || nSaved > 0)) {
        await _f(FB_BACKUP + p, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(nr) });
      }
    } catch (e) {}
  }

  async function syncUsers(_f) {
    try {
      var nasIds = await _f(apiRel('/users/') + '?t=' + Date.now()).then(function (r) { return r.ok ? r.json() : null; }).catch(function () { return null; });
      var fbUsers = await _f(FB_BACKUP + '/users.json?t=' + Date.now()).then(function (r) { return r.ok ? r.json() : null; }).catch(function () { return null; });
      var fbIds = fbUsers ? Object.keys(fbUsers) : [];
      var allIds = Array.from(new Set([].concat(Array.isArray(nasIds) ? nasIds : [], fbIds)));
      for (var i = 0; i < allIds.length; i++) {
        var uid = allIds[i];
        try {
          var nu = await _f(apiRel('/users/' + uid + '.json') + '?t=' + Date.now()).then(function (r) { return r.ok ? r.json() : null; }).catch(function () { return null; });
          var fu = fbUsers ? (fbUsers[uid] || null) : await _f(FB_BACKUP + '/users/' + uid + '.json?t=' + Date.now()).then(function (r) { return r.ok ? r.json() : null; }).catch(function () { return null; });
          if (nu && !fu) {
            await _f(FB_BACKUP + '/users/' + uid + '.json', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(nu) });
          } else if (fu && !nu) {
            await _f(apiRel('/users/' + uid + '.json'), { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(fu) });
          }
        } catch (e) {}
      }
    } catch (e) {}
  }

  async function runNasFirebaseSync() {
    if (global.__dayaSyncStarted) return;
    global.__dayaSyncStarted = true;
    var _f = global.__dayaOrigFetch;
    try {
      var ping = await _f(apiRel('/live.json') + '?t=' + Date.now());
      if (!ping.ok) {
        ping = await _f(apiRel('/config.json') + '?t=' + Date.now());
        if (!ping.ok) return;
      }
      var today = new Date().toISOString().slice(0, 10);
      var dates = [today];
      for (var i = 1; i <= 29; i++) {
        var d = new Date();
        d.setDate(d.getDate() - i);
        dates.push(d.toISOString().slice(0, 10));
      }
      var paths = ['/live.json'].concat(dates.map(function (dd) { return '/history/' + dd + '.json'; }), ['/config.json']);
      for (var j = 0; j < paths.length; j++) await syncPath(_f, paths[j]);
      await syncUsers(_f);
    } catch (e) {}
  }

  installFetch();

  var base = resolveApiBase();
  global.DAYA_API_BASE = base;
  global.FB_URL = base;
  global.API = base;
  global.FB_BACKUP = FB_BACKUP;
  global.dayaApiRel = apiRel;
  global.dayaApiUrl = function (path) { return toFullApiUrl(apiRel(path)); };
  global.dayaFetchLive = dayaFetchLive;
  global.dayaFetchLatestJson = dayaFetchLatestJson;
  global.dayaWriteLive = dayaWriteLive;
  global.dayaPutJson = dayaPutJson;
  global.dayaMergeLive = mergeLiveSources;
  global.dayaSetApiBase = function (url) {
    try { global.localStorage.setItem(STORAGE_KEY, (url || '').replace(/\/+$/, '')); } catch (e) {}
    global.DAYA_API_BASE = resolveApiBase();
    global.FB_URL = global.DAYA_API_BASE;
    global.API = global.DAYA_API_BASE;
  };

  setTimeout(runNasFirebaseSync, 3000);

  try {
    if (global.location && global.location.protocol === 'file:') {
      console.warn('[daya-api] HTML을 더블클릭(file://)으로 열면 API 연동이 막힐 수 있습니다. NAS 주소 또는 폴더에서 로컬 웹서버로 여세요.');
    }
  } catch (e) {}
})(window);
