/**
 * daya-predict.js — 주문량·박스수 예측 위젯
 * - 히스토리에서 주문량→박스수 비율 자동학습
 * - 현재주문량, 예상주문량, 예상박스량, 진행율, 완료예상시간 제공
 * - 세 앱 공통 (work.html / 관리자폰 / 관리자PC)
 */
(function (global) {
  'use strict';

  var RATIO_MIN = 0.005;  // 1박스 최대 200개 (대량 주문 허용)
  var RATIO_MAX = 1.0;    // 1박스 최소 1개
  var HIST_DAYS = 30;

  var _ratio = null;          // 학습된 주문량→박스수 비율
  var _orderAvgByDow = {};   // 요일별 평균 주문량 {1:n, 2:n, ...} (legacy)
  var _dayRecords = [];      // 학습된 일별 raw 레코드 [{date, dow, oq}, ...] (시간순)
  var _loaded = false;
  var _loading = false;
  var _lastLiveData = null;  // 마지막으로 렌더한 live 데이터 (학습 완료 후 재렌더용)

  /* ── 통계 헬퍼 ── */
  function removeOutliers(arr) {
    // IQR(사분위수) 기반 outlier 제거. n<4면 그대로 반환
    if (!arr || arr.length < 4) return (arr || []).slice();
    var s = arr.slice().sort(function (a, b) { return a - b; });
    var n = s.length;
    var q1 = s[Math.floor(n / 4)];
    var q3 = s[Math.floor(3 * n / 4)];
    var iqr = q3 - q1;
    var lo = q1 - 1.5 * iqr;
    var hi = q3 + 1.5 * iqr;
    return arr.filter(function (x) { return x >= lo && x <= hi; });
  }

  function median(arr) {
    if (!arr || arr.length === 0) return null;
    var s = arr.slice().sort(function (a, b) { return a - b; });
    var n = s.length;
    return n % 2 ? s[(n - 1) / 2] : (s[n / 2 - 1] + s[n / 2]) / 2;
  }

  function mean(arr) {
    if (!arr || arr.length === 0) return null;
    return arr.reduce(function (a, b) { return a + b; }, 0) / arr.length;
  }

  /* ── 모델 H: 블렌드 + 트렌드보정 (백테스트 MAPE 88.6% → 57.3%) ── */
  function predictOrdersModelH(dow) {
    if (!_dayRecords || _dayRecords.length < 5) return null;
    // 같은 요일 표본 (전체)
    var dowOq = _dayRecords.filter(function (r) { return r.dow === dow; }).map(function (r) { return r.oq; });
    // 최근 7일 (요일 무관)
    var recent7 = _dayRecords.slice(-7).map(function (r) { return r.oq; });
    // 최근 같은 요일 4개
    var sameDowRecent = _dayRecords.filter(function (r) { return r.dow === dow; }).slice(-4).map(function (r) { return r.oq; });

    var a = median(removeOutliers(dowOq));      // 요일중앙값 (정제)
    var b = median(removeOutliers(recent7));    // 최근7일 중앙값 (정제)
    var c = sameDowRecent.length ? median(sameDowRecent) : null;

    var parts = [];
    if (a !== null) parts.push([0.4, a]);
    if (b !== null) parts.push([0.4, b]);
    if (c !== null) parts.push([0.2, c]);
    if (!parts.length) return null;
    var totW = parts.reduce(function (s, p) { return s + p[0]; }, 0);
    var base = parts.reduce(function (s, p) { return s + p[0] * p[1]; }, 0) / totW;

    // 트렌드 보정: 최근7일 평균 / 그 이전7일 평균 (±30% 클램프, 절반 적용)
    var oqList = _dayRecords.map(function (r) { return r.oq; });
    if (oqList.length >= 14) {
      var r1 = mean(oqList.slice(-7));
      var r2 = mean(oqList.slice(-14, -7));
      if (r2 > 0) {
        var trend = Math.max(0.7, Math.min(1.3, r1 / r2));
        base = base * (0.5 + 0.5 * trend);
      }
    }
    return Math.round(base);
  }

  /* ── 유틸 ── */
  function apiBase() {
    return (global.DAYA_API_BASE || 'https://daya.sudalife.net/api').replace(/\/+$/, '');
  }

  function sumOrderLog(log) {
    if (!log || typeof log !== 'object') return 0;
    var total = 0;
    Object.values(log).forEach(function (entries) {
      // Firebase RTDB가 배열을 객체로 변환하므로 둘 다 처리
      var arr = Array.isArray(entries) ? entries : Object.values(entries);
      arr.forEach(function (e) { total += parseInt(e && e.qty) || 0; });
    });
    return total;
  }

  // 종근당 주문로그만 합산 (전체 업체 합산 오류 방지)
  function sumJkgOrderLog(log) {
    if (!log || !log['종근당']) return 0;
    var entries = log['종근당'];
    var arr = Array.isArray(entries) ? entries : Object.values(entries);
    return arr.reduce(function (s, e) { return s + (parseInt(e && e.qty) || 0); }, 0);
  }

  function fetchJson(url) {
    return fetch(url + (url.indexOf('?') >= 0 ? '&' : '?') + '_t=' + Date.now())
      .then(function (r) { return r.ok ? r.json() : null; })
      .catch(function () { return null; });
  }

  /* ── 히스토리 학습 ── */
  function learnFromHistory() {
    if (_loading) return Promise.resolve();
    _loading = true;
    var base = apiBase();
    var today = new Date();
    var fetches = [];
    for (var i = 1; i <= HIST_DAYS; i++) {
      var d = new Date(today);
      d.setDate(d.getDate() - i);
      var dk = d.toISOString().slice(0, 10);
      fetches.push({ dow: d.getDay(), url: base + '/history/' + dk + '.json' });
    }

    return Promise.allSettled(fetches.map(function (f, idx) {
      return fetchJson(f.url).then(function (h) {
        // date 정보 추가 (시간순 정렬용)
        var d = new Date();
        d.setDate(d.getDate() - (idx + 1));
        var dk = d.toISOString().slice(0, 10);
        return h ? { dow: f.dow, hist: h, date: dk } : null;
      });
    })).then(function (results) {
      var ratioSamples = [];
      var dowSums = {};
      var dowCnts = {};
      var rawDayRecs = [];  // [{date, dow, oq}]

      results.forEach(function (r) {
        if (r.status !== 'fulfilled' || !r.value) return;
        var dow = r.value.dow;
        var hist = r.value.hist;
        var date = r.value.date;
        if (!hist || typeof hist !== 'object') return;
        if (dow === 0 || dow === 6) return; // 주말 제외

        // 박스수: work.html 저장값 우선, 없으면 관리자폰 instrData.종근당.boxes 사용
        var boxes = (hist.종근당 && hist.종근당.매핑)
          ? parseInt(hist.종근당.매핑)
          : (hist.instrData && hist.instrData.종근당 && hist.instrData.종근당.boxes
              ? parseInt(hist.instrData.종근당.boxes) : 0);
        // 지시수량(instr) 우선 — 건수(count)는 스케일 달라 ratio 계산 불가
        var orders = hist.jkgOrderTotal
          ? parseInt(hist.jkgOrderTotal)
          : (hist.instrData && hist.instrData['종근당'] && hist.instrData['종근당'].instr
              ? parseInt(hist.instrData['종근당'].instr) : 0);
        if (!orders) orders = sumJkgOrderLog(hist.주문로그); // 종근당 전용 합산
        // 최후 fallback: count (스케일 다르지만 없는 것보다 나음)
        if (!orders && hist.instrData && hist.instrData['종근당'] && hist.instrData['종근당'].count) {
          orders = parseInt(hist.instrData['종근당'].count) || 0;
        }

        if (orders > 0) {
          dowSums[dow] = (dowSums[dow] || 0) + orders;
          dowCnts[dow] = (dowCnts[dow] || 0) + 1;
          rawDayRecs.push({ date: date, dow: dow, oq: orders });
        }
        if (boxes > 0 && orders > 0) {
          var r2 = boxes / orders;
          if (r2 >= RATIO_MIN && r2 <= RATIO_MAX) {
            ratioSamples.push(r2);
          }
        }
      });

      // 박스/주문량 비율: outlier 제거 후 평균 (IQR 기반)
      if (ratioSamples.length > 0) {
        var cleanedRatios = removeOutliers(ratioSamples);
        var src = cleanedRatios.length >= 4 ? cleanedRatios : ratioSamples;
        _ratio = src.reduce(function (a, b) { return a + b; }, 0) / src.length;
      }

      // legacy: 요일평균 (fallback용)
      [1, 2, 3, 4, 5].forEach(function (d) {
        if (dowCnts[d] > 0) {
          _orderAvgByDow[d] = Math.round(dowSums[d] / dowCnts[d]);
        }
      });

      // 모델 H 학습용: 시간순 정렬 (date asc)
      rawDayRecs.sort(function (a, b) { return a.date < b.date ? -1 : a.date > b.date ? 1 : 0; });
      _dayRecords = rawDayRecs;

      _loaded = true;
      _loading = false;

      // 학습 완료 → 이미 렌더된 위젯이 있으면 최신 비율로 재렌더
      if (_lastLiveData) {
        renderOrderPred('orderPredWrap', _lastLiveData);
      }
    }).catch(function () {
      _loading = false;
    });
  }

  /* ── 예측 계산 ── */
  function calcPredict(liveData) {
    var now = new Date();
    var dow = now.getDay();

    // 현재 주문량 — 종근당 전용 데이터만 사용 (orderTotal은 전체 업체 합산이라 사용 안 함)
    var currentOrders = 0;
    if (liveData) {
      // 종근당 주문 건수: jkgOrderCount 필드 우선, 없으면 주문로그.종근당 합산
      if (liveData.jkgOrderCount) {
        currentOrders = parseInt(liveData.jkgOrderCount) || 0;
      } else if (liveData.주문로그 && liveData.주문로그.종근당) {
        var jkgLog = liveData.주문로그.종근당;
        var arr = Array.isArray(jkgLog) ? jkgLog : Object.values(jkgLog);
        currentOrders = arr.reduce(function(s,e){ return s + (parseInt(e&&e.qty)||0); }, 0);
      }
    }

    // 현재 박스수 (작업자 입력)
    var currentBoxes = (liveData && liveData.종근당 && liveData.종근당.매핑)
      ? parseInt(liveData.종근당.매핑) : 0;

    // 학습된 비율 (없으면 박스 계산 불가)
    var ratio = _ratio;  // null이면 계산 안 함

    // 예상 주문량 — 모델 H (블렌드+트렌드보정) 우선, fallback: 요일평균
    var predictedOrders = null;
    if (dow >= 1 && dow <= 5) {
      predictedOrders = predictOrdersModelH(dow);
      if (predictedOrders === null) predictedOrders = _orderAvgByDow[dow] || null;
    }

    // 예상 박스량 (학습된 ratio가 있을 때만)
    var predictedBoxes = (ratio !== null && predictedOrders)
      ? Math.round(predictedOrders * ratio) : null;

    // 현재 주문량 기준 예상 박스수 (학습된 ratio가 있을 때만)
    var currentExpectedBoxes = (ratio !== null && currentOrders > 0)
      ? Math.round(currentOrders * ratio) : 0;

    // 진행율: 현재 박스수 / 예상 박스량 (ratio 학습된 경우만)
    var progress = 0;
    if (ratio !== null) {
      if (predictedBoxes && predictedBoxes > 0) {
        progress = Math.min(Math.round(currentBoxes / predictedBoxes * 100), 999);
      } else if (currentExpectedBoxes > 0) {
        progress = Math.min(Math.round(currentBoxes / currentExpectedBoxes * 100), 999);
      }
    }

    // 시간당 박스 처리 속도 (9시 기준)
    var start = new Date();
    start.setHours(9, 0, 0, 0);
    var elapsedHours = Math.max((now.getTime() - start.getTime()) / 3600000, 0.5);
    var boxesPerHour = currentBoxes > 0 ? currentBoxes / elapsedHours : 0;

    // ETA 계산 (ratio가 없으면 박스 기준 ETA도 없음)
    var etaCurrent = null, etaAll = null;
    if (boxesPerHour > 0 && ratio !== null) {
      var remCurrent = Math.max(currentExpectedBoxes - currentBoxes, 0);
      if (remCurrent > 0) {
        etaCurrent = new Date(now.getTime() + (remCurrent / boxesPerHour) * 3600000);
      } else {
        etaCurrent = now;
      }
      if (predictedBoxes) {
        var remAll = Math.max(predictedBoxes - currentBoxes, 0);
        if (remAll > 0) {
          etaAll = new Date(now.getTime() + (remAll / boxesPerHour) * 3600000);
        } else {
          etaAll = now;
        }
      }
    }

    return {
      currentOrders: currentOrders,
      currentBoxes: currentBoxes,
      currentExpectedBoxes: currentExpectedBoxes,
      predictedOrders: predictedOrders,
      predictedBoxes: predictedBoxes,
      progress: progress,
      ratio: ratio,
      ratioLearned: _ratio !== null,
      boxesPerHour: Math.round(boxesPerHour),
      etaCurrent: etaCurrent,
      etaAll: etaAll,
      loaded: _loaded,
      sampleCount: 0
    };
  }

  function fmtTime(date) {
    if (!date) return '—';
    var h = date.getHours();
    var m = String(date.getMinutes()).padStart(2, '0');
    return h + ':' + m;
  }

  /* ── 위젯 렌더링 ── */
  function renderOrderPred(containerId, liveData) {
    var container = document.getElementById(containerId);
    if (!container) return;

    // 마지막 live 데이터 캐싱 (학습 완료 후 재렌더용)
    if (liveData) _lastLiveData = liveData;

    var p = calcPredict(liveData);

    // 주문량도 없고 박스 작업도 없고 예측도 없으면 숨김
    if (!p.currentOrders && !p.predictedOrders && !p.currentBoxes) {
      container.style.display = 'none';
      return;
    }
    container.style.display = '';

    var ratioLabel = p.ratioLearned
      ? Math.round(p.ratio * 100) + '%'
      : '학습중';
    var ratioColor = p.ratioLearned ? 'var(--a3)' : '#ef4444';
    var curBoxText = p.ratioLearned ? ('→ ' + p.currentExpectedBoxes + '박스') : '비율 학습 후 표시';

    var etaCurrentText, etaAllText;
    if (!p.ratioLearned) {
      etaCurrentText = '비율학습후표시';
      etaAllText = '비율학습후표시';
    } else if (!p.boxesPerHour) {
      etaCurrentText = p.currentBoxes > 0 ? '계산중' : '작업대기';
      etaAllText = '—';
    } else {
      var nowTs = new Date();
      etaCurrentText = (p.etaCurrent && p.etaCurrent > nowTs) ? fmtTime(p.etaCurrent) : '완료';
      etaAllText = (p.etaAll && p.etaAll > nowTs) ? fmtTime(p.etaAll) : (p.predictedBoxes ? '완료' : '—');
    }

    var progressColor = p.progress >= 100
      ? 'linear-gradient(90deg,var(--a3),var(--a6))'
      : 'linear-gradient(90deg,var(--a1),var(--a3))';
    var progressBarW = Math.min(p.progress, 100);
    var progressTextColor = p.progress >= 100 ? 'var(--a6)' : 'var(--a5)';

    container.innerHTML =
      '<div style="margin-bottom:6px;font-size:10px;font-weight:800;color:var(--a3);letter-spacing:.5px;">📦 주문량 예측</div>' +
      '<div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:6px;margin-bottom:8px;">' +
        '<div style="background:rgba(59,158,255,.1);border:1px solid rgba(59,158,255,.3);border-radius:9px;padding:8px 6px;text-align:center;">' +
          '<div style="font-size:9px;color:var(--muted);font-weight:700;margin-bottom:2px;">현재주문량</div>' +
          '<div style="font-size:20px;font-weight:900;color:var(--a1);line-height:1.1;">' + (p.currentOrders || '—') + '</div>' +
          '<div style="font-size:8px;color:' + (p.ratioLearned ? 'var(--muted)' : '#ef4444') + ';margin-top:2px;">' + curBoxText + '</div>' +
        '</div>' +
        '<div style="background:rgba(255,214,0,.08);border:1px solid rgba(255,214,0,.3);border-radius:9px;padding:8px 6px;text-align:center;">' +
          '<div style="font-size:9px;color:var(--muted);font-weight:700;margin-bottom:2px;">예상주문량</div>' +
          '<div style="font-size:20px;font-weight:900;color:var(--a5);line-height:1.1;">' + (p.predictedOrders !== null ? p.predictedOrders : '—') + '</div>' +
          '<div style="font-size:8px;color:var(--muted);margin-top:2px;">' + (p.predictedOrders ? '요일평균' : '데이터부족') + '</div>' +
        '</div>' +
        '<div style="background:rgba(46,204,113,.08);border:1px solid rgba(46,204,113,.3);border-radius:9px;padding:8px 6px;text-align:center;">' +
          '<div style="font-size:9px;color:var(--muted);font-weight:700;margin-bottom:2px;">예상박스량</div>' +
          '<div style="font-size:20px;font-weight:900;color:var(--a3);line-height:1.1;">' + (p.predictedBoxes !== null ? p.predictedBoxes : '—') + '</div>' +
          '<div style="font-size:8px;color:' + ratioColor + ';margin-top:2px;">비율 ' + ratioLabel + '</div>' +
        '</div>' +
      '</div>' +
      '<div style="margin-bottom:8px;">' +
        '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:3px;">' +
          '<span style="font-size:10px;color:var(--muted);font-weight:700;">현재진행율</span>' +
          '<span style="font-size:14px;font-weight:900;color:' + progressTextColor + ';">' + p.progress + '%</span>' +
        '</div>' +
        '<div style="background:rgba(255,255,255,.08);border-radius:5px;height:7px;overflow:hidden;">' +
          '<div style="height:100%;border-radius:5px;background:' + progressColor + ';width:' + progressBarW + '%;transition:width .5s;"></div>' +
        '</div>' +
      '</div>' +
      '<div style="display:grid;grid-template-columns:1fr 1fr;gap:6px;">' +
        '<div style="background:rgba(255,255,255,.04);border:1px solid rgba(255,255,255,.1);border-radius:8px;padding:8px 10px;">' +
          '<div style="font-size:8px;color:var(--muted);font-weight:700;margin-bottom:3px;">현재주문 완료예상</div>' +
          '<div style="font-size:16px;font-weight:900;color:var(--a3);">' + etaCurrentText + '</div>' +
        '</div>' +
        '<div style="background:rgba(255,255,255,.04);border:1px solid rgba(255,255,255,.1);border-radius:8px;padding:8px 10px;">' +
          '<div style="font-size:8px;color:var(--muted);font-weight:700;margin-bottom:3px;">전체예상 완료시간</div>' +
          '<div style="font-size:16px;font-weight:900;color:var(--a5);">' + etaAllText + '</div>' +
        '</div>' +
      '</div>';
  }

  /* ── 전역 노출 ── */
  global.dayaLearnRatio = learnFromHistory;
  global.dayaOrderPredict = calcPredict;
  global.dayaRenderOrderPred = renderOrderPred;
  global.dayaGetLearnedRatio = function () { return _ratio; };

  /* ── 페이지 로드 후 자동 학습 (3초 딜레이) ── */
  function startLearn() { setTimeout(learnFromHistory, 3000); }
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', startLearn);
  } else {
    startLearn();
  }

})(window);
