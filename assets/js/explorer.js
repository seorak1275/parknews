/* =============================================================
 *  explorer.js  —  국내 / 해외 계층 탐색기
 *
 *  해외 국립공원은 2,600곳이 넘어 목록을 한 번에 펼치면 난잡해집니다.
 *  그래서 4단계 드릴다운으로 좁혀 들어갑니다.
 *
 *      대륙 (6)  →  지역 (22)  →  국가 (190)  →  공원
 *      아시아 540 → 동남아시아 261 → 태국 116 → Khao Yai …
 *
 *  · 목록은 현재 단계만 그려서 DOM이 항상 수십 개를 넘지 않습니다.
 *  · 지도는 개별 마커 대신 클러스터 레이어를 써서 2,600점도 가볍습니다.
 *  · 검색창은 단계와 무관하게 전체를 훑습니다.
 * ============================================================= */

window.Explorer = (() => {
  'use strict';

  const $ = (s, r = document) => r.querySelector(s);
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  const state = {
    scope: 'kr',          // 'kr' | 'global' | 'org'
    level: 'continent',   // continent → subregion → country → park
    continent: null,
    subregion: null,
    iso3: null,
    query: '',
    data: null,           // parks-global.json
    loaded: false,
    onPick: null,         // 공원 선택 콜백 (app.js가 주입)
    onScope: null,        // 국내/해외 전환 콜백
  };

  /* ==========================================================
   *  데이터 로드 (해외 탭을 처음 열 때만)
   * ======================================================== */
  async function ensureData() {
    if (state.loaded) return state.data;
    const box = $('#ex-list');
    if (box) box.innerHTML = `<li class="ex-state"><span class="dots"><i></i><i></i><i></i></span> 세계 국립공원 목록 불러오는 중…</li>`;
    try {
      const res = await fetch('assets/data/parks-global.json');
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      state.data = await res.json();
      state.loaded = true;
    } catch (e) {
      state.data = { total: 0, hierarchy: [], parks: [] };
      state.loaded = true;
      console.warn('해외 공원 데이터 로드 실패:', e);
    }
    return state.data;
  }

  const parksOf = (pred) => (state.data?.parks || []).filter(pred);

  /* ==========================================================
   *  렌더링
   * ======================================================== */
  function crumb() {
    const bits = [{ label: '전체', to: 'continent' }];
    if (state.continent) bits.push({ label: state.continent, to: 'subregion' });
    if (state.subregion) bits.push({ label: state.subregion, to: 'country' });
    if (state.iso3) {
      const c = findCountry();
      bits.push({ label: c ? c.name : state.iso3, to: 'park' });
    }
    return bits.map((b, i) =>
      i === bits.length - 1
        ? `<span class="ex-crumb__now">${esc(b.label)}</span>`
        : `<button class="ex-crumb__up" data-to="${b.to}">${esc(b.label)}</button>`
    ).join('<i>›</i>');
  }

  function findCountry() {
    for (const c of state.data?.hierarchy || []) {
      if (c.name !== state.continent) continue;
      for (const s of c.subregions) {
        if (s.name !== state.subregion) continue;
        return s.countries.find((k) => k.iso3 === state.iso3);
      }
    }
    return null;
  }

  const rowGroup = (label, count, attrs) =>
    `<li><button class="ex-row" ${attrs}>
       <span class="ex-row__n">${esc(label)}</span>
       <span class="ex-row__c">${count.toLocaleString()}</span>
       <svg viewBox="0 0 24 24" width="13" height="13"><path d="M9 6l6 6-6 6" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg>
     </button></li>`;

  const rowPark = (p) =>
    `<li><button class="ex-row ex-row--park" data-park="${esc(p.id)}">
       <span class="ex-row__n">${esc(p.name)}${
         p.nameEn && p.nameEn !== p.name ? `<em>${esc(p.nameEn)}</em>` : ''
       }</span>
     </button></li>`;

  function render() {
    const list = $('#ex-list');
    const crumbBox = $('#ex-crumb');
    if (!list) return;

    /* ---------- 국내 ---------- */
    if (state.scope === 'kr') {
      crumbBox.innerHTML = `<span class="ex-crumb__now">국내 국립공원 ${REGIONS_KR.length}곳</span>`;
      const q = state.query.trim().toLowerCase();
      const rows = REGIONS_KR.filter((r) => !q || r.name.toLowerCase().includes(q));
      list.innerHTML = rows.length
        ? rows.map((r) =>
            `<li><button class="ex-row ex-row--park" data-park="${esc(r.id)}">
               <span class="ex-row__n">${esc(r.name)}<em>${esc(r.desc.split(' · ').pop())}</em></span>
             </button></li>`).join('')
        : `<li class="ex-state">검색 결과가 없습니다.</li>`;
      return;
    }

    /* ---------- 보전기관 ---------- */
    if (state.scope === 'org') {
      const q0 = state.query.trim().toLowerCase();
      const rows = REGIONS_ORG.filter((r) =>
        !q0 || r.name.toLowerCase().includes(q0) || (r.desc || '').toLowerCase().includes(q0));
      crumbBox.innerHTML = `<span class="ex-crumb__now">보전기관·연맹 ${rows.length}곳</span>`;
      list.innerHTML = rows.length
        ? rows.map((r) =>
            `<li><button class="ex-row ex-row--org" data-park="${esc(r.id)}">
               <span class="ex-row__n">${esc(r.name)}<em>${esc((r.desc || '').split(' · ')[0])}</em></span>
             </button></li>`).join('')
        : `<li class="ex-state">검색 결과가 없습니다.</li>`;
      return;
    }

    /* ---------- 해외 : 검색 중이면 단계 무시하고 전역 검색 ---------- */
    const q = state.query.trim().toLowerCase();
    if (q) {
      const hits = parksOf((p) =>
        p.name.toLowerCase().includes(q) ||
        (p.nameEn || '').toLowerCase().includes(q) ||
        (p.countryKo || '').toLowerCase().includes(q) ||
        (p.country || '').toLowerCase().includes(q)
      ).slice(0, 120);
      crumbBox.innerHTML = `<span class="ex-crumb__now">검색 “${esc(state.query)}” · ${hits.length}곳</span>`;
      list.innerHTML = hits.length
        ? hits.map((p) =>
            `<li><button class="ex-row ex-row--park" data-park="${esc(p.id)}">
               <span class="ex-row__n">${esc(p.name)}<em>${esc(p.countryKo)} · ${esc(p.subregionKo)}</em></span>
             </button></li>`).join('')
        : `<li class="ex-state">검색 결과가 없습니다.</li>`;
      return;
    }

    crumbBox.innerHTML = crumb();
    const H = state.data?.hierarchy || [];

    if (state.level === 'continent') {
      list.innerHTML = H.map((c) =>
        rowGroup(c.name, c.count, `data-continent="${esc(c.name)}"`)).join('')
        || `<li class="ex-state">데이터를 불러오지 못했습니다.</li>`;
      return;
    }
    if (state.level === 'subregion') {
      const c = H.find((x) => x.name === state.continent);
      list.innerHTML = (c?.subregions || []).map((s) =>
        rowGroup(s.name, s.count, `data-subregion="${esc(s.name)}"`)).join('');
      return;
    }
    if (state.level === 'country') {
      const c = H.find((x) => x.name === state.continent);
      const s = c?.subregions.find((x) => x.name === state.subregion);
      list.innerHTML = (s?.countries || []).map((k) =>
        rowGroup(k.name, k.count, `data-iso3="${esc(k.iso3)}"`)).join('');
      return;
    }
    /* park */
    const rows = parksOf((p) => p.iso3 === state.iso3)
      .sort((a, b) => a.name.localeCompare(b.name, 'ko'));
    list.innerHTML = rows.map(rowPark).join('');
  }

  /* ==========================================================
   *  이동
   * ======================================================== */
  function goto(level, value, reason = 'nav') {
    if (level === 'continent') {
      Object.assign(state, { level: 'continent', continent: null, subregion: null, iso3: null });
    } else if (level === 'subregion') {
      if (value !== undefined) state.continent = value;
      Object.assign(state, { level: 'subregion', subregion: null, iso3: null });
    } else if (level === 'country') {
      if (value !== undefined) state.subregion = value;
      Object.assign(state, { level: 'country', iso3: null });
    } else if (level === 'park') {
      if (value !== undefined) state.iso3 = value;
      state.level = 'park';
    }
    render();
    emitScope(reason);
  }

  /**
   * 현재 화면에 보여야 할 집합을 app.js 에 알린다.
   * reason 으로 "왜" 바뀌었는지 구분한다 —
   *   'scope'  탭 전환      → 지도를 그 범위로 이동
   *   'nav'    드릴다운      → 선택 범위로 이동
   *   'search' 검색어 입력   → 결과가 적을 때만 이동 (타이핑마다 튀지 않도록)
   */
  function emitScope(reason = 'nav') {
    if (!state.onScope) return;
    if (state.scope !== 'global') {
      return state.onScope({ scope: state.scope, parks: [], reason });
    }

    let parks = state.data?.parks || [];
    const q = state.query.trim().toLowerCase();
    if (q) {
      parks = parks.filter((p) =>
        p.name.toLowerCase().includes(q) || (p.nameEn || '').toLowerCase().includes(q) ||
        (p.countryKo || '').toLowerCase().includes(q) || (p.country || '').toLowerCase().includes(q));
    } else if (state.iso3) parks = parks.filter((p) => p.iso3 === state.iso3);
    else if (state.subregion) parks = parks.filter((p) => p.subregionKo === state.subregion);
    else if (state.continent) parks = parks.filter((p) => p.continentKo === state.continent);

    state.onScope({ scope: 'global', parks, level: state.level, reason });
  }

  const PLACEHOLDER = {
    kr: '국내 공원 검색 (예: 설악)',
    global: '전 세계 검색 (예: Banff, 태국)',
    org: '기관 검색 (예: IUCN, 공단)',
  };

  async function setScope(scope) {
    if (state.scope === scope) return;
    state.scope = scope;
    for (const [k, el] of [['kr', '#ex-tab-kr'], ['global', '#ex-tab-global'], ['org', '#ex-tab-org']]) {
      $(el)?.classList.toggle('is-on', scope === k);
    }
    $('#ex-search').placeholder = PLACEHOLDER[scope];

    if (scope === 'global') {
      await ensureData();
      $('#ex-count').textContent = `${(state.data.total || 0).toLocaleString()}곳`;
      goto('continent', undefined, 'scope');
    } else {
      $('#ex-count').textContent =
        `${(scope === 'org' ? REGIONS_ORG : REGIONS_KR).length}곳`;
      render();
      emitScope('scope');
    }
  }

  const parkById = (id) =>
    REGIONS_KR.find((r) => r.id === id)
    || REGIONS_ORG.find((r) => r.id === id)
    || (state.data?.parks || []).find((p) => p.id === id);

  /* ==========================================================
   *  초기화
   * ======================================================== */
  function init({ onPick }) {
    state.onPick = onPick;

    $('#ex-tab-kr').addEventListener('click', () => setScope('kr'));
    $('#ex-tab-global').addEventListener('click', () => setScope('global'));
    $('#ex-tab-org').addEventListener('click', () => setScope('org'));

    $('#ex-search').addEventListener('input', (e) => {
      state.query = e.target.value;
      render();
      emitScope('search');
    });

    $('#ex-crumb').addEventListener('click', (e) => {
      const b = e.target.closest('[data-to]');
      if (b) goto(b.dataset.to);
    });

    $('#ex-list').addEventListener('click', (e) => {
      const b = e.target.closest('button');
      if (!b) return;
      if (b.dataset.continent) return goto('subregion', b.dataset.continent);
      if (b.dataset.subregion) return goto('country', b.dataset.subregion);
      if (b.dataset.iso3) return goto('park', b.dataset.iso3);
      if (b.dataset.park) {
        const p = parkById(b.dataset.park);
        if (p && state.onPick) state.onPick(p);
      }
    });

    $('#ex-count').textContent = `${REGIONS_KR.length}곳`;
    render();
  }

  return {
    init,
    setScope,
    parkById,
    onScope: (fn) => { state.onScope = fn; },
    get scope() { return state.scope; },
  };
})();
