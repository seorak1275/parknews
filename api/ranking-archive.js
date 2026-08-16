/* =============================================================
 *  /api/ranking-archive  —  기간별 인기뉴스 순위 (일 · 주 · 월 · 연)
 *
 *  ● 매일 아침 07:00 (KST) 자동 실행 (vercel.json 의 crons)
 *      → 전날(D-1) 보도된 국립공원 기사를 수집
 *      → 같은 사안끼리 묶고 보도 건수를 셈
 *      → GitHub 저장소 data/ranking/YYYY-MM-DD.json 로 커밋
 *      → 그 달의 월간 집계본(rollup)도 함께 갱신
 *
 *  ● 사이트의 [인기뉴스] 창이 이 API를 읽어 기간별 순위를 그립니다.
 *
 *  "인기"는 조회수가 아니라 **보도량**입니다.
 *  같은 사안을 여러 언론사가 다룰수록 위로 올라갑니다.
 *  → 화제성이 아니라 "언론이 얼마나 중요하게 봤나"를 재는 지표입니다.
 *
 *  AI 요약을 쓰지 않으므로 유료 API 키가 필요 없습니다.
 *
 *  --------- 필요한 환경변수 (Vercel → Settings → Environment Variables)
 *    GITHUB_TOKEN        아카이브 저장용 (필수 · Contents 읽기/쓰기)
 *    GITHUB_REPO         예) seorak1275/parknews
 *    GITHUB_BRANCH       기본값 main
 *    CRON_SECRET         수동 실행 보호용 (권장)
 *
 *  --------- 조회
 *    GET /api/ranking-archive?period=day            어제 하루
 *    GET /api/ranking-archive?period=week           최근 7일
 *    GET /api/ranking-archive?period=month          최근 30일
 *    GET /api/ranking-archive?period=year           최근 12개월
 *    GET /api/ranking-archive?period=week&set=global   국외
 *    GET /api/ranking-archive?list=1                보관된 날짜 목록
 * ============================================================= */

/* ==========================================================
 *  0. 날짜 유틸 (전부 KST 기준)
 * ======================================================== */
const KST_OFFSET = 9 * 60 * 60 * 1000;
const DOW = ['일', '월', '화', '수', '목', '금', '토'];

