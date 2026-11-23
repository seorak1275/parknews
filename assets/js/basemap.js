/* =============================================================
 *  basemap.js  —  배경 지도 공급자 (전부 키 없이 무료)
 *
 *  CARTO 무료 타일이 API 키를 요구하면서 지도 위에 "API KEY REQUIRED"
 *  워터마크가 덮였다. 그래서 키가 필요 없는 공급자로 갈아타고,
 *  하나가 죽어도 지도가 비지 않게 단계별로 자동 전환한다.
 *
 *   Plan A  OpenFreeMap (positron 벡터 스타일)
 *           · 밝은 지도 = 스타일 그대로
 *           · 어두운 지도 = 같은 스타일의 색상만 어둡게 변환 (스타일을 두 벌 받지 않음)
 *   Plan B  래스터 타일 — Esri 회색 캔버스(밝음/어두움) → OSM 표준 타일(어둡게 보정)
 *           · Plan A 서버가 응답하지 않을 때 실제로 열리는 서버를 골라 붙인다
 *   Plan C  단색 배경 — 공원 표시·뉴스·검색은 그대로 동작
 * ============================================================= */

window.Basemap = (() => {
  'use strict';

  const STYLE_URL = 'https://tiles.openfreemap.org/styles/positron';
  const FALLBACK_GLYPHS = 'https://tiles.openfreemap.org/fonts/{fontstack}/{range}.pbf';
  const FALLBACK_FONT = ['Noto Sans Regular'];

  const STYLE_TIMEOUT_MS = 5000;   // 스타일 JSON 대기 — 넘으면 Plan B/C 로
  const PROBE_TIMEOUT_MS = 4000;   // 대체 타일 서버 응답 확인
  const WATCH_MS = 8000;           // 스타일은 왔는데 타일이 한 장도 안 오면 Plan B 로

  const LAND = { light: '#e9ecf1', dark: '#080b13' };
  const WATER_DARK = [13, 27, 48];
  const WATERWAY_DARK = [22, 48, 79];

  const fetchT = (url, ms, opts = {}) => {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), ms);
    return fetch(url, { ...opts, signal: ctrl.signal }).finally(() => clearTimeout(t));
  };

  /* ==========================================================
   *  색상 변환 — 밝은 스타일 → 어두운 스타일
   * ======================================================== */
  const probeCtx = (() => {
    try { return document.createElement('canvas').getContext('2d'); } catch { return null; }
  })();
  const SENTINEL = '#010203';

  /** CSS 색 문자열(#hex · rgb() · hsl() · 알파 포함)을 {r,g,b,a} 로 — 색이 아니면 null */
  function parseColor(str) {
    if (!probeCtx || typeof str !== 'string' || !/^\s*(#|rgb|hsl)/i.test(str)) return null;
    probeCtx.fillStyle = SENTINEL;
    probeCtx.fillStyle = str.trim();
    const v = probeCtx.fillStyle;
    if (v === SENTINEL && !/^\s*#010203\s*$/i.test(str)) return null;   // 해석 실패
    let m = /^#([0-9a-f]{6})$/i.exec(v);
    if (m) {
      const n = parseInt(m[1], 16);
      return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255, a: 1 };
    }
    m = /^rgba?\(\s*(\d+),\s*(\d+),\s*(\d+)(?:,\s*([\d.]+))?\s*\)$/.exec(v);
    return m ? { r: +m[1], g: +m[2], b: +m[3], a: m[4] === undefined ? 1 : +m[4] } : null;
  }

  function rgbToHsl(r, g, b) {
    r /= 255; g /= 255; b /= 255;
    const max = Math.max(r, g, b), min = Math.min(r, g, b);
    const l = (max + min) / 2;
    let h = 0, s = 0;
    if (max !== min) {
      const d = max - min;
      s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
      if (max === r) h = (g - b) / d + (g < b ? 6 : 0);
      else if (max === g) h = (b - r) / d + 2;
      else h = (r - g) / d + 4;
      h *= 60;
    }
    return { h, s, l };
  }

  function hslToRgb(h, s, l) {
    h /= 360;
    if (s === 0) { const v = Math.round(l * 255); return [v, v, v]; }
    const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
    const p = 2 * l - q;
    const f = (t) => {
      if (t < 0) t += 1;
      if (t > 1) t -= 1;
      if (t < 1 / 6) return p + (q - p) * 6 * t;
      if (t < 1 / 2) return q;
      if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
      return p;
    };
    return [f(h + 1 / 3), f(h), f(h - 1 / 3)].map((x) => Math.round(x * 255));
  }

  const rgba = (r, g, b, a) => `rgba(${r}, ${g}, ${b}, ${Math.round(a * 1000) / 1000})`;
  const clamp01 = (x) => Math.min(1, Math.max(0, x));

  /* 역할별 변환 — 밝기 순서는 유지하되 전체를 어두운 대역으로 눌러 담는다.
       배경  앱 배경색(#080b13)에 맞춰 고정
       면    약간 밝은 어둠 + 채도 낮춤 (공원·건물·토지이용)
       선    도로·경계 — 면보다 한 단계 밝게 해서 윤곽이 읽히게
       글자  어두운 글자 → 밝은 글자
       후광  흰 후광 → 어두운 후광
       물    남색 계열 고정 (육지와 구분되도록) */
  const ROLE = {
    background: ({ a }) => [8, 11, 19, a],
    water: ({ a }) => [...WATER_DARK, a],
    waterway: ({ a }) => [...WATERWAY_DARK, a],
    fill: ({ h, s, l, a }) => [...hslToRgb(h, s * 0.45, clamp01(0.05 + 0.07 * l)), a],
    line: ({ h, s, l, a }) => [...hslToRgb(h, s * 0.35, clamp01(0.10 + 0.17 * l)), a],
    text: ({ h, s, l, a }) => [...hslToRgb(h, s * 0.40, clamp01(0.50 + 0.40 * (1 - l))), a],
    halo: ({ h, s, l, a }) => [...hslToRgb(h, s * 0.30, clamp01(0.04 + 0.06 * l)), a],
  };

  /** 밝은 색 하나를 역할에 맞는 어두운 색(rgba 문자열)으로 — 색이 아니면 null */
  function darkenColor(str, role) {
    const c = parseColor(str);
    const fn = ROLE[role];
    if (!c || !fn) return null;
    const { h, s, l } = rgbToHsl(c.r, c.g, c.b);
    const [r, g, b, a] = fn({ h, s, l, a: c.a });
    return rgba(r, g, b, a);
  }

  const PROP_ROLE = {
    'background-color': 'background',
    'fill-color': 'fill', 'fill-extrusion-color': 'fill',
    'fill-outline-color': 'line', 'line-color': 'line',
    'circle-color': 'line', 'circle-stroke-color': 'line',
    'text-color': 'text', 'icon-color': 'text',
    'text-halo-color': 'halo', 'icon-halo-color': 'halo',
  };

  const isWater = (layer) =>
    /water/i.test(layer.id || '') || /water/i.test(layer['source-layer'] || '');

  function roleFor(prop, layer) {
    const role = PROP_ROLE[prop];
    if (!role) return null;
    if (isWater(layer)) {
      if (role === 'fill') return 'water';
      if (role === 'line') return 'waterway';
    }
    return role;
  }

  /** 속성 값 안의 모든 색 문자열을 변환 — 단일 값 · 표현식 배열 · 구형 stops 함수 모두 */
  function mapColors(value, fn) {
    if (typeof value === 'string') return fn(value);
    if (Array.isArray(value)) return value.map((v) => mapColors(v, fn));
    if (value && typeof value === 'object') {
      const out = {};
      for (const [k, v] of Object.entries(value)) {
        out[k] = (k === 'stops' || k === 'default') ? mapColors(v, fn) : v;
      }
      return out;
    }
    return value;
  }

  /** 라벨용 글꼴 — 스타일이 이미 쓰는 글꼴 묶음을 그대로 따른다 (서버에 없는 글꼴 요청 방지) */
  function detectFont(style) {
    const stacks = [];
    for (const l of style.layers || []) {
      const f = l.layout && l.layout['text-font'];
      if (Array.isArray(f) && f.length && f.every((x) => typeof x === 'string')) stacks.push(f);
    }
    return stacks.find((s) => s.some((n) => /regular/i.test(n))) || stacks[0] || FALLBACK_FONT;
  }

  /** 받아온 스타일에서 밝음/어두움 두 벌의 색상표와 글꼴·글리프 정보를 뽑는다 */
  function prepare(style) {
    const paints = { light: {}, dark: {} };
    for (const layer of style.layers || []) {
      const p = layer.paint || {};
      for (const prop of Object.keys(p)) {
        const role = roleFor(prop, layer);
        if (!role) continue;
        if (!paints.light[layer.id]) { paints.light[layer.id] = {}; paints.dark[layer.id] = {}; }
        paints.light[layer.id][prop] = p[prop];
        paints.dark[layer.id][prop] = mapColors(p[prop], (s) => darkenColor(s, role) || s);
      }
      if (layer.type === 'background' && !('background-color' in p)) {
        paints.light[layer.id] = { 'background-color': LAND.light };
        paints.dark[layer.id] = { 'background-color': LAND.dark };
      }
    }
    return {
      style, paints,
      font: detectFont(style),
      glyphs: style.glyphs || null,
      baseIds: (style.layers || []).map((l) => l.id),
      vectorIds: Object.entries(style.sources || {})
        .filter(([, s]) => s && s.type === 'vector').map(([id]) => id),
    };
  }

  /** 원하는 테마의 색을 입힌 스타일 사본 — 처음부터 맞춰 두면 첫 화면이 깜빡이지 않는다 */
  function styleFor(prepared, dark) {
    const s = JSON.parse(JSON.stringify(prepared.style));
    if (dark) {
      for (const layer of s.layers) {
        const set = prepared.paints.dark[layer.id];
        if (set) layer.paint = { ...(layer.paint || {}), ...set };
      }
    }
    return s;
  }

  function applyPaints(map, set) {
    for (const [id, props] of Object.entries(set || {})) {
      if (!map.getLayer(id)) continue;
      for (const [prop, val] of Object.entries(props)) {
        try { map.setPaintProperty(id, prop, val); } catch { /* 한 속성 실패가 전체를 막지 않게 */ }
      }
    }
  }

  /* ==========================================================
   *  Plan A 로드
   * ======================================================== */
  async function loadStyle(url = STYLE_URL) {
    try {
      const res = await fetchT(url, STYLE_TIMEOUT_MS);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const style = await res.json();
      if (!style || !Array.isArray(style.layers) || !style.sources) throw new Error('스타일 형식 이상');
      return style;
    } catch (e) {
      console.warn('[basemap] Plan A(OpenFreeMap) 스타일을 못 받았습니다:', e.message || e);
      return null;
    }
  }

  const minimalStyle = (dark) => ({
    version: 8,
    glyphs: FALLBACK_GLYPHS,
    sources: {},
    layers: [{ id: 'bg', type: 'background',
      paint: { 'background-color': dark ? LAND.dark : LAND.light } }],
  });

  /** 지도에 넘길 스타일과 상태 묶음. style 이 없으면(Plan C 시작) 단색 배경으로 연다. */
  function create(rawStyle, dark) {
    let prepared = null;
    if (rawStyle) {
      try { prepared = prepare(rawStyle); } catch (e) { console.warn('[basemap] 스타일 해석 실패:', e); }
    }
    return {
      plan: prepared ? 'A' : 'C',
      prepared, provider: null,
      theme: dark ? 'dark' : 'light',
      font: prepared ? prepared.font : FALLBACK_FONT,
      glyphs: prepared ? prepared.glyphs : FALLBACK_GLYPHS,
      style: prepared ? styleFor(prepared, dark) : minimalStyle(dark),
    };
  }

  /** 글꼴 서버가 실제로 응답하는지 — 안 되면 숫자·이름 라벨 레이어를 넣지 않는다
      (글리프 요청이 실패하면 같은 소스의 원까지 통째로 사라지기 때문) */
  async function probeGlyphs(bm) {
    if (!bm.glyphs) return false;
    const url = bm.glyphs
      .replace('{fontstack}', encodeURIComponent(bm.font.join(',')))
      .replace('{range}', '0-255');
    try {
      const r = await fetchT(url, PROBE_TIMEOUT_MS);
      return r.ok;
    } catch { return false; }
  }

  /* ==========================================================
   *  Plan B — 래스터 대체 타일
   * ======================================================== */
  const ESRI = 'https://services.arcgisonline.com/ArcGIS/rest/services/Canvas';
  const PLAN_B = [
    {
      id: 'esri-gray', themed: true, maxzoom: 15,
      attribution: 'Tiles © Esri — Esri, HERE, Garmin, © OpenStreetMap contributors',
      urls: (dark) => {
        const k = dark ? 'Dark' : 'Light';
        return [`${ESRI}/World_${k}_Gray_Base/MapServer/tile/{z}/{y}/{x}`,
                `${ESRI}/World_${k}_Gray_Reference/MapServer/tile/{z}/{y}/{x}`];
      },
      probe: (dark) => `${ESRI}/World_${dark ? 'Dark' : 'Light'}_Gray_Base/MapServer/tile/5/12/27`,
    },
    {
      id: 'osm', themed: false, maxzoom: 19,
      attribution: '© OpenStreetMap contributors',
      urls: () => ['https://tile.openstreetmap.org/{z}/{x}/{y}.png'],
      probe: () => 'https://tile.openstreetmap.org/5/27/12.png',
      // OSM 은 밝은 지도뿐이라 어두운 테마에서는 밝기·채도를 눌러 어둡게 보정한다
      darkPaint: { 'raster-brightness-max': 0.34, 'raster-saturation': -0.7, 'raster-contrast': 0.15 },
      lightPaint: { 'raster-brightness-max': 1, 'raster-saturation': 0, 'raster-contrast': 0 },
    },
  ];

  /** 타일 한 장을 실제로 받아 보고 '이미지가 오는' 서버만 인정한다
      (키가 없으면 오류를 JSON 으로 돌려주는 서버가 있어 상태코드만으로는 모른다) */
  async function probeTile(url) {
    try {
      const r = await fetchT(url, PROBE_TIMEOUT_MS);
      if (!r.ok || !/^image\//i.test(r.headers.get('content-type') || '')) return false;
      return (await r.blob()).size > 100;
    } catch { return false; }
  }

  async function pickProvider(dark) {
    const ok = await Promise.all(PLAN_B.map((p) => probeTile(p.probe(dark))));
    return PLAN_B.find((_, i) => ok[i]) || null;
  }

  function setPlanBTheme(map, provider, dark) {
    if (provider.themed) {
      for (const v of ['light', 'dark']) {
        const show = (v === 'dark') === dark;
        for (let i = 0; map.getLayer(`planb-${v}-${i}`); i++) {
          map.setLayoutProperty(`planb-${v}-${i}`, 'visibility', show ? 'visible' : 'none');
        }
      }
    } else if (map.getLayer('planb-any-0')) {
      for (const [k, v] of Object.entries(dark ? provider.darkPaint : provider.lightPaint)) {
        map.setPaintProperty('planb-any-0', k, v);
      }
    }
  }

  /**
   * Plan A 가 죽었을 때 호출 — 실제로 열리는 대체 서버를 골라 붙인다.
   * @param beforeId 우리 오버레이(경계·마커 레이어) 중 가장 아래 것 — 그 밑에 깔아야 가리지 않는다
   * @returns 붙인 공급자, 전부 실패하면 null(Plan C 유지)
   */
  async function activatePlanB(map, bm, beforeId) {
    const dark = bm.theme === 'dark';
    const provider = await pickProvider(dark);
    if (!provider) { bm.plan = 'C'; return null; }

    if (bm.prepared) {
      for (const id of bm.prepared.baseIds) {          // 죽은 벡터 레이어는 숨겨 요청을 멈춘다
        if (map.getLayer(id)) map.setLayoutProperty(id, 'visibility', 'none');
      }
    }
    const before = beforeId && map.getLayer(beforeId) ? beforeId : undefined;

    if (!map.getLayer('bg')) {                         // 타일이 도착하기 전 바탕색
      const first = map.getStyle().layers[0]?.id;
      map.addLayer({ id: 'planb-bg', type: 'background',
        paint: { 'background-color': dark ? LAND.dark : LAND.light } }, first);
    }
    const variants = provider.themed ? ['light', 'dark'] : ['any'];
    for (const v of variants) {
      provider.urls(v === 'dark').forEach((url, i) => {
        const id = `planb-${v}-${i}`;
        map.addSource(id, {
          type: 'raster', tiles: [url], tileSize: 256,
          maxzoom: provider.maxzoom, attribution: provider.attribution,
        });
        map.addLayer({ id, type: 'raster', source: id }, before);
      });
    }
    bm.plan = 'B';
    bm.provider = provider;
    setPlanBTheme(map, provider, dark);
    return provider;
  }

  /* ==========================================================
   *  테마 전환 · 감시
   * ======================================================== */
  function setTheme(map, bm, dark) {
    if (!map || !bm || bm.plan === 'mapbox') return;
    const want = dark ? 'dark' : 'light';
    const land = dark ? LAND.dark : LAND.light;
    for (const id of ['bg', 'planb-bg']) {
      if (map.getLayer(id)) map.setPaintProperty(id, 'background-color', land);
    }
    if (bm.plan === 'A' && bm.prepared && bm.theme !== want) {
      applyPaints(map, bm.prepared.paints[want]);
    } else if (bm.plan === 'B' && bm.provider) {
      setPlanBTheme(map, bm.provider, dark);
    }
    bm.theme = want;
  }

  /**
   * 스타일은 받았는데 타일이 한 장도 안 오는 경우를 잡는다.
   * 오류가 2번 이상 났고 성공한 타일이 하나도 없을 때만 onDead 를 부른다 —
   * 단순히 느린 네트워크를 장애로 오판해 멀쩡한 지도를 바꾸지 않기 위해서다.
   */
  function watch(map, bm, onDead, ms = WATCH_MS) {
    if (bm.plan !== 'A' || !bm.prepared || !bm.prepared.vectorIds.length) return;
    const ids = new Set(bm.prepared.vectorIds);
    let ok = false, errs = 0;
    const onSrc = (e) => { if (ids.has(e.sourceId) && (e.tile || e.sourceDataType === 'content')) ok = true; };
    const onErr = (e) => { if (ids.has(e.sourceId)) errs++; };
    map.on('sourcedata', onSrc);
    map.on('error', onErr);
    setTimeout(() => {
      map.off('sourcedata', onSrc);
      map.off('error', onErr);
      if (!ok && errs >= 2) onDead({ errs });
    }, ms);
  }

  return {
    STYLE_URL, loadStyle, create, probeGlyphs, setTheme, watch, activatePlanB,
    // 테스트·진단용
    prepare, styleFor, darkenColor, parseColor, detectFont, PLAN_B,
  };
})();
