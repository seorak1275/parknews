/* =============================================================
 *  /api/datalab   (Vercel Serverless Function · 선택사항)
 *
 *  네이버 데이터랩 "통합 검색어 트렌드" API를 서버에서 호출합니다.
 *  → 사이드바의 검색 관심도 차트가 시뮬레이션 대신 실측값으로 바뀝니다.
 *
 *  Vercel → Environment Variables:
 *      NAVER_CLIENT_ID
 *      NAVER_CLIENT_SECRET
 *  ※ 데이터랩은 네이버 개발자센터에서 "데이터랩(검색어트렌드)" 이용 신청이
 *    별도로 필요합니다. 미신청 상태면 401/403이 오고 프론트는 자동 폴백합니다.
 * ============================================================= */

const ymd = (d) => d.toISOString().slice(0, 10);

export default async function handler(req, res) {
  const ID = process.env.NAVER_CLIENT_ID;
  const SECRET = process.env.NAVER_CLIENT_SECRET;

  if (!ID || !SECRET) {
    return res.status(501).json({ error: 'NAVER_CLIENT_ID / NAVER_CLIENT_SECRET 미설정' });
  }

  const keyword = String(req.query.keyword || '').slice(0, 40);
  const days = Math.min(Math.max(parseInt(req.query.days, 10) || 14, 7), 90);
  if (!keyword) return res.status(400).json({ error: 'keyword 파라미터가 필요합니다' });

  // 데이터랩은 당일 데이터를 제공하지 않으므로 어제까지로 요청
  const end = new Date(Date.now() - 86400000);
  const start = new Date(end.getTime() - (days - 1) * 86400000);

  const body = {
    startDate: ymd(start),
    endDate: ymd(end),
    timeUnit: 'date',
    keywordGroups: [{ groupName: keyword, keywords: [keyword] }],
  };

  try {
    const r = await fetch('https://openapi.naver.com/v1/datalab/search', {
      method: 'POST',
      headers: {
        'X-Naver-Client-Id': ID,
        'X-Naver-Client-Secret': SECRET,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });
    if (!r.ok) {
      return res.status(r.status).json({ error: `데이터랩 API 오류 (${r.status})` });
    }
    const data = await r.json();
    res.setHeader('Cache-Control', 's-maxage=3600, stale-while-revalidate=7200');
    return res.status(200).json(data);
  } catch (e) {
    return res.status(502).json({ error: String(e.message || e) });
  }
}