const toKst = (d) => new Date(d.getTime() + KST_OFFSET);
const ymd = (d) => d.toISOString().slice(0, 10);
const addDays = (dateStr, n) => {
  const d = new Date(`${dateStr}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return ymd(d);
};
const addMonths = (ym, n) => {
  const [y, m] = ym.split('-').map(Number);
  const d = new Date(Date.UTC(y, m - 1 + n, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
};
function korean(dateStr) {
  const d = new Date(`${dateStr}T00:00:00Z`);
  return `${d.getUTCFullYear()}년 ${d.getUTCMonth() + 1}월 ${d.getUTCDate()}일 ${DOW[d.getUTCDay()]}요일`;
}

/* ==========================================================
 *  1. 기사 수집  —  구글 뉴스 RSS (서버 → CORS 무관)
 * ======================================================== */
const UA = 'Mozilla/5.0 (compatible; ParkNews/1.0; +https://parknews.vercel.app)';

const SETS = {
  kr: {
    label: '국내',
    loc: 'hl=ko&gl=KR&ceid=KR:ko',
    queries: [
      /* 정책·현안 */
      '국립공원', '국립공원공단', '국립공원 탐방', '국립공원 멸종위기',
      '국립공원 지정', '국립공원 안전', '국립공원 생태', '국립공원 탐방로',
      /* 개별 공원 */
      '설악산 국립공원', '지리산 국립공원', '한라산 국립공원', '북한산 국립공원',
      '내장산 국립공원', '태백산 국립공원', '다도해해상 국립공원', '무등산 국립공원',
      '가야산 국립공원', '소백산 국립공원', '주왕산 국립공원', '팔공산 국립공원',
      /* 참고기사(기후·산림·관광) 후보 */
      '국립공원 기후', '등산객 안전', '산림청 국립공원', '탐방객 증가',
    ],
    /* 반드시 하나는 포함돼야 국립공원 기사로 인정 */
    must: [
      '국립공원', '도립공원', '군립공원', '자연공원', '공원공단', '탐방', '탐방로',
      '탐방객', '등산', '산행', '입산', '야영장', '대피소', '케이블카', '생태계',
      '멸종위기', '천연기념물', '자연유산', '보호구역', '둘레길', '야생동물',
      '반달가슴곰', '자연휴양림', '깃대종', '개화', '서식',
    ],
    noise: ['주가', '증권', '코스피', '분양', '아파트', '청약', '프로야구', '이적',
            '채용', '입찰', '공고', '모집공고'],
  },
  global: {
    label: '국외',
    loc: 'hl=en-US&gl=US&ceid=US:en',
    queries: [
      'national park', 'national park conservation', 'national park wildlife',
      'national park visitors', 'IUCN protected area', 'UNESCO natural heritage',
      'national park service', 'national park funding',
    ],
    must: ['national park', 'nature reserve', 'protected area', 'wildlife',
           'conservation', 'wilderness', 'heritage site', 'ranger', 'trail'],
    noise: ['stock', 'nasdaq', 'crypto', 'betting', 'transfer rumour'],
  },
};

const decodeEntities = (s) => String(s || '')
  .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
  .replace(/&quot;/g, '"').replace(/&#39;/g, "'")
  .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&');

const stripTags = (s) => decodeEntities(s).replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();

function tag(block, name) {
  const m = block.match(new RegExp(`<${name}[^>]*>([\\s\\S]*?)</${name}>`, 'i'));
  return m ? stripTags(m[1]) : '';
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function fetchRssOnce(url) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 11000);
  try {
    const res = await fetch(url, {
      signal: ctrl.signal,
      headers: { 'User-Agent': UA, Accept: 'application/rss+xml, application/xml, text/xml' },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const xml = await res.text();
    return [...xml.matchAll(/<item>([\s\S]*?)<\/item>/g)].map((m) => {
      const b = m[1];
      const raw = tag(b, 'title');
      const hit = raw.match(/^(.*)\s+-\s+([^-]{2,40})$/);
      return {
        title: hit ? hit[1].trim() : raw,
        press: hit ? hit[2].trim() : (tag(b, 'source') || '뉴스'),
        link: tag(b, 'link'),
        pubDate: tag(b, 'pubDate'),
      };
    });
  } finally {
    clearTimeout(t);
  }
}

/* 하루 한 번만 도는 수집이라, 한 번 실패하면 그날 기록에 구멍이 남는다.
   → 질의당 1회 재시도. 그래도 실패하면 그 질의만 포기한다. */
async function fetchRss(q, loc) {
  const url = `https://news.google.com/rss/search?q=${encodeURIComponent(q)}&${loc}`;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      return await fetchRssOnce(url);
    } catch {
      if (attempt === 0) await sleep(700);
    }
  }
  return null;                       // null = 실패 (0건과 구분한다)
}

/* 질의를 한꺼번에 다 던지면 통째로 거절당하는 일이 있어 동시 실행을 묶는다 */
async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) {
      const idx = i++;
      out[idx] = await fn(items[idx]);
    }
  }));
  return out;
}

/** 해당 날짜(KST)에 보도된 기사만 모은다 */
async function collectArticles(targetDate, setKey) {
  const cfg = SETS[setKey];
  const batches = await mapLimit(cfg.queries, 6, (q) => fetchRss(q, cfg.loc));
  const failed = batches.filter((b) => b === null).length;
  const seen = new Set();
  const out = [];

  for (const item of batches.filter(Boolean).flat()) {
    if (!item.title || !item.link) continue;

    const ts = Date.parse(item.pubDate);
    if (Number.isNaN(ts)) continue;
    if (ymd(toKst(new Date(ts))) !== targetDate) continue;      // 해당일 보도만

    const low = item.title.toLowerCase();
    if (cfg.noise.some((n) => low.includes(n))) continue;
    if (!cfg.must.some((w) => low.includes(w.toLowerCase()))) continue;

    const key = item.title.replace(/[^\p{L}\p{N}]/gu, '').slice(0, 40).toLowerCase();
    if (seen.has(`${key}|${item.press}`)) continue;
    seen.add(`${key}|${item.press}`);

    out.push(item);
  }
  return { articles: out, failed, queries: cfg.queries.length };
}

/* ==========================================================
 *  2. 같은 사안 묶기  —  제목 토큰 유사도
 *     (프론트 news.js 의 groupIssues 와 같은 사상)
 * ======================================================== */
const STOP = new Set([
  '국립공원', '공원', '기사', '지난', '올해', '관련', '이날', '등의', '위해', '국립',
  'the', 'and', 'for', 'with', 'from', 'national', 'park', 'parks', 'says', 'new',
]);

/* 조사 제거 — '내장산서'/'국립공원에' 가 '내장산'/'국립공원' 과 묶이도록 */
const JOSA = /(에서|에게|으로|과의|와의|은|는|이|가|을|를|에|의|서|와|과|도|로)$/;
const norm = (w) => (w.length >= 3 ? w.replace(JOSA, '') : w);

