/* =============================================================
 *  /api/digest  —  일일 국립공원 기사요약 생성 · 조회
 *
 *  ● 매일 아침 07:00 (KST) 자동 실행 (vercel.json 의 crons)
 *      → 전날(D-1) 보도된 국립공원 기사를 수집
 *      → 같은 이슈끼리 묶고(언론사 복수 표기)
 *      → D-1 · D-2 요약본과 대조해 중복 이슈 제거
 *      → Claude 로 "오늘의 주요기사(요약)" 문체에 맞춰 요약
 *      → GitHub 저장소 data/digest/YYYY-MM-DD.json 로 커밋
 *
 *  ● 사이트의 [일일 요약 다운로드] 버튼이 이 API를 읽어
 *    A4 요약표를 그려주고 PDF로 저장합니다.
 *
 *  --------- 필요한 환경변수 (Vercel → Settings → Environment Variables)
 *    ANTHROPIC_API_KEY   요약 생성용 (필수)
 *    CRON_SECRET         수동 실행 보호용 (권장)
 *    GITHUB_TOKEN        아카이브 저장용 (선택 · 없으면 저장 없이 결과만 반환)
 *    GITHUB_REPO         예) yourname/parknews
 *    GITHUB_BRANCH       기본값 main
 * ============================================================= */

import Anthropic from '@anthropic-ai/sdk';

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
function korean(dateStr) {
  const d = new Date(`${dateStr}T00:00:00Z`);
  return `${d.getUTCFullYear()}년 ${d.getUTCMonth() + 1}월 ${d.getUTCDate()}일 ${DOW[d.getUTCDay()]}요일`;
}

/* ==========================================================
 *  1. 기사 수집  —  구글 뉴스 RSS (서버 → CORS 무관)
 * ======================================================== */
const QUERIES = [
  /* 정책·현안 */
  '국립공원', '국립공원공단', '국립공원 탐방', '국립공원 멸종위기',
  '국립공원 지정', '국립공원 안전', '국립공원 생태', '국립공원 탐방로',
  /* 개별 공원 */
  '설악산 국립공원', '지리산 국립공원', '한라산 국립공원', '북한산 국립공원',
  '내장산 국립공원', '태백산 국립공원', '다도해해상 국립공원', '무등산 국립공원',
  '가야산 국립공원', '소백산 국립공원', '주왕산 국립공원', '팔공산 국립공원',
  /* 참고기사(기후·산림·관광) 후보 */
  '국립공원 기후', '등산객 안전', '산림청 국립공원', '탐방객 증가',
];

/* 반드시 하나는 포함돼야 국립공원 기사로 인정 (프론트 필터와 동일 사상) */
const PARK_WORDS = [
  '국립공원', '도립공원', '군립공원', '자연공원', '공원공단', '탐방', '탐방로',
  '탐방객', '등산', '산행', '입산', '야영장', '대피소', '케이블카', '생태계',
  '멸종위기', '천연기념물', '자연유산', '보호구역', '둘레길', '야생동물',
  '반달가슴곰', '자연휴양림', '깃대종', '개화', '서식',
];
const NOISE = [
  '주가', '증권', '코스피', '분양', '아파트', '청약', '프로야구', '이적',
  '채용', '입찰', '공고', '모집공고',        // 채용·입찰 공고는 기사가 아님
];

const stripTags = (s) => String(s || '')
  .replace(/<!\[CDATA\[|\]\]>/g, '')
  .replace(/<[^>]*>/g, ' ')
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
  .replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
  .replace(/&nbsp;/g, ' ')
  .replace(/\s+/g, ' ')
  .trim();

const tag = (block, name) => {
  const m = block.match(new RegExp(`<${name}[^>]*>([\\s\\S]*?)</${name}>`, 'i'));
  return m ? stripTags(m[1]) : '';
};

/** 구글 뉴스 RSS 한 건 조회 */
async function fetchRss(query) {
  const url = 'https://news.google.com/rss/search'
    + `?q=${encodeURIComponent(query)}&hl=ko&gl=KR&ceid=KR:ko`;
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 12000);
  try {
    const res = await fetch(url, {
      signal: ctrl.signal,
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; ParkNews/1.0)' },
    });
    if (!res.ok) return [];
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
  } catch {
    return [];
  } finally {
    clearTimeout(t);
  }
}

