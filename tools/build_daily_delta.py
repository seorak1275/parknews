# -*- coding: utf-8 -*-
"""자료받기의 '최신 30일 증분' CSV를 매일 아침 새로 만든다.

  python tools/build_daily_delta.py

전체판 재생성은 회당 ~35MB를 커밋해서 매일 돌리면 저장소가 감당 못 한다
(zip은 git 이 델타 압축을 못 한다). 그래서 이원화한다:
  · 전체판(5.7만 건, zip 포함)  — 주 1회 (dataset.yml)
  · 최신 30일 증분(이 스크립트) — 매일 (daily-delta.yml, 수백 KB)

질의는 전체판과 같은 127개, 다만 질의당 1쪽(100건)만 받는다 — 최근 30일은
그 안에 충분히 들어온다. 컬럼은 포털 형식(국립공원공단_국립공원뉴스정보)과
동일해서 받아서 이어 붙이면 그대로 전체판의 연장이 된다.
파일명에 날짜를 붙이지 않는다 — 링크가 매일 안 바뀌게 (내용만 갱신).
"""
import csv
import io
import json
import os
import re
import sys
import time
from concurrent.futures import ThreadPoolExecutor
from datetime import date, timedelta

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8")
import build_news_archive as bna
import build_global_news as bgn

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DST = os.path.join(REPO, "data", "dataset")
FILE = "국립공원공단_국립공원뉴스정보_최신30일.csv"
GL_FILE = "국립공원공단_해외국립공원뉴스정보_최신30일.csv"
DAYS = 30

KR_H = ["게시일자", "공원명", "소재지", "분야_자동분류", "세부분류_자동분류",
        "뉴스제목", "뉴스매체", "url", "공원판정근거", "분류방법"]
GL_H = ["게시일자", "공원명", "영문공원명", "국가", "대륙", "기사언어",
        "분야_자동분류", "뉴스제목", "뉴스매체", "url", "분류방법"]


def build_global(cutoff):
    """해외판 최근 30일 — 국외 대륙별 순위의 재료 (국내판과 같은 이유·같은 리듬)"""
    data = json.load(io.open(os.path.join(REPO, "assets", "data", "parks-global.json"),
                             encoding="utf-8"))
    parks = [p for p in data["parks"] if p.get("curated")]
    rows, seen = [], set()

    def add(p, title, desc, press, link, lang, table):
        k = re.sub(r"\W", "", title)[:40]
        if k in seen:
            return
        seen.add(k)
        rows.append({
            "게시일자": "", "공원명": p.get("nameLocal") or p["name"],
            "영문공원명": p.get("nameEn") or p["name"],
            "국가": p.get("countryKo") or "미상", "대륙": p.get("continentKo") or "미상",
            "기사언어": lang,
            "분야_자동분류": bgn.sector_of(f"{title} {desc}", table) or "기타",
            "뉴스제목": title, "뉴스매체": press or "미상", "url": link,
            "분류방법": "규칙기반 자동분류(제목·요약 낱말 대조)",
        })
        return rows[-1]

    # (1) 한국 언론 (네이버, 1쪽씩)
    ko_parks = [p for p in parks if p.get("nameLocal") and p["nameLocal"] != p.get("nameEn")]
    kq = {}
    for p in ko_parks:
        q = p["nameLocal"]
        if "국립공원" not in q:
            q += " 국립공원"
        kq[q] = p
    with ThreadPoolExecutor(max_workers=8) as ex:
        for q, items in ex.map(bgn.naver, [(q, 1) for q in kq]):
            p = kq[q]
            short = re.sub(r"\s*국립공원\s*$", "", p["nameLocal"]).strip()
            for a in items:
                t, d = bgn.clean(a.get("title")), bgn.clean(a.get("description"))
                link = a.get("originallink") or a.get("link") or ""
                if not t or not link or any(w in t for w in bgn.NOISE):
                    continue
                if short and short not in f"{t} {d}":
                    continue
                day = bgn.kst(a.get("pubDate", ""))
                if not day or day < cutoff:
                    continue
                r = add(p, t, d, re.sub(r"^https?://(www\.)?", "", link).split("/")[0],
                        link, "한국어", bgn.SECTORS_KO)
                if r:
                    r["게시일자"] = day

    # (2) 현지 영문 (구글 뉴스 RSS)
    eq = {}
    for p in parks:
        n = p.get("nameEn") or p["name"]
        eq[n if "ational" in n else f"{n} national park"] = p
    with ThreadPoolExecutor(max_workers=6) as ex:
        for q, items in ex.map(bgn.google, list(eq)):
            p = eq[q]
            base = re.sub(r"(?i)\s*national\s*park.*$", "", p.get("nameEn") or p["name"]).strip()
            for a in items:
                t = a.get("title", "")
                if not t or not a.get("link"):
                    continue
                if base and base.lower() not in t.lower():
                    continue
                day = bgn.kst(a.get("pubDate", ""))
                if not day or day < cutoff:
                    continue
                r = add(p, t, "", a.get("press", ""), a["link"], "영어", bgn.SECTORS_EN)
                if r:
                    r["게시일자"] = day

    rows.sort(key=lambda r: r["게시일자"], reverse=True)
    return rows


