/* =============================================================
 *  app.js  —  메인 애플리케이션
 *
 *  지도 구성
 *   · 국내 24곳  → DOM 마커 + 공식 경계 폴리곤(parks-kr.geojson)
 *   · 해외 2,600여 곳 → GeoJSON 클러스터 레이어 (탐색기 선택에 따라 갱신)
 *   · 정책·관문 도시 → DOM 마커
 * ============================================================= */

(() => {
  'use strict';

  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => [...r.querySelectorAll(s)];
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  const state = {
    gl: null, map: null, engine: 'maplibre',
    markers: new Map(),        // id -> { marker, el, region }  (국내 공원 + 보전기관)
    active: null,
    showBounds: true,
    mono: false,
    light: false,              // 밝은 지도 (CARTO Positron)
    popup: null,
    globalShown: [],           // 현재 지도에 뿌린 해외 공원
  };

  const CAT_LABEL = { kr: '국내 국립공원', global: '해외 국립공원', org: '보전기관·연맹' };

  /** 해외 공원 객체를 뉴스/차트가 쓰는 region 형태로 정규화 */
  function asRegion(p) {
    if (p.cat) return p;                      // 이미 region (국내/도시)

    /* 검색어 다듬기 —
       OSM 이름은 'Parc national de la Vanoise' / 'อุทยานแห่งชาติ…' 처럼 제각각이라
       영문명이 있으면 그걸 쓰고, 'national park' 이 없으면 붙여 준다.
       그래야 국립공원 관련도 필터(공원 문맥어 필수)를 통과한다. */
    const base = p.nameEn || p.name;
    const hasNP = /national\s*park|parc\s*national|nationalpark|국립공원/i.test(base);
    const country = p.country && !hasNP ? ` ${p.country}` : '';
    const q = hasNP ? base : `${base} national park${country}`;

    return {
      ...p,
      cat: 'global',
      q,
      lang: 'en',
      desc: p.desc || `${p.countryKo || p.country} · ${p.subregionKo || ''}`.replace(/ · $/, ''),
    };
  }

  /** 공식 홈페이지 URL (국내는 PARK_SITES, 해외는 OSM website 태그) */
  const siteOf = (region) =>
    (window.PARK_SITES && PARK_SITES[region.id]) || region.site || null;

  const prettyUrl = (u) => {
    try {
      const x = new URL(u);
      return (x.hostname + x.pathname).replace(/^www\./, '').replace(/\/$/, '');
    } catch { return u; }
  };

  /* ==========================================================
   *  0. 로더
   * ======================================================== */
  const loadScript = (src) => new Promise((ok, no) => {
    const s = document.createElement('script');
    s.src = src; s.async = true;
    s.onload = ok; s.onerror = () => no(new Error('load fail: ' + src));
    document.head.appendChild(s);
  });
  const loadCss = (href) => new Promise((ok) => {
    const l = document.createElement('link');
    l.rel = 'stylesheet'; l.href = href;
    l.onload = ok; l.onerror = ok;
    document.head.appendChild(l);
  });

  const hasToken = () => {
    const t = (CONFIG.MAPBOX_TOKEN || '').trim();
    return t.startsWith('pk.') && !t.includes('여기에') && t.length > 40;
  };

  /* 다크(기본)·라이트 타일을 한 스타일에 모두 실어 두고
     가시성만 전환한다 — setStyle 과 달리 커스텀 레이어가 유지되고 즉시 바뀐다.
     visibility:none 인 레이어는 타일을 요청하지 않으므로 트래픽 낭비도 없다. */
  const cartoTiles = (kind) => ['a', 'b', 'c', 'd'].map((s) =>
    `https://${s}.basemaps.cartocdn.com/${kind}/{z}/{x}/{y}@2x.png`);

  const FALLBACK_STYLE = {
    version: 8,
    sources: {
      'carto-dark': {
        type: 'raster', tiles: cartoTiles('dark_all'), tileSize: 256,
        attribution: '© OpenStreetMap contributors © CARTO',
      },
      'carto-light': {
        type: 'raster', tiles: cartoTiles('light_all'), tileSize: 256,
        attribution: '© OpenStreetMap contributors © CARTO',
      },
    },
    layers: [
      { id: 'bg', type: 'background', paint: { 'background-color': '#080b13' } },
      { id: 'carto-dark', type: 'raster', source: 'carto-dark', paint: { 'raster-opacity': 0.95 } },
      { id: 'carto-light', type: 'raster', source: 'carto-light',
        layout: { visibility: 'none' }, paint: { 'raster-opacity': 1 } },
    ],
  };

  /* ==========================================================
   *  1. 지도 초기화
   * ======================================================== */
  async function initMap() {
    const boot = $('#boot-status');

    boot.textContent = '지도 엔진 로딩 중…';
    if (hasToken()) {
      await loadCss('https://api.mapbox.com/mapbox-gl-js/v3.9.0/mapbox-gl.css');
      await loadScript('https://api.mapbox.com/mapbox-gl-js/v3.9.0/mapbox-gl.js');
      state.gl = window.mapboxgl;
      state.gl.accessToken = CONFIG.MAPBOX_TOKEN.trim();
      state.engine = 'mapbox';
    } else {
      await loadCss('https://unpkg.com/maplibre-gl@4.7.1/dist/maplibre-gl.css');
      await loadScript('https://unpkg.com/maplibre-gl@4.7.1/dist/maplibre-gl.js');
      state.gl = window.maplibregl;
      state.engine = 'maplibre';
    }

    const { center, zoom, pitch, bearing } = CONFIG.MAP_START;
    state.map = new state.gl.Map({
      container: 'map',
      style: state.engine === 'mapbox' ? CONFIG.MAPBOX_STYLE : FALLBACK_STYLE,
      center, zoom, pitch, bearing,
      attributionControl: false,
      projection: state.engine === 'mapbox' ? 'globe' : undefined,
    });

    state.map.addControl(new state.gl.NavigationControl({ visualizePitch: true }), 'bottom-right');
    state.map.addControl(new state.gl.AttributionControl({ compact: true }), 'bottom-left');
    state.map.scrollZoom.setWheelZoomRate(1 / 380);

    state.popup = new state.gl.Popup({
      closeButton: false, closeOnClick: false,
      offset: 20, className: 'hover-pop', maxWidth: '300px',
    });

    await new Promise((r) => state.map.on('load', r));

    if (state.engine === 'mapbox') {
      try {
        state.map.setFog({
          color: 'rgb(12,16,26)', 'high-color': 'rgb(24,40,72)',
          'horizon-blend': 0.06, 'space-color': 'rgb(4,6,12)', 'star-intensity': 0.5,
        });
      } catch { /* 스타일 미지원 */ }
    }

    addGlobalLayer();
    await addBoundaryLayer();
    addMarkers();

    /* 첫 화면 = 국내 국립공원 24곳이 모두 들어오는 범위.
       부팅 오버레이가 걷히기 전에 잡아 두어 화면이 튀지 않게 합니다. */
    fitTo(REGIONS_KR, { duration: 0, maxZoom: 8, pitch: 40 });

    boot.textContent = '';
    $('#boot').classList.add('is-done');
    setTimeout(() => $('#boot')?.remove(), 700);
  }

  function firstSymbolLayerId() {
    const layers = state.map.getStyle().layers || [];
    return layers.find((x) => x.type === 'symbol')?.id;
  }

  /* ==========================================================
   *  3. 국내 공원 경계 폴리곤 (환경부 공식 경계도)
   * ======================================================== */
  async function addBoundaryLayer() {
    let fc;
    try {
      const res = await fetch('assets/data/parks-kr.geojson');
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      fc = await res.json();
    } catch (e) {
      console.warn('경계 데이터 로드 실패:', e);
      $('#toggle-bounds').disabled = true;
      return;
    }

    state.map.addSource('kr-bounds', { type: 'geojson', data: fc });

    state.map.addLayer({
      id: 'kr-bounds-fill', type: 'fill', source: 'kr-bounds',
      layout: { visibility: state.showBounds ? 'visible' : 'none' },
      paint: {
        'fill-color': CONFIG.COLORS.kr,
        'fill-opacity': ['interpolate', ['linear'], ['zoom'], 4, 0.10, 8, 0.16, 12, 0.09],
      },
    }, firstSymbolLayerId());

    state.map.addLayer({
      id: 'kr-bounds-line', type: 'line', source: 'kr-bounds',
      layout: { visibility: state.showBounds ? 'visible' : 'none', 'line-join': 'round' },
      paint: {
        'line-color': CONFIG.COLORS.kr,
        'line-width': ['interpolate', ['linear'], ['zoom'], 4, 0.6, 9, 1.6, 14, 2.6],
        'line-opacity': 0.75,
      },
    }, firstSymbolLayerId());

    /* 경계 클릭 → 해당 공원 열기 */
    state.map.on('click', 'kr-bounds-fill', (e) => {
      const id = e.features?.[0]?.properties?.id;
      const r = REGIONS_KR.find((x) => x.id === id);
      if (r) select(r);
    });
    state.map.on('mouseenter', 'kr-bounds-fill', () => { state.map.getCanvas().style.cursor = 'pointer'; });
    state.map.on('mouseleave', 'kr-bounds-fill', () => { state.map.getCanvas().style.cursor = ''; });
  }

  /* ==========================================================
   *  4. 해외 공원 — 클러스터 레이어
   *     2,600점을 DOM 마커로 찍으면 브라우저가 죽습니다.
   *     GeoJSON 소스의 네이티브 클러스터링을 씁니다.
   * ======================================================== */
  const EMPTY_FC = { type: 'FeatureCollection', features: [] };

  function addGlobalLayer() {
    state.map.addSource('global-parks', {
      type: 'geojson', data: EMPTY_FC,
      cluster: true, clusterRadius: 46, clusterMaxZoom: 9,
    });

    state.map.addLayer({
      id: 'gp-cluster', type: 'circle', source: 'global-parks',
      filter: ['has', 'point_count'],
      paint: {
        'circle-color': CONFIG.COLORS.global,
        'circle-opacity': 0.24,
        'circle-radius': ['step', ['get', 'point_count'], 15, 10, 20, 50, 26, 200, 34],
        'circle-stroke-width': 1.5,
        'circle-stroke-color': CONFIG.COLORS.global,
        'circle-stroke-opacity': 0.85,
      },
    });

    state.map.addLayer({
      id: 'gp-count', type: 'symbol', source: 'global-parks',
      filter: ['has', 'point_count'],
      layout: {
        'text-field': ['get', 'point_count_abbreviated'],
        'text-size': 12, 'text-font': ['Open Sans Bold', 'Arial Unicode MS Bold'],
        'text-allow-overlap': true,
      },
      paint: { 'text-color': '#ffffff' },
    });

    state.map.addLayer({
      id: 'gp-point', type: 'circle', source: 'global-parks',
      filter: ['!', ['has', 'point_count']],
      paint: {
        'circle-color': CONFIG.COLORS.global,
        'circle-radius': ['interpolate', ['linear'], ['zoom'], 3, 3.5, 8, 6, 13, 9],
        'circle-stroke-width': 1.6,
        'circle-stroke-color': 'rgba(8,11,19,.9)',
      },
    });

    state.map.addLayer({
      id: 'gp-label', type: 'symbol', source: 'global-parks',
      filter: ['!', ['has', 'point_count']], minzoom: 6,
      layout: {
        'text-field': ['get', 'name'], 'text-size': 11,
        'text-offset': [0, 1.1], 'text-anchor': 'top',
        'text-font': ['Open Sans Regular', 'Arial Unicode MS Regular'],
      },
      paint: {
        'text-color': 'rgba(255,255,255,.92)',
        'text-halo-color': 'rgba(0,0,0,.85)', 'text-halo-width': 1.4,
      },
    });

    /* 클러스터 클릭 → 확대 */
    state.map.on('click', 'gp-cluster', (e) => {
      const f = e.features[0];
      state.map.getSource('global-parks').getClusterExpansionZoom(
        f.properties.cluster_id,
        (err, zoom) => {
          if (err) return;
          state.map.easeTo({ center: f.geometry.coordinates, zoom: zoom + 0.4, duration: 650 });
        }
      );
    });

    /* 선택된 해외 공원 강조 링 */
    state.map.addLayer({
      id: 'gp-active', type: 'circle', source: 'global-parks',
      filter: ['==', ['get', 'id'], '__none__'],
      paint: {
        'circle-radius': ['interpolate', ['linear'], ['zoom'], 3, 8, 8, 13, 13, 18],
        'circle-color': 'rgba(0,0,0,0)',
        'circle-stroke-width': 2.5,
        'circle-stroke-color': CONFIG.COLORS.global,
        'circle-stroke-opacity': 0.95,
      },
    });

    /* 개별 공원 클릭 → 사이드바 */
    state.map.on('click', 'gp-point', (e) => {
      const id = e.features?.[0]?.properties?.id;
      const p = Explorer.parkById(id);
      if (p) select(asRegion(p));
    });

    /* 호버 미니 팝업 (국내 마커와 동일한 경험) */
    let hoverId = null;
    state.map.on('mousemove', 'gp-point', (e) => {
      const f = e.features?.[0];
      if (!f) return;
      const id = f.properties.id;
      if (id === hoverId) return;
      hoverId = id;
      const p = Explorer.parkById(id);
      if (p) showHover(asRegion(p));
    });
    state.map.on('mouseleave', 'gp-point', () => {
      hoverId = null;
      state.popup.remove();
    });

    for (const id of ['gp-cluster', 'gp-point']) {
      state.map.on('mouseenter', id, () => { state.map.getCanvas().style.cursor = 'pointer'; });
      state.map.on('mouseleave', id, () => { state.map.getCanvas().style.cursor = ''; });
    }
  }

  /** 탐색기에서 고른 범위를 지도에 반영 */
  function showGlobal(parks) {
    state.globalShown = parks;
    const src = state.map?.getSource('global-parks');
    if (!src) return;

    src.setData({
      type: 'FeatureCollection',
      features: parks.map((p) => ({
        type: 'Feature',
        properties: { id: p.id, name: p.name, country: p.countryKo || p.country },
        geometry: { type: 'Point', coordinates: [p.lng, p.lat] },
      })),
    });

    $('#stat-points').textContent = parks.length.toLocaleString();
  }

  /** 좌측 패널·사이드바를 피한 여백 (화면 폭에 따라 조정) */
  function fitPadding() {
    const narrow = window.innerWidth <= 860;
    return {
      top: narrow ? 90 : 120,
      bottom: narrow ? 70 : 90,
      left: narrow ? 24 : 306,
      right: narrow ? 24 : 80,
    };
  }

  /** 보이는 지점들이 다 들어오도록 화면 맞추기 */
  function fitTo(points, opts = {}) {
    if (!points?.length || !state.map) return;
    const { duration = 900, maxZoom = 9, pitch } = opts;

    if (points.length === 1) {
      state.map.flyTo({
        center: [points[0].lng, points[0].lat],
        zoom: 8.5, pitch: pitch ?? 45, duration, essential: true,
      });
      return;
    }
    const b = new state.gl.LngLatBounds();
    for (const p of points) b.extend([p.lng, p.lat]);
    state.map.fitBounds(b, {
      padding: fitPadding(), duration, maxZoom, essential: true,
      ...(pitch !== undefined ? { pitch } : {}),
    });
  }

  const flyWorld = (duration = 1100) =>
    state.map?.flyTo({ ...CONFIG.WORLD_VIEW, duration, essential: true });

  /** 탭(국내/해외/기관)에 해당하는 기본 화면으로 이동 */
  function frameScope(scope, duration = 900) {
    if (scope === 'kr') return fitTo(REGIONS_KR, { duration, maxZoom: 8, pitch: 40 });
    if (scope === 'org') return fitTo(REGIONS_ORG, { duration, maxZoom: 4, pitch: 20 });
    return flyWorld(duration);
  }

  /* ==========================================================
   *  5. DOM 마커 (국내 24 + 도시)
   * ======================================================== */
  function addMarkers() {
    for (const region of [...REGIONS_KR, ...REGIONS_ORG]) {
      const el = document.createElement('div');
      el.className = `mk mk--${region.cat}`;
      el.innerHTML = `
        <span class="mk__pulse"></span>
        <span class="mk__dot"></span>
        <span class="mk__label">${esc(region.name)}</span>`;

      el.addEventListener('mouseenter', () => showHover(region));
      el.addEventListener('mouseleave', () => state.popup.remove());
      el.addEventListener('click', (e) => { e.stopPropagation(); select(region); });

      const marker = new state.gl.Marker({ element: el, anchor: 'center' })
        .setLngLat([region.lng, region.lat])
        .addTo(state.map);

      state.markers.set(region.id, { marker, el, region });
    }
    applyVisibility();
  }

  /** 현재 탭(국내/해외/기관)에 맞춰 마커·경계 표시 */
  function applyVisibility() {
    const scope = Explorer.scope;          // 'kr' | 'global' | 'org'
    let shown = 0;
    for (const { el, region } of state.markers.values()) {
      const on = (scope === 'kr' && region.cat === 'kr')
              || (scope === 'org' && region.cat === 'org');
      el.style.display = on ? '' : 'none';
      if (on) shown++;
    }
    if (scope !== 'global') {
      showGlobal([]);
      $('#stat-points').textContent = shown.toLocaleString();
    }
    for (const id of ['kr-bounds-fill', 'kr-bounds-line']) {
      if (state.map?.getLayer(id)) {
        state.map.setLayoutProperty(id, 'visibility',
          (scope === 'kr' && state.showBounds) ? 'visible' : 'none');
      }
    }
  }

  /* ---------- 호버 팝업 ---------- */
  function hoverHtml(region, items) {
    const url = siteOf(region);
    const head = items?.length
      ? `<p class="hp__head">${esc(items[0].title)}</p>
         <p class="hp__meta">${esc(items[0].press)} · ${esc(NewsService.timeAgo(items[0].date))}</p>`
      : Array.isArray(items)
        ? `<p class="hp__none">최근 국립공원 관련 기사가 없습니다</p>`
        : `<p class="hp__loading"><span class="dots"><i></i><i></i><i></i></span> 뉴스 불러오는 중…</p>`;

    const siteHtml = url
      ? `<div class="hp__site">${GLOBE_ICON}<span>${esc(prettyUrl(url))}</span></div>`
      : '';

    return `
      <div class="hp hp--${region.cat}">
        <div class="hp__top">
          <span class="hp__cat">${CAT_LABEL[region.cat]}</span>
          <h4>${esc(region.name)}</h4>
        </div>
        ${siteHtml}
        <div class="hp__news">${head}</div>
        <div class="hp__cta">클릭하면 상세 브리핑 →</div>
      </div>`;
  }

  function showHover(region) {
    const cached = NewsService.peek(region);
    state.popup.setLngLat([region.lng, region.lat])
      .setHTML(hoverHtml(region, cached?.items))
      .addTo(state.map);

    if (!cached) {
      NewsService.load(region).then((d) => {
        if (state.popup.isOpen()) state.popup.setHTML(hoverHtml(region, d.items));
      }).catch(() => {
        if (state.popup.isOpen()) {
          state.popup.setHTML(hoverHtml(region, [{ title: '뉴스를 불러오지 못했습니다', press: '네트워크', date: '' }]));
        }
      });
    }
  }

  /* ==========================================================
   *  6. 사이드바
   * ======================================================== */
  const openSidebar = () => { $('#sidebar').classList.add('is-open'); $('#sb-toggle').classList.add('is-open'); };
  const closeSidebar = () => { $('#sidebar').classList.remove('is-open'); $('#sb-toggle').classList.remove('is-open'); TrendChart.destroy(); };

  function select(regionLike) {
    const region = asRegion(regionLike);
    state.active = region;
    state.popup.remove();

    $$('.mk').forEach((e) => e.classList.remove('is-active'));
    state.markers.get(region.id)?.el.classList.add('is-active');
    if (state.map?.getLayer('gp-active')) {
      state.map.setFilter('gp-active',
        ['==', ['get', 'id'], region.cat === 'global' ? region.id : '__none__']);
    }

    state.map.flyTo({
      center: [region.lng, region.lat],
      zoom: region.cat === 'city' ? 11 : 9.2,
      pitch: 52, bearing: -14, speed: 0.85, curve: 1.5, essential: true,
    });

    renderSidebar(region);
    openSidebar();
    state.onPickMobileClose?.();   // 모바일: 탐색 시트를 닫아 상세가 온전히 보이게
  }

  function renderSidebar(region) {
    $('#sb-body').innerHTML = `
      <div class="sb-hero sb-hero--${region.cat}">
        <span class="chip chip--${region.cat}">${CAT_LABEL[region.cat]}</span>
        <h2>${esc(region.name)}</h2>
        ${region.nameEn && region.nameEn !== region.name ? `<p class="sb-en">${esc(region.nameEn)}</p>` : ''}
        <p class="muted">${esc(region.desc || '')}</p>
        <p class="coords">${region.lat.toFixed(4)}°, ${region.lng.toFixed(4)}° · 검색어 “${esc(region.q || region.name)}”</p>
      </div>

      <section class="sb-card">
        <h3 class="sb-h">공식 홈페이지</h3>
        <div id="site-body"></div>
      </section>

      <section class="sb-card">
        <div class="sb-h-row">
          <h3 class="sb-h">검색 관심도 추이 · 최근 14일</h3>
          <span class="badge" id="trend-badge">불러오는 중</span>
        </div>
        <div class="chart-wrap"><canvas id="trend-canvas"></canvas></div>
        <p class="axis-note">값은 기간 내 최댓값을 100으로 환산한 상대 지수입니다.</p>
      </section>

      <section class="sb-card">
        <h3 class="sb-h">헤드라인 키워드</h3>
        <div id="kw-body" class="kw-body"><p class="muted sm">기사 분석 중…</p></div>
      </section>

      <section class="sb-card">
        <div class="sb-h-row">
          <h3 class="sb-h">국립공원 관련 최신 뉴스</h3>
          <button class="linkbtn" id="btn-refresh">새로고침</button>
        </div>
        <p class="filter-note" id="filter-note">수집한 기사 중 국립공원 관련 기사만 선별합니다.</p>
        <ul id="news-body" class="news-list">${'<li class="news-skel"></li>'.repeat(4)}</ul>
      </section>`;

    renderSite(region);
    TrendChart.render($('#trend-canvas'), region, $('#trend-badge'))
      .catch(() => { $('#trend-badge').textContent = '데이터 없음'; });

    const fill = ({ items, raw, dropped }) => {
      $('#filter-note').innerHTML = items.length
        ? `수집 <b>${raw}</b>건 중 국립공원 관련 <b>${items.length}</b>건만 표시 · 무관 기사 ${dropped}건 제외`
        : `수집 <b>${raw}</b>건 모두 국립공원과 무관해 제외했습니다.`;

      $('#news-body').innerHTML = items.length
        ? items.map((n) => `
          <li class="news-item">
            <a href="${esc(n.link)}" target="_blank" rel="noopener noreferrer">
              <p class="news-title">${esc(n.title)}</p>
              ${n.summary ? `<p class="news-sum">${esc(n.summary)}</p>` : ''}
              <p class="news-meta"><span class="press">${esc(n.press)}</span>${n.date ? ` · ${esc(NewsService.timeAgo(n.date))}` : ''}</p>
            </a>
          </li>`).join('')
        : `<li class="empty-news">최근 이 지역의 <b>국립공원 관련</b> 기사가 없습니다.
             <span class="sm muted">공원과 무관한 기사는 의도적으로 제외됩니다.</span></li>`;

      KeywordBars.render($('#kw-body'), items);
    };

    NewsService.load(region).then(fill).catch(() => {
      $('#filter-note').textContent = '';
      $('#news-body').innerHTML =
        `<li class="err">뉴스를 불러오지 못했습니다.<br><span class="sm muted">CORS 프록시가 일시적으로 응답하지 않을 수 있습니다.</span></li>`;
      $('#kw-body').innerHTML = '<p class="muted sm">-</p>';
    });

    $('#btn-refresh').addEventListener('click', () => {
      $('#news-body').innerHTML = '<li class="news-skel"></li>'.repeat(4);
      NewsService.load(region, true).then(fill)
        .catch(() => { $('#news-body').innerHTML = '<li class="err">재시도 실패</li>'; });
    });
  }

  const GLOBE_ICON = `<svg viewBox="0 0 24 24" width="17" height="17" aria-hidden="true"><circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" stroke-width="1.8"/><path d="M3 12h18M12 3c2.6 2.6 2.6 15 0 18M12 3c-2.6 2.6-2.6 15 0 18" fill="none" stroke="currentColor" stroke-width="1.6"/></svg>`;
  const OUT_ICON = `<svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true"><path d="M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 01-1 1H5a1 1 0 01-1-1V7a1 1 0 011-1h5" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"/></svg>`;

  function renderSite(region) {
    const box = $('#site-body');
    if (!box) return;

    const url = siteOf(region);
    if (url) {
      box.innerHTML = `
        <a class="sitebtn" href="${esc(url)}" target="_blank" rel="noopener noreferrer">
          <span class="sitebtn__ico">${GLOBE_ICON}</span>
          <span class="sitebtn__t">
            홈페이지 바로가기
            <em>${esc(prettyUrl(url))}</em>
          </span>
          <span class="sitebtn__out">${OUT_ICON}</span>
        </a>`;
      return;
    }

    /* 등록된 홈페이지가 없으면 검색으로 연결 — 없는 URL을 지어내지 않습니다 */
    const term = `${region.nameEn || region.name} ${region.cat === 'kr' ? '국립공원 공식 홈페이지' : 'national park official site'}`;
    box.innerHTML = `
      <p class="muted sm">등록된 공식 홈페이지 정보가 없습니다.</p>
      <a class="sitebtn sitebtn--ghost" target="_blank" rel="noopener noreferrer"
         href="https://www.google.com/search?q=${encodeURIComponent(term)}">
        <span class="sitebtn__ico">${GLOBE_ICON}</span>
        <span class="sitebtn__t">웹에서 공식 사이트 찾아보기<em>google.com 검색</em></span>
        <span class="sitebtn__out">${OUT_ICON}</span>
      </a>`;
  }

  /* ==========================================================
   *  7. UI 바인딩
   * ======================================================== */
  /* ---------- 흑백 모드 ----------
     body 에 filter 를 걸면 position:fixed 가 깨지므로
     지도에만 grayscale 을 적용하고 UI 색은 CSS 변수로 바꿉니다. */
  function setMono(on, persist = true) {
    state.mono = on;
    document.body.classList.toggle('mono', on);
    $('#toggle-mono').checked = on;
    $('#btn-mono').classList.toggle('is-on', on);
    $('#btn-mono').setAttribute('aria-pressed', String(on));
    if (persist) {
      try { localStorage.setItem('parknews-mono', on ? '1' : '0'); } catch { /* 무시 */ }
    }
  }

  /* ---------- 밝은 지도 ----------
     MapLibre 폴백 스타일에 실어 둔 다크·라이트 래스터 레이어의
     가시성만 바꾼다. (Mapbox 토큰 사용 시에는 스타일이 달라 미적용) */
  function setMapLight(on, persist = true) {
    state.light = on;
    document.body.classList.toggle('map-light', on);
    $('#toggle-light').checked = on;
    $('#btn-light').classList.toggle('is-on', on);
    $('#btn-light').setAttribute('aria-pressed', String(on));

    const m = state.map;
    if (m?.getLayer('carto-light')) {
      m.setLayoutProperty('carto-light', 'visibility', on ? 'visible' : 'none');
      m.setLayoutProperty('carto-dark', 'visibility', on ? 'none' : 'visible');
      m.setPaintProperty('bg', 'background-color', on ? '#e9ecf1' : '#080b13');
    }
    /* 밝은 배경에서는 지도 위 글자를 어두운 색 + 밝은 외곽선으로 */
    if (m?.getLayer('gp-label')) {
      m.setPaintProperty('gp-label', 'text-color', on ? 'rgba(24,32,46,.95)' : 'rgba(255,255,255,.92)');
      m.setPaintProperty('gp-label', 'text-halo-color', on ? 'rgba(255,255,255,.9)' : 'rgba(0,0,0,.85)');
    }
    if (m?.getLayer('gp-count')) {
      m.setPaintProperty('gp-count', 'text-color', on ? '#1f2937' : '#ffffff');
    }
    if (persist) {
      try { localStorage.setItem('parknews-light', on ? '1' : '0'); } catch { /* 무시 */ }
    }
  }

  function bindUI() {
    $('#toggle-bounds').addEventListener('change', (e) => {
      state.showBounds = e.target.checked;
      applyVisibility();
    });

    $('#toggle-mono').addEventListener('change', (e) => setMono(e.target.checked));
    $('#btn-mono').addEventListener('click', () => setMono(!state.mono));

    $('#toggle-light').addEventListener('change', (e) => setMapLight(e.target.checked));
    $('#btn-light').addEventListener('click', () => setMapLight(!state.light));

    $('#sb-close').addEventListener('click', closeSidebar);
    $('#sb-toggle').addEventListener('click', () => {
      $('#sidebar').classList.contains('is-open') ? closeSidebar()
        : (state.active ? select(state.active) : openSidebar());
    });
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeSidebar(); });

    /* ---------- 패널 열고 닫기 (데스크톱: 접기 / 모바일: 서랍) ---------- */
    const isMobile = () => window.matchMedia('(max-width: 860px)').matches;
    const setPanel = (open) => {
      $('#panel').classList.toggle('is-folded', !open);
      $('#btn-panel').setAttribute('aria-expanded', String(open));
      $('#btn-panel').classList.toggle('is-on', open);
    };
    const togglePanel = () => setPanel($('#panel').classList.contains('is-folded'));

    $('#panel-fold').addEventListener('click', togglePanel);
    $('#btn-panel').addEventListener('click', togglePanel);

    /* 모바일에서는 기본으로 닫아 지도를 가리지 않게 */
    if (isMobile()) setPanel(false);
    window.addEventListener('resize', () => {
      if (!isMobile()) setPanel(true);
    });

    /* 모바일에서 공원을 고르면 시트를 닫아 지도가 보이게 */
    state.onPickMobileClose = () => { if (isMobile()) setPanel(false); };

    /* 지도를 탭하면 열려 있던 시트를 닫는다 (바깥 탭으로 닫기) */
    $('#map').addEventListener('pointerdown', () => {
      if (!isMobile()) return;
      if (!$('#panel').classList.contains('is-folded')) setPanel(false);
      if ($('#sidebar').classList.contains('is-open')) closeSidebar();
    }, { passive: true });

    /* ---------- 모바일 바텀시트: 상단 핸들을 아래로 끌면 닫힘 ---------- */
    const enableSheetDrag = (sheet, onClose, grabPx = 52) => {
      let startY = 0, dy = 0, dragging = false;
      sheet.addEventListener('touchstart', (e) => {
        if (!isMobile()) return;
        const y = e.touches[0].clientY;
        if (y - sheet.getBoundingClientRect().top > grabPx) return;
        startY = y; dy = 0; dragging = true;
        sheet.style.transition = 'none';
      }, { passive: true });
      sheet.addEventListener('touchmove', (e) => {
        if (!dragging) return;
        dy = Math.max(0, e.touches[0].clientY - startY);
        sheet.style.transform = `translateY(${dy}px)`;
      }, { passive: true });
      const end = () => {
        if (!dragging) return;
        dragging = false;
        sheet.style.transition = '';
        sheet.style.transform = '';
        if (dy > 70) onClose();
      };
      sheet.addEventListener('touchend', end);
      sheet.addEventListener('touchcancel', end);
    };
    enableSheetDrag($('#panel'), () => setPanel(false));
    enableSheetDrag($('#sidebar'), closeSidebar);

    /* 현재 탭의 기본 화면으로 되돌린다 (국내면 대한민국, 해외면 전 세계) */
    $('#btn-home').addEventListener('click', () => {
      if (!state.map) return;
      frameScope(Explorer.scope, 1000);
      $$('.mk').forEach((e) => e.classList.remove('is-active'));
      if (state.map.getLayer('gp-active')) {
        state.map.setFilter('gp-active', ['==', ['get', 'id'], '__none__']);
      }
      closeSidebar();
    });
  }

  /* ==========================================================
   *  8. 하단 헤드라인 티커 · 시계
   * ======================================================== */
  async function initTicker() {
    const rail = $('#ticker-rail');
    try {
      const items = await NewsService.search('국립공원', 'ko', 14);
      if (!items.length) throw new Error('empty');
      const html = items.map((n) =>
        `<a class="tk" href="${esc(n.link)}" target="_blank" rel="noopener noreferrer">
           <i class="tk__dot"></i><span>${esc(n.title)}</span><em>${esc(n.press)}</em>
         </a>`).join('');
      rail.innerHTML = html + html;
      rail.classList.add('is-running');
      $('#ticker').hidden = false;
    } catch {
      $('#ticker').hidden = true;
    }
  }

  function initClock() {
    const el = $('#clock');
    if (!el) return;
    /* toLocaleTimeString('ko-KR', {hour12:false}) 는 iOS Safari 에서
       "14시 0분 59초" 같은 서술형을 돌려줘 폭이 터집니다.
       브라우저에 맡기지 않고 직접 조립합니다. */
    const p = (n) => String(n).padStart(2, '0');
    const tick = () => {
      const d = new Date();
      el.textContent = `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
    };
    tick();
    setInterval(tick, 1000);
  }

  /* ==========================================================
   *  부트
   * ======================================================== */
  (async function boot() {
    initClock();
    bindUI();
    Digest.init();
    Ranking.init();
    Stats.init();
    try {
      const saved = localStorage.getItem('parknews-mono') ?? localStorage.getItem('parkwatch-mono');
      setMono(saved === '1', false);
    } catch { /* 무시 */ }
    Explorer.init({ onPick: (p) => { select(p); state.onPickMobileClose?.(); } });
    Explorer.onScope(({ scope, parks, level, reason }) => {
      applyVisibility();

      if (scope === 'global') showGlobal(parks);

      /* 탭을 바꿨을 때만 그 범위의 기본 화면으로 이동 */
      if (reason === 'scope') {
        frameScope(scope, 1000);
        return;
      }
      if (scope !== 'global') return;

      /* 드릴다운/검색은 대상이 적당할 때만 따라간다 (타이핑마다 튀지 않도록) */
      const follow = reason === 'nav'
        ? level !== 'continent' && parks.length && parks.length <= 400
        : parks.length > 0 && parks.length <= 40;
      if (follow) fitTo(parks);
    });
    try {
      await initMap();
      applyVisibility();
      try { setMapLight(localStorage.getItem('parknews-light') === '1', false); } catch { /* 무시 */ }
    } catch (e) {
      console.error(e);
      $('#boot-status').innerHTML =
        `지도를 불러오지 못했습니다.<br><span class="sm">${esc(e.message)}</span>`;
      return;
    }

    HotBar.init();
    initTicker();
  })();
})();
