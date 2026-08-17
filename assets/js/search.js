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
    q: '', ex: '', year: '', range: '1', park: '', sector: '', conf: '0', near: false,
  };
  const PER = 50;
  /* 같은 사안 묶기를 낱말 색인으로 바꿔 훨씬 빨라졌지만(4천 건 620ms → 35ms),
     전체 범위(5만여 건)까지 한 번에 묶을 일은 없다. 최근 것부터 이만큼만 묶는다. */
  const RANK_LIMIT = 20000;

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

  /** 검색 대상 연도
   *  연도를 고르면 그 해만. 아니면 '범위'에서 고른 만큼.
   *  기본을 올해로 둔다 — 5년치는 8.4MB·3만 건이라 눈에 띄게 버벅였다. */
  function targetYears() {
    const ys = state.meta.years.map((y) => y.year);
    if (state.year) return [state.year];
    if (state.range === 'all') return ys;
    return ys.slice(0, Number(state.range) || 1);
  }

  /** 지금 범위로 몇 건·몇 MB 를 받게 되는지 (고르기 전에 알려 준다) */
  function scopeCost() {
    const set = new Set(targetYears());
    const ys = state.meta.years.filter((y) => set.has(y.year));
    return {
      years: ys.length,
      count: ys.reduce((s, y) => s + y.count, 0),
      mb: ys.reduce((s, y) => s + y.sizeKB, 0) / 1024,
    };
  }

  /* ---------- 검색 ---------- */
  /* 제외 낱말 — 띄어쓰기로 여러 개.
     '드라마 맛집 분양' 처럼 적으면 그중 하나라도 걸리는 기사를 뺀다.
     무엇을 뺄지는 보는 사람마다 다르므로 목록을 코드에 박아 두지 않고 직접 넣게 했다. */
  function exWords() {
    return state.ex.toLowerCase().split(/[\s,]+/).filter(Boolean);
  }

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

  /** 제외 낱말에 걸리는가 — 제목과 언론사 이름을 함께 본다 */
  function excluded(r, ex) {
    if (!ex.length) return false;
    const hay = `${r[F.title]} ${r[F.press]}`.toLowerCase();
    return ex.some((w) => hay.includes(w));
  }

  /* 같은 사안 묶기 — 제목 낱말이 절반 넘게 겹치면 한 사안으로 본다 */
  const STOP = new Set(['국립공원', '공원', '기자', '사진', '영상', '지난', '올해', '관련', '위해']);
  const tokens = (t) => new Set(
    t.replace(/[^\p{L}\p{N}\s]/gu, ' ').split(/\s+/)
      .filter((w) => w.length >= 2 && !STOP.has(w)));

  /* 낱말 하나도 안 겹치는 기사끼리는 견줘 볼 것도 없다.
     예전에는 새 기사마다 이미 만든 묶음을 전부 훑어서, 기사가 늘면
     제곱으로 느려졌다(3만 건이면 몇십 초). 낱말 → 묶음 색인을 두고
     낱말이 겹치는 묶음만 견준다. */
  function groupIssues(rows) {
    const groups = [];
    const byWord = new Map();          // 낱말 → 그 낱말을 가진 묶음 번호들
    for (const r of rows) {
      const tk = tokens(r[F.title]);
      if (!tk.size) continue;

      const inter = new Map();         // 묶음 번호 → 겹친 낱말 수
      for (const w of tk) {
        const ids = byWord.get(w);
        if (!ids) continue;
        for (const id of ids) inter.set(id, (inter.get(id) || 0) + 1);
      }
      /* 번호 순으로 본다 — 먼저 만들어진 묶음이 이기게 (예전과 같은 결과) */
      let gi = -1;
      for (const id of [...inter.keys()].sort((x, y) => x - y)) {
        const n = inter.get(id);
        const g = groups[id];
        if (Math.max(n / (g.tk.size + tk.size - n),
          n / Math.min(g.tk.size, tk.size)) >= 0.5) { gi = id; break; }
      }

      if (gi < 0) { gi = groups.length; groups.push({ tk: new Set(), rows: [] }); }
      const g = groups[gi];
      g.rows.push(r);
      for (const w of tk) {
        if (!g.tk.has(w)) {
          g.tk.add(w);
          const ids = byWord.get(w);
          if (ids) ids.push(gi); else byWord.set(w, [gi]);
        }
      }
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
      const src = rows.slice(0, RANK_LIMIT);
      const g = groupIssues(src).slice(0, 40);
      box.innerHTML = `
        <p class="sc-note">같은 사안끼리 묶어 <b>보도한 매체 수</b>로 순위를 매깁니다 · 조회수가 아닙니다${rows.length > RANK_LIMIT ? ` · 최근 ${nf(RANK_LIMIT)}건만 묶었습니다 (전체 ${nf(rows.length)}건)` : ''}</p>
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
    $('#sc-range').disabled = Boolean(state.year);   // 연도를 콕 집었으면 범위는 의미가 없다
    const years = targetYears();
    const all = [];
    for (let i = 0; i < years.length; i++) {
      if (years.length > 1) {
        box.innerHTML = `<div class="rk-state"><span class="dots"><i></i><i></i><i></i></span> `
          + `${years[i]}년 불러오는 중… (${i + 1}/${years.length})</div>`;
      }
      all.push(...await yearRows(years[i]));
    }
    const ex = exWords();
    const hit = all.filter(match);
    const kept = ex.length ? hit.filter((r) => !excluded(r, ex)) : hit;
    state.excluded = hit.length - kept.length;
    state.rows = kept.sort((a, b) => `${b[9]}-${b[F.date]}`.localeCompare(`${a[9]}-${a[F.date]}`));
    state.page = 1;

    if (state.excluded) {
      $('#sc-excount').textContent = ` · 제외 ${nf(state.excluded)}건`;
    } else $('#sc-excount').textContent = '';

    const c = scopeCost();
    $('#sc-scope').textContent = state.year
      ? `${state.year}년`
      : (years.length === 1 ? `${years[0]}년` : `${years[years.length - 1]}~${years[0]}년`)
        + ` (${nf(c.count)}건)`;
    render();
  }

  /* ---------- 시작 ---------- */
  (async () => {
    await meta();
    renderControls();
    $('#sc-total').textContent = `${nf(state.meta.total)}건 · ${state.meta.years.length}개 연도`;

    const go = () => {
      state.q = $('#sc-q').value.trim();
      state.ex = $('#sc-ex').value.trim();
      state.year = $('#sc-year').value;
      state.range = $('#sc-range').value;
      state.park = $('#sc-park').value;
      state.sector = $('#sc-sector').value;
      state.conf = $('#sc-conf').value;
      state.near = $('#sc-near').checked;
      run();
    };
    $('#sc-form').addEventListener('submit', (e) => { e.preventDefault(); go(); });
    ['#sc-year', '#sc-range', '#sc-park', '#sc-sector', '#sc-conf'].forEach((s) =>
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