/** 해당 날짜(KST)에 보도된 국립공원 기사만 모은다 */
async function collectArticles(targetDate) {
  const batches = await Promise.all(QUERIES.map(fetchRss));
  const seen = new Set();
  const out = [];

  for (const item of batches.flat()) {
    if (!item.title || !item.link) continue;

    const ts = Date.parse(item.pubDate);
    if (Number.isNaN(ts)) continue;
    if (ymd(toKst(new Date(ts))) !== targetDate) continue;      // 전날 보도만

    const low = item.title.toLowerCase();
    if (NOISE.some((n) => low.includes(n))) continue;
    if (!PARK_WORDS.some((w) => item.title.includes(w))) continue;

    const key = item.title.replace(/[^\p{L}\p{N}]/gu, '').slice(0, 40);
    if (seen.has(`${key}|${item.press}`)) continue;
    seen.add(`${key}|${item.press}`);

    out.push({ ...item, kst: new Date(ts + KST_OFFSET).toISOString() });
  }
  return out;
}

/* ==========================================================
 *  2. 같은 이슈 묶기  —  제목 토큰 유사도
 *     (한 사안을 여러 언론사가 보도하면 1개 항목 · 언론사 나열)
 * ======================================================== */
const STOP = new Set(['국립공원', '공원', '기사', '지난', '올해', '관련', '이날', '등의', '위해', '국립']);

/* 조사 제거 — '내장산서'/'국립공원에' 가 '내장산'/'국립공원' 과 묶이도록 */
const JOSA = /(에서|에게|으로|과의|와의|은|는|이|가|을|를|에|의|서|와|과|도|로)$/;
const norm = (w) => (w.length >= 3 ? w.replace(JOSA, '') : w);

function tokens(title) {
  return new Set(
    title.replace(/[^\p{L}\p{N}\s]/gu, ' ').split(/\s+/)
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

/**
 * 따옴표로 묶인 핵심어 추출 — 종명·프로그램명이 여기 들어간다.
 * 예) '대흥란', ‘진노랑상사화’
 * 두 기사가 각각 핵심어를 갖고 있는데 겹치지 않으면 다른 사안으로 본다.
 * (없으면 "내장산 멸종위기 야생생물 개화" 두 건이 종만 다른 채 합쳐진다)
 */
const KEY_RE = /[‘'"“]([^’'"”]{2,20})[’'"”]/g;
const keyEntities = (title) =>
  new Set([...title.matchAll(KEY_RE)].map((m) => m[1].trim()).filter(Boolean));

function groupByIssue(articles) {
  const groups = [];
  for (const art of articles) {
    const tk = tokens(art.title);
    const ky = keyEntities(art.title);

    const hit = groups.find((g) => {
      if (similarity(g.tokens, tk) < 0.5) return false;
      if (ky.size && g.keys.size && ![...ky].some((k) => g.keys.has(k))) return false;
      return true;
    });

    if (hit) {
      hit.articles.push(art);
      for (const t of tk) hit.tokens.add(t);
      for (const k of ky) hit.keys.add(k);
    } else {
      groups.push({ tokens: tk, keys: ky, articles: [art] });
    }
  }
  return groups
    .map((g) => ({
      titles: g.articles.map((a) => a.title),
      press: [...new Set(g.articles.map((a) => a.press))],
      links: g.articles.map((a) => a.link),
      reports: g.articles.length,           // 보도 건수 (언론사별 합계)
    }))
    .sort((a, b) => b.reports - a.reports);
}

/* ==========================================================
 *  3. 아카이브 저장소 (GitHub Contents API)
 *     GITHUB_TOKEN 미설정 시 조용히 건너뛰고 결과만 반환
 * ======================================================== */
const GH = {
  ok: () => Boolean(process.env.GITHUB_TOKEN && process.env.GITHUB_REPO),
  repo: () => process.env.GITHUB_REPO,
  branch: () => process.env.GITHUB_BRANCH || 'main',
  headers: () => ({
    Authorization: `Bearer ${process.env.GITHUB_TOKEN}`,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
  }),
};

async function ghRead(path) {
  if (!GH.ok()) return null;
  const url = `https://api.github.com/repos/${GH.repo()}/contents/${path}?ref=${GH.branch()}`;
  const res = await fetch(url, { headers: GH.headers() });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`GitHub read ${res.status}`);
  const j = await res.json();
  return { sha: j.sha, data: JSON.parse(Buffer.from(j.content, 'base64').toString('utf8')) };
}

async function ghWrite(path, data, message) {
  if (!GH.ok()) return false;
  const existing = await ghRead(path).catch(() => null);
  const url = `https://api.github.com/repos/${GH.repo()}/contents/${path}`;
  const res = await fetch(url, {
    method: 'PUT',
    headers: { ...GH.headers(), 'Content-Type': 'application/json' },
    body: JSON.stringify({
      message,
      branch: GH.branch(),
      content: Buffer.from(JSON.stringify(data, null, 2), 'utf8').toString('base64'),
      ...(existing?.sha ? { sha: existing.sha } : {}),
    }),
  });
  if (!res.ok) throw new Error(`GitHub write ${res.status}: ${await res.text()}`);
  return true;
}

const digestPath = (date) => `data/digest/${date}.json`;

async function loadDigest(date) {
  const hit = await ghRead(digestPath(date)).catch(() => null);
  return hit?.data || null;
}

async function saveDigest(date, digest) {
  await ghWrite(digestPath(date), digest, `일일기사요약 ${date}`);
  // 아카이브 목록 갱신
  const idx = (await ghRead('data/digest/index.json').catch(() => null))?.data || { dates: [] };
  if (!idx.dates.includes(date)) {
    idx.dates = [...idx.dates, date].sort().reverse().slice(0, 400);
    idx.updatedAt = new Date().toISOString();
    await ghWrite('data/digest/index.json', idx, `아카이브 목록 갱신 ${date}`);
  }
}

/* ==========================================================
 *  4. Claude 로 요약 생성
 * ======================================================== */
const SCHEMA = {
  type: 'object',
  properties: {
    items: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          press: { type: 'array', items: { type: 'string' } },
          title: { type: 'string' },
          summary: { type: 'string' },
          category: { type: 'string', enum: ['주요기사', '참고기사'] },
          reports: { type: 'integer' },
          links: { type: 'array', items: { type: 'string' } },
        },
        required: ['press', 'title', 'summary', 'category', 'reports', 'links'],
        additionalProperties: false,
      },
    },
    droppedAsDuplicate: { type: 'integer' },
    duplicateNotes: { type: 'array', items: { type: 'string' } },
  },
  required: ['items', 'droppedAsDuplicate', 'duplicateNotes'],
  additionalProperties: false,
};

