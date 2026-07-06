/**
 * daya-error-log.js
 * 모든 앱의 JS 에러를 Firebase에 자동 저장
 * 사용법: <script src="daya-error-log.js"></script> 한 줄만 추가
 */
(function () {
  'use strict';

  // 앱 이름 자동 감지 (파일명 기반)
  function detectApp() {
    const p = location.pathname.split('/').pop() || 'unknown';
    if (p.includes('work'))       return '작업자앱';
    if (p.includes('관리자폰'))   return '관리자폰';
    if (p.includes('관리자PC'))   return '관리자PC';
    if (p.includes('리포트'))     return '리포트';
    if (p.includes('설정관리'))   return '설정관리';
    if (p.includes('jkg'))        return '위고비분석';
    return p || 'unknown';
  }

  function getUser() {
    try {
      const s = localStorage.getItem('daya_auth') || sessionStorage.getItem('daya_auth');
      if (s) { const o = JSON.parse(s); return o.name || o.id || '?'; }
    } catch {}
    return window._loginWorkerName || '?';
  }

  function nowStr() {
    const d = new Date();
    return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
  }
  function pad(n) { return String(n).padStart(2,'0'); }

  function dateKey() {
    const d = new Date();
    return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}`;
  }

  // 중복 방지 (같은 에러 10초 내 재발 무시)
  const _recentErrors = new Set();
  function isDuplicate(key) {
    if (_recentErrors.has(key)) return true;
    _recentErrors.add(key);
    setTimeout(() => _recentErrors.delete(key), 10000);
    return false;
  }

  // Firebase에 에러 저장
  async function saveError(payload) {
    const fb = window.FB_URL || window.DAYA_API_BASE;
    if (!fb) return;

    const key = `${Date.now()}_${Math.random().toString(36).slice(2,6)}`;
    const dk = dateKey();

    try {
      await fetch(`${fb}/error_logs/${dk}/${key}.json`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
    } catch (e) {
      // 에러 저장 실패는 조용히 무시 (무한루프 방지)
    }
  }

  function buildPayload(msg, source, lineno, colno, stack) {
    return {
      ts:    Date.now(),
      time:  nowStr(),
      app:   detectApp(),
      user:  getUser(),
      url:   location.href,
      msg:   String(msg).slice(0, 500),
      source: String(source || '').replace(location.origin, ''),
      line:  lineno || 0,
      col:   colno  || 0,
      stack: String(stack || '').slice(0, 1000),
      ua:    navigator.userAgent.slice(0, 150)
    };
  }

  // ── JS 런타임 에러 캐치 ──
  window.onerror = function (msg, source, lineno, colno, error) {
    const key = `${msg}:${lineno}`;
    if (isDuplicate(key)) return false;
    saveError(buildPayload(msg, source, lineno, colno, error?.stack));
    return false; // 기본 에러 처리 유지
  };

  // ── Promise 미처리 에러 캐치 ──
  window.addEventListener('unhandledrejection', function (e) {
    const msg = e.reason?.message || String(e.reason) || 'UnhandledRejection';
    const key = `rej:${msg}`;
    if (isDuplicate(key)) return;
    saveError(buildPayload(
      msg, '', 0, 0,
      e.reason?.stack || ''
    ));
  });

  // ── 수동 에러 로그 (앱에서 직접 호출 가능) ──
  // 사용법: dayaLogError('설명', { 추가정보 })
  window.dayaLogError = function (msg, context) {
    const key = `manual:${msg}`;
    if (isDuplicate(key)) return;
    const payload = buildPayload(msg, '', 0, 0, '');
    payload.context = context ? JSON.stringify(context).slice(0, 500) : '';
    payload.type = 'manual';
    saveError(payload);
  };

  // ── 앱 시작 로그 (선택적: 앱 로드 성공 기록) ──
  window.dayaLogStart = function () {
    const fb = window.FB_URL || window.DAYA_API_BASE;
    if (!fb) return;
    const dk = dateKey();
    const key = `start_${Date.now()}`;
    fetch(`${fb}/error_logs/${dk}/${key}.json`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ts: Date.now(), time: nowStr(),
        app: detectApp(), user: getUser(),
        type: 'start', msg: '앱 정상 로드'
      })
    }).catch(() => {});
  };

})();
