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
   *  검색 — 한글 표기 + 오타 허용 퍼지 매칭
   *  · "요세미티" 같은 한글 표기: 별칭 사전 + 한글→로마자 변환으로 매칭
   *  · "yosemiet" 같은 오타: 편집거리 기반 근사 부분일치로 허용
   * ======================================================== */

  /* 유명 공원 한글 표기 → 영문 검색어 (| 로 복수 표기) */
  const KO_ALIASES = {
    /* 북미 */
    '요세미티': 'yosemite', '옐로스톤': 'yellowstone', '옐로우스톤': 'yellowstone',
    '그랜드캐니언': 'grandcanyon', '그랜드캐년': 'grandcanyon', '그랜드티턴': 'grandteton',
    '자이언': 'zion', '브라이스캐니언': 'brycecanyon', '아치스': 'arches',
    '세쿼이아': 'sequoia', '킹스캐니언': 'kingscanyon', '데스밸리': 'deathvalley',
    '조슈아트리': 'joshuatree', '로키마운틴': 'rockymountain', '글레이셔': 'glacier',
    '올림픽': 'olympic', '레이니어': 'rainier', '마운트레이니어': 'rainier',
    '크레이터레이크': 'craterlake', '배들랜즈': 'badlands', '아카디아': 'acadia',
    '에버글레이즈': 'everglades', '데날리': 'denali', '빅벤드': 'bigbend',
    '사와로': 'saguaro', '화이트샌즈': 'whitesands', '칼즈배드': 'carlsbad',
    '카를스바드': 'carlsbad', '메사버드': 'mesaverde', '캐니언랜즈': 'canyonlands',
    '캐피톨리프': 'capitolreef', '그레이트스모키': 'greatsmoky', '셰넌도어': 'shenandoah',
    '셰난도어': 'shenandoah', '하와이화산': 'hawaiivolcanoes', '레드우드': 'redwood',
    '그레이트베이슨': 'greatbasin', '노스캐스케이드': 'northcascades',
    '채널제도': 'channelislands', '매머드동굴': 'mammothcave', '맘모스케이브': 'mammothcave',
    '핫스프링스': 'hotsprings', '반프': 'banff', '재스퍼': 'jasper', '요호': 'yoho',
    '쿠트니': 'kootenay', '워터턴': 'waterton', '그로모른': 'grosmorne',
    /* 중남미 */
    '토레스델파이네': 'torresdelpaine', '이과수': 'iguazu|iguacu', '갈라파고스': 'galapagos',
    '티칼': 'tikal', '코르코바도': 'corcovado', '로스글라시아레스': 'losglaciares',
    '나우엘우아피': 'nahuelhuapi', '코토팍시': 'cotopaxi', '마누': 'manu',
    '우아스카란': 'huascaran', '카나이마': 'canaima',
    /* 아프리카 */
    '크루거': 'kruger', '세렝게티': 'serengeti', '킬리만자로': 'kilimanjaro',
    '에토샤': 'etosha', '초베': 'chobe', '암보셀리': 'amboseli', '차보': 'tsavo',
    '비룽가': 'virunga', '브윈디': 'bwindi', '시미엔': 'simien',
    '테이블마운틴': 'tablemountain', '아루샤': 'arusha', '나이로비': 'nairobi',
    /* 유럽 */
    '플리트비체': 'plitvice', '사렉': 'sarek', '아비스코': 'abisko', '오울랑카': 'oulanka',
    '타트라': 'tatra', '트리글라브': 'triglav', '두르미토르': 'durmitor',
    '올림포스': 'olympus', '칼랑크': 'calanques', '요툰헤이멘': 'jotunheimen',
    '케언곰': 'cairngorms', '레이크디스트릭트': 'lakedistrict',
    '스노도니아': 'snowdonia|eryri', '피크디스트릭트': 'peakdistrict',
    '도냐나': 'donana', '시에라네바다': 'sierranevada', '피코스데에우로파': 'picosdeeuropa',
    '테이데': 'teide', '그란파라디소': 'granparadiso', '아브루초': 'abruzzo',
    '친퀘테레': 'cinqueterre', '바이에른숲': 'bayerischerwald',
    '작센스위스': 'sachsischeschweiz', '베르히테스가덴': 'berchtesgaden',
    '바누아즈': 'vanoise', '에크랭': 'ecrins', '피레네': 'pyrenees',
    /* 아시아 */
    '후지하코네': 'fujihakone', '시레토코': 'shiretoko', '닛코': 'nikko',
    '아소': 'aso', '다이세쓰잔': 'daisetsuzan', '장자제': 'zhangjiajie', '장가계': 'zhangjiajie',
    '코모도': 'komodo', '브로모': 'bromo', '구눙레우세르': 'gunungleuser',
    '카오야이': 'khaoyai', '카오속': 'khaosok', '도이인타논': 'doiinthanon',
    '카지랑가': 'kaziranga', '코르벳': 'corbett', '란탐보르': 'ranthambore',
    '순다르반스': 'sundarbans', '치트완': 'chitwan', '사가르마타': 'sagarmatha',
    '랑탕': 'langtang', '푸꾸옥': 'phuquoc', '퐁냐케방': 'phongnhakebang',
    '깟바': 'catba', '타만네가라': 'tamannegara', '키나발루': 'kinabalu',
    /* 오세아니아 */
    '카카두': 'kakadu', '울루루': 'uluru', '블루마운틴스': 'bluemountains',
    '다인트리': 'daintree', '크레이들마운틴': 'cradlemountain', '통가리로': 'tongariro',
    '피오르드랜드': 'fiordland', '아오라키': 'aoraki|mountcook', '마운트쿡': 'aoraki|mountcook',
    '아벨태즈먼': 'abeltasman',
  };

  /* 정규화 — 소문자 · 발음기호 제거 · 한글/영숫자 외 제거 */
  const norm = (s) => String(s || '').toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '').normalize('NFC')
    .replace(/[^a-z0-9가-힣]/g, '');

  const hasHangul = (s) => /[가-힣]/.test(s);

  /* 한글 → 로마자 (외래어 표기 역추정용 — 정확할 필요 없이 퍼지 매칭 입력) */
  const H2L = (() => {
    const ON = ['g', 'kk', 'n', 'd', 'tt', 'r', 'm', 'b', 'pp', 's', 'ss', '', 'j', 'jj', 'ch', 'k', 't', 'p', 'h'];
    const VO = ['a', 'ae', 'ya', 'yae', 'eo', 'e', 'yeo', 'ye', 'o', 'wa', 'wae', 'oe', 'yo', 'u', 'wo', 'we', 'wi', 'yu', 'eu', 'ui', 'i'];
    const CO = ['', 'k', 'k', 'k', 'n', 'n', 'n', 't', 'l', 'k', 'm', 'l', 'l', 'l', 'l', 'l', 'm', 'p', 'p', 't', 't', 'ng', 't', 't', 'k', 't', 'p', 't'];
    return (s) => {
      let out = '';
      for (const ch of s) {
        const c = ch.codePointAt(0);
        if (c < 0xAC00 || c > 0xD7A3) { out += ch; continue; }
        const i = c - 0xAC00;
        const on = ON[Math.floor(i / 588)];
        const vo = VO[Math.floor((i % 588) / 28)];
        const co = CO[i % 28];
        /* '스'·'트' 같은 받침 없는 '으' 음절은 자음만 (외래어 삽입모음) */
        out += (vo === 'eu' && !co && on) ? on : on + vo + co;
      }
      return out;
    };
  })();

  /* 근사 부분일치 — needle 이 hay 안 어딘가에 편집거리 max 이내로 존재하면 그 거리 */
  function subDist(hay, needle, max) {
    if (!hay || hay.length < needle.length - max) return Infinity;
    let prev = new Array(hay.length + 1).fill(0);   // 시작 위치 자유
    for (let i = 1; i <= needle.length; i++) {
      const cur = [i];
      let rowMin = i;
      for (let j = 1; j <= hay.length; j++) {
        const cost = needle[i - 1] === hay[j - 1] ? 0 : 1;
        const v = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
        cur.push(v);
        if (v < rowMin) rowMin = v;
      }
      if (rowMin > max) return Infinity;
      prev = cur;
    }
    return Math.min(...prev);
  }

  /* 허용 오타 수 — 한글은 음절 단위라 보수적으로 */
  const tol = (term) => hasHangul(term)
    ? (term.length >= 3 ? 1 : 0)
    : (term.length <= 3 ? 0 : term.length <= 6 ? 1 : term.length <= 10 ? 2 : 3);

  /** 이름류 필드에서 최고 점수 (부분일치 0 · 퍼지 1+거리 · 불일치 Infinity) */
  function fieldScore(fields, term) {
    let best = Infinity;
    const t = tol(term);
    for (const hay of fields) {
      if (!hay) continue;
      if (hay.includes(term)) return 0;
      if (t) {
        const d = subDist(hay, term, t);
        if (d !== Infinity && d + 1 < best) best = d + 1;
      }
    }
    return best;
  }

  /** 검색어 → 매칭에 쓸 항(term) 목록 */
  function searchTerms(raw) {
    const nq = norm(raw);
    if (!nq) return [];
    if (!hasHangul(nq)) return [nq];
    const terms = [nq];
    for (const [ko, en] of Object.entries(KO_ALIASES)) {
      const k = norm(ko);
      const hit = k.includes(nq) || nq.includes(k)
        || (nq.length >= 3 && subDist(k, nq, 1) !== Infinity);
      if (hit) for (const t of en.split('|')) terms.push(t);
    }
    const lat = H2L(nq);
    if (lat && !hasHangul(lat)) terms.push(lat);
    return terms;
  }

  let searchMemo = { q: null, hits: null };

  /** 해외 공원 퍼지 검색 — 점수순 정렬 (목록·지도 공용) */
  function globalSearch(raw) {
    if (searchMemo.q === raw) return searchMemo.hits;
    const terms = searchTerms(raw);
    const scored = [];
    for (const p of state.data?.parks || []) {
      if (!p.__idx) {
        p.__idx = {
          names: [norm(p.name), norm(p.nameEn), norm(p.nameLocal)],
          geo: [norm(p.countryKo), norm(p.country), norm(p.subregionKo)],
        };
      }
      let best = Infinity;
      for (const t of terms) {
        /* 나라·지역명은 정확 부분일치만 (퍼지 허용 시 잡음 폭증) */
        if (p.__idx.geo.some((g) => g && g.includes(t))) { best = 0; break; }
        const s = fieldScore(p.__idx.names, t);
        if (s < best) best = s;
        if (!best) break;
      }
      if (best !== Infinity) scored.push([best, p]);
    }
    scored.sort((a, b) => a[0] - b[0] || a[1].name.localeCompare(b[1].name));
    const hits = scored.map((x) => x[1]);
    searchMemo = { q: raw, hits };
    return hits;
  }

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
      let rows = REGIONS_KR.filter((r) => !q || r.name.toLowerCase().includes(q));
      /* 정확 일치가 없으면 오타 허용 (예: 설학산 → 설악산) */
      if (q && !rows.length) {
        const nq = norm(q);
        rows = REGIONS_KR.filter((r) => fieldScore([norm(r.name)], nq) !== Infinity);
      }
      list.innerHTML = rows.length
        ? rows.map((r) =>
            `<li><button class="ex-row ex-row--park" data-park="${esc(r.id)}">
               <span class="ex-row__n">${esc(r.name)}<em>${esc(r.desc.split(' · ').pop())}</em></span>
             </button></li>`).join('')
        : `<li class="ex-state">검색 결과가 없습니다.</li>`;
      return;
    }

    /* ---------- 보전기관 — 국내/해외 공원청/국제기구 섹션으로 묶어서 ---------- */
    if (state.scope === 'org') {
      const q0 = state.query.trim().toLowerCase();
      let rows = REGIONS_ORG.filter((r) =>
        !q0 || r.name.toLowerCase().includes(q0) || (r.desc || '').toLowerCase().includes(q0));
      if (q0 && !rows.length) {
        const nq = norm(q0);
        rows = REGIONS_ORG.filter((r) => fieldScore([norm(r.name)], nq) !== Infinity);
      }
      crumbBox.innerHTML = `<span class="ex-crumb__now">보전기관·연맹 ${rows.length}곳</span>`;

      const ORG_GROUPS = [
        ['kr', '국내 기관'],
        ['agency', '해외 공원청·연합'],
        ['intl', '국제기구·NGO'],
      ];
      const row = (r) =>
        `<li><button class="ex-row ex-row--org" data-park="${esc(r.id)}">
           <span class="ex-row__n">${esc(r.name)}<em>${esc((r.desc || '').split(' · ')[0])}</em></span>
         </button></li>`;
      const sections = ORG_GROUPS.map(([key, title]) => {
        const inGroup = rows.filter((r) => (r.group || 'intl') === key);
        if (!inGroup.length) return '';
        return `<li class="ex-group">${title} <i>${inGroup.length}</i></li>` + inGroup.map(row).join('');
      }).join('');

      list.innerHTML = sections || `<li class="ex-state">검색 결과가 없습니다.</li>`;
      return;
    }

    /* ---------- 해외 : 검색 중이면 단계 무시하고 전역 퍼지 검색 ---------- */
    const q = state.query.trim().toLowerCase();
    if (q) {
      const hits = globalSearch(state.query).slice(0, 120);
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
      parks = globalSearch(state.query).slice(0, 200);
    } else if (state.iso3) parks = parks.filter((p) => p.iso3 === state.iso3);
    else if (state.subregion) parks = parks.filter((p) => p.subregionKo === state.subregion);
    else if (state.continent) parks = parks.filter((p) => p.continentKo === state.continent);

    state.onScope({ scope: 'global', parks, level: state.level, reason });
  }

  const PLACEHOLDER = {
    kr: '국내 공원 검색 (예: 설악)',
    global: '전 세계 검색 (예: 요세미티, Banff, 태국)',
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
    /** 해외 공원 전체 목록 (필요 시 지연 로드) — '모든 지점 표시'가 사용 */
    allParks: async () => (await ensureData()).parks || [],
    onScope: (fn) => { state.onScope = fn; },
    get scope() { return state.scope; },
  };
})();
