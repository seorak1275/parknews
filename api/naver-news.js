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
  const display = Math.min(Math.max(parseInt(req.query.display, 10) || 6, 1), 20);
  if (!query) return res.status(400).json({ error: 'query 파라미터가 필요합니다' });

  const url = 'https://openapi.naver.com/v1/search/news.json'
    + `?query=${encodeURIComponent(query)}&display=${display}&sort=date`;

  try {
    const r = await fetch(url, {
      headers: { 'X-Naver-Client-Id': ID, 'X-Naver-Client-Secret': SECRET },
    });
    if (!r.ok) {
      return res.status(r.status).json({ error: `네이버 API 오류 (${r.status})` });
    }
    const data = await r.json();
    // 5분 CDN 캐시 → 무료 호출량 절약
    res.setHeader('Cache-Control', 's-maxage=300, stale-while-revalidate=600');
    return res.status(200).json(data);
  } catch (e) {
    return res.status(502).json({ error: String(e.message || e) });
  }
}
