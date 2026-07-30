/* =============================================================
 *  ranking.js  —  통합 인기뉴스 순위 (국내 / 국외)
 *
 *  순위 기준 (NewsService.groupIssues)
 *    heat = 같은 사안을 보도한 언론사 수 + (최근 12시간 내 보도면 +1.5)
 *
 *  같은 사안을 여러 매체가 받아쓸수록 위로 올라갑니다.
 *  단일 매체 단독 기사는 아무리 최신이어도 상위에 오지 않습니다.
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

  const state = { tab: 'kr', cache: {}, loading: false };
  const TTL = 10 * 60 * 1000;

  async function fetchRank(which) {
    const hit = state.cache[which];
    if (hit && Date.now() - hit.at < TTL) return hit.rows;

    const cfg = SETS[which];
    const batches = await Promise.all(
      cfg.queries.map((q) => NewsService.search(q, cfg.lang, 25).catch(() => []))
    );
    const rows = NewsService.groupIssues(batches.flat()).slice(0, 25);
    state.cache[which] = { at: Date.now(), rows };
    return rows;
  }

  function medal(i) {
    if (i === 0) return '<b class="rk-no rk-no--1">1</b>';
    if (i === 1) return '<b class="rk-no rk-no--2">2</b>';
    if (i === 2) return '<b class="rk-no rk-no--3">3</b>';
    return `<b class="rk-no">${i + 1}</b>`;
  }

  function rowHtml(g, i) {
    const a = g.lead;
    const others = g.arts.slice(1, 4);
    return `
      <li class="rk-row">
        ${medal(i)}
        <div class="rk-main">
          <a class="rk-title" href="${esc(a.link)}" target="_blank" rel="noopener noreferrer">${esc(a.title)}</a>
          <p class="rk-meta">
            <span class="rk-heat" title="이 사안을 보도한 언론사 수">${g.outletCount}개사</span>
            <span class="rk-press">${esc(g.outlets.slice(0, 4).join(' · '))}${g.outlets.length > 4 ? ` 외 ${g.outlets.length - 4}` : ''}</span>
            <span class="rk-time">${esc(NewsService.timeAgo(a.date))}</span>
          </p>
          ${others.length ? `<details class="rk-more">
              <summary>관련 보도 ${others.length}건 더보기</summary>
              <ul>${others.map((o) => `
                <li><a href="${esc(o.link)}" target="_blank" rel="noopener noreferrer">
                  ${esc(o.title)}<em>${esc(o.press)}</em></a></li>`).join('')}</ul>
            </details>` : ''}
        </div>
        <div class="rk-bar" style="--w:${Math.min(100, Math.round(g.outletCount / 8 * 100))}%"><i></i></div>
      </li>`;
  }

  async function render() {
    const body = $('#rk-body');
    if (!body) return;

    $('#rk-tab-kr').classList.toggle('is-on', state.tab === 'kr');
    $('#rk-tab-global').classList.toggle('is-on', state.tab === 'global');

    body.innerHTML = `<div class="rk-state"><span class="dots"><i></i><i></i><i></i></span> 순위를 집계하는 중…</div>`;
    try {
      const rows = await fetchRank(state.tab);
      if (!rows.length) {
        body.innerHTML = `<div class="rk-state">집계할 기사를 찾지 못했습니다.</div>`;
        return;
      }
      body.innerHTML = `
        <p class="rk-note">
          같은 사안을 보도한 <b>언론사 수</b>로 순위를 매깁니다 · 최근 12시간 내 보도는 가산
          <span>${SETS[state.tab].label} · 상위 ${rows.length}건 · ${new Date().toLocaleTimeString('ko-KR', { hour12: false })} 기준</span>
        </p>
        <ol class="rk-list">${rows.map(rowHtml).join('')}</ol>`;
    } catch (e) {
      console.warn(e);
      body.innerHTML = `<div class="rk-state">순위를 불러오지 못했습니다. 잠시 후 다시 시도해 주세요.</div>`;
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
    $('#rk-tab-kr')?.addEventListener('click', () => { state.tab = 'kr'; render(); });
    $('#rk-tab-global')?.addEventListener('click', () => { state.tab = 'global'; render(); });
    $('#rk-refresh')?.addEventListener('click', () => { state.cache = {}; render(); });
  }

  return { init, open, close };
})();
