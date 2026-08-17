# -*- coding: utf-8 -*-
"""뉴스 검색용 색인을 만든다.

  python tools/build_search_index.py

왜 색인을 따로 두나
  아카이브 CSV 는 30MB 다. 검색할 때마다 이걸 통째로 내려받게 하면
  느리고 데이터도 많이 쓴다. 검색에 필요한 항목만 남기고 **연도별로**
  쪼개 두면, 고른 연도치(1~2MB)만 받아 쓰면 된다.
  서버 없이 정적 파일만으로 검색이 돌아간다.

만드는 것
  data/search/index.json     연도 목록·건수·공원/분야 목록
  data/search/<연도>.json     그 해 기사 (배열의 배열 — 키 이름을 빼 용량을 줄임)

한 줄 구조 (자리마다 뜻이 정해져 있다)
  [보도일(MM-DD), 공원, 분야, 세부분류, 신뢰도, 근접도, 제목, 매체, url]
"""
import csv, glob, io, json, os, sys, time
from collections import Counter

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC = sys.argv[1] if len(sys.argv) > 1 else os.path.join(
    os.path.expanduser("~"), "Desktop", "데이터뱅크_국립공원뉴스")
DST = os.path.join(REPO, "data", "search")

CONF = {"상": 3, "중": 2, "하": 1, "미분류": 0}
NEAR = {"높음": 1, "낮음": 0}


def newest(pat):
    fs = sorted(glob.glob(os.path.join(SRC, pat)))
    return fs[-1] if fs else None


def main():
    src = newest("국립공원_뉴스아카이브_네이버_*.csv")
    if not src:
        print("아카이브가 없습니다. build_news_archive.py 를 먼저 돌리세요."); return
    rows = list(csv.DictReader(io.open(src, encoding="utf-8-sig")))
    print(f"원본 {len(rows):,}건")

    os.makedirs(DST, exist_ok=True)
    for f in os.listdir(DST):
        os.remove(os.path.join(DST, f))

    by_year = {}
    for r in rows:
        d = r.get("보도일") or ""
        if len(d) != 10:
            continue
        y = d[:4]
        by_year.setdefault(y, []).append([
            d[5:],                                   # MM-DD (연도는 파일명에 있다)
            r.get("공원", ""),
            r.get("섹터", ""),
            r.get("세부분류", ""),
            CONF.get(r.get("분류신뢰도", ""), 0),
            NEAR.get(r.get("주제근접도", ""), 0),
            r.get("제목", ""),
            r.get("매체도메인", ""),
            r.get("링크", ""),
        ])

    years = sorted(by_year, reverse=True)
    meta = []
    for y in years:
        items = sorted(by_year[y], key=lambda x: x[0], reverse=True)
        p = os.path.join(DST, f"{y}.json")
        io.open(p, "w", encoding="utf-8").write(
            json.dumps(items, ensure_ascii=False, separators=(",", ":")))
        kb = os.path.getsize(p) / 1024
        meta.append({"year": y, "count": len(items), "sizeKB": round(kb)})
        if len(items) > 500:
            print(f"  {y}  {len(items):6,}건  {kb:7,.0f}KB")

    idx = {
        "generatedAt": time.strftime("%Y-%m-%dT%H:%M:%S+09:00"),
        "total": sum(m["count"] for m in meta),
        "fields": ["date", "park", "sector", "sub", "conf", "near", "title", "press", "url"],
        "conf": {"3": "상", "2": "중", "1": "하", "0": "미분류"},
        "years": meta,
        "parks": [p for p, _ in Counter(r.get("공원", "") for r in rows).most_common() if p],
        "sectors": [s for s, _ in Counter(r.get("섹터", "") for r in rows).most_common() if s],
        "subs": sorted({r.get("세부분류", "") for r in rows} - {""}),
    }
    io.open(os.path.join(DST, "index.json"), "w", encoding="utf-8").write(
        json.dumps(idx, ensure_ascii=False, indent=1))

    tot = sum(os.path.getsize(os.path.join(DST, f)) for f in os.listdir(DST))
    print(f"\n{len(years)}개 연도 · {idx['total']:,}건 · 합계 {tot/1024/1024:.1f}MB")
    print("대상:", DST)


if __name__ == "__main__":
    sys.stdout.reconfigure(encoding="utf-8")
    main()