function tokens(title) {
  return new Set(
    String(title).toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, ' ').split(/\s+/)
      .map((w) => norm(w.trim()))
      .filter((w) => w.length >= 2 && !STOP.has(w))
  );
}

/**
 * 두 제목의 유사도.
 * 자카드만 쓰면 제목 길이가 다를 때(축약형 vs 풀네임) 같은 사안을 놓친다.
 * → 포함율(작은 쪽 기준)을 함께 보고 둘 중 큰 값을 쓴다.
 */
function similarity(a, b) {
  let inter = 0;
  for (const x of a) if (b.has(x)) inter++;
  if (!inter) return 0;
  const jaccard = inter / (a.size + b.size - inter);
  const containment = inter / Math.min(a.size, b.size);
  return Math.max(jaccard, containment);
}

/** 따옴표로 묶인 핵심어 — 종명·프로그램명이 여기 들어간다 */
const KEY_RE = /[‘'"“]([^’'"”]{2,20})[’'"”]/g;
const keyEntities = (title) =>
  new Set([...String(title).matchAll(KEY_RE)].map((m) => m[1].trim()).filter(Boolean));

/**
 * 기사 목록 → 사안별 묶음.
 * seed 가 있으면(기간 집계) 이미 계산된 보도수를 이어받는다.
 */
function groupByIssue(entries) {
  const groups = [];
  for (const e of entries) {
    const tk = tokens(e.title);
    const ky = keyEntities(e.title);

    const hit = groups.find((g) => {
      if (similarity(g.tokens, tk) < 0.5) return false;
      if (ky.size && g.keys.size && ![...ky].some((k) => g.keys.has(k))) return false;
      return true;
    });

    if (hit) {
      hit.reports += e.reports;
      for (const p of e.press) hit.press.add(p);
      for (const a of e.articles) if (hit.articles.length < 8) hit.articles.push(a);
      for (const t of tk) hit.tokens.add(t);
      for (const k of ky) hit.keys.add(k);
      /* 대표 제목은 보도수가 가장 많았던 쪽을 유지 */
      if (e.reports > hit.leadReports) { hit.title = e.title; hit.leadReports = e.reports; }
    } else {
      groups.push({
        tokens: tk, keys: ky,
        title: e.title,
        leadReports: e.reports,
        reports: e.reports,
        press: new Set(e.press),
        articles: e.articles.slice(0, 8),
        firstSeen: e.firstSeen,
        lastSeen: e.lastSeen,
      });
    }
  }

  return groups
    .map((g) => ({
      title: g.title,
      reports: g.reports,
      press: [...g.press],
      outletCount: g.press.size,
      articles: g.articles,
      link: g.articles[0]?.link || '',
    }))
    .sort((a, b) => b.reports - a.reports || b.outletCount - a.outletCount);
}

/** 원본 기사 배열 → groupByIssue 가 먹는 형태 */
const asEntries = (articles) => articles.map((a) => ({
  title: a.title,
  reports: 1,
  press: [a.press],
  articles: [{ title: a.title, press: a.press, link: a.link }],
}));

/* ==========================================================
 *  3. 아카이브 저장소 (GitHub Contents API)
 * ======================================================== */
const GH = {
  ok: () => Boolean(process.env.GITHUB_TOKEN && process.env.GITHUB_REPO),
  repo: () => process.env.GITHUB_REPO,
  branch: () => process.env.GITHUB_BRANCH || 'main',
  headers: () => ({
    Authorization: `Bearer ${process.env.GITHUB_TOKEN}`,
    Accept: 'application/vnd.github+json',
    'User-Agent': UA,
  }),
};

async function ghRead(path) {
  if (!GH.ok()) throw new Error('GITHUB_TOKEN / GITHUB_REPO 미설정');
  const url = `https://api.github.com/repos/${GH.repo()}/contents/${path}?ref=${GH.branch()}`;
  const r = await fetch(url, { headers: GH.headers() });
  if (r.status === 404) return null;
  if (!r.ok) throw new Error(`GitHub 읽기 실패 (${r.status})`);
  const j = await r.json();
  return { sha: j.sha, data: JSON.parse(Buffer.from(j.content, 'base64').toString('utf-8')) };
}

