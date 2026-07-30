/* =============================================================
 *  charts.js  —  트렌드 차트 + 키워드 바
 *
 *  데이터 경로 (자동 폴백)
 *   1) /api/datalab  ← Vercel 배포 + 네이버 DataLab 키 등록 시 실측 데이터
 *   2) 시드 기반 시뮬레이션 데이터 (지역마다 항상 동일한 곡선)
 *
 *  차트 원칙
 *   · 단일 시리즈 → 범례 없음(제목이 시리즈를 지칭), 축은 하나만
 *   · 2px 선 / 얇은 마크 / 흐린 그리드 / 크로스헤어 툴팁
 *   · 숫자는 모든 점에 찍지 않고 최고점만 직접 라벨
 * ============================================================= */

window.TrendChart = (() => {
  let chart = null;
  const dataCache = new Map();

  /* ---------- 시드 난수 (지역별 고정 곡선) ---------- */
  function seedOf(str) {
    let h = 2166136261;
    for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619); }
    return h >>> 0;
  }
  function mulberry32(a) {
    return () => {
      a = (a + 0x6D2B79F5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  const DAYS = 14;

  function labels() {
    const out = [];
    for (let i = DAYS - 1; i >= 0; i--) {
      const d = new Date(Date.now() - i * 86400000);
      out.push(`${d.getMonth() + 1}/${d.getDate()}`);
    }
    return out;
  }

  /** 시뮬레이션: 완만한 추세 + 주말 상승 + 노이즈 (0~100 정규화) */
  function simulate(region) {
    const rnd = mulberry32(seedOf(region.id));
    const drift = (rnd() - 0.35) * 2.2;
    const base = 32 + rnd() * 26;
    const raw = [];
    for (let i = 0; i < DAYS; i++) {
      const d = new Date(Date.now() - (DAYS - 1 - i) * 86400000);
      const weekend = (d.getDay() === 0 || d.getDay() === 6) ? 12 : 0;
      const wave = Math.sin((i / DAYS) * Math.PI * 2 + rnd()) * 8;
      raw.push(Math.max(4, base + drift * i + weekend + wave + (rnd() - 0.5) * 14));
    }
    const max = Math.max(...raw);
    return raw.map((v) => Math.round((v / max) * 100));
  }

  /** DataLab(있으면) → 없으면 시뮬레이션 */
  async function getSeries(region) {
    if (dataCache.has(region.id)) return dataCache.get(region.id);

    let result = null;
    if (CONFIG.USE_SERVERLESS) {
      try {
        const kw = region.q || region.name;
        const res = await fetch(`/api/datalab?keyword=${encodeURIComponent(kw)}&days=${DAYS}`);
        if (res.ok) {
          const j = await res.json();
          const pts = j?.results?.[0]?.data || [];
          if (pts.length >= 5) {
            result = {
              real: true,
              labels: pts.map((p) => p.period.slice(5).replace('-', '/')),
              values: pts.map((p) => Math.round(p.ratio)),
            };
          }
        }
      } catch { /* 폴백 */ }
    }
    if (!result) result = { real: false, labels: labels(), values: simulate(region) };

    dataCache.set(region.id, result);
    return result;
  }

  /* ---------- 크로스헤어 플러그인 ---------- */
  const crosshair = {
    id: 'crosshair',
    afterDatasetsDraw(c) {
      const act = c.tooltip?.getActiveElements?.() || [];
      if (!act.length) return;
      const x = act[0].element.x;
      const { top, bottom } = c.chartArea;
      const ctx = c.ctx;
      ctx.save();
      ctx.beginPath();
      ctx.setLineDash([4, 4]);
      ctx.lineWidth = 1;
      ctx.strokeStyle = 'rgba(255,255,255,0.28)';
      ctx.moveTo(x, top); ctx.lineTo(x, bottom); ctx.stroke();
      ctx.restore();
    },
  };

  /* ---------- 렌더 ---------- */
  async function render(canvas, region, badgeEl) {
    const { real, labels: lb, values } = await getSeries(region);

    if (badgeEl) {
      badgeEl.textContent = real ? '실측 · 네이버 데이터랩' : '시뮬레이션 데이터';
      badgeEl.classList.toggle('is-sim', !real);
    }

    const ctx = canvas.getContext('2d');
    const grad = ctx.createLinearGradient(0, 0, 0, canvas.clientHeight || 160);
    grad.addColorStop(0, 'rgba(34,211,238,0.35)');
    grad.addColorStop(1, 'rgba(34,211,238,0.00)');

    const peak = values.indexOf(Math.max(...values));

    if (chart) { chart.destroy(); chart = null; }

    chart = new Chart(ctx, {
      type: 'line',
      data: {
        labels: lb,
        datasets: [{
          label: '검색 관심도',
          data: values,
          borderColor: '#22d3ee',
          borderWidth: 2,
          backgroundColor: grad,
          fill: true,
          tension: 0.35,
          pointRadius: (c) => (c.dataIndex === peak ? 4 : 0),
          pointHoverRadius: 5,
          pointBackgroundColor: '#22d3ee',
          pointBorderColor: 'rgba(11,15,26,1)',   // 배경색 링 = 마크 분리
          pointBorderWidth: 2,
          pointHitRadius: 14,
        }],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        animation: { duration: 900, easing: 'easeOutQuart' },
        interaction: { mode: 'index', intersect: false },
        plugins: {
          legend: { display: false },           // 단일 시리즈 → 범례 불필요
          tooltip: {
            backgroundColor: 'rgba(13,17,28,0.94)',
            borderColor: 'rgba(255,255,255,0.14)',
            borderWidth: 1,
            titleColor: 'rgba(255,255,255,0.62)',
            bodyColor: '#ffffff',
            titleFont: { size: 11, weight: '500' },
            bodyFont: { size: 13, weight: '600' },
            padding: 10,
            displayColors: false,
            callbacks: { label: (c) => `관심도 ${c.parsed.y}` },
          },
        },
        scales: {
          x: {
            grid: { display: false },
            border: { color: 'rgba(255,255,255,0.10)' },
            ticks: {
              color: 'rgba(255,255,255,0.42)',
              font: { size: 10 },
              maxRotation: 0,
              autoSkip: true, maxTicksLimit: 6,
            },
          },
          y: {
            beginAtZero: true, suggestedMax: 105,
            grid: { color: 'rgba(255,255,255,0.06)', drawTicks: false },
            border: { display: false },
            ticks: {
              color: 'rgba(255,255,255,0.42)',
              font: { size: 10 }, maxTicksLimit: 4, padding: 6,
            },
          },
        },
      },
      plugins: [crosshair],
    });

    return { real, values };
  }

  function destroy() { if (chart) { chart.destroy(); chart = null; } }

  return { render, destroy };
})();


/* =============================================================
 *  키워드 바  —  실제 기사 제목에서 추출한 빈도 (단일 색상 = 크기 인코딩)
 * ============================================================= */
window.KeywordBars = {
  render(container, items) {
    const kw = NewsService.keywords(items, 7);
    if (!kw.length) { container.innerHTML = '<p class="muted sm">키워드를 추출할 기사가 없습니다.</p>'; return; }
    const max = kw[0].count;
    container.innerHTML = kw.map((k, i) => `
      <div class="kwbar" style="--i:${i}">
        <span class="kwbar__label" title="${k.word}">${k.word}</span>
        <span class="kwbar__track">
          <span class="kwbar__fill" style="--w:${Math.round((k.count / max) * 100)}%"></span>
        </span>
        <span class="kwbar__val">${k.count}</span>
      </div>`).join('');
  },
};
