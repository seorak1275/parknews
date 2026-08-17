/* =============================================================
 *  stats.js  —  전국/전세계 국립공원 통계
 *
 *  · 국내 24곳: 기후에너지환경부 공식 경계도에서 실제 면적을 계산합니다
 *    (구면 근사 — 위도별 경도 축소를 반영한 shoelace)
 *  · 해외 3,313곳: 대륙·국가 분포
 *  · 뉴스 통계: 오늘 수집된 사안 수 · 최다 보도 공원
 * ============================================================= */

window.Stats = (() => {
  'use strict';

  const $ = (s) => document.querySelector(s);
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const nf = (n, d = 0) => n.toLocaleString('ko-KR', { maximumFractionDigits: d, minimumFractionDigits: d });

  const state = { built: false, kr: null, global: null };

  /* ==========================================================
   *  면적 계산 — GeoJSON 폴리곤 → km²
   *  경도 1도의 실거리는 위도에 따라 줄어들므로 cos(lat) 보정
   * ======================================================== */
  const R = 6371.0088;                       // 지구 평균 반지름 km
  const DEG = Math.PI / 180;

  function ringArea(ring) {
    if (ring.length < 4) return 0;
    const lat0 = ring.reduce((s, p) => s + p[1], 0) / ring.length;
    const kx = Math.cos(lat0 * DEG) * R * DEG;   // 경도 1도 → km
    const ky = R * DEG;                          // 위도 1도 → km
    let a = 0;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const xi = ring[i][0] * kx, yi = ring[i][1] * ky;
      const xj = ring[j][0] * kx, yj = ring[j][1] * ky;
      a += xj * yi - xi * yj;
    }
    return Math.abs(a) / 2;
  }

  function polyArea(coords) {                 // [outer, hole, hole…]
    if (!coords.length) return 0;
    return coords.reduce((s, ring, i) => s + (i === 0 ? ringArea(ring) : -ringArea(ring)), 0);
  }

  function featureArea(geom) {
    if (geom.type === 'Polygon') return polyArea(geom.coordinates);
    if (geom.type === 'MultiPolygon') return geom.coordinates.reduce((s, p) => s + polyArea(p), 0);
    return 0;
  }

  /* ==========================================================
   *  집계
   * ======================================================== */
  async function buildKr() {
    let fc = null;
    try {
      const res = await fetch('assets/data/parks-kr.geojson');
      if (res.ok) fc = await res.json();
    } catch { /* 면적 없이 진행 */ }

    const areaById = {};
    let total = 0;
    if (fc) {
      for (const f of fc.features) {
        const a = featureArea(f.geometry);
        areaById[f.properties.id] = a;
        total += a;
      }
    }

    const rows = REGIONS_KR.map((r) => {
      const year = Number((r.desc.match(/(\d{4})년 지정/) || [])[1]) || null;
      return { ...r, area: areaById[r.id] || 0, year };
    });

    /* 연대별 지정 추이 */
    const decades = {};
    for (const r of rows) {
      if (!r.year) continue;
      const d = Math.floor(r.year / 10) * 10;
      decades[d] = (decades[d] || 0) + 1;
    }

    /* 유형 — 이름으로 판별 */
    const type = { 산악: 0, 해상해안: 0, 사적: 0 };
    for (const r of rows) {
      if (r.name.includes('해상') || r.name.includes('해안')) type.해상해안++;
      else if (r.name.includes('경주')) type.사적++;
      else type.산악++;
    }

    return {
      count: rows.length, totalArea: total,
      biggest: [...rows].sort((a, b) => b.area - a.area).slice(0, 5),
      smallest: [...rows].filter((r) => r.area > 0).sort((a, b) => a.area - b.area).slice(0, 3),
      oldest: [...rows].filter((r) => r.year).sort((a, b) => a.year - b.year).slice(0, 3),
      newest: [...rows].filter((r) => r.year).sort((a, b) => b.year - a.year).slice(0, 3),
      decades, type, rows,
    };
  }

  async function buildGlobal() {
    try {
      const res = await fetch('assets/data/parks-global.json');
      if (!res.ok) throw new Error();
      const d = await res.json();
      const countries = {};
      for (const p of d.parks) {
        countries[p.countryKo] = (countries[p.countryKo] || 0) + 1;
      }
      return {
        total: d.total,
        hierarchy: d.hierarchy,
        countryCount: Object.keys(countries).length,
        topCountries: Object.entries(countries).sort((a, b) => b[1] - a[1]).slice(0, 10),
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
      <span class="st-bar__v">${typeof value === 'number' ? nf(value, unit === 'km²' ? 0 : 0) : value}${unit}</span>
    </div>`;

  function render() {
    const box = $('#st-body');
    const { kr, global: g } = state;
    if (!box || !kr) return;

    const maxArea = kr.biggest[0]?.area || 1;
    const decadeRows = Object.entries(kr.decades).sort((a, b) => a[0] - b[0]);
    const maxDecade = Math.max(...decadeRows.map((d) => d[1]), 1);

    box.innerHTML = `
      <!-- ── 핵심 숫자 ── -->
      <div class="st-tiles">
        <div class="st-tile">
          <span class="st-tile__k">국내 국립공원</span>
          <b class="st-tile__v">${kr.count}<em>곳</em></b>
          <span class="st-tile__s">1967년 지리산 → 2025년 금정산</span>
        </div>
        <div class="st-tile">
          <span class="st-tile__k">국내 총면적</span>
          <b class="st-tile__v">${nf(kr.totalArea)}<em>km²</em></b>
          <span class="st-tile__s">국토(100,443km²)의 약 ${nf(kr.totalArea / 100443 * 100, 1)}%</span>
        </div>
        <div class="st-tile">
          <span class="st-tile__k">해외 국립공원</span>
          <b class="st-tile__v">${g ? nf(g.total) : '–'}<em>곳</em></b>
          <span class="st-tile__s">${g ? `${g.countryCount}개국 · ${g.hierarchy.length}개 대륙` : '데이터 없음'}</span>
        </div>
        <div class="st-tile">
          <span class="st-tile__k">공식 홈페이지</span>
          <b class="st-tile__v">24<em>/24</em></b>
          <span class="st-tile__s">국내 전 공원 링크 확인 완료</span>
        </div>
      </div>

      <!-- ── 국내 면적 순위 ── -->
      <section class="st-sec">
        <h3 class="st-h">면적 상위 <span>국내 · 공식 경계도 기준</span></h3>
        ${kr.biggest.map((r) => bar(r.name.replace('국립공원', ''), r.area, maxArea, ' km²')).join('')}
        <p class="st-note">
          가장 작은 곳 · ${kr.smallest.map((r) => `${esc(r.name.replace('국립공원', ''))} ${nf(r.area)}km²`).join(' / ')}
        </p>
      </section>

      <!-- ── 지정 추이 ── -->
      <section class="st-sec">
        <h3 class="st-h">연대별 지정 <span>${kr.count}곳</span></h3>
        ${decadeRows.map(([d, n]) => bar(`${d}년대`, n, maxDecade, '곳', 'org')).join('')}
        <p class="st-note">
          최초 · ${kr.oldest.map((r) => `${esc(r.name.replace('국립공원', ''))}(${r.year})`).join(' / ')}
          &nbsp;·&nbsp;
          최근 · ${kr.newest.map((r) => `${esc(r.name.replace('국립공원', ''))}(${r.year})`).join(' / ')}
        </p>
      </section>

      <!-- ── 유형 ── -->
      <section class="st-sec">
        <h3 class="st-h">유형 구성</h3>
        <div class="st-chips">
          <span class="st-chip st-chip--kr">산악형 <b>${kr.type.산악}</b></span>
          <span class="st-chip st-chip--global">해상·해안형 <b>${kr.type.해상해안}</b></span>
          <span class="st-chip st-chip--org">사적형 <b>${kr.type.사적}</b></span>
        </div>
      </section>

      ${g ? `
      <!-- ── 세계 분포 ── -->
      <section class="st-sec">
        <h3 class="st-h">대륙별 분포 <span>해외 ${nf(g.total)}곳</span></h3>
        ${g.hierarchy.map((c) => bar(c.name, c.count, g.hierarchy[0].count, '곳', 'global')).join('')}
      </section>

      <section class="st-sec">
        <h3 class="st-h">국가 상위 10</h3>
        <ol class="st-rank">
          ${g.topCountries.map(([n, c], i) =>
            `<li><b>${i + 1}</b><span>${esc(n)}</span><em>${nf(c)}곳</em></li>`).join('')}
        </ol>
        <p class="st-note">
          OSM 태깅 편차로 나라별 밀도가 고르지 않습니다 —
          캐나다는 주립공원 527곳을 걷어낸 뒤에도 실제(48곳)보다 많습니다.
          WDPA 정본으로 교체하면 해소됩니다.
        </p>
      </section>` : ''}

      <p class="st-src">
        출처 · 국내 경계·면적: 기후에너지환경부(구 환경부) 「전국국립공원 경계」(EPSG:5179 → WGS84 변환) ·
        해외: OpenStreetMap(ODbL) + Natural Earth · 면적은 구면 근사값으로 공식 고시면적과 차이가 있을 수 있습니다.
      </p>`;
  }

  async function build() {
    if (state.built) return;
    const box = $('#st-body');
    if (box) box.innerHTML = `<div class="rk-state"><span class="dots"><i></i><i></i><i></i></span> 통계를 계산하는 중…</div>`;
    const [kr, g] = await Promise.all([buildKr(), buildGlobal()]);
    state.kr = kr; state.global = g; state.built = true;
    render();
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