async function ghWrite(path, data, message) {
  if (!GH.ok()) throw new Error('GITHUB_TOKEN / GITHUB_REPO 미설정');
  const prev = await ghRead(path).catch(() => null);
  const url = `https://api.github.com/repos/${GH.repo()}/contents/${path}`;
  const r = await fetch(url, {
    method: 'PUT',
    headers: { ...GH.headers(), 'Content-Type': 'application/json' },
    body: JSON.stringify({
      message,
      branch: GH.branch(),
      content: Buffer.from(JSON.stringify(data, null, 2), 'utf-8').toString('base64'),
      ...(prev?.sha ? { sha: prev.sha } : {}),
    }),
  });
  if (!r.ok) throw new Error(`GitHub 쓰기 실패 (${r.status}) ${(await r.text()).slice(0, 200)}`);
}

const dayPath = (date) => `data/ranking/${date}.json`;
const monthPath = (ym) => `data/ranking/month-${ym}.json`;
const INDEX_PATH = 'data/ranking/index.json';

const loadDay = (date) => ghRead(dayPath(date)).then((h) => h?.data || null).catch(() => null);
const loadMonth = (ym) => ghRead(monthPath(ym)).then((h) => h?.data || null).catch(() => null);

/* ==========================================================
 *  4. 기간 집계
 * ======================================================== */
const TOP_PER_DAY = 40;     // 하루치에 보관할 상위 사안 수
const TOP_RESULT = 30;      // 조회 시 돌려줄 상위 사안 수

/** 여러 날/달의 순위표를 하나로 합친다 */
function mergeRankings(snapshots, setKey) {
  const entries = [];
  for (const snap of snapshots) {
    const rows = snap?.[setKey]?.rows;
    if (!Array.isArray(rows)) continue;
    for (const r of rows) {
      entries.push({
        title: r.title,
        reports: r.reports || 1,
        press: r.press || [],
        articles: r.articles || [],
      });
    }
  }
  /* 보도수 많은 것부터 넣어야 대표 제목이 안정적으로 잡힌다 */
  entries.sort((a, b) => b.reports - a.reports);
  return groupByIssue(entries);
}

/** 그 달의 일간 파일들을 모아 월간 집계본을 만든다 */
async function rebuildMonth(ym) {
  const [y, m] = ym.split('-').map(Number);
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const dates = Array.from({ length: last }, (_, i) => `${ym}-${String(i + 1).padStart(2, '0')}`);

  const days = (await Promise.all(dates.map(loadDay))).filter(Boolean);
  if (!days.length) return null;

  const rollup = {
    month: ym,
    days: days.length,
    from: days[0].date,
    to: days[days.length - 1].date,
    generatedAt: new Date().toISOString(),
  };
  for (const setKey of Object.keys(SETS)) {
    rollup[setKey] = { rows: mergeRankings(days, setKey).slice(0, TOP_PER_DAY) };
  }

  await ghWrite(monthPath(ym), rollup, `월간 인기뉴스 집계 갱신 ${ym}`);
  return rollup;
}

/* ==========================================================
 *  5. 핸들러
 * ======================================================== */
const PERIODS = {
  day:   { days: 1,   label: '일간' },
  week:  { days: 7,   label: '주간' },
  month: { days: 30,  label: '월간' },
  year:  { days: 365, label: '연간' },
};

