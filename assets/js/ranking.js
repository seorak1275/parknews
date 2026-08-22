/* =============================================================
 *  ranking.js  —  통합 인기뉴스 순위 (국내 / 국외 · 실시간 ~ 연간)
 *
 *  순위 기준
 *    같은 사안을 보도한 매체가 많을수록 위로 올라갑니다.
 *    단일 매체 단독 기사는 아무리 최신이어도 상위에 오지 않습니다.
 *    → 조회수(화제성)가 아니라 "언론이 얼마나 중요하게 봤나"를 재는 지표입니다.
 *
 *  기간
 *    실시간  지금 이 순간 검색되는 기사로 즉석 집계 (NewsService)
 *    일·주·월·연  매일 아침 쌓아둔 보관본을 합산 (/api/ranking-archive)
 *
 *  보관본은 2026-08-16부터 하루씩 쌓입니다. 그 이전 기간은 소급되지 않으므로
 *  주간은 7일, 월간은 30일, 연간은 12개월이 지나야 온전한 순위가 됩니다.
 *  (모자란 동안에는 "n일치 기준"이라고 화면에 밝힙니다)
 * ============================================================= */

window.Ranking = (() => {
  'use strict';

  const $ = (s) => document.querySelector(s);
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  const SETS = {
    kr: {
      label: '국내',
      lang: 'ko',
      queries: ['국립공원', '국립공원공단', '국립공원 탐방', '국립공원 멸종위기',
                '국립공원 지정', '국립공원 안전', '설악산 국립공원', '지리산 국립공원'],
    },
    global: {
      label: '국외',
      lang: 'en',
      queries: ['national park', 'national park conservation', 'national park wildlife',
                'national park visitors', 'IUCN protected area', 'UNESCO natural heritage',
                'national park service', 'national park funding'],
    },
  };

  /* '일간(어제)'은 '오늘'로 바꿨다 — 어제는 주간에 어차피 포함되고,
     사람들이 궁금한 건 "지금 오늘 뭐가 뜨나"다 (서버 즉석 집계 · 30분 캐시) */
  const PERIODS = {
    live:  '실시간',
    today: '오늘',
    week:  '주간',
    month: '월간',
    year:  '연간',
  };

  /* 국내 24곳 — 공원 하나만 골라서 순위를 볼 수 있게 한다.
     '설악산에서 요즘 뭐가 이슈지?' 를 바로 확인하는 용도다. */
  const KR_PARKS = (window.REGIONS_KR || []).map((r) => ({
    id: r.id, name: r.name.replace('국립공원', ''), q: r.q || r.name,
  }));

  /* 마지막으로 보던 국내/국외·기간을 기억한다 — 열 때마다 기본값으로
     돌아가면 매번 다시 골라야 한다 (지도 밝기·뉴스 정렬과 같은 방식) */
  const saved = (() => {
    try { return JSON.parse(localStorage.getItem('parknews-rank') || '{}'); } catch { return {}; }
  })();
  const state = {
    tab: saved.tab === 'global' ? 'global' : 'kr',
    period: saved.period === 'day' ? 'today'   // 옛 저장값 이관
      : Object.prototype.hasOwnProperty.call(PERIODS, saved.period) ? saved.period : 'live',
    park: '', sector: '', continent: '', cache: {}, loading: false,
  };

  /* 국외 탭의 대륙 필터 — 제목에서 공원을 찾아낸 기사만 대륙을 안다 */
  const CONTINENTS = ['아시아', '유럽', '북아메리카', '남아메리카', '아프리카', '오세아니아'];
  const remember = () => {
    try { localStorage.setItem('parknews-rank', JSON.stringify({ tab: state.tab, period: state.period })); }
    catch { /* 무시 */ }
  };

  const SECTORS = window.Taxonomy?.SECTORS || [];
  const sectorOf = (r) =>
    window.Taxonomy?.classify(`${r.title} ${(r.others || []).map((o) => o.title).join(' ')}`) || null;
  const TTL = 10 * 60 * 1000;

  /* ==========================================================
   *  자료 가져오기 — 실시간은 즉석 집계, 나머지는 보관본
   * ======================================================== */

  /** 실시간: 지금 검색되는 기사를 그 자리에서 묶어 순위를 낸다 */
  async function fetchLive(which) {
    const cfg = SETS[which];
    const park = which === 'kr' && state.park
      ? KR_PARKS.find((p) => p.id === state.park) : null;

    /* 공원을 골랐으면 그 공원 이름을 얹어 좁게 찾고, 이름이 없는 기사는 뺀다 */
    const queries = park
      ? [park.q, `${park.name} 탐방`, `${park.name} 사고`, `${park.name} 생태`]
      : cfg.queries;
    const batches = await Promise.all(
      queries.map((q) => NewsService.search(q, cfg.lang, 25).catch(() => null))
    );
    let ok = batches.filter(Boolean);
    /* 전부 실패 = 수집 장애 — "기사 없음"과 구분해야 빈 화면으로 굳지 않는다 */
    if (!ok.length) throw new Error('뉴스 검색이 모두 실패했습니다');
    if (park) {
      ok = ok.map((b) => b.filter((n) => `${n.title} ${n.summary || ''}`.includes(park.name)));
    }
    const groups = NewsService.groupIssues(ok.flat()).slice(0, 25);
    return {
      rows: groups.map((g) => ({
        title: g.lead.title,
        link: g.lead.link,
        press: g.outlets,
        outletCount: g.outletCount,
        reports: g.arts.length,
        time: NewsService.timeAgo(g.lead.date),
        others: g.arts.slice(1, 4).map((o) => ({ title: o.title, press: o.press, link: o.link })),
      })),
      note: `지금 검색되는 기사 기준 · ${new Date().toLocaleTimeString('ko-KR', { hour12: false })} 집계`,
    };
  }

  /** 일·주·월·연: 매일 쌓아둔 보관본을 합산해 받아온다 */
  /* ==========================================================
   *  공원별 주간·월간 — '최신 30일 증분' CSV(매일 갱신)로 직접 집계
   *
   *  보관본(일간 상위 80묶음)에는 조용한 공원의 단독 보도가 빠질 수 있어
   *  공원 필터가 굶는다. 증분 CSV에는 공원명 컬럼까지 있는 기사 원장이
   *  통째로 있으므로(약 350KB · CDN) 이걸 한 번 받아 브라우저에서 묶는다.
   *  → 공원을 바꿔도 다시 안 받는다. 분야 필터처럼 즉시 뜬다.
   * ======================================================== */
  const DELTA_URL = 'data/dataset/%EA%B5%AD%EB%A6%BD%EA%B3%B5%EC%9B%90%EA%B3%B5%EB%8B%A8_%EA%B5%AD%EB%A6%BD%EA%B3%B5%EC%9B%90%EB%89%B4%EC%8A%A4%EC%A0%95%EB%B3%B4_%EC%B5%9C%EC%8B%A030%EC%9D%BC.csv';
  let deltaCache = null;

  function parseCsv(text) {
    const s = text.replace(/^﻿/, '');
    const rows = [];
    let cur = [''], q = false;
    for (let i = 0; i < s.length; i++) {
      const c = s[i];
      if (q) {
        if (c === '"') {
          if (s[i + 1] === '"') { cur[cur.length - 1] += '"'; i++; } else q = false;
        } else cur[cur.length - 1] += c;
      } else if (c === '"') q = true;
      else if (c === ',') cur.push('');
      else if (c === '\n') { rows.push(cur); cur = ['']; }
      else if (c !== '\r') cur[cur.length - 1] += c;
    }
    if (cur.length > 1 || cur[0]) rows.push(cur);
    return rows;
  }

  async function loadDelta() {
    if (deltaCache) return deltaCache;
    const r = await fetch(DELTA_URL);
    if (!r.ok) throw new Error(`증분 CSV 없음 (${r.status})`);
    const rows = parseCsv(await r.text());
    const ix = Object.fromEntries(rows[0].map((k, i) => [k, i]));
    deltaCache = rows.slice(1)
      .filter((c) => c.length >= rows[0].length)
      .map((c) => ({
        date: c[ix['게시일자']],
        park: c[ix['공원명']],
        basis: c[ix['공원판정근거']],
        title: c[ix['뉴스제목']],
        press: c[ix['뉴스매체']],
        link: c[ix['url']],
      }));
    return deltaCache;
  }

  /* 국외 대륙별 주간·월간 — 해외 증분 CSV(대륙 태그 포함, 매일 갱신)로 집계.
     보관본 상위 묶음에는 대륙별 재료가 얇아 필터가 굶는다(2026-08-22 실측 0건). */
  const GLOBAL_DELTA_URL = 'data/dataset/%EA%B5%AD%EB%A6%BD%EA%B3%B5%EC%9B%90%EA%B3%B5%EB%8B%A8_%ED%95%B4%EC%99%B8%EA%B5%AD%EB%A6%BD%EA%B3%B5%EC%9B%90%EB%89%B4%EC%8A%A4%EC%A0%95%EB%B3%B4_%EC%B5%9C%EC%8B%A030%EC%9D%BC.csv';
  let globalDeltaCache = null;

  async function loadGlobalDelta() {
    if (globalDeltaCache) return globalDeltaCache;
    const r = await fetch(GLOBAL_DELTA_URL);
    if (!r.ok) throw new Error(`해외 증분 CSV 없음 (${r.status})`);
    const rows = parseCsv(await r.text());
    const ix = Object.fromEntries(rows[0].map((k, i) => [k, i]));
    globalDeltaCache = rows.slice(1)
      .filter((c) => c.length >= rows[0].length)
      .map((c) => ({
        date: c[ix['게시일자']],
        continent: c[ix['대륙']],
        title: c[ix['뉴스제목']],
        press: c[ix['뉴스매체']],
        link: c[ix['url']],
      }));
    return globalDeltaCache;
  }

  function rowsFromGroups(groups) {
    return groups
      .sort((x, y) => y.outletCount - x.outletCount || y.newest - x.newest)
      .slice(0, 30)
      .map((g) => ({
        title: g.lead.title,
        link: g.lead.link,
        press: g.outlets,
        outletCount: g.outletCount,
        reports: g.arts.length,
        time: '',
        others: g.arts.slice(1, 4),
      }));
  }

  async function continentRank(period, continent) {
    const arts = await loadGlobalDelta();
    const days = period === 'week' ? 7 : 30;
    const cut = new Date(Date.now() - days * 86400000).toISOString().slice(0, 10);
    const mine = arts
      .filter((a) => a.date >= cut && a.continent === continent)
      .sort((a, b) => (a.date < b.date ? 1 : -1));
    if (!mine.length) throw new Error('해외 증분에 해당 대륙 기사 없음');

    const groups = window.NewsService.groupIssues(
      mine.map((a) => ({ title: a.title, press: a.press, link: a.link, date: `${a.date}T12:00:00+09:00` })), 0.4);
    const dates = mine.map((a) => a.date);
    return {
      rows: rowsFromGroups(groups),
      note: `${esc(dates[dates.length - 1])} ~ ${esc(dates[0])} · 대륙 태그 수집분 ${mine.length}건 기준(매일 아침 갱신)`,
      continentFiltered: continent,
    };
  }

  async function parkRank(period, parkName) {
    const arts = await loadDelta();
    const days = period === 'week' ? 7 : 30;
    const cut = new Date(Date.now() - days * 86400000).toISOString().slice(0, 10);
    const mine = arts
      /* 제목에 공원명이 있거나, 공원 태그가 '제목' 판정인 기사만 —
         요약에만 스치듯 언급된 기사(APEC 회담 등)가 공원 순위를 오염시킨다 */
      .filter((a) => a.date >= cut
        && (a.title.includes(parkName) || (a.park === parkName && a.basis === '제목')))
      .sort((a, b) => (a.date < b.date ? 1 : -1));           // 최신부터 — 묶음 대표가 최신이 되게
    if (!mine.length) throw new Error('증분에 해당 공원 기사 없음');

    const groups = window.NewsService.groupIssues(
      mine.map((a) => ({ title: a.title, press: a.press, link: a.link, date: `${a.date}T12:00:00+09:00` })), 0.4);
    const dates = mine.map((a) => a.date);
    return {
      rows: rowsFromGroups(groups),
      note: `${esc(dates[dates.length - 1])} ~ ${esc(dates[0])} · 공원 태그 수집분 ${mine.length}건 기준(매일 아침 갱신)`,
      parkFiltered: parkName,
    };
  }

  async function fetchArchive(which, period, parkName = '') {
    /* 공원 필터는 서버에 맡긴다 — 상위 30건으로 자르기 전에 걸러야
       공원별 순위가 제대로 선다 (합친 뒤 거르면 한두 건만 남는다) */
    const pq = parkName ? `&park=${encodeURIComponent(parkName)}` : '';
    const r = await fetch(`/api/ranking-archive?period=${period}&set=${which}${pq}`);
    const data = await r.json().catch(() => ({}));

    if (!r.ok) {
      const err = new Error(data.error || `순위를 불러오지 못했습니다 (${r.status})`);
      err.hint = data.hint;
      err.soft = r.status === 404;      // 자료가 아직 없는 것 — 고장이 아님
      throw err;
    }

    const unitKo = data.unit === 'month' ? '개월' : '일';
    const partial = data.have < data.want
      ? ` · <b>${data.have}${unitKo}치만 쌓여 있습니다</b> (${data.want}${unitKo} 기준 예정)`
      : '';

    return {
      rows: (data.rows || []).map((x) => ({
        title: x.title,
        link: x.link,
        press: x.press || [],
        outletCount: x.outletCount || (x.press || []).length,
        reports: x.reports || 0,
        time: '',
        others: (x.articles || []).slice(1, 4),
      })),
      note: data.note ? esc(data.note) : `${esc(data.from)} ~ ${esc(data.to)} 보도 합산${partial}`,
      parkFiltered: data.park || '',
    };
  }

  /* ==========================================================
   *  제목 → 공원 찾기 (위치 바로가기)
   *
   *  해외 기사는 "Bulldozers tear through Big Bend national park…" 처럼
   *  제목만 봐서는 그 공원이 어디 있는 나라인지 알 수 없다.
   *  제목에서 공원 이름을 찾아내 지도로 보내주는 버튼을 붙인다.
   * ======================================================== */
  let parkIndex = null;

  const reEsc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

  async function ensureParkIndex() {
    if (parkIndex) return parkIndex;
    const idx = [];

    /* 국내 24곳 — '지리산국립공원' → '지리산' 으로 찾는다 */
    for (const r of (window.REGIONS_KR || [])) {
      const key = r.name.replace('국립공원', '').trim();
      if (key.length >= 2) idx.push({ key, park: r, ko: true });
    }

    /* 해외 3,313곳 — 'Big Bend National Park' → 'big bend' */
    const norm = (s) => String(s || '').toLowerCase()
      .replace(/national\s*park|nationalpark|national\s*monument|national\s*preserve/g, ' ')
      .replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();

    try {
      for (const p of await Explorer.allParks()) {
        /* name 과 nameEn 을 둘 다 넣는다.
           미국 Glacier 는 nameEn 이 'Glacier National Park Montana' 라서
           nameEn 만 보면 기사 제목의 'Glacier National Park' 과 안 맞고,
           같은 이름의 캐나다 공원으로 잘못 가버린다. */
        for (const key of new Set([norm(p.nameEn), norm(p.name)])) {
          if (key.length >= 4) idx.push({ key, park: p, re: new RegExp(`\\b${reEsc(key)}\\b`) });
        }
      }
    } catch (e) {
      console.warn('해외 공원 목록을 불러오지 못해 위치 바로가기를 건너뜁니다:', e);
    }

    /* 긴 이름 우선 → 같은 길이면 큐레이션된(유명한) 공원 우선.
       'glacier' 처럼 여러 나라에 같은 이름이 있을 때 뉴스에 나올 법한 쪽을 고른다. */
    idx.sort((a, b) => b.key.length - a.key.length
      || (b.park.curated ? 1 : 0) - (a.park.curated ? 1 : 0));
    parkIndex = idx;
    return idx;
  }

  function findPark(title, idx) {
    const t = String(title).toLowerCase();
    for (const e of idx) {
      if (e.ko) {
        /* '경주' 처럼 짧은 이름은 지명과 겹치므로 '국립공원'이 함께 있을 때만 인정 */
        if (!t.includes(e.key)) continue;
        if (e.key.length <= 2 && !t.includes('국립공원')) continue;
        return e.park;
      }
      if (e.re.test(t)) return e.park;
    }
    return null;
  }

  async function attachParks(rows) {
    try {
      const idx = await ensureParkIndex();
      return rows.map((r) => ({ ...r, park: findPark(r.title, idx) }));
    } catch {
      return rows;                     // 위치 버튼만 빠지고 순위는 그대로 보여준다
    }
  }

  async function fetchRank(which, period) {
    const ck = `${which}|${period}|${state.park || '-'}|${state.continent || '-'}`;
    const hit = state.cache[ck];
    if (hit && Date.now() - hit.at < TTL) return hit.res;

    const park = which === 'kr' && state.park
      ? KR_PARKS.find((p) => p.id === state.park) : null;
    const continent = which === 'global' ? state.continent : '';
    /* 공원(국내)·대륙(국외)+주간·월간은 증분 CSV로 브라우저에서 직접
       집계(풍부·즉시), 실패하면 서버 조회로 폴백. 나머지는 서버 조회. */
    const raw = period === 'live'
      ? await fetchLive(which)
      : (park && (period === 'week' || period === 'month'))
        ? await parkRank(period, park.name)
            .catch(() => fetchArchive(which, period, park.name))
        : (continent && (period === 'week' || period === 'month'))
          ? await continentRank(period, continent)
              .catch(() => fetchArchive(which, period))
          : await fetchArchive(which, period, park ? park.name : '');

    /* 서버가 걸러줬으면(park 응답 확인) 그대로 쓰고,
       옛 캐시 응답(park 없음)에만 예비로 제목·묶인 기사 기준 필터 */
    const rows = park && period !== 'live' && !raw.parkFiltered
      ? raw.rows.filter((r) => r.title.includes(park.name)
          || (r.others || []).some((o) => o.title?.includes(park.name)))
      : raw.rows;

    const withParks = await attachParks(rows);
    const res = { ...raw, rows: withParks.map((r) => ({ ...r, sector: sectorOf(r) })) };
    /* 빈 결과는 캐시하지 않는다 — 일시 장애로 비었을 때 10분간 "없음"으로 굳는다 */
    if (res.rows.length) state.cache[ck] = { at: Date.now(), res };
    return res;
  }

  /* ==========================================================
   *  그리기
   * ======================================================== */
  function medal(i) {
    if (i === 0) return '<b class="rk-no rk-no--1">1</b>';
    if (i === 1) return '<b class="rk-no rk-no--2">2</b>';
    if (i === 2) return '<b class="rk-no rk-no--3">3</b>';
    return `<b class="rk-no">${i + 1}</b>`;
  }

  /** 지도로 보내는 버튼 — 어느 나라 어디쯤인지 알려준다 */
  function locHtml(p) {
    if (!p) return '';
    const where = p.cat === 'kr'
      ? (p.desc || '').split(' · ')[0]                 // 예) '전남·전북·경남'
      : (p.countryKo || p.country || '');
    return `<button type="button" class="rk-loc" data-park="${esc(p.id)}"
      title="지도에서 이 공원 위치 보기">
      <svg viewBox="0 0 24 24" width="11" height="11" aria-hidden="true"><path d="M12 21s7-6.2 7-11a7 7 0 10-14 0c0 4.8 7 11 7 11z" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/><circle cx="12" cy="10" r="2.4" fill="currentColor"/></svg>
      ${esc(p.name)}${where ? ` · ${esc(where)}` : ''}</button>`;
  }

  function rowHtml(r, i, max) {
    const others = r.others || [];
    const s = r.sector;
    return `
      <li class="rk-row">
        ${medal(i)}
        <div class="rk-main">
          ${s ? `<span class="rk-sec" style="--c:${s.color}" title="${esc(s.desc)}">${esc(s.name)}</span>` : ''}
          <a class="rk-title" href="${esc(r.link)}" target="_blank" rel="noopener noreferrer">${esc(r.title)}</a>
          <p class="rk-meta">
            <!-- 'N개사'를 누르면 아래에 언론사 전체 목록이 펼쳐진다 -->
            <button type="button" class="rk-heat" data-outlets="${i}"
              title="누르면 보도한 언론사를 모두 봅니다">${r.outletCount}개사</button>
            <span class="rk-press">${esc(r.press.slice(0, 4).join(' · '))}${r.press.length > 4 ? ` 외 ${r.press.length - 4}` : ''}</span>
            ${r.time ? `<span class="rk-time">${esc(r.time)}</span>` : ''}
            <!-- 검색량 추이 — 자료가 오면 채워진다 (부가 정보라 없어도 무방) -->
            <span class="rk-trend" id="rk-trend-${i}" hidden></span>
          </p>
          <div class="rk-outlets" id="rk-outlets-${i}" hidden>
            <b>보도한 언론사 ${r.press.length}곳</b>
            <ul>${r.press.map((p) => `<li>${esc(p)}</li>`).join('')}</ul>
          </div>
          ${locHtml(r.park)}
          ${others.length ? `<details class="rk-more">
              <summary>관련 보도 ${others.length}건 더보기</summary>
              <ul>${others.map((o) => `
                <li><a href="${esc(o.link)}" target="_blank" rel="noopener noreferrer">
                  ${esc(o.title)}<em>${esc(o.press)}</em></a></li>`).join('')}</ul>
            </details>` : ''}
        </div>
        <!-- 막대 옆에 점수를 숫자로 함께 적는다. 막대만 있으면 '얼마나 큰지'가 안 잡힌다.
             점수 = 이 사안을 보도한 언론사 수 (1위를 100으로 환산한 값도 함께) -->
        <div class="rk-bar" style="--w:${Math.min(100, Math.round(r.outletCount / max * 100))}%">
          <i></i>
          <b class="rk-score" title="보도 언론사 ${r.outletCount}곳 · 기사 ${r.reports}건 · 1위 대비 ${Math.round(r.outletCount / max * 100)}%">${r.outletCount}</b>
        </div>
      </li>`;
  }

  /* ==========================================================
   *  화제성 — '사람들이 실제로 얼마나 찾아봤나'
   *
   *  보도량(언론사 수)만으로는 '언론은 많이 썼는데 아무도 안 찾아본 사안'
   *  과 '기사는 적은데 검색이 몰린 사안'이 구분되지 않는다.
   *  이슈 제목에서 핵심어를 뽑아 네이버 데이터랩 검색량을 함께 보여준다.
   *
   *  ※ 기사 조회수가 아니다. 조회수는 어떤 공개 API로도 얻을 수 없다.
   * ======================================================== */
  const TREND_STOP = new Set(['국립공원', '공원', '국립', '지역', '관련', '올해', '지난',
    '위해', '대한', '이번', '오늘', '내일', '기자', '뉴스', '사진', '영상', '단독']);

  /** 제목에서 검색해 볼 만한 낱말 하나 — 가장 길고 흔하지 않은 것 */
  function coreWord(r) {
    if (r.park?.cat === 'kr') return r.park.name;         // 국내는 공원명이 가장 안정적
    const ws = String(r.title).replace(/[^\p{L}\p{N}\s]/gu, ' ').split(/\s+/)
      .map((w) => w.trim())
      .filter((w) => w.length >= 2 && !TREND_STOP.has(w) && !/^\d+$/.test(w));
    return ws.sort((a, b) => b.length - a.length)[0] || '';
  }

  /** 문자 막대(▁▂▃)는 글꼴에 따라 들쭉날쭉해 지저분하다 — 매끈한 SVG 선으로 그린다 */
  const spark = (vals) => {
    const W = 56, H = 14, P = 1.5;
    const mx = Math.max(...vals), mn = Math.min(...vals);
    const span = mx - mn || 1;
    const pts = vals.map((v, i) =>
      `${(P + i * (W - 2 * P) / (vals.length - 1)).toFixed(1)},${(H - P - (v - mn) / span * (H - 2 * P)).toFixed(1)}`);
    const [lx, ly] = pts[pts.length - 1].split(',');
    return `<svg viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" aria-hidden="true">
      <polyline points="${pts.join(' ')}" fill="none" stroke="currentColor" stroke-width="1.5"
        stroke-linecap="round" stroke-linejoin="round" opacity=".8"/>
      <circle cx="${lx}" cy="${ly}" r="1.8" fill="currentColor"/></svg>`;
  };

  /** 상위 몇 건만 — 데이터랩은 한 번에 키워드 5개까지 받는다 */
  async function renderTrends(rows) {
    const targets = rows
      .map((r, i) => ({ i, w: coreWord(r) }))
      .filter((x) => x.w)
      .slice(0, 10);
    if (!targets.length) return;

    for (let n = 0; n < targets.length; n += 5) {
      const chunk = targets.slice(n, n + 5);
      try {
        /* 주 단위로 12주 — 기본값(14일)이면 두 칸밖에 안 나와 추이가 안 보인다 */
        const since = new Date(Date.now() - 84 * 86400000).toISOString().slice(0, 10);
        const q = new URLSearchParams({
          keywords: chunk.map((c) => c.w).join(','), unit: 'week', start: since,
        });
        const res = await fetch(`/api/datalab?${q}`);
        if (!res.ok) return;                       // 키 미설정 등 — 조용히 건너뛴다
        const data = await res.json();
        for (const g of data.results || []) {
          const hit = chunk.find((c) => c.w === g.title);
          const el = hit && $(`#rk-trend-${hit.i}`);
          const pts = (g.data || []).map((d) => d.ratio);
          if (!el || pts.length < 3) continue;
          if (Math.max(...pts) === Math.min(...pts)) continue;   // 변동 없음 — 그릴 정보가 없다
          const last = pts[pts.length - 1];
          const prev = pts.length >= 2 ? pts[pts.length - 2] : last;
          const dir = last > prev * 1.15 ? '▲' : last < prev * 0.85 ? '▼' : '·';
          el.innerHTML = `<span class="rk-spark" title="'${esc(g.title)}' 최근 검색량 추이">${spark(pts)}</span>`
            + `<em class="rk-dir rk-dir--${dir === '▲' ? 'up' : dir === '▼' ? 'down' : 'flat'}">${dir}</em>`;
          el.hidden = false;
        }
      } catch { /* 화제성은 부가 정보 — 실패해도 순위는 그대로 */ }
    }
  }

  function syncTabs() {
    $('#rk-tab-kr')?.classList.toggle('is-on', state.tab === 'kr');
    $('#rk-tab-global')?.classList.toggle('is-on', state.tab === 'global');
    document.querySelectorAll('#rk-periods .rk-tab').forEach((b) => {
      b.classList.toggle('is-on', b.dataset.period === state.period);
    });

    /* 국내 = 분야 고르기 (구조대는 '구조활동'만 따로 보고 싶을 때가 많다),
       국외 = 대륙 고르기 (분류 사전이 한글 낱말뿐이라 분야는 영문 제목에 무의미) */
    const sbox = $('#rk-sectors');
    if (sbox) {
      sbox.hidden = false;
      sbox.innerHTML = state.tab === 'kr'
        ? `
        <button class="rk-sec-btn${state.sector ? '' : ' is-on'}" data-sector="">전체 분야</button>
        ${SECTORS.map((s) => `
          <button class="rk-sec-btn${state.sector === s.key ? ' is-on' : ''}"
            style="--c:${s.color}" data-sector="${s.key}">${esc(s.name)}</button>`).join('')}`
        : `
        <button class="rk-sec-btn${state.continent ? '' : ' is-on'}" data-continent="">전체 대륙</button>
        ${CONTINENTS.map((c) => `
          <button class="rk-sec-btn${state.continent === c ? ' is-on' : ''}"
            style="--c:#60a5fa" data-continent="${c}">${esc(c)}</button>`).join('')}`;
    }

    /* 공원 선택은 국내에서만 의미가 있다 */
    const box = $('#rk-parks');
    if (!box) return;
    box.hidden = state.tab !== 'kr' || !KR_PARKS.length;
    if (box.hidden) return;
    box.innerHTML = `
      <button class="rk-park${state.park ? '' : ' is-on'}" data-park="">전체</button>
      ${KR_PARKS.map((p) => `
        <button class="rk-park${state.park === p.id ? ' is-on' : ''}" data-park="${esc(p.id)}">
          ${esc(p.name)}
        </button>`).join('')}`;
  }

  async function render(retried = false) {
    const body = $('#rk-body');
    if (!body) return;
    syncTabs();

    const pk = state.tab === 'kr' && state.park
      ? KR_PARKS.find((p) => p.id === state.park) : null;
    const label = `${pk ? `${pk.name}국립공원` : SETS[state.tab].label} · ${PERIODS[state.period]}`;
    body.innerHTML = `<div class="rk-state"><span class="dots"><i></i><i></i><i></i></span> ${esc(label)} 순위를 집계하는 중…</div>`;

    const token = `${state.tab}|${state.period}`;
    state.loading = token;

    try {
      const res = await fetchRank(state.tab, state.period);
      const all = res.rows;
      const note = res.note;
      if (state.loading !== token) return;         // 그 사이 다른 탭을 눌렀으면 버림

      const filterOn = state.tab === 'kr' ? state.sector : state.continent;
      /* 대륙은 증분 CSV 집계가 이미 걸러서 온다(continentFiltered) —
         그때는 다시 거르지 않는다 (재필터하면 공원 매칭 안 된 기사가 다 빠진다) */
      const rows = state.tab === 'kr'
        ? (state.sector ? all.filter((r) => r.sector?.key === state.sector) : all)
        : (state.continent && !res.continentFiltered
          ? all.filter((r) => r.park?.continentKo === state.continent) : all);
      if (!rows.length) {
        const fn = state.tab === 'kr'
          ? SECTORS.find((s) => s.key === state.sector)?.name : state.continent;
        const parkSel = state.tab === 'kr' && state.park
          ? KR_PARKS.find((p) => p.id === state.park)?.name : '';
        const quiet = filterOn || parkSel;      // 필터 때문에 빈 것 — 재시도가 소용없다
        body.innerHTML = `<div class="rk-state">${
          filterOn
            ? (state.tab === 'kr'
              ? `이 기간에 <b>${esc(fn)}</b> 분야로 분류된 사안이 없습니다.`
              : `이 기간에 <b>${esc(fn)}</b> 대륙 기사가 없습니다.`)
            : parkSel
              ? `이 기간에 <b>${esc(parkSel)}</b> 관련 보도가 없습니다.`
              : '집계할 기사를 찾지 못했습니다.'
        }${quiet ? '' : ' <button class="rk-retry" type="button">다시 시도</button>'}</div>`;
        body.querySelector('.rk-retry')?.addEventListener('click', () => render());
        return;
      }
      const max = Math.max(...rows.map((r) => r.outletCount)) || 1;
      const filterName = state.tab === 'kr'
        ? SECTORS.find((s) => s.key === state.sector)?.name : state.continent;
      body.innerHTML = `
        <p class="rk-note">
          <span class="rk-note__l">같은 사안을 보도한 <b>언론사 수</b>로 순위를 매깁니다 · 조회수가 아닙니다</span>
          <span class="rk-note__r">${label}${filterName ? ` · ${esc(filterName)}` : ''} · 상위 ${rows.length}건${
            filterOn && !res.continentFiltered ? ` / 전체 ${all.length}건` : ''}${
            state.tab === 'global' && state.continent && !res.continentFiltered
              ? ' · 제목에서 공원이 파악된 기사만' : ''} · ${note}</span>
        </p>
        <ol class="rk-list">${rows.map((r, i) => rowHtml(r, i, max)).join('')}</ol>`;
      renderTrends(rows.slice(0, 8));
    } catch (e) {
      if (state.loading !== token) return;
      console.warn(e);
      /* soft = 보관본이 아직 안 쌓인 것 — 재시도해도 소용없으니 안내만 한다.
         그 외는 일시 장애 — 재시도 버튼과 함께 한 번은 자동으로 다시 시도한다. */
      body.innerHTML = e.soft
        ? `<div class="rk-state">
             ${esc(e.message)}
             ${e.hint ? `<small>${esc(e.hint)}</small>` : ''}
           </div>`
        : `<div class="rk-state">순위를 불러오지 못했습니다. 잠시 후 자동으로 다시 시도합니다.
             <button class="rk-retry" type="button">지금 다시 시도</button></div>`;
      body.querySelector('.rk-retry')?.addEventListener('click', () => render());
      if (!e.soft && !retried) setTimeout(() => {
        if (isOpen() && state.loading === token && body.querySelector('.rk-retry')) render(true);
      }, 7000);
    }
  }

  /* 창 열고 닫기 — 여는 것도 방문 기록에 남겨 뒤로가기로 닫을 수 있게 한다.
     휴대폰에서 창을 닫으려고 뒤로가기를 눌렀다가 사이트를 나가버리는 일을 막는다. */
  const HASH = '#ranking';
  const show = () => { $('#ranking').classList.add('is-open'); document.body.classList.add('dg-lock'); render(); };
  const hide = () => { $('#ranking').classList.remove('is-open'); document.body.classList.remove('dg-lock'); };
  const isOpen = () => $('#ranking')?.classList.contains('is-open');

  const open = () => {
    if (isOpen()) return;
    try { history.pushState({ modal: 'ranking' }, '', HASH); } catch { /* 무시 */ }
    show();
  };
  /** 닫기 버튼·ESC·바깥 클릭 — 쌓아둔 기록을 하나 되돌린다 */
  const close = () => {
    if (!isOpen()) return;
    hide();
    if (location.hash === HASH) { try { history.back(); } catch { /* 무시 */ } }
  };

  function init() {
    $('#btn-ranking')?.addEventListener('click', open);
    $('#rk-close')?.addEventListener('click', close);
    $('#ranking')?.addEventListener('click', (e) => { if (e.target.id === 'ranking') close(); });
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && isOpen()) close();
    });
    /* 뒤로가기·앞으로가기에 맞춰 창을 열고 닫는다 */
    window.addEventListener('popstate', () => {
      if (location.hash === HASH) { if (!isOpen()) show(); }
      else if (isOpen()) hide();
    });
    /* 'N개사' — 보도한 언론사 목록을 펼치고 접는다 */
    $('#rk-body')?.addEventListener('click', (e) => {
      const h = e.target.closest('.rk-heat');
      if (!h) return;
      const box = $(`#rk-outlets-${h.dataset.outlets}`);
      if (box) { box.hidden = !box.hidden; h.classList.toggle('is-on', !box.hidden); }
    });

    /* 위치 바로가기 — 순위 창을 닫고 그 공원으로 지도를 이동시킨다 */
    $('#rk-body')?.addEventListener('click', (e) => {
      const b = e.target.closest('.rk-loc');
      if (!b) return;
      const p = (parkIndex || []).find((x) => x.park.id === b.dataset.park)?.park;
      if (!p || !window.ParkMap) return;
      /* 여기서는 기록을 되돌리지 않는다 — 지도로 간 뒤 뒤로가기를 누르면
         순위 창으로 되돌아오는 편이 자연스럽다 */
      hide();
      window.ParkMap.select(p);
    });

    $('#rk-tab-kr')?.addEventListener('click', () => { state.tab = 'kr'; state.continent = ''; remember(); render(); });
    $('#rk-tab-global')?.addEventListener('click', () => { state.tab = 'global'; state.park = ''; state.sector = ''; remember(); render(); });
    $('#rk-parks')?.addEventListener('click', (e) => {
      const b = e.target.closest('.rk-park');
      if (!b) return;
      state.park = b.dataset.park || '';
      render();
    });
    $('#rk-sectors')?.addEventListener('click', (e) => {
      const b = e.target.closest('.rk-sec-btn');
      if (!b) return;
      if (b.dataset.continent !== undefined) state.continent = b.dataset.continent || '';
      else state.sector = b.dataset.sector || '';
      render();
    });
    $('#rk-periods')?.addEventListener('click', (e) => {
      const b = e.target.closest('.rk-tab');
      if (!b || !b.dataset.period) return;
      state.period = b.dataset.period;
      remember();
      render();
    });
    $('#rk-refresh')?.addEventListener('click', () => { state.cache = {}; render(); });
  }

  return { init, open, close };
})();
