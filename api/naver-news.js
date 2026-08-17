/* =============================================================
 *  /api/naver-news   (Vercel Serverless Function · 선택사항)
 *
 *  네이버 검색 API를 서버에서 대신 호출합니다.
 *  → API 키가 브라우저에 노출되지 않고, CORS 문제도 없습니다.
 *
 *  사용하려면 Vercel 프로젝트 설정 → Environment Variables 에 등록:
 *      NAVER_CLIENT_ID       = 발급받은 Client ID
 *      NAVER_CLIENT_SECRET   = 발급받은 Client Secret
 *
 *  등록하지 않으면 501을 반환하고, 프론트엔드가 자동으로
 *  구글 뉴스 RSS 경로로 폴백합니다. (사이트는 정상 동작)
 * ============================================================= */

export default async function handler(req, res) {
  const ID = process.env.NAVER_CLIENT_ID;
  const SECRET = process.env.NAVER_CLIENT_SECRET;

  if (!ID || !SECRET) {
    return res.status(501).json({ error: 'NAVER_CLIENT_ID / NAVER_CLIENT_SECRET 미설정' });
  }

  const query = String(req.query.query || '').slice(0, 100);
  if (!query) return res.status(400).json({ error: 'query 파라미터가 필요합니다' });

  /* 네이버 검색은 한 질의당 display 100건 · start 1000까지 페이지를 넘길 수 있다.
     → 한 검색어로 최대 1,000건까지 과거로 거슬러 모을 수 있어
       데이터셋을 만들 때 이 두 값을 쓴다. (화면은 기본값 6건만 쓴다) */
  const display = Math.min(Math.max(parseInt(req.query.display, 10) || 6, 1), 100);
  const start = Math.min(Math.max(parseInt(req.query.start, 10) || 1, 1), 1000);
  const sort = req.query.sort === 'sim' ? 'sim' : 'date';

  const qs = `?query=${encodeURIComponent(query)}&display=${display}&start=${start}&sort=${sort}`;

  /* 키를 어디서 발급받았느냐에 따라 부르는 곳과 헤더가 다르다.
       · 개발자센터(developers.naver.com) → openapi.naver.com + X-Naver-*
       · API 허브(NAVER Cloud Platform)   → naveropenapi.apigw.ntruss.com + X-NCP-*
     발급처를 사용자가 알기 어려워 둘 다 시도하고 되는 쪽을 쓴다. */
  const ROUTES = [
    { name: 'developers',
      url: `https://openapi.naver.com/v1/search/news.json${qs}`,
      headers: { 'X-Naver-Client-Id': ID, 'X-Naver-Client-Secret': SECRET } },
    { name: 'apihub',
      url: `https://naverapihub.apigw.ntruss.com/search/v1/news${qs}&format=json`,
      headers: { 'X-NCP-APIGW-API-KEY-ID': ID, 'X-NCP-APIGW-API-KEY': SECRET } },
  ];

  const tried = [];
  for (const route of ROUTES) {
    try {
      const r = await fetch(route.url, { headers: route.headers });
      if (r.ok) {
        const data = await r.json();
        // 5분 CDN 캐시 → 무료 호출량 절약
        res.setHeader('Cache-Control', 's-maxage=300, stale-while-revalidate=600');
        return res.status(200).json({ ...data, via: route.name });
      }
      tried.push(`${route.name}:${r.status}`);
    } catch (e) {
      tried.push(`${route.name}:${e?.name || 'err'}`);
    }
  }
  return res.status(502).json({
    error: '네이버 검색 API 호출 실패 — 키가 맞는지 확인해 주세요',
    tried,
  });
}