def update_index(entries):
    """자료받기 목록에 증분 항목들을 넣거나 갱신"""
    idx_path = os.path.join(DST, "index.json")
    idx = json.load(io.open(idx_path, encoding="utf-8"))
    items = idx.get("items", [])
    for e in entries:
        items = [i for i in items if i.get("file") != e["file"]]
        items.insert(0, e)
    idx["items"] = items
    idx["generatedAt"] = time.strftime("%Y-%m-%dT%H:%M:%S+09:00")
    io.open(idx_path, "w", encoding="utf-8").write(json.dumps(idx, ensure_ascii=False, indent=1))


def main():
    queries = []
    for name, _ in bna.PARKS:
        queries += [f"{name} 국립공원", f"{name} 국립공원 사고", f"{name} 국립공원 탐방",
                    f"{name} 국립공원 생태", f"{name} 국립공원 구조"]
    queries += ["국립공원공단", "국립공원 정책", "국립공원 산불", "국립공원 멸종위기",
                "국립공원 안전사고", "국립공원 구조", "국립공원 탐방객"]
    jobs = [(q, 1) for q in queries]
    print(f"질의 {len(queries)}개 × 1쪽")

    raw = []
    with ThreadPoolExecutor(max_workers=8) as ex:
        for _query, items in ex.map(bna.page, jobs):
            raw += items
    print(f"원시 {len(raw):,}건")

    cutoff = (date.today() - timedelta(days=DAYS)).isoformat()
    seen, rows = set(), []
    for a in raw:
        title = bna.clean(a.get("title"))
        desc = bna.clean(a.get("description"))
        link = a.get("originallink") or a.get("link") or ""
        if not title or not link:
            continue
        if any(w in title for w in bna.NOISE):
            continue
        text = f"{title} {desc}"
        if "국립공원" not in text and "공원공단" not in text:
            continue
        day = bna.kst(a.get("pubDate", ""))
        if not day or day < cutoff:
            continue
        key = re.sub(r"\W", "", title)[:40]
        if key in seen:
            continue
        seen.add(key)

        park = next((n for n, _ in bna.PARKS if n in title), "")
        basis = "제목" if park else ""
        if not park:
            park = next((n for n, _ in bna.PARKS if n in desc), "")
            basis = "요약" if park else ""
        press = re.sub(r"^https?://(www\.)?", "", link).split("/")[0]
        sec, _sc, _margin = bna.sector_of(text)
        rows.append({
            "게시일자": day,
            "공원명": park or "(전체·공통)",
            "소재지": next((loc for n, loc in bna.PARKS if n == park), "") or "전국·공통",
            "분야_자동분류": sec or "기타",
            "세부분류_자동분류": bna.subsector_of(sec, text) or "미분류",
            "뉴스제목": title,
            "뉴스매체": press or "미상",
            "url": link,
            "공원판정근거": basis or "해당없음",
            "분류방법": "규칙기반 자동분류(제목·요약 낱말 대조)",
        })
    rows.sort(key=lambda r: r["게시일자"], reverse=True)
    print(f"최근 {DAYS}일 선별 {len(rows):,}건 ({cutoff} ~)")

    if len(rows) < 50:
        # 수집 실패로 빈 파일을 만들면 어제까지 멀쩡하던 증분이 사라진다.
        print(f"너무 적어({len(rows)}건) 갱신하지 않습니다 — 기존 파일 유지")
        return 0

    entries = []
    path = os.path.join(DST, FILE)
    with io.open(path, "w", encoding="utf-8-sig", newline="") as f:
        w = csv.DictWriter(f, fieldnames=KR_H)
        w.writeheader()
        w.writerows(rows)
    size = os.path.getsize(path)
    print(f"✓ {FILE}  {len(rows):,}행  {size / 1024:.0f}KB")
    entries.append({
        "file": FILE, "name": FILE,
        "desc": f"최신 {DAYS}일 뉴스 (매일 아침 갱신 · 전체판은 주 1회 재생성)",
        "rows": len(rows), "size": size, "rawSize": size,
        "gz": True, "packed": False,
    })

    # ── 해외판 — 국외 대륙별 순위의 재료
    gl = build_global(cutoff)
    print(f"해외 최근 {DAYS}일 선별 {len(gl):,}건")
    if len(gl) >= 30:
        gp = os.path.join(DST, GL_FILE)
        with io.open(gp, "w", encoding="utf-8-sig", newline="") as f:
            w = csv.DictWriter(f, fieldnames=GL_H)
            w.writeheader()
            w.writerows(gl)
        gsize = os.path.getsize(gp)
        print(f"✓ {GL_FILE}  {len(gl):,}행  {gsize / 1024:.0f}KB")
        entries.append({
            "file": GL_FILE, "name": GL_FILE,
            "desc": f"해외 최신 {DAYS}일 뉴스 (매일 아침 갱신 · 대륙·국가 태그 포함)",
            "rows": len(gl), "size": gsize, "rawSize": gsize,
            "gz": True, "packed": False,
        })
    else:
        print(f"해외분이 너무 적어({len(gl)}건) 갱신하지 않습니다 — 기존 파일 유지")

    # 목록 갱신 — 내려받기 화면(data.html)이 이 목록을 읽는다
    update_index(entries)
    print("index.json 갱신")
    return 0


if __name__ == "__main__":
    sys.exit(main())
