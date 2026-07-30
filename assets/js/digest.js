/* =============================================================
 *  digest.js  —  일일기사요약 뷰어 · PDF 다운로드
 *
 *  · 상단 [일일 요약] 버튼 → A4 요약표 미리보기
 *  · [PDF 다운로드] → 일일기사요약_YYYYMMDD.pdf 저장
 *  · 날짜 아카이브 이동 (◀ ▶)
 *
 *  데이터 경로
 *   1) /api/digest?date=YYYY-MM-DD   ← Vercel 배포 시 (Claude 요약 적용)
 *   2) 간이본 — 배포 전/로컬에서는 구글 뉴스 RSS 헤드라인만으로 목록을 구성
 *      (요약문이 없으므로 "간이본"으로 명확히 표시)
 * ============================================================= */

window.Digest = (() => {
  'use strict';

  const $ = (s, r = document) => r.querySelector(s);
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  const KST = 9 * 3600 * 1000;
  const DOW = ['일', '월', '화', '수', '목', '금', '토'];

  const todayKst = () => new Date(Date.now() + KST).toISOString().slice(0, 10);
  const addDays = (d, n) => {
    const x = new Date(`${d}T00:00:00Z`);
    x.setUTCDate(x.getUTCDate() + n);
    return x.toISOString().slice(0, 10);
  };
  const korean = (d) => {
    const x = new Date(`${d}T00:00:00Z`);
    return `${x.getUTCFullYear()}년 ${x.getUTCMonth() + 1}월 ${x.getUTCDate()}일 ${DOW[x.getUTCDay()]}요일`;
  };

  const state = { date: todayKst(), digest: null, loading: false };

  /* ==========================================================
   *  간이본 — 서버 없이 헤드라인만으로 구성
   * ======================================================== */
  const LOCAL_QUERIES = [
    '국립공원', '국립공원공단', '국립공원 멸종위기', '국립공원 탐방',
    '설악산 국립공원', '지리산 국립공원', '한라산 국립공원', '내장산 국립공원',
  ];

  /* 서버(api/digest.js)와 동일한 묶기 규칙 */
  const JOSA = /(에서|에게|으로|과의|와의|은|는|이|가|을|를|에|의|서|와|과|도|로)$/;
  const STOP = new Set(['국립공원', '공원', '국립', '지난', '올해', '관련', '이날']);

  function tokenSet(t) {
    return new Set(t.replace(/[^\p{L}\p{N}\s]/gu, ' ').split(/\s+/)
      .map((w) => (w.length >= 3 ? w.replace(JOSA, '') : w))
      .filter((w) => w.length >= 2 && !STOP.has(w)));
  }
  function similar(a, b) {
    let i = 0;
    for (const x of a) if (b.has(x)) i++;
    if (!i) return 0;
    return Math.max(i / (a.size + b.size - i), i / Math.min(a.size, b.size));
  }

  /* 따옴표 안 핵심어(종명·프로그램명)가 서로 다르면 다른 사안 */
  const KEY_RE = /[‘'"“]([^’'"”]{2,20})[’'"”]/g;
  const keyOf = (t) => new Set([...t.matchAll(KEY_RE)].map((m) => m[1].trim()).filter(Boolean));
  const NOISE = ['채용', '입찰', '공고', '모집공고'];

  async function buildLocalDigest(issueDate) {
    const target = addDays(issueDate, -1);
    const batches = await Promise.all(
      LOCAL_QUERIES.map((q) => NewsService.search(q, 'ko', 30).catch(() => []))
    );

    const seen = new Set();
    const arts = [];
    for (const n of batches.flat()) {
      const ts = Date.parse(n.date);
      if (Number.isNaN(ts)) continue;
      if (new Date(ts + KST).toISOString().slice(0, 10) !== target) continue;
      if (NOISE.some((w) => n.title.includes(w))) continue;
      const k = `${n.title.replace(/\s+/g, '').slice(0, 30)}|${n.press}`;
      if (seen.has(k)) continue;
      seen.add(k);
      arts.push(n);
    }

    /* 같은 사안 묶기 */
    const groups = [];
    for (const a of arts) {
      const tk = tokenSet(a.title);
      const ky = keyOf(a.title);
      const g = groups.find((x) => {
        if (similar(x.tk, tk) < 0.5) return false;
        if (ky.size && x.ky.size && ![...ky].some((k) => x.ky.has(k))) return false;
        return true;
      });
      if (g) { g.arts.push(a); tk.forEach((t) => g.tk.add(t)); ky.forEach((t) => g.ky.add(t)); }
      else groups.push({ tk, ky, arts: [a] });
    }

    const items = groups
      .sort((x, y) => y.arts.length - x.arts.length)
      .slice(0, 12)
      .map((g, i) => ({
        no: i + 1,
        press: [...new Set(g.arts.map((a) => a.press))],
        title: g.arts[0].title,
        summary: '',
        category: i < 6 ? '주요기사' : '참고기사',
        reports: g.arts.length,
        links: g.arts.map((a) => a.link),
      }));

    return {
      issueDate,
      issueDateKo: korean(issueDate),
      targetDate: target,
      targetDateKo: korean(target),
      totalReports: items.reduce((s, it) => s + it.reports, 0),
      itemCount: items.length,
      collected: arts.length,
      droppedAsDuplicate: 0,
      duplicateNotes: [],
      items,
      simple: true,        // ★ 간이본 표시
    };
  }

  /* ==========================================================
   *  데이터 로드
   * ======================================================== */
  async function load(date) {
    state.loading = true;
    render();
    try {
      const res = await fetch(`/api/digest?date=${date}`);
      if (res.ok) {
        state.digest = await res.json();
        return;
      }
      // 404 / 501 / 로컬(HTML 응답) → 간이본으로 폴백
      state.digest = await buildLocalDigest(date);
    } catch {
      try { state.digest = await buildLocalDigest(date); }
      catch { state.digest = null; }
    } finally {
      state.loading = false;
      render();
    }
  }

  /* ==========================================================
   *  A4 시트 렌더링
   * ======================================================== */
  function sheetHtml(d) {
    const rows = (cat) => d.items.filter((i) => i.category === cat);
    const block = (cat) => {
      const list = rows(cat);
      if (!list.length) return '';
      return `
        <div class="dg-sec">
          <div class="dg-sec__tag">${cat}</div>
          <table class="dg-table">
            <colgroup><col style="width:26px"><col style="width:78px"><col></colgroup>
            <tbody>
              ${list.map((it) => `
                <tr>
                  <td class="dg-no">${it.no}</td>
                  <td class="dg-press">${it.press.map((p) => `<span>${esc(p)}</span>`).join('')}</td>
                  <td>
                    <p class="dg-title">${
                      it.links?.[0]
                        ? `<a href="${esc(it.links[0])}" target="_blank" rel="noopener noreferrer">${esc(it.title)}</a>`
                        : esc(it.title)
                    }</p>
                    ${it.summary ? `<p class="dg-sum">${esc(it.summary)}</p>` : ''}
                  </td>
                </tr>`).join('')}
            </tbody>
          </table>
        </div>`;
    };

    return `
      <div class="dg-sheet" id="dg-sheet">
        <header class="dg-head">
          <h1>오늘의 주요기사<span>(요약)</span></h1>
          <p class="dg-meta">${esc(d.issueDateKo)} / 총 <b>${d.totalReports}</b>건 보도 · ${d.itemCount}개 사안</p>
          <p class="dg-sub">수록 대상 : ${esc(d.targetDateKo)} 보도분${
            d.droppedAsDuplicate ? ` · 직전 요약본과 중복된 ${d.droppedAsDuplicate}건 제외` : ''
          }</p>
        </header>

        ${block('주요기사')}
        ${block('참고기사')}

        ${d.duplicateNotes?.length ? `
          <div class="dg-notes">
            <p class="dg-notes__t">중복으로 제외한 사안</p>
            <ul>${d.duplicateNotes.map((n) => `<li>${esc(n)}</li>`).join('')}</ul>
          </div>` : ''}

        <footer class="dg-foot">
          <span>파크뉴스 일일 국립공원 기사요약</span>
          <span>${d.simple ? '간이본 · AI 요약 미적용' : 'Claude 자동 요약'} · 수집 ${d.collected ?? d.itemCount}건</span>
        </footer>
      </div>`;
  }

  function render() {
    const body = $('#dg-body');
    if (!body) return;

    $('#dg-date').textContent = korean(state.date);
    $('#dg-next').disabled = state.date >= todayKst();

    if (state.loading) {
      body.innerHTML = `<div class="dg-state"><span class="dots"><i></i><i></i><i></i></span> 요약본을 불러오는 중…</div>`;
      $('#dg-pdf').disabled = true;
      return;
    }
    const d = state.digest;
    if (!d || !d.items?.length) {
      body.innerHTML = `<div class="dg-state">
        <p>${esc(korean(state.date))}자 요약본이 없습니다.</p>
        <p class="sm muted">전날 보도된 국립공원 기사가 없거나, 아직 생성되지 않았습니다.</p>
      </div>`;
      $('#dg-pdf').disabled = true;
      return;
    }

    body.innerHTML = sheetHtml(d);
    $('#dg-pdf').disabled = false;
    $('#dg-badge').textContent = d.simple ? '간이본' : '자동 요약';
    $('#dg-badge').classList.toggle('is-sim', Boolean(d.simple));
  }

  /* ==========================================================
   *  PDF 저장  (html2canvas → jsPDF · 한글 깨짐 없음)
   * ======================================================== */
  const loadScript = (src) => new Promise((ok, no) => {
    if ([...document.scripts].some((s) => s.src === src)) return ok();
    const el = document.createElement('script');
    el.src = src; el.onload = ok; el.onerror = () => no(new Error(src));
    document.head.appendChild(el);
  });

  async function downloadPdf() {
    const sheet = $('#dg-sheet');
    if (!sheet) return;
    const btn = $('#dg-pdf');
    const label = btn.textContent;
    btn.disabled = true;
    btn.textContent = 'PDF 만드는 중…';

    try {
      await loadScript('https://cdn.jsdelivr.net/npm/html2canvas@1.4.1/dist/html2canvas.min.js');
      await loadScript('https://cdn.jsdelivr.net/npm/jspdf@2.5.2/dist/jspdf.umd.min.js');

      /* 모바일에서는 시트가 화면 폭(예: 390px)이라 그대로 캡처하면
         길쭉한 PDF가 나옵니다. 캡처 순간만 A4 폭(794px)으로 고정합니다. */
      const A4_W = 794;
      const narrow = sheet.offsetWidth < A4_W;
      const prev = { width: sheet.style.width, maxWidth: sheet.style.maxWidth };
      if (narrow) {
        sheet.style.width = `${A4_W}px`;
        sheet.style.maxWidth = 'none';
      }

      let canvas;
      try {
        canvas = await window.html2canvas(sheet, {
          scale: narrow ? 2 : 2,
          backgroundColor: '#ffffff',
          useCORS: true,
          logging: false,
          windowWidth: A4_W,
          width: A4_W,
        });
      } finally {
        if (narrow) {
          sheet.style.width = prev.width;
          sheet.style.maxWidth = prev.maxWidth;
        }
      }

      const { jsPDF } = window.jspdf;
      const pdf = new jsPDF({ unit: 'mm', format: 'a4', orientation: 'portrait' });
      const pw = pdf.internal.pageSize.getWidth();     // 210
      const ph = pdf.internal.pageSize.getHeight();    // 297
      const imgH = (canvas.height * pw) / canvas.width;
      const img = canvas.toDataURL('image/jpeg', 0.94);

      let left = imgH;
      let y = 0;
      pdf.addImage(img, 'JPEG', 0, 0, pw, imgH, undefined, 'FAST');
      left -= ph;
      while (left > 0) {
        y -= ph;
        pdf.addPage();
        pdf.addImage(img, 'JPEG', 0, y, pw, imgH, undefined, 'FAST');
        left -= ph;
      }

      pdf.save(`일일기사요약_${state.date.replace(/-/g, '')}.pdf`);
    } catch (e) {
      console.error(e);
      alert('PDF 생성에 실패했습니다. 브라우저 인쇄(Ctrl+P → PDF로 저장)를 이용해 주세요.');
    } finally {
      btn.disabled = false;
      btn.textContent = label;
    }
  }

  /* ==========================================================
   *  공개 API
   * ======================================================== */
  function open() {
    $('#digest').classList.add('is-open');
    document.body.classList.add('dg-lock');
    if (!state.digest) load(state.date);
  }
  function close() {
    $('#digest').classList.remove('is-open');
    document.body.classList.remove('dg-lock');
  }

  function init() {
    $('#btn-digest')?.addEventListener('click', open);
    $('#dg-close')?.addEventListener('click', close);
    $('#digest')?.addEventListener('click', (e) => { if (e.target.id === 'digest') close(); });
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && $('#digest')?.classList.contains('is-open')) close();
    });

    $('#dg-prev')?.addEventListener('click', () => { state.date = addDays(state.date, -1); load(state.date); });
    $('#dg-next')?.addEventListener('click', () => {
      if (state.date >= todayKst()) return;
      state.date = addDays(state.date, 1);
      load(state.date);
    });
    $('#dg-pdf')?.addEventListener('click', downloadPdf);
    $('#dg-print')?.addEventListener('click', () => window.print());
  }

  return { init, open, close };
})();
