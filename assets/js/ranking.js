/* =============================================================
 *  ranking.js  —  통합 인기뉴스 순위 (국내 / 국외 · 실시간 ~ 연간)
 *
 *  순위 기준
 *    같은 사안을 보도한 매체가 많을수록 위로 올라갑니다.
 *    단일 매체 단독 기사는 아무리 최신이어도 상위에 오지 않습니다.
 *    → 조회수(화제성)가 아니라 "언론이 얼마나 중요하게 봤나"를 재는 지표입니다.
 *
 *  기간
 *    실시간  지금 이 순간 검색되는 기사로 즉석 집계 (NewsService)
 *    일·주·월·연  매일 아침 쌓아둔 보관본을 합산 (/api/ranking-archive)
 *
 *  보관본은 2026-08-16부터 하루씩 쌓입니다. 그 이전 기간은 소급되지 않으므로
 *  주간은 7일, 월간은 30일, 연간은 12개월이 지나야 온전한 순위가 됩니다.
 *  (모자란 동안에는 "n일치 기준"이라고 화면에 밝힙니다)
 * ============================================================= */

window.Ranking = (() => {
  'use strict';

  const $ = (s) => document.querySelector(s);
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  const SETS = {
    kr: {
      label: '국내',
      lang: 'ko',
      queries: ['국립공원', '국립공원공단', '국립공원 탐방', '국립공원 멸종위기',
                '국립공원 지정', '국립공원 안전', '설악산 국립공원', '지리산 국립공원'],
    },
    global: {
      label: '국외',
      lang: 'en',
      queries: ['national park', 'national park conservation', 'national park wildlife',
                'national park visitors', 'IUCN protected area', 'UNESCO natural heritage',
                'national park service', 'national park funding'],
    },
  };

  const PERIODS = {
    live:  '실시간',
    day:   '일간',
    week:  '주간',
    month: '월간',
    year:  '연간',
  };

  const state = { tab: 'kr', period: 'live', cache: {}, loading: false };
  const TTL = 10 * 60 * 1000;

  /* ==========================================================
   *  자료 가져오기 — 실시간은 즉석 집계, 나머지는 보관본
   * ======================================================== */

  /** 실시간: 지금 검색되는 기사를 그 자리에서 묶어 순위를 낸다 */
  async function fetchLive(which) {
    const cfg = SETS[which];
    const batches = await Promise.all(
      cfg.queries.map((q) => NewsService.search(q, cfg.lang, 25).catch(() => []))
    );
    const groups = NewsService.groupIssues(batches.flat()).slice(0, 25);
    return {
      rows: groups.map((g) => ({
        title: g.lead.title,
        link: g.lead.link,
        press: g.outlets,
        outletCount: g.outletCount,
        reports: g.arts.length,
        time: NewsService.timeAgo(g.lead.date),
        others: g.arts.slice(1, 4).map((o) => ({ title: o.title, press: o.press, link: o.link })),
      })),
      note: `지금 검색되는 기사 기준 · ${new Date().toLocaleTimeString('ko-KR', { hour12: false })} 집계`,
    };
  }

  /** 일·주·월·연: 매일 쌓아둔 보관본을 합산해 받아온다 */
  async function fetchArchive(which, period) {
    const r = await fetch(`/api/ranking-archive?period=${period}&set=${which}`);
    const data = await r.json().catch(() => ({}));

    if (!r.ok) {
      const err = new Error(data.error || `순위를 불러오지 못했습니다 (${r.status})`);
      err.hint = data.hint;
      err.soft = r.status === 404;      // 자료가 아직 없는 것 — 고장이 아님
      throw err;
    }

    const unitKo = data.unit === 'month' ? '개월' : '일';
    const partial = data.have < data.want
      ? ` · <b>${data.have}${unitKo}치만 쌓여 있습니다</b> (${data.want}${unitKo} 기준 예정)`
      : '';

    return {
      rows: (data.rows || []).map((x) => ({
        title: x.title,
        link: x.link,
        press: x.press || [],
        outletCount: x.outletCount || (x.press || []).length,
        reports: x.reports || 0,
        time: '',
        others: (x.articles || []).slice(1, 4),
      })),
      note: `${esc(data.from)} ~ ${esc(data.to)} 보도 합산${partial}`,
    };
  }

  /* ==========================================================
   *  제목 → 공원 찾기 (위치 바로가기)
   *
   *  해외 기사는 "Bulldozers tear through Big Bend national park…" 처럼
   *  제목만 봐서는 그 공원이 어디 있는 나라인지 알 수 없다.
   *  제목에서 공원 이름을 찾아내 지도로 보내주는 버튼을 붙인다.
   * ======================================================== */
  let parkIndex = null;

  const reEsc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

  async function ensureParkIndex() {
    if (parkIndex) return parkIndex;
    const idx = [];

    /* 국내 24곳 — '지리산국립공원' → '지리산' 으로 찾는다 */
    for (const r of (window.REGIONS_KR || [])) {
      const key = r.name.replace('국립공원', '').trim();
      if (key.length >= 2) idx.push({ key, park: r, ko: true });
    }

    /* 해외 3,313곳 — 'Big Bend National Park' → 'big bend' */
    const norm = (s) => String(s || '').toLowerCase()
      .replace(/national\s*park|nationalpark|national\s*monument|national\s*preserve/g, ' ')
      .replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();

    try {
      for (const p of await Explorer.allParks()) {
        /* name 과 nameEn 을 둘 다 넣는다.
           미국 Glacier 는 nameEn 이 'Glacier National Park Montana' 라서
           nameEn 만 보면 기사 제목의 'Glacier National Park' 과 안 맞고,
           같은 이름의 캐나다 공원으로 잘못 가버린다. */
        for (const key of new Set([norm(p.nameEn), norm(p.name)])) {
          if (key.length >= 4) idx.push({ key, park: p, re: new RegExp(`\\b${reEsc(key)}\\b`) });
        }
      }
    } catch (e) {
      console.warn('해외 공원 목록을 불러오지 못해 위치 바로가기를 건너뜁니다:', e);
    }

    /* 긴 이름 우선 → 같은 길이면 큐레이션된(유명한) 공원 우선.
       'glacier' 처럼 여러 나라에 같은 이름이 있을 때 뉴스에 나올 법한 쪽을 고른다. */
    idx.sort((a, b) => b.key.length - a.key.length
      || (b.park.curated ? 1 : 0) - (a.park.curated ? 1 : 0));
    parkIndex = idx;
    return idx;
  }

  function findPark(title, idx) {
    const t = String(title).toLowerCase();
    for (const e of idx) {
      if (e.ko) {
        /* '경주' 처럼 짧은 이름은 지명과 겹치므로 '국립공원'이 함께 있을 때만 인정 */
        if (!t.includes(e.key)) continue;
        if (e.key.length <= 2 && !t.includes('국립공원')) continue;
        return e.park;
      }
      if (e.re.test(t)) return e.park;
    }
    return null;
  }

  async function attachParks(rows) {
    try {
      const idx = await ensureParkIndex();
      return rows.map((r) => ({ ...r, park: findPark(r.title, idx) }));
    } catch {
      return rows;                     // 위치 버튼만 빠지고 순위는 그대로 보여준다
    }
  }

  async function fetchRank(which, period) {
    const ck = `${which}|${period}`;
    const hit = state.cache[ck];
    if (hit && Date.now() - hit.at < TTL) return hit.res;

    const raw = period === 'live' ? await fetchLive(which) : await fetchArchive(which, period);
    const res = { ...raw, rows: await attachParks(raw.rows) };
    state.cache[ck] = { at: Date.now(), res };
    return res;
  }

  /* ==========================================================
   *  그리기
   * ======================================================== */
  function medal(i) {
    if (i === 0) return '<b class="rk-no rk-no--1">1</b>';
    if (i === 1) return '<b class="rk-no rk-no--2">2</b>';
    if (i === 2) return '<b class="rk-no rk-no--3">3</b>';
    return `<b class="rk-no">${i + 1}</b>`;
  }

  /** 지도로 보내는 버튼 — 어느 나라 어디쯤인지 알려준다 */
  function locHtml(p) {
    if (!p) return '';
    const where = p.cat === 'kr'
      ? (p.desc || '').split(' · ')[0]                 // 예) '전남·전북·경남'
      : (p.countryKo || p.country || '');
    return `<button type="button" class="rk-loc" data-park="${esc(p.id)}"
      title="지도에서 이 공원 위치 보기">
      <svg viewBox="0 0 24 24" width="11" height="11" aria-hidden="true"><path d="M12 21s7-6.2 7-11a7 7 0 10-14 0c0 4.8 7 11 7 11z" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/><circle cx="12" cy="10" r="2.4" fill="currentColor"/></svg>
      ${esc(p.name)}${where ? ` · ${esc(where)}` : ''}</button>`;
  }

  function rowHtml(r, i, max) {
    const others = r.others || [];
    return `
      <li class="rk-row">
        ${medal(i)}
        <div class="rk-main">
          <a class="rk-title" href="${esc(r.link)}" target="_blank" rel="noopener noreferrer">${esc(r.title)}</a>
          <p class="rk-meta">
            <span class="rk-heat" title="이 사안을 보도한 언론사 수">${r.outletCount}개사</span>
            <span class="rk-press">${esc(r.press.slice(0, 4).join(' · '))}${r.press.length > 4 ? ` 외 ${r.press.length - 4}` : ''}</span>
            ${r.time ? `<span class="rk-time">${esc(r.time)}</span>` : ''}
          </p>
          ${locHtml(r.park)}
          ${others.length ? `<details class="rk-more">
              <summary>관련 보도 ${others.length}건 더보기</summary>
              <ul>${others.map((o) => `
                <li><a href="${esc(o.link)}" target="_blank" rel="noopener noreferrer">
                  ${esc(o.title)}<em>${esc(o.press)}</em></a></li>`).join('')}</ul>
            </details>` : ''}
        </div>
        <div class="rk-bar" style="--w:${Math.min(100, Math.round(r.outletCount / max * 100))}%"><i></i></div>
      </li>`;
  }

  function syncTabs() {
    $('#rk-tab-kr')?.classList.toggle('is-on', state.tab === 'kr');
    $('#rk-tab-global')?.classList.toggle('is-on', state.tab === 'global');
    document.querySelectorAll('#rk-periods .rk-tab').forEach((b) => {
      b.classList.toggle('is-on', b.dataset.period === state.period);
    });
  }

  async function render() {
    const body = $('#rk-body');
    if (!body) return;
    syncTabs();

    const label = `${SETS[state.tab].label} · ${PERIODS[state.period]}`;
    body.innerHTML = `<div class="rk-state"><span class="dots"><i></i><i></i><i></i></span> ${esc(label)} 순위를 집계하는 중…</div>`;

    const token = `${state.tab}|${state.period}`;
    state.loading = token;

    try {
      const { rows, note } = await fetchRank(state.tab, state.period);
      if (state.loading !== token) return;         // 그 사이 다른 탭을 눌렀으면 버림

      if (!rows.length) {
        body.innerHTML = `<div class="rk-state">집계할 기사를 찾지 못했습니다.</div>`;
        return;
      }
      const max = Math.max(...rows.map((r) => r.outletCount)) || 1;
      body.innerHTML = `
        <p class="rk-note">
          <span class="rk-note__l">같은 사안을 보도한 <b>언론사 수</b>로 순위를 매깁니다 · 조회수가 아닙니다</span>
          <span class="rk-note__r">${label} · 상위 ${rows.length}건 · ${note}</span>
        </p>
        <ol class="rk-list">${rows.map((r, i) => rowHtml(r, i, max)).join('')}</ol>`;
    } catch (e) {
      if (state.loading !== token) return;
      console.warn(e);
      body.innerHTML = e.soft
        ? `<div class="rk-state">
             ${esc(e.message)}
             ${e.hint ? `<small>${esc(e.hint)}</small>` : ''}
           </div>`
        : `<div class="rk-state">순위를 불러오지 못했습니다. 잠시 후 다시 시도해 주세요.</div>`;
    }
  }

  const open = () => { $('#ranking').classList.add('is-open'); document.body.classList.add('dg-lock'); render(); };
  const close = () => { $('#ranking').classList.remove('is-open'); document.body.classList.remove('dg-lock'); };

  function init() {
    $('#btn-ranking')?.addEventListener('click', open);
    $('#rk-close')?.addEventListener('click', close);
    $('#ranking')?.addEventListener('click', (e) => { if (e.target.id === 'ranking') close(); });
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && $('#ranking')?.classList.contains('is-open')) close();
    });
    /* 위치 바로가기 — 순위 창을 닫고 그 공원으로 지도를 이동시킨다 */
    $('#rk-body')?.addEventListener('click', (e) => {
      const b = e.target.closest('.rk-loc');
      if (!b) return;
      const p = (parkIndex || []).find((x) => x.park.id === b.dataset.park)?.park;
      if (!p || !window.ParkMap) return;
      close();
      window.ParkMap.select(p);
    });

    $('#rk-tab-kr')?.addEventListener('click', () => { state.tab = 'kr'; render(); });
    $('#rk-tab-global')?.addEventListener('click', () => { state.tab = 'global'; render(); });
    $('#rk-periods')?.addEventListener('click', (e) => {
      const b = e.target.closest('.rk-tab');
      if (!b || !b.dataset.period) return;
      state.period = b.dataset.period;
      render();
    });
    $('#rk-refresh')?.addEventListener('click', () => { state.cache = {}; render(); });
  }

  return { init, open, close };
})();