export default async function handler(req, res) {
  const now = toKst(new Date());
  const today = ymd(now);
  const setKey = req.query.set === 'global' ? 'global' : 'kr';

  /* ---------- 생성 모드 (크론 또는 수동) ---------- */
  if (req.query.cron || req.query.generate) {
    const secret = process.env.CRON_SECRET;
    const authed = !secret
      || req.headers.authorization === `Bearer ${secret}`
      || req.query.key === secret;
    if (!authed) return res.status(401).json({ error: '인증 실패 (CRON_SECRET)' });

    if (!GH.ok()) {
      return res.status(501).json({
        error: 'GITHUB_TOKEN / GITHUB_REPO 미설정 — 아카이브를 저장할 수 없습니다.',
      });
    }

    const targetDate = String(req.query.date || addDays(today, -1));

    try {
      const snapshot = {
        date: targetDate,
        dateKo: korean(targetDate),
        generatedAt: new Date().toISOString(),
      };
      let total = 0;
      let failedAll = 0;
      let queriesAll = 0;

      for (const key of Object.keys(SETS)) {
        const { articles, failed, queries } = await collectArticles(targetDate, key);
        total += articles.length;
        failedAll += failed;
        queriesAll += queries;
        snapshot[key] = {
          collected: articles.length,
          failedQueries: failed,
          rows: groupByIssue(asEntries(articles)).slice(0, TOP_PER_DAY),
        };
      }

      /* 질의가 전멸했다면 "그날은 기사가 없었다"가 아니라 수집 자체가 실패한 것이다.
         빈 껍데기를 저장하면 주간·월간 순위가 조용히 왜곡되므로 저장하지 않는다. */
      if (failedAll === queriesAll) {
        return res.status(502).json({
          error: '뉴스 수집이 전부 실패했습니다 — 보관본을 저장하지 않았습니다.',
          date: targetDate,
          failedQueries: failedAll,
        });
      }
      if (failedAll) snapshot.partial = { failedQueries: failedAll, of: queriesAll };

      await ghWrite(dayPath(targetDate), snapshot, `일간 인기뉴스 순위 ${targetDate}`);

      /* 보관 날짜 목록 갱신 */
      const idx = (await ghRead(INDEX_PATH).catch(() => null))?.data || { dates: [] };
      if (!idx.dates.includes(targetDate)) {
        idx.dates = [...idx.dates, targetDate].sort().reverse().slice(0, 400);
        idx.updatedAt = new Date().toISOString();
        await ghWrite(INDEX_PATH, idx, `인기뉴스 보관 목록 갱신 ${targetDate}`);
      }

      /* 그 달 집계본 갱신 — 연간 조회를 12번 읽기로 끝내기 위한 사전 계산 */
      let monthRollup = null;
      try { monthRollup = await rebuildMonth(targetDate.slice(0, 7)); }
      catch (e) { snapshot.rollupError = String(e.message || e); }

      return res.status(200).json({
        ok: true,
        date: targetDate,
        collected: total,
        failedQueries: failedAll,
        kr: snapshot.kr.rows.length,
        global: snapshot.global.rows.length,
        monthRollup: monthRollup ? `${monthRollup.month} (${monthRollup.days}일)` : null,
      });
    } catch (e) {
      console.error(e);
      return res.status(500).json({ error: String(e.message || e) });
    }
  }

  /* ---------- 보관 목록 ---------- */
  if (req.query.list) {
    const idx = (await ghRead(INDEX_PATH).catch(() => null))?.data;
    res.setHeader('Cache-Control', 's-maxage=300, stale-while-revalidate=1800');
    return res.status(200).json(idx || { dates: [] });
  }

  /* ---------- 조회 모드 ---------- */
  const periodKey = PERIODS[req.query.period] ? req.query.period : 'week';
  const period = PERIODS[periodKey];

  if (!GH.ok()) {
    return res.status(501).json({
      error: 'GITHUB_TOKEN / GITHUB_REPO 미설정 — 보관된 순위를 읽을 수 없습니다.',
    });
  }

  try {
    let snapshots = [];
    let from = '';
    const to = addDays(today, -1);

    if (periodKey === 'year') {
      /* 최근 12개월 집계본 — 일간 365개를 읽지 않는다 */
      const thisMonth = to.slice(0, 7);
      const months = Array.from({ length: 12 }, (_, i) => addMonths(thisMonth, -i));
      snapshots = (await Promise.all(months.map(loadMonth))).filter(Boolean);
      from = snapshots.length ? snapshots[snapshots.length - 1].from : '';
    } else {
      const dates = Array.from({ length: period.days }, (_, i) => addDays(to, -i));
      snapshots = (await Promise.all(dates.map(loadDay))).filter(Boolean);
      from = snapshots.length ? snapshots[snapshots.length - 1].date : '';
    }

    if (!snapshots.length) {
      return res.status(404).json({
        error: `${period.label} 순위를 만들 자료가 아직 없습니다.`,
        hint: '매일 07:00(KST)에 하루치씩 쌓입니다. 주간은 7일, 월간은 30일, 연간은 12개월이 지나야 온전해집니다.',
        period: periodKey,
        have: 0,
      });
    }

    const rows = mergeRankings(snapshots, setKey).slice(0, TOP_RESULT);

    res.setHeader('Cache-Control', 's-maxage=3600, stale-while-revalidate=86400');
    return res.status(200).json({
      period: periodKey,
      periodKo: period.label,
      set: setKey,
      setKo: SETS[setKey].label,
      from,
      to,
      /* 실제로 자료가 있는 날/달 수 — 화면에 "n일치 기준"으로 표시 */
      have: snapshots.length,
      want: periodKey === 'year' ? 12 : period.days,
      unit: periodKey === 'year' ? 'month' : 'day',
      totalReports: rows.reduce((s, r) => s + r.reports, 0),
      rows,
      generatedAt: new Date().toISOString(),
    });
  } catch (e) {
    console.error(e);
    return res.status(502).json({ error: String(e.message || e) });
  }
}
