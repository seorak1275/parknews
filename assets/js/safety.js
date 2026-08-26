/* =============================================================
 *  safety.js  —  시기별 안전 캘린더 (수집을 넘어 '활용'으로)
 *
 *  tools/build_safety_calendar.py 가 구운 정적 JSON 하나만 읽습니다.
 *  (assets/data/safety-calendar.json — 1990~ 아카이브의 재난안전·구조활동
 *   위험 유형을 월×공원으로 미리 집계) 서버도 AI 도 쓰지 않습니다.
 *
 *  각도 4가지로 '지금 이 시기'를 읽습니다.
 *   · 강도  — 이번 달 보도량이 그 유형의 월평균 대비 몇 배인가
 *   · 추세  — 최근 5년, 위험 보도 안에서 차지하는 비중이 늘었나
 *             (연도별 '건수'는 수집 깊이가 최근일수록 깊어 그대로 못 쓴다)
 *   · 장소  — 이번 달 이 유형 보도가 가장 몰린 공원은 어디인가
 *   · 사례  — 그 시기 보도가 가장 몰렸던 해의 실제 기사 1건
 *
 *  ※ 전부 언론 보도량입니다. 실제 사고 통계가 아니므로 화면마다
 *    같은 단서를 붙입니다 — 근거 없는 수치를 보여주지 않는 사이트 원칙.
 * ============================================================= */

