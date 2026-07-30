/* =============================================================
 *  /api/news  —  뉴스 수집 서버리스 프록시
 *
 *  브라우저에서 구글 뉴스 RSS를 직접 부르면 CORS에 막혀서
 *  그동안 rss2json·allorigins 같은 무료 서드파티를 경유했는데,
 *  이들이 수시로 죽습니다 (실측: rss2json 422, allorigins/codetabs 522).
 *
 *  서버에서는 CORS가 없으므로 구글 뉴스 RSS를 그대로 가져올 수 있습니다.
 *  이 엔드포인트가 프론트의 1순위 경로이고, 서드파티는 폴백으로만 남깁니다.
 *
 *  GET /api/news?q=국립공원&lang=ko&limit=40
 *    → { items: [{ title, press, link, date, summary }], count, source }
 * ============================================================= */

const UA = 'Mozilla/5.0 (compatible; ParkWatch/1.0; +https://parknews.vercel.app)';

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

function parseRss(xml, limit) {
  const out = [];
  for (const m of xml.matchAll(/<item>([\s\S]*?)<\/item>/g)) {
    const b = m[1];
    const raw = tag(b, 'title');
    if (!raw) continue;

    // 구글 뉴스 제목은 "기사제목 - 언론사" 형태
    const hit = raw.match(/^(.*)\s+-\s+([^-]{2,40})$/);
    const summary = stripTags(tag(b, 'description'));

    out.push({
      title: (hit ? hit[1] : raw).trim(),
      press: (hit ? hit[2] : (tag(b, 'source') || '뉴스')).trim(),
      link: tag(b, 'link'),
      date: tag(b, 'pubDate'),
      // 검색 피드의 description 은 링크 하나뿐이라 요약으로 쓸 수 없다
      summary: /^https?:\/\//.test(summary) || summary.length < 15 ? '' : summary.slice(0, 180),
    });
    if (out.length >= limit) break;
  }
  return out;
}

export default async function handler(req, res) {
  const q = String(req.query.q || '').slice(0, 120).trim();
  const lang = req.query.lang === 'en' ? 'en' : 'ko';
  const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 30, 1), 100);

  if (!q) return res.status(400).json({ error: 'q 파라미터가 필요합니다' });

  const loc = lang === 'ko' ? 'hl=ko&gl=KR&ceid=KR:ko' : 'hl=en-US&gl=US&ceid=US:en';
  const mkt = lang === 'ko' ? '&setmkt=ko-KR' : '';

  /* 상위 소스를 순서대로 시도 — 한 곳이 죽어도 뉴스가 끊기지 않게.
     (실측: 구글 100건, Bing 12건 응답 확인) */
  const SOURCES = [
    { name: 'google-news-rss',
      url: `https://news.google.com/rss/search?q=${encodeURIComponent(q)}&${loc}` },
    { name: 'bing-news-rss',
      url: `https://www.bing.com/news/search?q=${encodeURIComponent(q)}&format=RSS${mkt}` },
  ];

  const errors = [];
  for (const src of SOURCES) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 11000);
    try {
      const r = await fetch(src.url, {
        signal: ctrl.signal,
        headers: { 'User-Agent': UA, Accept: 'application/rss+xml, application/xml, text/xml' },
      });
      if (!r.ok) { errors.push(`${src.name}:${r.status}`); continue; }

      const items = parseRss(await r.text(), limit);
      if (!items.length) { errors.push(`${src.name}:empty`); continue; }

      // 같은 질의는 5분간 CDN 캐시 — 여러 사용자가 눌러도 원본에 한 번만 나감
      res.setHeader('Cache-Control', 's-maxage=300, stale-while-revalidate=1800');
      return res.status(200).json({ items, count: items.length, source: src.name });
    } catch (e) {
      errors.push(`${src.name}:${e?.name === 'AbortError' ? 'timeout' : 'err'}`);
    } finally {
      clearTimeout(timer);
    }
  }

  return res.status(502).json({ error: '모든 뉴스 소스 실패', tried: errors });
}
