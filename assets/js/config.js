/* =============================================================
 *  config.js  —  전역 설정
 *  여기 값만 바꾸면 전체 시스템 동작이 달라집니다.
 * ============================================================= */

window.CONFIG = {
  /* -----------------------------------------------------------
   * 1) Mapbox 액세스 토큰
   *    https://account.mapbox.com/  에서 무료 발급 (월 50,000 로드)
   *    아래 'pk.여기에_토큰_붙여넣기' 부분만 교체하세요.
   *
   *    ※ 토큰을 넣지 않아도 사이트는 전부 동작합니다.
   *      → MapLibre + CARTO 다크 타일로 자동 전환 (키 불필요)
   *      → 토큰이 있으면 지구본 투영·안개 등 표현이 더 좋아집니다.
   * --------------------------------------------------------- */
  MAPBOX_TOKEN: 'pk.여기에_토큰_붙여넣기',

  /* 지도 초기 위치 — 시작은 국내(대한민국) 기준.
     실제로는 국내 공원 24곳이 모두 들어오도록 자동으로 화면을 맞추고,
     아래 값은 그 계산이 실패했을 때의 대비값입니다. */
  MAP_START: { center: [127.8, 36.3], zoom: 6.2, pitch: 0, bearing: 0 },

  /* 해외 탭으로 나갈 때 쓰는 전 세계 뷰 */
  WORLD_VIEW: { center: [30, 25], zoom: 1.6, pitch: 0, bearing: 0 },

  /* 스타일 */
  MAPBOX_STYLE: 'mapbox://styles/mapbox/dark-v11',

  /* -----------------------------------------------------------
   * 2) 뉴스 설정
   * --------------------------------------------------------- */
  NEWS_COUNT: 6,          // 지역당 표시할 기사 수
  NEWS_CACHE_MS: 10 * 60 * 1000,   // 10분 캐시

  /* CORS 우회용 무료 프록시 — /api/news 가 없을 때만 쓰는 폴백.
     2026-07-30 실측 기준 순서 (allorigins 계열만 안정적으로 응답):
       allorigins/raw 200 · allorigins/get 200 · codetabs 522 · corsproxy 403 */
  PROXIES: [
    (u) => `https://api.allorigins.win/raw?url=${encodeURIComponent(u)}`,
    (u) => `https://api.allorigins.win/get?url=${encodeURIComponent(u)}`,
    (u) => `https://corsproxy.io/?url=${encodeURIComponent(u)}`,
    (u) => `https://api.codetabs.com/v1/proxy?quest=${encodeURIComponent(u)}`,
  ],

  /* Vercel 서버리스 함수 사용 여부 (배포 후 네이버 API 키를 넣었다면 자동 사용)
     로컬에서 그냥 index.html 열었을 때는 실패 → 구글 RSS로 자동 폴백 */
  USE_SERVERLESS: true,

  /* -----------------------------------------------------------
   * 3) 색상 토큰 (CSS 변수와 동기화)
   * --------------------------------------------------------- */
  COLORS: {
    kr:     '#22d3ee',   // 국내 국립공원 - 시안
    global: '#a78bfa',   // 해외 국립공원 - 퍼플
    org:    '#fbbf24',   // 보전기관·연맹 - 앰버
  },
};