window.SafetyCal = (() => {
  'use strict';

  const URL = 'assets/data/safety-calendar.json';
  const COLORS = {
    '산불': '#f87171', '호우·태풍': '#38bdf8', '폭설·한파': '#a5b4fc',
    '산사태·낙석': '#c084fc', '폭염·가뭄': '#fb923c', '지진': '#facc15',
    '물놀이 위험지역': '#22d3ee', '실족·추락': '#f472b6', '수난사고': '#60a5fa',
    '조난·고립': '#34d399', '실종·수색': '#94a3b8', '심정지·응급질환': '#fda4af',
    '벌쏘임·뱀': '#fbbf24',
  };
  /* 화면에 쓰는 짧은 이름 — 데이터 키는 그대로 두고 표기만 줄인다 */
  const SHORT = { '물놀이 위험지역': '물놀이 위험', '심정지·응급질환': '심정지·응급' };

  let dataP = null;
  let chart = null;

  const load = () => (dataP ||= fetch(URL).then((r) => {
    if (!r.ok) throw new Error('safety-calendar ' + r.status);
    return r.json();
  }));

  const esc = (s) => String(s ?? '').replace(/[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const label = (key) => SHORT[key] || key;

  /* ---------- 분석 ---------- */

  /** 이번 달 보도량이 월평균의 몇 배인가 (계절 강도) */
  const intensity = (t, m) => (t.total ? t.months[m] / (t.total / 12) : 0);

  /** 이번 달 상위 유형 — 강도순. 표본 3건 미만인 달은 말하지 않는다.
   *  (벌쏘임·뱀처럼 건수는 적어도 계절성이 뚜렷한 유형을 놓치지 않으면서,
   *   건수를 함께 표기해 표본 크기를 숨기지 않는다) */
  function monthTop(data, m, n = 5) {
    return data.types
      .filter((t) => t.months[m] >= 3)
      .map((t) => ({ t, x: intensity(t, m) }))
      .sort((a, b) => b.x - a.x)
      .slice(0, n);
  }

  /** 최근 5년 비중 추세 — 이전 5년과 비교해 1.5배↑/0.67배↓만 뱃지 */
  function trend(data, type) {
    const years = {};
    data.types.forEach((t) => Object.entries(t.years).forEach(([y, n]) => {
      years[y] = (years[y] || 0) + n;
    }));
    const maxY = Math.max(...Object.keys(years).map(Number));
    const win = (t, a, b) => {
      let s = 0;
      for (let y = a; y <= b; y++) s += t.years?.[y] || t.years?.[String(y)] || 0;
      return s;
    };
    const allWin = (a, b) => {
      let s = 0;
      for (let y = a; y <= b; y++) s += years[y] || years[String(y)] || 0;
      return s;
    };
    const recAll = allWin(maxY - 4, maxY), priAll = allWin(maxY - 9, maxY - 5);
    if (priAll < 300 || recAll < 300) return null;   // 표본이 적으면 침묵
    const rec = win(type, maxY - 4, maxY) / recAll;
    const pri = win(type, maxY - 9, maxY - 5) / priAll;
    if (!pri || win(type, maxY - 9, maxY - 5) < 15) return null;
    const r = rec / pri;
    if (r >= 1.5) return { dir: 'up', r };
    if (r <= 0.67) return { dir: 'down', r };
    return null;
  }

  /** 이번 달 이 유형 보도가 몰린 공원 상위 k곳 */
  function topParks(data, key, m, k = 2) {
    return Object.entries(data.parks)
      .map(([p, d]) => [p, d[key]?.[m] || 0])
      .filter(([, n]) => n > 0)
      .sort((a, b) => b[1] - a[1])
      .slice(0, k);
  }

  /* ---------- 전국 카드 (지도 첫 화면) ---------- */

  function rowHtml(data, t, m) {
    const x = intensity(t, m);
    const tr = trend(data, t);
    const parks = topParks(data, t.key, m);
    const ex = t.examples?.[String(m + 1)];
    return `
      <div class="sf-row" data-key="${esc(t.key)}" title="누르면 ${esc(label(t.key))} 상세가 열립니다" role="button" tabindex="0">
        <span class="sf-dot" style="--c:${COLORS[t.key] || '#94a3b8'}"></span>
        <div class="sf-main">
          <p class="sf-name">${esc(label(t.key))}
            ${x >= 1.3 ? `<b class="sf-x">평소의 ${x.toFixed(1)}배</b>` : ''}
            ${tr ? `<i class="sf-tr sf-tr--${tr.dir}" title="최근 5년, 위험 보도 내 비중이 ${tr.dir === 'up' ? '늘었' : '줄었'}습니다">비중${tr.dir === 'up' ? '↑' : '↓'}</i>` : ''}
          </p>
          ${parks.length ? `<p class="sf-parks">주의 ${parks.map(([p]) => esc(p)).join(' · ')}</p>` : ''}
        </div>
        <span class="sf-n">${t.months[m]}건</span>
        ${ex ? `<a class="sf-ex" href="${esc(ex.u)}" target="_blank" rel="noopener noreferrer"
                  title="${ex.y}년 사례 — ${esc(ex.t)}">사례</a>` : '<span class="sf-ex sf-ex--none"></span>'}
      </div>`;
  }

  /** 유형 상세 — 연중 분포·집중 시기·주의 공원·추세·대표 사례 */
  function typeHtml(data, key, m) {
    const t = data.types.find((x) => x.key === key);
    if (!t) return '';
    const c = COLORS[key] || '#94a3b8';
    const max = Math.max(...t.months);
    const peak = t.months.indexOf(max);
    const tr = trend(data, t);
    /* 연중 전체 기준 상위 공원 — '어디서 많이 나는가' */
    const parks = Object.entries(data.parks)
      .map(([p, d]) => [p, (d[key] || []).reduce((a, b) => a + b, 0)])
      .filter(([, n]) => n > 0).sort((a, b) => b[1] - a[1]).slice(0, 3);
    const ex = t.examples?.[String(peak + 1)];
    const bars = t.months.map((n, i) => `
      <div class="sf-bcol${i === m ? ' is-now' : ''}${i === peak ? ' is-peak' : ''}"
           title="${i + 1}월 ${n}건${i === peak ? ' · 연중 최다' : ''}">
        <i style="height:${max ? Math.max(3, Math.round(n / max * 100)) : 3}%;--c:${c}"></i>
        <em>${i + 1}</em>
      </div>`).join('');
    return `
      <div class="sf-detail">
        <p class="sf-dhead">
          <span class="sf-dot" style="--c:${c}"></span>
          <b>${esc(key)}</b>
          <span class="sf-dtotal">${t.total.toLocaleString()}건 · 1990~</span>
          ${tr ? `<i class="sf-tr sf-tr--${tr.dir}">최근 5년 비중${tr.dir === 'up' ? '↑' : '↓'}</i>` : ''}
        </p>
        <div class="sf-bars">${bars}</div>
        <p class="sf-dline"><b>${peak + 1}월 집중</b> — 연중 보도의 ${Math.round(max / t.total * 100)}%가 ${peak + 1}월에 나왔습니다.
          지금(${m + 1}월)은 ${t.months[m]}건${intensity(t, m) >= 1.3 ? ` · 월평균의 ${intensity(t, m).toFixed(1)}배` : ''}.</p>
        ${parks.length ? `<p class="sf-dline">주의 공원 — ${parks.map(([p, n]) => `${esc(p)} ${n}건`).join(' · ')}</p>` : ''}
        ${ex ? `<a class="sp-ex" href="${esc(ex.u)}" target="_blank" rel="noopener noreferrer">
            <span class="sp-ex__tag">${ex.y}년 ${peak + 1}월 · 대표 사례</span>
            <span class="sp-ex__t">${esc(ex.t)}</span>
          </a>` : ''}
      </div>`;
  }

  async function renderBox(box) {
    const data = await load();
    const m = new Date().getMonth();
    const top = monthTop(data, m);
    if (!top.length) return false;   // 말할 게 없으면 카드째로 안 띄운다

    const KEY = 'parknews-safetybox';
    let state;
    try { state = localStorage.getItem(KEY); } catch { state = null; }
    /* 좁은 화면에서는 지도를 가리지 않게 접힌 채로 시작 */
    if (!state) state = window.innerWidth <= 860 ? 'min' : 'open';

    /* 연간 뷰 — 1~12월 각 달의 상위 위험을 한 줄씩. 이번 달은 또렷하게. */
    const yearHtml = () => Array.from({ length: 12 }, (_, mm) => {
      const rows = monthTop(data, mm, 3);
      return `
        <div class="sf-yrow${mm === m ? ' is-now' : ''}">
          <span class="sf-ym">${mm + 1}월</span>
          <span class="sf-ychips">${rows.length ? rows.map(({ t, x }) =>
            `<button class="sf-ychip" data-key="${esc(t.key)}" style="--c:${COLORS[t.key] || '#94a3b8'}"
                   title="${esc(t.key)} ${t.months[mm]}건 · 월평균의 ${x.toFixed(1)}배 — 누르면 상세">${esc(label(t.key))}</button>`
          ).join('') : '<span class="sf-yquiet">두드러진 위험 없음</span>'}</span>
        </div>`;
    }).join('');

    const head = (title) => `
      <header class="sf-head">
        <b title="이 시기 보도가 몰리는 위험">${title}</b>
        <span class="sf-sub"></span>
        <button class="sf-seg${state === 'year' ? '' : ' is-on'}" id="sf-now" title="이번 달 보기">${m + 1}월</button>
        <button class="sf-seg${state === 'year' ? ' is-on' : ''}" id="sf-year" title="열두 달 한눈에">연간</button>
        <button class="iconbtn sf-min" id="sf-min" aria-label="접기" title="접기">
          <svg viewBox="0 0 24 24" width="14" height="14"><path d="M5 12h14" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"/></svg>
        </button>
      </header>`;
    const note = `<p class="sf-note">1990~ 아카이브 ${data.source.rows_used.toLocaleString()}건 집계 ·
      언론 보도량 기준 — 실제 사고 통계가 아닙니다.</p>`;

    let typeView = null;   // 유형 상세 — 접었다 펴면 목록으로 돌아간다 (저장 안 함)

    const draw = () => {
      box.classList.toggle('is-min', state === 'min');
      box.classList.toggle('is-year', state === 'year' && !typeView);
      box.innerHTML = state === 'min'
        ? `<button class="sf-pill" id="sf-open" title="펼치기">
             <b>${m + 1}월 안전 유의</b> ${top.slice(0, 2).map(({ t }) => esc(label(t.key))).join(' · ')} 외
           </button>`
        : typeView
          ? `<header class="sf-head">
               <button class="iconbtn sf-min" id="sf-back" aria-label="목록으로" title="목록으로">
                 <svg viewBox="0 0 24 24" width="14" height="14"><path d="M15 6l-6 6 6 6" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg>
               </button>
               <b>위험 유형 상세</b><span class="sf-sub"></span>
               <button class="iconbtn sf-min" id="sf-min" aria-label="접기" title="접기">
                 <svg viewBox="0 0 24 24" width="14" height="14"><path d="M5 12h14" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"/></svg>
               </button>
             </header>` + typeHtml(data, typeView, m) + note
          : state === 'year'
            ? head('연간 안전 캘린더') + `<div class="sf-ywrap">${yearHtml()}</div>` + note
            : head(`${m + 1}월 안전 캘린더`) + top.map(({ t }) => rowHtml(data, t, m)).join('') + note;
      box.querySelector('#sf-min')?.addEventListener('click', () => { typeView = null; set('min'); });
      box.querySelector('#sf-open')?.addEventListener('click', () => set('open'));
      box.querySelector('#sf-now')?.addEventListener('click', () => { typeView = null; set('open'); });
      box.querySelector('#sf-year')?.addEventListener('click', () => { typeView = null; set('year'); });
      box.querySelector('#sf-back')?.addEventListener('click', () => { typeView = null; draw(); });
      /* 유형을 누르면 상세로 — 행 안의 '사례' 링크 클릭은 그대로 통과시킨다 */
      box.querySelectorAll('[data-key]').forEach((el) => {
        el.addEventListener('click', (e) => {
          if (e.target.closest('a')) return;
          typeView = el.dataset.key;
          draw();
        });
      });
    };
    const set = (s) => {
      state = s;
      try { localStorage.setItem(KEY, s); } catch { /* 무시 */ }
      draw();
    };
    draw();
    return true;
  }

  /* ---------- 공원 프로필 (사이드바) ---------- */

  /** 공원명 매핑 — '설악산국립공원' → 데이터의 '설악산' */
  const shortName = (region) => (region.name || '').replace(/국립공원$/, '');

  async function renderPark(region) {
    const data = await load();
    const m = new Date().getMonth();
    const pName = shortName(region);
    const pd = data.parks[pName];
    const pTotal = pd ? Object.values(pd).reduce((s, mm) => s + mm.reduce((a, b) => a + b, 0), 0) : 0;

    /* 표본이 적은 공원(최근 지정 등)은 전국 집계로 대신하고 그렇다고 말한다 */
    const sparse = pTotal < 40;
    const src = sparse
      ? Object.fromEntries(data.types.map((t) => [t.key, t.months]))
      : pd;

    const totals = Object.entries(src)
      .map(([k, mm]) => [k, mm.reduce((a, b) => a + b, 0)])
      .sort((a, b) => b[1] - a[1]);
    const topTypes = totals.slice(0, 4).map(([k]) => k);
    if (!topTypes.length) return false;

    /* 이번 달 상위 — 건수순, 2건 미만은 말하지 않는다 */
    const nowTop = Object.entries(src)
      .map(([k, mm]) => [k, mm[m]])
      .filter(([, n]) => n >= 2)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 3);

    const topEl = document.getElementById('sp-top');
    const badge = document.getElementById('sp-badge');
    const exEl = document.getElementById('sp-example');
    const canvas = document.getElementById('sp-canvas');
    if (!topEl || !canvas) return false;

    if (badge) {
      badge.textContent = sparse ? '전국 기준' : `${pName} ${pTotal.toLocaleString()}건`;
      badge.title = sparse
        ? `${pName} 표본이 적어(${pTotal}건) 전국 집계를 보여줍니다`
        : `1990~ 아카이브에서 ${pName} 위험 유형 보도 ${pTotal.toLocaleString()}건`;
    }

    topEl.innerHTML = nowTop.length
      ? `<p class="sp-now"><b>${m + 1}월 상위</b> ${nowTop.map(([k, n]) =>
          `<span class="sp-chip" style="--c:${COLORS[k] || '#94a3b8'}">${esc(label(k))} ${n}건</span>`).join('')}</p>`
      : `<p class="sp-now muted sm">${m + 1}월에 두드러진 유형이 없습니다.</p>`;

    /* 대표 사례 — 이번 달 1위 유형의 전국 사례 기사 */
    const exKey = nowTop[0]?.[0];
    const ex = exKey && data.types.find((t) => t.key === exKey)?.examples?.[String(m + 1)];
    if (exEl) {
      exEl.innerHTML = ex
        ? `<a class="sp-ex" href="${esc(ex.u)}" target="_blank" rel="noopener noreferrer">
             <span class="sp-ex__tag">${ex.y}년 ${m + 1}월 · 전국 사례</span>
             <span class="sp-ex__t">${esc(ex.t)}</span>
           </a>`
        : '';
    }

    /* 12개월 누적 막대 — 이번 달만 또렷하게, 나머지는 반투명 */
    if (chart) { chart.destroy(); chart = null; }
    chart = new Chart(canvas.getContext('2d'), {
      type: 'bar',
      data: {
        labels: ['1월', '2월', '3월', '4월', '5월', '6월', '7월', '8월', '9월', '10월', '11월', '12월'],
        datasets: topTypes.map((k) => ({
          label: label(k),
          data: src[k],
          backgroundColor: (c) => {
            const base = COLORS[k] || '#94a3b8';
            return c.dataIndex === m ? base : base + '55';
          },
          borderWidth: 0,
          stack: 's',
          borderRadius: 2,
          barPercentage: 0.8,
        })),
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        animation: { duration: 700, easing: 'easeOutQuart' },
        interaction: { mode: 'index', intersect: false },
        plugins: {
          legend: {
            display: true, position: 'bottom',
            labels: { color: 'rgba(255,255,255,0.55)', boxWidth: 8, boxHeight: 8, font: { size: 10 }, padding: 8 },
          },
          tooltip: {
            backgroundColor: 'rgba(13,17,28,0.94)',
            borderColor: 'rgba(255,255,255,0.14)', borderWidth: 1,
            titleColor: 'rgba(255,255,255,0.62)', bodyColor: '#fff',
            titleFont: { size: 11 }, bodyFont: { size: 12 },
            padding: 10,
            callbacks: { label: (c) => ` ${c.dataset.label} ${c.parsed.y}건` },
          },
        },
        scales: {
          x: {
            stacked: true, grid: { display: false },
            border: { color: 'rgba(255,255,255,0.10)' },
            ticks: { color: 'rgba(255,255,255,0.42)', font: { size: 9.5 }, maxRotation: 0, autoSkip: true, maxTicksLimit: 12 },
          },
          y: {
            stacked: true, beginAtZero: true,
            grid: { color: 'rgba(255,255,255,0.06)', drawTicks: false },
            border: { display: false },
            ticks: { color: 'rgba(255,255,255,0.42)', font: { size: 10 }, maxTicksLimit: 4, padding: 6 },
          },
        },
      },
    });
    return true;
  }

  function destroy() { if (chart) { chart.destroy(); chart = null; } }

  /* 전국 카드는 컨테이너가 있는 화면(index)에서만 스스로 뜬다 */
  const box = document.getElementById('safetybox');
  if (box) {
    renderBox(box).then((ok) => { if (ok) box.hidden = false; })
      .catch(() => { /* 데이터가 없으면 조용히 안 띄운다 */ });
  }

  return { load, renderPark, destroy };
})();
