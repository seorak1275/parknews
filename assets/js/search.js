/* =============================================================
 *  search.js  —  뉴스 검색 (search.html 전용)
 *
 *  1990~2026년 국립공원 기사 5만여 건을 제목·연도·공원·분야로 찾습니다.
 *
 *  서버 없이 정적 파일만 씁니다.
 *  data/search/<연도>.json 을 고른 연도만 받아 브라우저에서 거릅니다.
 *  (아카이브 CSV 는 30MB 라 통째로 받으면 느립니다)
 *
 *  '인기 순위' 는 찾은 기사를 같은 사안끼리 묶어 보도 매체 수로 셉니다.
 *  검색어 없이 연도만 골라도 그 해 가장 크게 다뤄진 사안이 나옵니다.
 * ============================================================= */

(() => {
  'use strict';

  const $ = (s, r = document) => r.querySelector(s);
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const nf = (n) => n.toLocaleString('ko-KR');

  const F = { date: 0, park: 1, sector: 2, sub: 3, conf: 4, near: 5, title: 6, press: 7, url: 8 };
  const CONF_NAME = ['미분류', '하', '중', '상'];

  const state = {
    meta: null, cache: new Map(), rows: [], view: 'list', page: 1,
    q: '', year: '', park: '', sector: '', conf: '0', near: false,
  };
  const PER = 50;

  /* ---------- 자료 ---------- */
  async function meta() {
    if (state.meta) return state.meta;
    const r = await fetch('data/search/index.json', { cache: 'no-store' });
    state.meta = await r.json();
    return state.meta;
  }

  async function yearRows(y) {
    if (state.cache.has(y)) return state.cache.get(y);
    const r = await fetch(`data/search/${y}.json`);
    if (!r.ok) return [];
    const rows = (await r.json()).map((x) => (x.push(y), x));   // 연도를 뒤에 붙여 둔다
    state.cache.set(y, rows);
    return rows;
  }

  /** 검색 대상 연도 — 고르지 않았으면 최근 5년만 (전부 받으면 11MB) */
  function targetYears() {
    const ys = state.meta.years.map((y) => y.year);
    if (state.year) return [state.year];
    return state.q ? ys : ys.slice(0, 5);
  }

  /* ---------- 검색 ---------- */
  function match(r) {
    if (state.park && r[F.park] !== state.park) return false;
    if (state.sector && r[F.sector] !== state.sector) return false;
    if (r[F.conf] < Number(state.conf)) return false;
    if (state.near && !r[F.near]) return false;
    if (state.q) {
      const q = state.q.toLowerCase();
      const words = q.split(/\s+/).filter(Boolean);
      const t = r[F.title].toLowerCase();
      if (!words.every((w) => t.includes(w))) return false;
    }
    return true;
  }

  /* 같은 사안 묶기 — 제목 낱말이 절반 넘게 겹치면 한 사안으로 본다 */
  const STOP = new Set(['국립공원', '공원', '기자', '사진', '영상', '지난', '올해', '관련', '위해']);
  const tokens = (t) => new Set(
    t.replace(/[^\p{L}\p{N}\s]/gu, ' ').split(/\s+/)
      .filter((w) => w.length >= 2 && !STOP.has(w)));

  function groupIssues(rows) {
    const groups = [];
    for (const r of rows) {
      const tk = tokens(r[F.title]);
      if (!tk.size) continue;
      const g = groups.find((x) => {
        let inter = 0;
        for (const w of tk) if (x.tk.has(w)) inter++;
        return inter && Math.max(inter / (x.tk.size + tk.size - inter),
          inter / Math.min(x.tk.size, tk.size)) >= 0.5;
      });
      if (g) { g.rows.push(r); tk.forEach((w) => g.tk.add(w)); }
      else groups.push({ tk, rows: [r] });
    }
    return groups
      .map((g) => ({
        lead: g.rows[0],
        n: g.rows.length,
        press: [...new Set(g.rows.map((r) => r[F.press]).filter(Boolean))],
        rows: g.rows,
      }))
      .sort((a, b) => b.press.length - a.press.length || b.n - a.n);
  }

  /* ---------- 그리기 ---------- */
  function renderControls() {
    const m = state.meta;
    $('#sc-year').innerHTML = `<option value="">전체 연도</option>`
      + m.years.map((y) => `<option value="${y.year}"${state.year === y.year ? ' selected' : ''}>${y.year}년 (${nf(y.count)})</option>`).join('');
    $('#sc-park').innerHTML = `<option value="">전체 공원</option>`
      + m.parks.map((p) => `<option value="${esc(p)}"${state.park === p ? ' selected' : ''}>${esc(p)}</option>`).join('');
    $('#sc-sector').innerHTML = `<option value="">전체 분야</option>`
      + m.sectors.map((s) => `<option value="${esc(s)}"${state.sector === s ? ' selected' : ''}>${esc(s)}</option>`).join('');
  }

  function rowHtml(r) {
    return `
      <li class="sc-row">
        <a href="${esc(r[F.url])}" target="_blank" rel="noopener noreferrer">${esc(r[F.title])}</a>
        <p class="sc-meta">
          <span class="sc-date">${esc(r[9])}-${esc(r[F.date])}</span>
          ${r[F.park] && r[F.park] !== '(전체·공통)' ? `<span class="sc-park">${esc(r[F.park])}</span>` : ''}
          <span class="sc-sec">${esc(r[F.sector])}${r[F.sub] ? ` · ${esc(r[F.sub])}` : ''}</span>
          <span class="sc-press">${esc(r[F.press])}</span>
          <span class="sc-conf sc-conf--${r[F.conf]}" title="분류 신뢰도">${CONF_NAME[r[F.conf]]}</span>
        </p>
      </li>`;
  }

  function render() {
    const box = $('#sc-body');
    const rows = state.rows;
    if (!rows.length) {
      box.innerHTML = `<p class="db-empty">조건에 맞는 기사가 없습니다.</p>`;
      $('#sc-count').textContent = '0건';
      return;
    }
    $('#sc-count').textContent = `${nf(rows.length)}건`;

    if (state.view === 'rank') {
      const g = groupIssues(rows).slice(0, 40);
      box.innerHTML = `
        <p class="sc-note">같은 사안끼리 묶어 <b>보도한 매체 수</b>로 순위를 매깁니다 · 조회수가 아닙니다</p>
        <ol class="sc-rank">${g.map((x, i) => `
          <li>
            <b class="sc-no">${i + 1}</b>
            <div>
              <a href="${esc(x.lead[F.url])}" target="_blank" rel="noopener noreferrer">${esc(x.lead[F.title])}</a>
              <p class="sc-meta">
                <span class="sc-heat">${x.press.length}개사</span>
                <span class="sc-press">${esc(x.press.slice(0, 5).join(' · '))}${x.press.length > 5 ? ` 외 ${x.press.length - 5}` : ''}</span>
                <span class="sc-date">${esc(x.lead[9])}-${esc(x.lead[F.date])}</span>
              </p>
            </div>
          </li>`).join('')}</ol>`;
      return;
    }

    const pages = Math.ceil(rows.length / PER);
    const page = Math.min(state.page, pages);
    const slice = rows.slice((page - 1) * PER, page * PER);
    box.innerHTML = `
      <ul class="sc-list">${slice.map(rowHtml).join('')}</ul>
      ${pages > 1 ? `
        <div class="sc-pager">
          <button ${page <= 1 ? 'disabled' : ''} data-page="${page - 1}">이전</button>
          <span>${page} / ${nf(pages)}</span>
          <button ${page >= pages ? 'disabled' : ''} data-page="${page + 1}">다음</button>
        </div>` : ''}`;
  }

  async function run() {
    const box = $('#sc-body');
    box.innerHTML = `<div class="rk-state"><span class="dots"><i></i><i></i><i></i></span> 찾는 중…</div>`;
    await meta();
    const years = targetYears();
    const all = (await Promise.all(years.map(yearRows))).flat();
    state.rows = all.filter(match).sort((a, b) => `${b[9]}-${b[F.date]}`.localeCompare(`${a[9]}-${a[F.date]}`));
    state.page = 1;

    const scope = state.year ? `${state.year}년` : (state.q ? '전체 연도' : '최근 5년');
    $('#sc-scope').textContent = scope;
    render();
  }

  /* ---------- 시작 ---------- */
  (async () => {
    await meta();
    renderControls();
    $('#sc-total').textContent = `${nf(state.meta.total)}건 · ${state.meta.years.length}개 연도`;

    const go = () => {
      state.q = $('#sc-q').value.trim();
      state.year = $('#sc-year').value;
      state.park = $('#sc-park').value;
      state.sector = $('#sc-sector').value;
      state.conf = $('#sc-conf').value;
      state.near = $('#sc-near').checked;
      run();
    };
    $('#sc-form').addEventListener('submit', (e) => { e.preventDefault(); go(); });
    ['#sc-year', '#sc-park', '#sc-sector', '#sc-conf'].forEach((s) =>
      $(s).addEventListener('change', go));
    $('#sc-near').addEventListener('change', go);
    $('#sc-tabs').addEventListener('click', (e) => {
      const b = e.target.closest('[data-view]');
      if (!b) return;
      state.view = b.dataset.view;
      document.querySelectorAll('#sc-tabs [data-view]').forEach((x) =>
        x.classList.toggle('is-on', x.dataset.view === state.view));
      render();
    });
    $('#sc-body').addEventListener('click', (e) => {
      const b = e.target.closest('[data-page]');
      if (!b) return;
      state.page = Number(b.dataset.page);
      render();
      window.scrollTo({ top: 0, behavior: 'smooth' });
    });

    run();
  })();
})();
