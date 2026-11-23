/* =============================================================
 *  hotbar.js  —  최상단 핫이슈 한 줄 (흐르는 띠)
 *
 *  "가장 핫한 이슈" 기준
 *   · 최근 2일 안에 보도된 기사만 대상 (사안이 모자라면 7일까지 넓힘)
 *   · 같은 사안을 보도한 언론사가 많을수록 뜨겁다
 *   · 최근 12시간 내 보도면 가산
 *   → 1위 이슈에 HOT 배지를 달고, 상위 6개를 순환시킵니다.
 * ============================================================= */

window.HotBar = (() => {
  'use strict';

  const $ = (s) => document.querySelector(s);
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  const QUERIES = ['국립공원', '국립공원공단', '국립공원 탐방', '국립공원 멸종위기'];
  const REFRESH_MS = 15 * 60 * 1000;

  /** 수집 → 사안별 묶기 (묶기 로직은 NewsService 공용)
      '실시간 핫이슈'이므로 최근 2일 기사만 쓰고, 모자라면 7일까지 넓힌다
      (날짜 제한이 없으면 몇 달 전 대형 사건이 언론사 수만으로 1위를 차지한다) */
  async function collect() {
    const { groups } = await NewsService.collectFresh(QUERIES, 'ko',
      { perQuery: 25, days: [2, 7], minGroups: 4 });
    return groups.slice(0, 6);
  }

  function render(groups) {
    const bar = $('#hotbar');
    const rail = $('#hot-rail');
    if (!bar || !rail) return;

    // 일시적 수집 실패로 비어 있어도 이미 띠가 돌고 있으면 그대로 둔다
    if (!groups.length) { if (!rail.children.length) bar.hidden = true; return; }

    const item = (g, i) => {
      const a = g.lead;
      const outlets = g.outlets;
      return `<a class="hot-item" href="${esc(a.link)}" target="_blank" rel="noopener noreferrer">
        ${i === 0 ? '<b class="hot-item__flag">HOT</b>' : `<i class="hot-item__no">${i + 1}</i>`}
        <span class="hot-item__t">${esc(a.title)}</span>
        <em class="hot-item__m">${esc(outlets.slice(0, 3).join(' · '))}${
          outlets.length > 1 ? ` <s>${outlets.length}개사 보도</s>` : ''
        } · ${esc(NewsService.timeAgo(a.date))}</em>
      </a>`;
    };

    const html = groups.map(item).join('<span class="hot-sep">◆</span>');
    rail.innerHTML = html + '<span class="hot-sep">◆</span>' + html;   // 무한 루프용 2배
    bar.hidden = false;
    document.body.classList.add('has-hotbar');

    /* 내용 길이에 맞춰 속도 보정 (px당 일정 속도) */
    requestAnimationFrame(() => {
      const w = rail.scrollWidth / 2;
      rail.style.animationDuration = `${Math.max(40, Math.round(w / 42))}s`;
      rail.classList.add('is-running');
    });
  }

  async function refresh() {
    try {
      const groups = await collect();
      render(groups);
    } catch (e) {
      console.warn('핫이슈 수집 실패:', e);
      const bar = $('#hotbar');
      if (bar && !$('#hot-rail')?.children.length) bar.hidden = true;
    }
  }

  function init() {
    refresh();
    setInterval(refresh, REFRESH_MS);
    $('#hot-close')?.addEventListener('click', () => {
      $('#hotbar').hidden = true;
      document.body.classList.remove('has-hotbar');
    });
  }

  return { init, refresh };
})();
