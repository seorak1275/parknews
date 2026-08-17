/* =============================================================
 *  sector.js  —  섹터별 뉴스 대시보드 (dashboard.html 전용)
 *
 *  최근 국립공원 기사를 모아 제목·요약의 키워드로
 *  행정 / 재난안전 / 자원보전 / 탐방시설 네 분야로 분류합니다.
 * ============================================================= */

(() => {
  'use strict';

  const $ = (s, r = document) => r.querySelector(s);
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  /* ---------- 섹터 정의 ---------- */
  const SECTORS = [
    {
      key: 'admin', name: '행정', color: '#818cf8',
      desc: '정책 · 지정 · 협약 · 조직',
      queries: ['국립공원공단', '국립공원 정책', '국립공원 지정'],
      words: ['공단', '인사', '임명', '취임', '조직', '예산', '정책', '지정', '승격', '협약',
        '업무협약', 'MOU', '조례', '국정감사', '국감', '위원회', '공모', '공청회', '고시',
        '행정', '법안', '개정', '이사장', '청장', '소장', '간담회', '토론회', '심의', '용역'],
    },
    {
      /* 구조대 업무용 — 예전에는 '재난안전'에 산불·기상과 섞여 있어
         출동 관련 기사만 따로 보기 어려웠다. 겹치는 낱말은 이쪽으로 몰아
         우선 잡히게 하고, 재난안전에서는 뺐다. */
      key: 'rescue', name: '구조출동', color: '#fb923c',
      desc: '조난 · 구조 · 수색 · 응급',
      queries: ['국립공원 구조', '국립공원 조난', '국립공원 실종',
        '국립공원 안전사고', '산악구조', '국립공원 심정지'],
      words: ['구조', '구조대', '구조요청', '조난', '실종', '수색', '추락', '고립', '표류',
        '심정지', '심폐소생', '응급', '응급처치', '이송', '후송', '헬기', '119', '소방',
        '구급', '구급대', '탈진', '저체온', '온열질환', '벌쏘임', '뱀', '낙상', '골절',
        '안전사고', '조난객', '등산객 사고', '익사', '수난', '실족'],
    },
    {
      key: 'safety', name: '재난안전', color: '#f87171',
      desc: '산불 · 기상 · 통제',
      queries: ['국립공원 산불', '국립공원 안전', '국립공원 통제'],
      words: ['산불', '화재', '진화', '통제', '폭우', '호우', '태풍', '폭설', '한파', '폭염',
        '산사태', '낙석', '지진', '대피', '출입금지', '입산통제', '긴급', '순찰', '경보',
        '주의보', '특보', '재난', '예방', '점검', '훈련', '방재'],
    },
    {
      key: 'nature', name: '자원보전', color: '#34d399',
      desc: '생태 · 멸종위기종 · 복원',
      queries: ['국립공원 멸종위기', '국립공원 생태', '국립공원 복원'],
      words: ['멸종위기', '복원', '생태', '서식', '천연기념물', '깃대종', '반달가슴곰', '산양',
        '수달', '여우', '발견', '개화', '만개', '식물', '조류', '철새', '외래종', '보호',
        '보전', '자연유산', '생물', '방사', '증식', '포착', '군락', '희귀'],
    },
    {
      key: 'facility', name: '탐방시설', color: '#fbbf24',
      desc: '탐방로 · 야영장 · 프로그램',
      queries: ['국립공원 탐방로', '국립공원 야영장', '국립공원 케이블카'],
      words: ['탐방로', '탐방', '케이블카', '야영장', '대피소', '개방', '개장', '폐쇄', '시설',
        '둘레길', '탐방객', '예약', '조성', '정비', '설치', '운영', '프로그램', '축제',
        '체험', '해설', '전망대', '주차장', '무장애', '데크'],
    },
  ];

  const BASE_QUERIES = ['국립공원', '국립공원공단'];
  const NOISE = ['채용', '입찰', '공고', '모집공고', '분양', '아파트', '주가', '코스피'];

  /* ---------- 분류 ---------- */
  function classify(article) {
    const text = `${article.title} ${article.summary || ''}`;
    let best = null;
    let bestScore = 0;
    for (const s of SECTORS) {
      let score = 0;
      for (const w of s.words) if (text.includes(w)) score++;
      if (score > bestScore) { bestScore = score; best = s.key; }
    }
    return bestScore >= 1 ? best : null;
  }

  /* ---------- 렌더 ---------- */
  const timeAgo = (d) => { try { return NewsService.timeAgo(d); } catch { return ''; } };

  function renderTiles(buckets) {
    $('#db-tiles').innerHTML = SECTORS.map((s) => {
      const list = buckets[s.key];
      const latest = list[0];
      return `
        <div class="db-tile" style="--c:${s.color}">
          <span class="db-tile__k">${s.name}</span>
          <span class="db-tile__v">${list.length}<em>건</em></span>
          <span class="db-tile__s">${latest ? `최신 ${esc(timeAgo(latest.date))}` : '수집된 기사 없음'}</span>
        </div>`;
    }).join('');
  }

  function renderCols(buckets) {
    $('#db-grid').innerHTML = SECTORS.map((s) => {
      const list = buckets[s.key].slice(0, 12);
      const body = list.length
        ? `<ul class="news-list">${list.map((n) => `
            <li class="news-item">
              <a href="${esc(n.link)}" target="_blank" rel="noopener noreferrer">
                <p class="news-title">${esc(n.title)}</p>
                ${n.summary ? `<p class="news-sum">${esc(n.summary)}</p>` : ''}
                <p class="news-meta"><span class="press">${esc(n.press)}</span>${n.date ? ` · ${esc(timeAgo(n.date))}` : ''}</p>
              </a>
            </li>`).join('')}</ul>`
        : `<p class="db-empty">최근 이 분야의 기사가 없습니다.</p>`;
      return `
        <section class="db-col glass" style="--c:${s.color}">
          <header class="db-col__h">
            <i class="db-col__dot"></i>
            <div>
              <b>${s.name}</b>
              <em>${s.desc}</em>
            </div>
            <span class="db-col__n">${buckets[s.key].length}</span>
          </header>
          <div class="db-col__list">${body}</div>
        </section>`;
    }).join('');
  }

  function renderSkeleton() {
    $('#db-tiles').innerHTML = SECTORS.map((s) => `
      <div class="db-tile" style="--c:${s.color}">
        <span class="db-tile__k">${s.name}</span>
        <span class="db-tile__v">–</span>
        <span class="db-tile__s">불러오는 중…</span>
      </div>`).join('');
    $('#db-grid').innerHTML = SECTORS.map((s) => `
      <section class="db-col glass" style="--c:${s.color}">
        <header class="db-col__h">
          <i class="db-col__dot"></i>
          <div><b>${s.name}</b><em>${s.desc}</em></div>
        </header>
        <div class="db-col__list">${'<div class="news-skel"></div>'.repeat(4)}</div>
      </section>`).join('');
  }

  /* ==========================================================
   *  공원별 보기
   *  '전체'는 국립공원 일반 기사, 공원을 고르면 그 공원 기사만 분류한다.
   * ======================================================== */
  /* 24곳을 단추로 늘어놓으니 한 줄을 훌쩍 넘겨 눈에 안 들어왔다.
     권역으로 묶은 드롭다운 하나로 바꾼다. */
  const ZONE = {
    bukhansan: '수도권',
    seoraksan: '강원', odaesan: '강원', chiaksan: '강원', taebaeksan: '강원',
    gyeryongsan: '충청', songnisan: '충청', woraksan: '충청',
    sobaeksan: '충청', taeanhaean: '충청',
    jirisan: '전라', naejangsan: '전라', mudeungsan: '전라',
    wolchulsan: '전라', byeonsan: '전라', dadohae: '전라', deogyusan: '전라',
    gyeongju: '경상', gayasan: '경상', juwangsan: '경상',
    palgongsan: '경상', geumjeongsan: '경상', hallyeo: '경상',
    hallasan: '제주',
  };
  const ZONE_ORDER = ['수도권', '강원', '충청', '전라', '경상', '제주'];

  const PARKS = (window.REGIONS_KR || []).map((r) => ({
    id: r.id,
    name: r.name.replace('국립공원', ''),   // '지리산국립공원' → '지리산'
    q: r.q || r.name,
    zone: ZONE[r.id] || '기타',
  }));

  let current = '';   // '' = 전체

  function renderPicker() {
    const box = $('#db-parks');
    if (!box || !PARKS.length) return;
    const cur = PARKS.find((p) => p.id === current);
    box.innerHTML = `
      <label class="db-pick">
        <span>공원</span>
        <select id="db-park-sel">
          <option value=""${current ? '' : ' selected'}>국내 국립공원 전체</option>
          ${ZONE_ORDER.map((z) => {
            const list = PARKS.filter((p) => p.zone === z);
            if (!list.length) return '';
            return `<optgroup label="${esc(z)}">${list.map((p) => `
              <option value="${esc(p.id)}"${current === p.id ? ' selected' : ''}>${esc(p.name)}국립공원</option>`).join('')}</optgroup>`;
          }).join('')}
        </select>
      </label>
      ${cur ? `<button class="db-clear" id="db-clear">전체로 돌아가기</button>` : ''}`;
  }

  /** 고른 공원 기사인지 — 제목·요약에 공원 이름이 있어야 인정 */
  const belongsTo = (n, park) =>
    `${n.title} ${n.summary || ''}`.includes(park.name);

  /* ---------- 수집 ---------- */
  async function load() {
    renderSkeleton();
    renderPicker();

    const park = PARKS.find((p) => p.id === current);
    const queries = park
      /* 공원별: 그 공원 이름을 섹터 질의에 얹어 좁게 찾는다 */
      ? [...new Set([park.q,
          ...SECTORS.map((s) => `${park.name} ${s.queries[0].replace('국립공원 ', '')}`)])]
      : [...new Set([...BASE_QUERIES, ...SECTORS.flatMap((s) => s.queries)])];

    const batches = await Promise.all(
      queries.map((q) => NewsService.search(q, 'ko', 25).catch(() => []))
    );

    const seen = new Set();
    const buckets = Object.fromEntries(SECTORS.map((s) => [s.key, []]));

    for (const n of batches.flat()) {
      if (!n?.title || !n.link) continue;
      if (NOISE.some((w) => n.title.includes(w))) continue;
      if (park && !belongsTo(n, park)) continue;      // 이름이 없으면 다른 공원 기사
      const key = `${n.title.replace(/\s+/g, '').slice(0, 30)}|${n.press}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const sector = classify(n);
      if (sector) buckets[sector].push(n);
    }

    for (const s of SECTORS) {
      buckets[s.key].sort((a, b) => (Date.parse(b.date) || 0) - (Date.parse(a.date) || 0));
    }

    const label = park ? `${park.name}국립공원` : '국내 국립공원 전체';
    const head = $('#db-scope');
    if (head) head.textContent = label;

    renderTiles(buckets);
    renderCols(buckets);
  }

  /* 공원 선택도 방문 기록에 남긴다 — 뒤로가기로 되돌아올 수 있게 */
  function go(id, push = true) {
    current = id || '';
    if (push) {
      const url = current ? `#park=${encodeURIComponent(current)}` : location.pathname;
      try { history.pushState({ park: current }, '', url); } catch { /* 무시 */ }
    }
    load();
  }

  $('#db-parks')?.addEventListener('change', (e) => {
    if (e.target.id === 'db-park-sel') go(e.target.value);
  });
  $('#db-parks')?.addEventListener('click', (e) => {
    if (e.target.id === 'db-clear') go('');
  });
  window.addEventListener('popstate', () => {
    const m = location.hash.match(/^#park=([^&]+)/);
    go(m ? decodeURIComponent(m[1]) : '', false);
  });

  $('#db-refresh')?.addEventListener('click', () => load());

  const m0 = location.hash.match(/^#park=([^&]+)/);
  current = m0 ? decodeURIComponent(m0[1]) : '';
  load();
})();
