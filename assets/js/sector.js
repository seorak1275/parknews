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
      key: 'safety', name: '재난안전', color: '#f87171',
      desc: '산불 · 사고 · 통제 · 기상',
      queries: ['국립공원 사고', '국립공원 산불', '국립공원 안전'],
      words: ['산불', '화재', '사고', '실종', '구조', '추락', '사망', '부상', '안전', '통제',
        '폭우', '호우', '태풍', '폭설', '산사태', '낙석', '대피', '고립', '수색', '익사',
        '조난', '출입금지', '긴급', '순찰', '헬기', '119', '소방'],
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

  /* ---------- 수집 ---------- */
  async function load() {
    renderSkeleton();

    const queries = [...new Set([...BASE_QUERIES, ...SECTORS.flatMap((s) => s.queries)])];
    const batches = await Promise.all(
      queries.map((q) => NewsService.search(q, 'ko', 25).catch(() => []))
    );

    const seen = new Set();
    const buckets = Object.fromEntries(SECTORS.map((s) => [s.key, []]));

    for (const n of batches.flat()) {
      if (!n?.title || !n.link) continue;
      if (NOISE.some((w) => n.title.includes(w))) continue;
      const key = `${n.title.replace(/\s+/g, '').slice(0, 30)}|${n.press}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const sector = classify(n);
      if (sector) buckets[sector].push(n);
    }

    for (const s of SECTORS) {
      buckets[s.key].sort((a, b) => (Date.parse(b.date) || 0) - (Date.parse(a.date) || 0));
    }

    renderTiles(buckets);
    renderCols(buckets);
  }

  $('#db-refresh')?.addEventListener('click', () => location.reload());
  load();
})();
