/* =============================================================
 *  news.js  —  뉴스 수집 · 파싱 · 키워드 추출
 *
 *  수집 경로 (자동 폴백)
 *   1) /api/naver-news        ← Vercel 배포 + 네이버 API 키 등록 시
 *   2) 구글 뉴스 RSS + 무료 CORS 프록시  ← 키 없이도 항상 동작
 * ============================================================= */

window.NewsService = (() => {
  const cache = new Map();          // id -> { at, items }
  const inflight = new Map();       // id -> Promise (중복 요청 방지)

  /* ---------- 유틸 ---------- */

  const decode = (() => {
    const el = document.createElement('textarea');
    return (s) => { el.innerHTML = s || ''; return el.value; };
  })();

  const stripTags = (s) => decode(String(s || '').replace(/<[^>]*>/g, ' '))
    .replace(/\s+/g, ' ').trim();

  function googleRssUrl(query, lang) {
    const loc = lang === 'ko'
      ? 'hl=ko&gl=KR&ceid=KR:ko'
      : 'hl=en-US&gl=US&ceid=US:en';
    return `https://news.google.com/rss/search?q=${encodeURIComponent(query)}&${loc}`;
  }

  /* ---------- 1순위: 자체 서버리스 (/api/news) ----------
     서버에서는 CORS가 없어 구글 뉴스 RSS를 직접 가져올 수 있다.
     서드파티 프록시(rss2json·allorigins 등)는 수시로 죽으므로
     배포 환경에서는 이 경로만 쓰고, 나머지는 폴백으로만 남긴다. */
  let apiNewsDown = false;          // 한 번 실패하면 이 세션에서는 재시도하지 않음

  async function fetchViaApi(query, lang, limit) {
    if (apiNewsDown) throw new Error('api/news unavailable');
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 13000);
    try {
      const res = await fetch(
        `/api/news?q=${encodeURIComponent(query)}&lang=${lang}&limit=${limit}`,
        { signal: ctrl.signal });
      if (!res.ok) {
        if (res.status === 404 || res.status === 405) apiNewsDown = true;  // 정적 호스팅
        throw new Error(`HTTP ${res.status}`);
      }
      const json = await res.json();
      if (!json.items?.length) throw new Error('empty');
      return json.items;
    } catch (e) {
      if (e.name === 'TypeError') apiNewsDown = true;   // 네트워크/파싱 — 로컬 정적 서버
      throw e;
    } finally { clearTimeout(t); }
  }

  /* rss2json — CORS가 열려 있어 프록시 없이 호출 가능. 폴백 2순위. */
  async function fetchViaRss2Json(rssUrl) {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 10000);
    try {
      const res = await fetch(
        `https://api.rss2json.com/v1/api.json?rss_url=${encodeURIComponent(rssUrl)}&count=40`,
        { signal: ctrl.signal });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = await res.json();
      if (json.status !== 'ok' || !json.items?.length) throw new Error('rss2json empty');
      return json;
    } finally { clearTimeout(t); }
  }

  /* 프록시를 순서대로 시도.
     allorigins 의 /get 은 원문을 JSON({contents:"…"})으로 감싸 주므로 풀어 준다. */
  async function fetchViaProxy(url) {
    let lastErr;
    for (const build of CONFIG.PROXIES) {
      try {
        const ctrl = new AbortController();
        const t = setTimeout(() => ctrl.abort(), 9000);
        const res = await fetch(build(url), { signal: ctrl.signal });
        clearTimeout(t);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);

        let text = await res.text();
        const head = text.slice(0, 40).trimStart();
        if (head.startsWith('{')) {
          try {
            const j = JSON.parse(text);
            if (typeof j.contents === 'string') text = j.contents;   // allorigins /get
          } catch { /* JSON 아님 — 원문 그대로 */ }
        }

        if (text && text.includes('<item') && text.length > 200) return text;
        throw new Error('no items');
      } catch (e) { lastErr = e; }
    }
    throw lastErr || new Error('all proxies failed');
  }

  /* RSS(XML) → 기사 배열 */
  function parseRss(xmlText) {
    const doc = new DOMParser().parseFromString(xmlText, 'text/xml');
    if (doc.querySelector('parsererror')) throw new Error('RSS 파싱 실패');

    return [...doc.querySelectorAll('item')].map((it) => {
      const get = (t) => it.querySelector(t)?.textContent || '';
      const rawTitle = stripTags(get('title'));
      // 구글뉴스 제목은 "기사제목 - 언론사" 형태
      const m = rawTitle.match(/^(.*)\s+-\s+([^-]{2,40})$/);
      return {
        title: m ? m[1] : rawTitle,
        press: m ? m[2] : (stripTags(get('source')) || '뉴스'),
        link: get('link').trim(),
        date: get('pubDate'),
        summary: stripTags(get('description')).slice(0, 180),
      };
    });
  }

  /* rss2json 응답 → 기사 배열
     (구글뉴스 검색 피드는 description 이 링크 하나뿐이라 요약은 비워둔다) */
  function parseRss2Json(json) {
    return (json.items || []).map((it) => {
      const raw = stripTags(it.title);
      const m = raw.match(/^(.*)\s+-\s+([^-]{2,40})$/);
      const sum = stripTags(it.description || '');
      return {
        title: m ? m[1] : raw,
        press: m ? m[2] : (it.author || '뉴스'),
        link: it.link || '',
        date: it.pubDate ? `${it.pubDate.replace(' ', 'T')}Z` : '',
        summary: /^https?:\/\//.test(sum) || sum.length < 15 ? '' : sum.slice(0, 180),
      };
    });
  }

  /* 네이버 API 응답 → 기사 배열 */
  function parseNaver(json) {
    return (json.items || []).map((it) => ({
      title: stripTags(it.title),
      press: (() => { try { return new URL(it.originallink || it.link).hostname.replace(/^www\./, ''); }
                      catch { return '네이버뉴스'; } })(),
      link: it.originallink || it.link,
      date: it.pubDate,
      summary: stripTags(it.description).slice(0, 180),
    }));
  }

  /* ==========================================================
   *  ★ 국립공원 관련도 필터
   *    "국립공원에 해당되는 뉴스만" 남기기 위한 핵심 로직.
   *    수집한 기사를 3단계로 검증한다.
   *      ① 노이즈 배제  — 주가·분양·스포츠팀 등 동명이인성 기사 제거
   *      ② 지역 고유명  — 해당 공원 이름이 제목/요약에 있는가
   *      ③ 공원 문맥어  — 국립공원 / 탐방 / 등산 / national park …
   *    ②나 ③ 중 하나라도 걸리면 통과, 둘 다면 상위 노출.
   * ======================================================== */

  /* 공원 문맥어 — 기사에 이 중 하나도 없으면 국립공원 뉴스로 인정하지 않는다 (필수 조건) */
  const PARK_WORDS_KO = [
    '국립공원', '도립공원', '군립공원', '자연공원', '국립공원공단', '공원공단',
    '탐방', '탐방로', '탐방객', '등산', '등산객', '산행', '입산', '야영장', '캠핑장',
    '대피소', '케이블카', '삭도', '생태계', '멸종위기', '천연기념물', '자연유산',
    '보호구역', '샛길', '둘레길', '야생동물', '반달가슴곰', '자연휴양림', '탐방예약',
  ];
  const PARK_WORDS_EN = [
    'national park', 'national parks', 'nationalpark', 'park service', 'nps',
    'wilderness', 'trailhead', 'hiking', 'backcountry', 'campground', 'campsite',
    'ranger', 'wildlife', 'conservation', 'world heritage', 'nature reserve',
    'protected area', 'endangered species', 'visitor center', 'visitor centre',
    'ecosystem', 'unesco',
  ];

  /* 노이즈 — 이 단어가 제목에 있으면 공원 뉴스가 아님 (동명 기업/아파트/구단 등) */
  const NOISE = [
    '주가', '증권', '코스피', '코스닥', '상한가', '분양', '아파트', '청약', '재건축',
    '프로야구', '경기력', '이적', '선발 등판', '드래프트', '연예', '열애', '결혼설',
    'stock', 'shares', 'nasdaq', 'earnings', 'apartment', 'condo', 'casino',
    'fc ', 'united fc', 'transfer rumour', 'box office',
  ];

  /** 지역명에서 핵심 고유명 추출 : '설악산국립공원' → ['설악산'] / 'Yellowstone NP' → ['yellowstone'] */
  function coreTokens(region) {
    if (region.must?.length) return region.must.map((s) => s.toLowerCase());

    const raw = `${region.name} ${region.q || ''}`
      .replace(/국립공원|도립공원|군립공원|국립|공원/g, ' ')
      .replace(/\b(NP|National|Park|Parks)\b/gi, ' ')
      .replace(/[^\p{L}\p{N}\s]/gu, ' ');

    return [...new Set(
      raw.split(/\s+/)
        .map((s) => s.trim().toLowerCase())
        .filter((s) => s.length >= 2)
    )];
  }

  /**
   * 기사 1건의 국립공원 관련도 점수 (0이면 탈락)
   *  · 필수: 공원 문맥어(PARK_WORDS)가 반드시 1개 이상 있어야 한다.
   *          → "설악산 맛집", "경주 아파트 분양" 같은 지명만 겹치는 기사를 잘라낸다.
   *  · 가산: 해당 공원의 고유명이 있으면(특히 제목에) 상위로 올린다.
   */
  function scoreItem(region, item, cores, words) {
    const title = (item.title || '').toLowerCase();
    const text = `${title} ${(item.summary || '').toLowerCase()}`;

    if (NOISE.some((n) => title.includes(n))) return 0;

    const parkInTitle = words.some((w) => title.includes(w));
    const parkInText = parkInTitle || words.some((w) => text.includes(w));
    if (!parkInText) return 0;                     // ★ 공원 문맥어 없으면 무조건 탈락

    let s = 1;
    if (parkInTitle) s += 2;
    if (cores.some((c) => text.includes(c))) s += 2;
    if (cores.some((c) => title.includes(c))) s += 3;   // 제목에 지역명 → 가장 확실
    return s;
  }

  /** 기사 배열 → 국립공원 관련 기사만, 관련도 높은 순 */
  function filterPark(region, items) {
    const cores = coreTokens(region);
    const words = region.lang === 'ko'
      ? PARK_WORDS_KO.map((w) => w.toLowerCase())
      : [...PARK_WORDS_EN, ...PARK_WORDS_KO].map((w) => w.toLowerCase());

    const seen = new Set();
    return items
      .map((it) => ({ it, s: scoreItem(region, it, cores, words) }))
      .filter(({ it, s }) => {
        if (s <= 0) return false;
        const k = it.title.replace(/\s+/g, '').slice(0, 30);   // 중복 기사 제거
        if (seen.has(k)) return false;
        seen.add(k);
        return true;
      })
      /* 화면에 '최신 뉴스' 라고 적어 놓고 관련도순으로 늘어놓고 있었다.
         관련도가 높은 오래된 기사가 갓 나온 기사보다 위에 오니
         "최신인데 최신이 아니다" 라는 말이 나온다.
         관련 없는 기사는 위에서 이미 걸러졌으므로(s<=0 제외) 날짜순으로 세운다.
         날짜가 같거나 없을 때만 관련도로 가른다. */
      .sort((a, b) => (Date.parse(b.it.date) || 0) - (Date.parse(a.it.date) || 0) || b.s - a.s)
      .map(({ it, s }) => ({ ...it, score: s }));
  }

  /* ---------- 공개 API ---------- */

  /**
   * 지역 하나의 "국립공원 관련" 최신 뉴스를 가져온다.
   * @param {object} region
   * @param {boolean} force  캐시 무시하고 새로 받기
   * @returns {Promise<{items:Array, raw:number}>}
   */
  function load(region, force = false) {
    const key = region.id;
    if (!force) {
      const hit = cache.get(key);
      if (hit && Date.now() - hit.at < CONFIG.NEWS_CACHE_MS) return Promise.resolve(hit.data);
      if (inflight.has(key)) return inflight.get(key);
    }

    const query = region.q || region.name;
    const pool = CONFIG.NEWS_COUNT * 5;   // 넉넉히 받아서 걸러낸다

    const task = (async () => {
      let items = null;

      // 1) 네이버 검색 API (국내 지역, 키가 등록돼 있을 때만)
      if (CONFIG.USE_SERVERLESS && region.lang === 'ko') {
        try {
          const res = await fetch(`/api/naver-news?query=${encodeURIComponent(query)}&display=20`);
          if (res.ok) {
            const parsed = parseNaver(await res.json());
            if (parsed.length) items = parsed;
          }
        } catch { /* 무시하고 폴백 */ }
      }

      // 2) 자체 서버리스 — 배포 환경의 기본 경로
      if (!items) {
        try { items = await fetchViaApi(query, region.lang, pool); }
        catch { /* 폴백 */ }
      }

      const rss = googleRssUrl(query, region.lang);

      // 3) rss2json (서드파티, 불안정)
      if (!items) {
        try { items = parseRss2Json(await fetchViaRss2Json(rss)).slice(0, pool); }
        catch { /* 폴백 */ }
      }
      // 4) CORS 프록시 3중 폴백
      if (!items) {
        const xml = await fetchViaProxy(rss);
        items = parseRss(xml).slice(0, pool);
      }

      /* 표시 개수 제한은 화면(app.js)에서 한다 — 인기순은 관련 기사
         전체를 사안별로 묶어야 순위가 서기 때문에 전부 넘긴다. */
      const kept = filterPark(region, items);
      return { items: kept, raw: items.length, dropped: items.length - kept.length };
    })()
      .then((data) => { cache.set(key, { at: Date.now(), data }); return data; })
      .finally(() => inflight.delete(key));

    inflight.set(key, task);
    return task;
  }

  /** 캐시에 이미 있으면 즉시 반환 (호버 팝업용) */
  const peek = (region) => cache.get(region.id)?.data || null;

  /** 임의 키워드로 검색 — 국립공원 관련도 필터를 동일하게 적용
      (핫이슈 띠 · 인기뉴스 순위 · 하단 티커 · 일일요약 간이본이 사용) */
  async function search(query, lang = 'ko', limit = 12) {
    const rss = googleRssUrl(query, lang);
    let items = null;

    try { items = await fetchViaApi(query, lang, limit * 3); }
    catch { /* 폴백 */ }

    if (!items) {
      try { items = parseRss2Json(await fetchViaRss2Json(rss)); }
      catch { /* 폴백 */ }
    }
    if (!items) items = parseRss(await fetchViaProxy(rss));

    const pseudo = { name: query, q: query, lang, must: ['국립공원', 'national park'] };
    return filterPark(pseudo, items.slice(0, limit * 3)).slice(0, limit);
  }

  /* ---------- 헤드라인 키워드 추출 ---------- */
  const STOP = new Set([
    '국립공원', '공원', '기사', '뉴스', '오늘', '어제', '올해', '지난', '관련', '대한',
    '위해', '통해', '이번', '그리고', '하지만', '있다', '없다', '한다', '했다', '된다',
    '됐다', '있는', '하는', '되는', '이날', '최근', '등의', '등을', '등이', '지역',
    '국내', '사진', '영상', '속보', '종합', '단독', '재배포', '무단', '저작권',
    'the', 'and', 'for', 'with', 'from', 'that', 'this', 'what', 'have', 'has',
    'was', 'were', 'are', 'will', 'you', 'your', 'not', 'but', 'its', 'into',
    'over', 'about', 'national', 'park', 'news', 'says', 'say', 'new', 'more',
    'than', 'after', 'before', 'amid', 'out', 'how', 'why', 'who', 'when', 'where',
  ]);

  function keywords(items, top = 8) {
    const freq = new Map();
    for (const it of items) {
      const tokens = (it.title + ' ' + (it.summary || ''))
        .replace(/[^\p{L}\p{N}\s]/gu, ' ')
        .split(/\s+/);
      for (let w of tokens) {
        w = w.trim();
        if (w.length < 2 || w.length > 14) continue;
        if (/^\d+$/.test(w)) continue;
        const low = w.toLowerCase();
        if (STOP.has(low) || STOP.has(w)) continue;
        freq.set(w, (freq.get(w) || 0) + 1);
      }
    }
    return [...freq.entries()]
      .sort((a, b) => b[1] - a[1] || b[0].length - a[0].length)
      .slice(0, top)
      .map(([word, count]) => ({ word, count }));
  }

  /* ==========================================================
   *  이슈 묶기 — 같은 사안을 보도한 기사들을 하나로
   *  (핫이슈 띠 · 인기뉴스 순위 · 일일요약 간이본이 공유)
   * ======================================================== */
  const G_JOSA = /(에서|에게|으로|은|는|이|가|을|를|에|의|서|와|과|도|로)$/;
  const G_STOP = new Set(['국립공원', '공원', '국립', '지난', '올해', '관련', '이날']);
  const G_KEY = /[‘'"“]([^’'"”]{2,20})[’'"”]/g;

  const gTokens = (t) => new Set(
    t.replace(/[^\p{L}\p{N}\s]/gu, ' ').split(/\s+/)
      .map((w) => (w.length >= 3 ? w.replace(G_JOSA, '') : w))
      .filter((w) => w.length >= 2 && !G_STOP.has(w)));

  const gKeys = (t) => new Set([...t.matchAll(G_KEY)].map((m) => m[1].trim()).filter(Boolean));

  function gSim(a, b) {
    let i = 0;
    for (const x of a) if (b.has(x)) i++;
    return i ? Math.max(i / (a.size + b.size - i), i / Math.min(a.size, b.size)) : 0;
  }

  /**
   * 기사 배열 → 사안별 묶음 (열기 순 정렬)
   * heat = 보도 언론사 수 + (최근 12시간 내면 +1.5)
   */
  function groupIssues(items) {
    const seen = new Set();
    const arts = [];
    for (const n of items) {
      const k = `${n.title.replace(/\s+/g, '').slice(0, 30)}|${n.press}`;
      if (seen.has(k)) continue;
      seen.add(k);
      arts.push(n);
    }

    const groups = [];
    for (const a of arts) {
      const tk = gTokens(a.title);
      const ky = gKeys(a.title);
      const g = groups.find((x) => {
        if (gSim(x.tk, tk) < 0.5) return false;
        if (ky.size && x.ky.size && ![...ky].some((k) => x.ky.has(k))) return false;
        return true;
      });
      if (g) { g.arts.push(a); tk.forEach((t) => g.tk.add(t)); ky.forEach((t) => g.ky.add(t)); }
      else groups.push({ tk, ky, arts: [a] });
    }

    const now = Date.now();
    return groups.map((g) => {
      const outlets = [...new Set(g.arts.map((a) => a.press))];
      const newest = Math.max(...g.arts.map((a) => Date.parse(a.date) || 0));
      const fresh = now - newest < 12 * 3600 * 1000 ? 1.5 : 0;
      return {
        arts: g.arts, outlets, newest,
        outletCount: outlets.length,
        heat: outlets.length + fresh,
        lead: g.arts[0],
      };
    }).sort((a, b) => b.heat - a.heat || b.newest - a.newest);
  }

  /**
   * 인기순 목록 — 최근 days일 기사를 사안별로 묶어 보도 언론사 수가
   * 많은 순으로 대표 기사를 돌려준다. 동률은 최신순.
   *  · 대표 기사 = 묶음 안에서 가장 최신 기사 (사안은 오래돼도 보이는 건 후속 보도)
   *  · 30일 밖·날짜 없는 기사는 1건짜리로 뒤에 붙인다 — 조용한 공원에서
   *    목록이 비지 않게 하되 순위를 어지럽히지는 않는다.
   */
  function hotList(items, days = 30, limit = 6) {
    const cut = Date.now() - days * 86400 * 1000;
    const inWin = (n) => (Date.parse(n.date) || 0) >= cut;
    const recent = items.filter(inWin);
    const rest = items.filter((n) => !inWin(n));

    const out = groupIssues(recent)
      .sort((a, b) => b.outletCount - a.outletCount || b.newest - a.newest)
      .map((g) => {
        const lead = g.arts.reduce(
          (m, a) => ((Date.parse(a.date) || 0) > (Date.parse(m.date) || 0) ? a : m), g.arts[0]);
        return { ...lead, outletCount: g.outletCount };
      });
    for (const n of rest) out.push({ ...n, outletCount: 1 });
    return out.slice(0, limit);
  }

  /* ---------- 상대 시간 ---------- */
  function timeAgo(dateStr) {
    const t = Date.parse(dateStr);
    if (Number.isNaN(t)) return '';
    const s = (Date.now() - t) / 1000;
    if (s < 60) return '방금';
    if (s < 3600) return `${Math.floor(s / 60)}분 전`;
    if (s < 86400) return `${Math.floor(s / 3600)}시간 전`;
    if (s < 86400 * 7) return `${Math.floor(s / 86400)}일 전`;
    return new Date(t).toLocaleDateString('ko-KR', { month: 'short', day: 'numeric' });
  }

  return { load, peek, search, keywords, timeAgo, filterPark, coreTokens, groupIssues, hotList };
})();