const SYSTEM = `너는 국립공원공단 홍보실의 일일 언론 모니터링 담당자다.
전날 보도된 국립공원 관련 기사를 정리해 "오늘의 주요기사(요약)" 문서를 만든다.

[요약 문체 — 반드시 지킬 것]
· 1~2문장, 개조식 종결. 보도자료성 기사는 "~고 밝혀." / 일반 기사는 "~는 내용의 기사."로 끝낸다.
· 기관 발표 기사는 주체를 괄호와 함께 밝힌다. 예) 내장산국립공원(소장 한경동)은 ...
· 학명·급수 등 원문의 고유정보는 살린다. 예) 멸종위기 야생생물 Ⅱ급 대흥란(Cymbidium macrorhizon)
· 추측·논평·수식어를 넣지 않는다. 기사에 없는 사실을 지어내지 않는다.

[구분]
· 주요기사 = 국립공원공단/각 공원사무소의 정책·발표·현안, 공원 내 사건사고, 공원 지정·제도 변화
· 참고기사 = 공원과 간접적으로 얽힌 기후·산림·관광·환경 일반 기사

[중복 처리 — 매우 중요]
· 전날치(D-1)·전전날치(D-2) 요약본을 함께 준다. 같은 사안이 이미 실렸다면 그 항목은 제외한다.
· 다만 "같은 소재, 다른 공원"은 별개 사안이다.
  예) 27일 다도해해상 대흥란 / 28일 내장산 대흥란 → 둘 다 게재.
· 후속 보도라도 새로운 사실(수치·조치·결정)이 추가됐다면 게재하고, 요약에 그 진전을 드러낸다.
· 제외한 사안은 duplicateNotes에 "제목 — 제외 사유" 한 줄로 남긴다.

[선별]
· 중요도 순으로 정렬한다. 보도 언론사가 많은 사안일수록 통상 상위다.
· 주요기사를 먼저, 참고기사를 뒤에 배치한다.
· 최대 12개 항목. 남길 가치가 없는 단순 홍보성 중복 기사는 버린다.
· title은 대표 기사 제목을 그대로 쓰되 언론사명 접미사는 뗀다.
· press에는 그 사안을 보도한 언론사를 모두 나열한다.`;

