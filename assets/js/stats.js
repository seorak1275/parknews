/* =============================================================
 *  stats.js  —  뉴스 통계
 *
 *  매일 아침 쌓이는 인기뉴스 보관본(data/ranking/*.json)을 합산해
 *  보도량·공원·분야·언론사 통계를 보여줍니다.
 *  (공원 면적·지정연대 같은 국립공원 자체 통계는 뉴스와 무관해 뺐다 — 2026-08-19)
 * ============================================================= */

window.Stats = (() => {
  'use strict';

  const $ = (s) => document.querySelector(s);
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const nf = (n) => n.toLocaleString('ko-KR');

  const state = { built: false };

  /* ==========================================================
   *  집계 — 보관본 합산 (인기뉴스 순위와 같은 자료를 다른 각도로)
   * ======================================================== */
  async function buildNews() {
    try {
      const idx = await (await fetch('data/ranking/index.json')).json();
      const dates = (idx.dates || []).slice(0, 14).sort();          // 오래된 → 최신
      if (!dates.length) return null;

      const days = (await Promise.all(dates.map(async (d) => {
        try {
          const r = await fetch(`data/ranking/${d}.json`);
          return r.ok ? await r.json() : null;
        } catch { return null; }
      }))).filter(Boolean);
      if (!days.length) return null;

      const sum = (rows) => (rows || []).reduce((s, r) => s + (r.reports || 1), 0);
      const daily = days.map((d) => ({
        date: d.date,
        kr: sum(d.kr?.rows),
        global: sum(d.global?.rows),
      }));

      const parkNames = REGIONS_KR.map((r) => r.name.replace('국립공원', ''));
      const byPark = {}, byPress = {}, bySector = {};
      let totalKr = 0, totalGlobal = 0, issueCount = 0;

      for (const d of days) {
        totalGlobal += sum(d.global?.rows);
        for (const row of d.kr?.rows || []) {
          const n = row.reports || 1;
          totalKr += n;
          issueCount++;
          const park = parkNames.find((p) => row.title.includes(p));
          if (park) byPark[park] = (byPark[park] || 0) + n;
          for (const p of row.press || []) byPress[p] = (byPress[p] || 0) + 1;
          const sec = window.Taxonomy?.classify(row.title);
          if (sec) bySector[sec.name] = (bySector[sec.name] || 0) + n;
        }
      }

      const top = (obj, n) => Object.entries(obj).sort((a, b) => b[1] - a[1]).slice(0, n);
      return {
        daily, totalKr, totalGlobal, issueCount,
        topParks: top(byPark, 5),
        topPress: top(byPress, 5),
        sectors: top(bySector, 5),
        from: days[0].date, to: days[days.length - 1].date, have: days.length,
      };
    } catch {
      return null;
    }
  }

  /* ==========================================================
   *  렌더
   * ======================================================== */
  const bar = (label, value, max, unit = '', accent = 'kr') => `
    <div class="st-bar">
      <span class="st-bar__l" title="${esc(label)}">${esc(label)}</span>
      <span class="st-bar__t"><i class="st-bar__f st-bar__f--${accent}" style="--w:${Math.max(2, Math.round(value / max * 100))}%"></i></span>
      <span class="st-bar__v">${nf(value)}${unit}</span>
    </div>`;

  function render(n) {
    const box = $('#st-body');
    if (!box) return;
    if (!n) {
      box.innerHTML = `<div class="rk-state">뉴스 보관본을 불러오지 못했습니다. 잠시 후 다시 열어 보세요.</div>`;
      state.built = false;             // 다음에 열면 다시 시도
      return;
    }

    const md = (d) => `${Number(d.slice(5, 7))}/${Number(d.slice(8, 10))}`;
    const maxDaily = Math.max(...n.daily.map((d) => d.kr + d.global), 1);
    const maxPark = n.topParks[0]?.[1] || 1;
    const maxPress = n.topPress[0]?.[1] || 1;
    const maxSector = n.sectors[0]?.[1] || 1;
    const avg = Math.round((n.totalKr + n.totalGlobal) / n.have);

    /* 보관이 며칠 밀렸으면 그대로 밝힌다 — 없는 걸 있는 척하지 않는다 */
    const lag = Math.round((Date.now() - new Date(`${n.to}T00:00:00+09:00`)) / 86400000);
    const lagNote = lag > 2 ? ` · <b>최근 보관본이 ${esc(n.to)}자까지입니다</b>` : '';

    box.innerHTML = `
      <!-- ── 핵심 숫자 ── -->
      <div class="st-tiles">
        <div class="st-tile">
          <span class="st-tile__k">집계 기간</span>
          <b class="st-tile__v">${n.have}<em>일치</em></b>
          <span class="st-tile__s">${esc(n.from)} ~ ${esc(n.to)}</span>
        </div>
        <div class="st-tile">
          <span class="st-tile__k">총 보도량</span>
          <b class="st-tile__v">${nf(n.totalKr + n.totalGlobal)}<em>건</em></b>
          <span class="st-tile__s">국내 ${nf(n.totalKr)} · 국외 ${nf(n.totalGlobal)}</span>
        </div>
        <div class="st-tile">
          <span class="st-tile__k">하루 평균</span>
          <b class="st-tile__v">${nf(avg)}<em>건</em></b>
          <span class="st-tile__s">사안 ${nf(n.issueCount)}묶음 집계</span>
        </div>
        <div class="st-tile">
          <span class="st-tile__k">최다 보도 공원</span>
          <b class="st-tile__v">${n.topParks[0] ? esc(n.topParks[0][0]) : '–'}</b>
          <span class="st-tile__s">${n.topParks[0] ? `${nf(n.topParks[0][1])}건 보도` : '집계 없음'}</span>
        </div>
      </div>

      <!-- ── 일별 보도량 ── -->
      <section class="st-sec">
        <h3 class="st-h">일별 보도량 <span>국내 + 국외</span></h3>
        ${n.daily.map((d) => bar(md(d.date), d.kr + d.global, maxDaily, '건', 'org')).join('')}
        <p class="st-note">매일 아침 하루치씩 쌓입니다${lagNote}</p>
      </section>

      ${n.topParks.length ? `
      <section class="st-sec">
        <h3 class="st-h">최다 보도 공원 <span>국내 · 제목 기준</span></h3>
        ${n.topParks.map(([name, v]) => bar(name, v, maxPark, '건')).join('')}
      </section>` : ''}

      ${n.sectors.length ? `
      <section class="st-sec">
        <h3 class="st-h">분야별 구성 <span>국내 보도</span></h3>
        ${n.sectors.map(([name, v]) => bar(name, v, maxSector, '건', 'global')).join('')}
      </section>` : ''}

      ${n.topPress.length ? `
      <section class="st-sec">
        <h3 class="st-h">활발히 보도한 언론사 <span>사안 수 기준</span></h3>
        ${n.topPress.map(([name, v]) => bar(name, v, maxPress, '건', 'org')).join('')}
      </section>` : ''}

      <p class="st-src">
        출처 · 구글 뉴스·네이버 검색으로 수집한 일간 보관본 합산 ·
        보도량은 같은 사안을 다룬 기사 수, 순위 기준은 언론사 수입니다.
      </p>`;
  }

  async function build() {
    if (state.built) return;
    state.built = true;
    const box = $('#st-body');
    if (box) box.innerHTML = `<div class="rk-state"><span class="dots"><i></i><i></i><i></i></span> 뉴스 통계를 집계하는 중…</div>`;
    render(await buildNews());
  }

  /* 여는 것을 방문 기록에 남겨 뒤로가기로 닫히게 한다 (ranking.js 와 같은 사정) */
  const HASH = '#stats';
  const show = () => { $('#stats').classList.add('is-open'); document.body.classList.add('dg-lock'); build(); };
  const hide = () => { $('#stats').classList.remove('is-open'); document.body.classList.remove('dg-lock'); };
  const isOpen = () => $('#stats')?.classList.contains('is-open');

  const open = () => {
    if (isOpen()) return;
    try { history.pushState({ modal: 'stats' }, '', HASH); } catch { /* 무시 */ }
    show();
  };
  const close = () => {
    if (!isOpen()) return;
    hide();
    if (location.hash === HASH) { try { history.back(); } catch { /* 무시 */ } }
  };

  function init() {
    $('#btn-stats')?.addEventListener('click', open);
    $('#st-close')?.addEventListener('click', close);
    $('#stats')?.addEventListener('click', (e) => { if (e.target.id === 'stats') close(); });
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && isOpen()) close();
    });
    window.addEventListener('popstate', () => {
      if (location.hash === HASH) { if (!isOpen()) show(); }
      else if (isOpen()) hide();
    });
  }

  return { init, open, close };
})();
