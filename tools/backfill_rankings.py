# -*- coding: utf-8 -*-
"""아카이브(네이버 검색 수집분)로 인기뉴스 보관본을 사후 집계한다.

  python tools/backfill_rankings.py

  · 월간 집계본  data/ranking/month-YYYY-MM.json  — 연간 조회(12개월)를 즉시 채움
  · 일간 보관본  data/ranking/YYYY-MM-DD.json     — 월간 조회(30일 창)를 채움
  · 이미 있는 파일(RSS 크론 수집분)은 절대 덮지 않는다
  · backfilled/source 표시를 남긴다 — 없는 걸 있는 척하지 않기

왜 가능한가: 아카이브 원장(5.7만 건)에 게시일자·제목·매체가 다 있다.
왜 완전하지 않은가: 아카이브는 제목 기준 중복 제거를 거쳤고(같은 제목 전재 유실)
네이버 검색 표본이라, RSS 크론 수집분보다 언론사 수가 적게 잡힐 수 있다.
그래도 상위 사안 순위는 뚜렷하게 선다 (2026-07 실측: 29개사 한라산 단속 등).

묶음 알고리즘은 api/ranking-archive.js 의 groupByIssue 를 그대로 이식했다
(토큰 유사도 0.5 · 조사 제거 · 따옴표 핵심어 거부권) — RSS 수집분과 사상 일치.
"""
import csv
import io
import json
import os
import re
import sys
import zipfile
from datetime import date, datetime, timedelta, timezone

sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8")

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATASET = os.path.join(ROOT, "data", "dataset")
RANKING = os.path.join(ROOT, "data", "ranking")

import glob as _glob


def _newest(pattern):
    """전체판은 주 1회 재생성되며 날짜가 바뀐다 — 항상 최신 zip을 잡는다"""
    hits = sorted(_glob.glob(os.path.join(os.path.dirname(os.path.dirname(
        os.path.abspath(__file__))), "data", "dataset", pattern)))
    if not hits:
        raise SystemExit(f"없음: {pattern}")
    return os.path.basename(hits[-1])


KR_ZIP = _newest("국립공원공단_국립공원뉴스정보_2*.zip")
GLOBAL_ZIP = _newest("국립공원공단_해외국립공원뉴스정보_2*.zip")

TOP_PER_DAY = 80          # 서버와 동일 (40→80: 단독 보도까지 보관해야 공원별 순위가 선다)
MAX_ARTICLES = 10         # 묶음당 보관할 기사 수 (파일 크기 관리)

MONTH_FROM, MONTH_TO = "2025-09", "2026-07"   # 연간 12개월 창 (2026-08은 RSS분 존재)
DAY_FROM, DAY_TO = "2026-07-22", "2026-08-08"  # 월간 30일 창의 RSS 이전 구간

# ---------- 서버 groupByIssue 이식 ----------
STOP = {"국립공원", "공원", "국립", "지난", "올해", "관련", "이날"}
JOSA = re.compile(r"(에서|에게|으로|과의|와의|은|는|이|가|을|를|에|의|서|와|과|도|로)$")
KEY_RE = re.compile(r"[‘'\"“]([^’'\"”]{2,20})[’'\"”]")
DOW = ["일", "월", "화", "수", "목", "금", "토"]


def tokens(title):
    out = set()
    for w in re.sub(r"[^\w\s]", " ", title, flags=re.U).split():
        w = JOSA.sub("", w) if len(w) >= 3 else w
        if len(w) >= 2 and w not in STOP:
            out.add(w)
    return out


def similarity(a, b):
    i = len(a & b)
    if not i:
        return 0.0
    return max(i / (len(a) + len(b) - i), i / min(len(a), len(b)))


def group_issues(articles):
    """기사 목록 → 서버 스키마의 rows (outletCount desc, reports desc)"""
    groups = []
    for a in articles:
        tk = tokens(a["title"])
        ky = set(KEY_RE.findall(a["title"]))
        g = None
        for x in groups:
            if similarity(x["tk"], tk) < 0.5:
                continue
            if ky and x["ky"] and not (ky & x["ky"]):
                continue
            g = x
            break
        if g:
            g["arts"].append(a)
            g["tk"] |= tk
            g["ky"] |= ky
        else:
            groups.append({"tk": tk, "ky": ky, "arts": [a]})

    rows = []
    for g in groups:
        press = []
        for a in g["arts"]:
            if a["press"] not in press:
                press.append(a["press"])
        rows.append({
            "title": g["arts"][0]["title"],
            "reports": len(g["arts"]),
            "press": press,
            "outletCount": len(press),
            "articles": [
                {"title": a["title"], "press": a["press"], "link": a["link"]}
                for a in g["arts"][:MAX_ARTICLES]
            ],
            "link": g["arts"][0]["link"],
        })
    rows.sort(key=lambda r: (-r["outletCount"], -r["reports"]))
    return rows[:TOP_PER_DAY]