async function summarize({ targetDate, groups, prev1, prev2 }) {
  const client = new Anthropic();   // ANTHROPIC_API_KEY 자동 사용

  const brief = (d, label) => {
    if (!d?.items?.length) return `[${label}] 없음`;
    return `[${label}] ${d.items.map((i) => `${i.title} (${i.press.join('/')})`).join(' | ')}`;
  };

  const payload = groups.slice(0, 40).map((g, i) => ({
    n: i + 1,
    titles: g.titles.slice(0, 6),
    press: g.press,
    reports: g.reports,
    links: g.links.slice(0, 6),
  }));

  /* 스트리밍으로 받는다 — 서버리스 함수의 HTTP 타임아웃을 피하기 위함 */
  const stream = client.messages.stream({
    model: 'claude-opus-5',
    max_tokens: 16000,
    system: SYSTEM,
    output_config: {
      // Vercel Hobby(60초)에서도 넉넉히 끝나도록 기본은 medium.
      // Pro 요금제라면 DIGEST_EFFORT=high 로 올리면 요약 품질이 더 좋아집니다.
      effort: process.env.DIGEST_EFFORT || 'medium',
      format: { type: 'json_schema', schema: SCHEMA },
    },
    messages: [{
      role: 'user',
      content:
        `${korean(targetDate)} 보도된 국립공원 관련 기사입니다. 요약본을 만들어 주세요.\n\n` +
        `── 중복 판정용 직전 요약본 ──\n${brief(prev1, '전날치')}\n${brief(prev2, '전전날치')}\n\n` +
        `── 수집 기사 (같은 사안끼리 묶어둔 상태) ──\n${JSON.stringify(payload, null, 1)}\n\n` +
        `links는 각 사안의 원문 URL이니 해당 항목의 links에 그대로 옮겨 주세요.`,
    }],
  });
  const response = await stream.finalMessage();

  if (response.stop_reason === 'refusal') {
    throw new Error(`요약 생성이 거부되었습니다 (${response.stop_details?.category || 'unknown'})`);
  }
  const text = response.content.find((b) => b.type === 'text')?.text;
  if (!text) throw new Error('요약 응답이 비어 있습니다');

  return { parsed: JSON.parse(text), usage: response.usage };
}

/* ==========================================================
 *  5. 핸들러
 * ======================================================== */
export default async function handler(req, res) {
  const now = toKst(new Date());
  const issueDate = String(req.query.date || ymd(now));        // 발행일
  const targetDate = addDays(issueDate, -1);                    // 수록 대상일 = 전날

  /* ---------- 조회 모드 ---------- */
  if (!req.query.generate && !req.query.cron) {
    if (req.query.list) {
      const idx = (await ghRead('data/digest/index.json').catch(() => null))?.data;
      res.setHeader('Cache-Control', 's-maxage=300, stale-while-revalidate=1800');
      return res.status(200).json(idx || { dates: [] });
    }
    const stored = await loadDigest(issueDate).catch(() => null);
    if (!stored) {
      return res.status(404).json({
        error: `${issueDate} 요약본이 아직 없습니다.`,
        hint: '매일 07:00(KST)에 자동 생성됩니다. 즉시 만들려면 ?generate=1&key=<CRON_SECRET>',
      });
    }
    res.setHeader('Cache-Control', 's-maxage=3600, stale-while-revalidate=86400');
    return res.status(200).json(stored);
  }

  /* ---------- 생성 모드 (크론 또는 수동) ---------- */
  const secret = process.env.CRON_SECRET;
  const authed = !secret
    || req.headers.authorization === `Bearer ${secret}`
    || req.query.key === secret;
  if (!authed) return res.status(401).json({ error: '인증 실패 (CRON_SECRET)' });

  if (!process.env.ANTHROPIC_API_KEY) {
    return res.status(501).json({ error: 'ANTHROPIC_API_KEY 미설정 — 요약을 생성할 수 없습니다.' });
  }

  try {
    const articles = await collectArticles(targetDate);
    if (!articles.length) {
      return res.status(200).json({
        issueDate, targetDate, items: [], totalReports: 0,
        note: `${targetDate} 보도된 국립공원 기사를 찾지 못했습니다.`,
      });
    }

    const groups = groupByIssue(articles);
    const [prev1, prev2] = await Promise.all([
      loadDigest(addDays(issueDate, -1)).catch(() => null),
      loadDigest(addDays(issueDate, -2)).catch(() => null),
    ]);

    const { parsed, usage } = await summarize({ targetDate, groups, prev1, prev2 });

    const items = parsed.items.map((it, i) => ({ no: i + 1, ...it }));
    const digest = {
      issueDate,
      issueDateKo: korean(issueDate),
      targetDate,
      targetDateKo: korean(targetDate),
      totalReports: items.reduce((s, it) => s + (it.reports || it.press.length || 1), 0),
      itemCount: items.length,
      collected: articles.length,
      droppedAsDuplicate: parsed.droppedAsDuplicate,
      duplicateNotes: parsed.duplicateNotes,
      items,
      generatedAt: new Date().toISOString(),
      usage: { input: usage.input_tokens, output: usage.output_tokens },
    };

    let archived = false;
    try { await saveDigest(issueDate, digest); archived = true; }
    catch (e) { digest.archiveError = String(e.message || e); }

    return res.status(200).json({ ...digest, archived });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: String(e.message || e) });
  }
}
