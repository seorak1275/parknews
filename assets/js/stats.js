/* =============================================================
 *  stats.js  —  뉴스 통계
 *
 *  큰 그림은 뉴스 아카이브(자료받기와 같은 데이터, 1990~)의 피벗을,
 *  최근 흐름은 매일 쌓이는 인기뉴스 보관본(data/ranking/*.json)을 쓴다.
 *  — 보관본만 합산하니 자료받기 5.7만 건과 규모가 안 맞아 보였다 (2026-08-19)
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
   *  집계 2 — 뉴스 아카이브 (자료받기와 같은 데이터, 1990~)
   *  원장 5.7만 행은 읽지 않고 작은 피벗 CSV 2개만 가져온다.
   * ======================================================== */
  async function csvRows(url) {
    const t = await (await fetch(url)).text();
    return t.replace(/^﻿/, '').trim().split(/\r?\n/).map((l) => l.split(','));
  }

  async function buildArchive() {
    try {
      const idx = await (await fetch('data/dataset/index.json')).json();
      const items = idx.items || [];
      const pick = (re) => items.find((i) => re.test(i.file || ''));
      const yearFile = pick(/^국립공원_연도별섹터/)?.file;
      const parkFile = pick(/^국립공원_피벗_공원×섹터/)?.file;
      if (!yearFile || !parkFile) return null;

      const [yearsCsv, parksCsv] = await Promise.all([
        csvRows(`data/dataset/${encodeURIComponent(yearFile)}`),
        csvRows(`data/dataset/${encodeURIComponent(parkFile)}`),
      ]);

      /* 연도별섹터: 연도,구조활동,…,기타,합계 */
      const yHead = yearsCsv[0];
      const yTotal = yHead.indexOf('합계');
      const years = yearsCsv.slice(1)
        .map((r) => ({ year: Number(r[0]), total: Number(r[yTotal]) || 0, r }))
        .filter((y) => y.year)
        .sort((a, b) => a.year - b.year);
      if (!years.length) return null;

      const secNames = yHead.slice(1, yTotal);
      const sectors = secNames
        .map((name, i) => [name, years.reduce((s, y) => s + (Number(y.r[i + 1]) || 0), 0)])
        .sort((a, b) => b[1] - a[1]);

      /* 공원×섹터: 공원,…,합계,최다분야 */
      const pHead = parksCsv[0];
      const pTotal = pHead.indexOf('합계');
      const parks = parksCsv.slice(1)
        .map((r) => [r[0], Number(r[pTotal]) || 0])
        .filter(([, v]) => v > 0)
        .sort((a, b) => b[1] - a[1]);

      const archiveSum = years.reduce((s, y) => s + y.total, 0);
      return {
        totalKr: pick(/^국립공원공단_국립공원뉴스정보_\d/)?.rows || archiveSum,
        totalGlobal: pick(/^국립공원공단_해외국립공원뉴스정보_\d/)?.rows || 0,
        yearFrom: years[0].year, yearTo: years[years.length - 1].year,
        yearCount: years.length,
        thisYear: years[years.length - 1],
        years, sectors, topParks: parks.slice(0, 5),
        basis: (idx.generatedAt || '').slice(0, 10),
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

  function render(a, n) {
    const box = $('#st-body');
    if (!box) return;
    if (!a && !n) {
      box.innerHTML = `<div class="rk-state">뉴스 통계를 불러오지 못했습니다. 잠시 후 다시 열어 보세요.</div>`;
      state.built = false;             // 다음에 열면 다시 시도
      return;
    }

    /* ── 큰 그림: 뉴스 아카이브 (자료받기와 같은 데이터) ── */
    let arcHtml = '';
    if (a) {
      const recent = a.years.slice(-10);
      const maxYear = Math.max(...recent.map((y) => y.total), 1);
      const maxSector = a.sectors[0]?.[1] || 1;
      const maxPark = a.topParks[0]?.[1] || 1;

      arcHtml = `
      <div class="st-tiles">
        <div class="st-tile">
          <span class="st-tile__k">뉴스 아카이브</span>
          <b class="st-tile__v">${nf(a.totalKr)}<em>건</em></b>
          <span class="st-tile__s">해외 ${nf(a.totalGlobal)}건 별도</span>
        </div>
        <div class="st-tile">
          <span class="st-tile__k">축적 기간</span>
          <b class="st-tile__v">${a.yearFrom}~${a.yearTo}</b>
          <span class="st-tile__s">${a.yearCount}개 연도 · 일 단위</span>
        </div>
        <div class="st-tile">
          <span class="st-tile__k">올해 보도량</span>
          <b class="st-tile__v">${nf(a.thisYear.total)}<em>건</em></b>
          <span class="st-tile__s">${a.thisYear.year}년 · 집계 중</span>
        </div>
        <div class="st-tile">
          <span class="st-tile__k">최다 보도 공원</span>
          <b class="st-tile__v">${a.topParks[0] ? esc(a.topParks[0][0]) : '–'}</b>
          <span class="st-tile__s">${a.topParks[0] ? `누적 ${nf(a.topParks[0][1])}건` : '집계 없음'}</span>
        </div>
      </div>

      <section class="st-sec">
        <h3 class="st-h">연도별 보도량 <span>최근 10년 · 국내</span></h3>
        ${recent.map((y) => bar(String(y.year), y.total, maxYear, '건', 'org')).join('')}
      </section>

      <section class="st-sec">
        <h3 class="st-h">분야별 구성 <span>전 기간 · 국내</span></h3>
        ${a.sectors.map(([name, v]) => bar(name, v, maxSector, '건', 'global')).join('')}
      </section>

      <section class="st-sec">
        <h3 class="st-h">공원별 누적 보도 <span>제목에 공원명이 있는 기사 기준</span></h3>
        ${a.topParks.map(([name, v]) => bar(name, v, maxPark, '건')).join('')}
      </section>`;
    }

    /* ── 최근 흐름: 인기뉴스 일일 보관본 ── */
    let dayHtml = '';
    if (n) {
      const md = (d) => `${Number(d.slice(5, 7))}/${Number(d.slice(8, 10))}`;
      const maxDaily = Math.max(...n.daily.map((d) => d.kr + d.global), 1);
      const maxPress = n.topPress[0]?.[1] || 1;
      const avg = Math.round((n.totalKr + n.totalGlobal) / n.have);

      /* 보관이 며칠 밀렸으면 그대로 밝힌다 — 없는 걸 있는 척하지 않는다 */
      const lag = Math.round((Date.now() - new Date(`${n.to}T00:00:00+09:00`)) / 86400000);
      const lagNote = lag > 2 ? ` · <b>최근 보관본이 ${esc(n.to)}자까지입니다</b>` : '';

      dayHtml = `
      <section class="st-sec">
        <h3 class="st-h">최근 일일 수집 <span>인기뉴스 보관본 · 매일 아침 수집(8/8 이전은 아카이브 사후 집계)</span></h3>
        ${n.daily.map((d) => bar(md(d.date), d.kr + d.global, maxDaily, '건', 'org')).join('')}
        <p class="st-note">${esc(n.from)} ~ ${esc(n.to)} · ${n.have}일치 · 하루 평균 ${nf(avg)}건${lagNote}
          — 위 아카이브와 달리 <b>순위용 상위 사안만</b> 담아 건수가 적습니다</p>
      </section>

      ${n.topPress.length ? `
      <section class="st-sec">
        <h3 class="st-h">활발히 보도한 언론사 <span>최근 ${n.have}일 · 사안 수 기준</span></h3>
        ${n.topPress.map(([name, v]) => bar(name, v, maxPress, '건', 'org')).join('')}
      </section>` : ''}`;
    }

    box.innerHTML = `${arcHtml}${dayHtml}
      <p class="st-src">
        출처 · 뉴스 아카이브(자료받기와 동일 데이터${a?.basis ? `, 기준일 ${esc(a.basis)}` : ''}, 월 단위 갱신)
        + 인기뉴스 일일 보관본 · 분야는 제목 낱말 기반 자동분류입니다.
      </p>`;
  }

  async function build() {
    if (state.built) return;
    state.built = true;
    const box = $('#st-body');
    if (box) box.innerHTML = `<div class="rk-state"><span class="dots"><i></i><i></i><i></i></span> 뉴스 통계를 집계하는 중…</div>`;
    const [a, n] = await Promise.all([buildArchive(), buildNews()]);
    render(a, n);
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