# ---------- 아카이브 읽기 ----------
def load_zip(name):
    z = zipfile.ZipFile(os.path.join(DATASET, name))
    rows = list(csv.DictReader(io.TextIOWrapper(z.open(z.namelist()[0]), encoding="utf-8-sig")))
    return [
        {"date": r["게시일자"], "title": r["뉴스제목"], "press": r["뉴스매체"], "link": r["url"]}
        for r in rows
        if r.get("게시일자") and r.get("뉴스제목") and r.get("뉴스매체")
    ]


def korean(ds):
    d = date.fromisoformat(ds)
    return f"{d.year}년 {d.month}월 {d.day}일 {DOW[d.isoweekday() % 7]}요일"


def month_range(a, b):
    y, m = map(int, a.split("-"))
    while True:
        cur = f"{y}-{m:02d}"
        if cur > b:
            return
        yield cur
        m += 1
        if m > 12:
            y, m = y + 1, 1


def day_range(a, b):
    d = date.fromisoformat(a)
    while d.isoformat() <= b:
        yield d.isoformat()
        d += timedelta(days=1)


def write_json(path, data):
    with open(path, "w", encoding="utf-8", newline="\n") as f:
        json.dump(data, f, ensure_ascii=False, indent=2)
        f.write("\n")


NOTE = "아카이브(네이버 검색 수집분) 사후 집계 — 표본이 달라 언론사 수가 실제보다 적을 수 있음"


def main():
    kr = load_zip(KR_ZIP)
    gl = load_zip(GLOBAL_ZIP)
    print(f"아카이브 로드: 국내 {len(kr):,} · 해외 {len(gl):,}")
    now = datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")
    made_months, made_days, skipped = [], [], []

    # ── 월간 집계본
    for ym in month_range(MONTH_FROM, MONTH_TO):
        path = os.path.join(RANKING, f"month-{ym}.json")
        if os.path.exists(path):
            skipped.append(f"month-{ym}")
            continue
        kr_m = [a for a in kr if a["date"].startswith(ym)]
        gl_m = [a for a in gl if a["date"].startswith(ym)]
        if not kr_m and not gl_m:
            skipped.append(f"month-{ym}(자료없음)")
            continue
        dates = sorted({a["date"] for a in kr_m + gl_m})
        rollup = {
            "month": ym,
            "days": len(dates),
            "from": dates[0],
            "to": dates[-1],
            "generatedAt": now,
            "backfilled": True,
            "source": NOTE,
            "kr": {"rows": group_issues(kr_m)},
            "global": {"rows": group_issues(gl_m)},
        }
        write_json(path, rollup)
        made_months.append(ym)
        print(f"  month-{ym}: 국내 {len(kr_m)}건→{len(rollup['kr']['rows'])}행 · 해외 {len(gl_m)}건→{len(rollup['global']['rows'])}행")

    # ── 일간 보관본
    new_dates = []
    for ds in day_range(DAY_FROM, DAY_TO):
        path = os.path.join(RANKING, f"{ds}.json")
        if os.path.exists(path):
            skipped.append(ds)
            continue
        kr_d = [a for a in kr if a["date"] == ds]
        gl_d = [a for a in gl if a["date"] == ds]
        if not kr_d and not gl_d:
            skipped.append(f"{ds}(자료없음)")
            continue
        snap = {
            "date": ds,
            "dateKo": korean(ds),
            "generatedAt": now,
            "backfilled": True,
            "source": NOTE,
            "kr": {"collected": len(kr_d), "failedQueries": 0, "rows": group_issues(kr_d)},
            "global": {"collected": len(gl_d), "failedQueries": 0, "rows": group_issues(gl_d)},
        }
        write_json(path, snap)
        made_days.append(ds)
        new_dates.append(ds)
        print(f"  {ds}: 국내 {len(kr_d)}건 · 해외 {len(gl_d)}건")

    # ── 보관 목록 갱신
    idx_path = os.path.join(RANKING, "index.json")
    idx = json.load(open(idx_path, encoding="utf-8"))
    before = len(idx.get("dates", []))
    idx["dates"] = sorted(set(idx.get("dates", [])) | set(new_dates), reverse=True)[:400]
    idx["updatedAt"] = now
    write_json(idx_path, idx)

    print(f"\n월간 {len(made_months)}개 · 일간 {len(made_days)}개 생성, {len(skipped)}개 건너뜀")
    print(f"목록: {before} → {len(idx['dates'])}개 날짜")


if __name__ == "__main__":
    main()
