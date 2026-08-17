# -*- coding: utf-8 -*-
"""이미 모아 둔 아카이브를 분류 기준만 바꿔 다시 매긴다.

  python tools/reclassify_archive.py

분류 낱말(SECTORS/SUBSECTORS)을 고칠 때마다 5만 건을 다시 긁어 오면
네이버 할당량이 아깝고 시간도 오래 걸린다. 제목·요약은 이미 CSV 에 있으니
분류 칸만 다시 계산하면 된다. 새 기사를 받아오지는 않는다.

build_news_archive.py 의 sector_of / subsector_of / confidence 를 그대로 쓴다.
(기준이 두 벌이 되지 않도록 불러다 쓴다)
"""
import csv, io, glob, os, sys
from collections import Counter

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from build_news_archive import sector_of, subsector_of, confidence  # noqa: E402

SRC = sys.argv[1] if len(sys.argv) > 1 else os.path.join(
    os.path.expanduser("~"), "Desktop", "데이터뱅크_국립공원뉴스")


def main():
    fs = sorted(glob.glob(os.path.join(SRC, "국립공원_뉴스아카이브_네이버_*.csv")))
    if not fs:
        print("아카이브가 없습니다."); return
    path = fs[-1]
    rows = list(csv.DictReader(io.open(path, encoding="utf-8-sig")))
    print(f"원본 {len(rows):,}건  ←  {os.path.basename(path)}")

    before = Counter(r["섹터"] for r in rows)
    moved = Counter()

    for r in rows:
        text = f"{r['제목']} {r['요약']}"
        sec, score, margin = sector_of(text)
        old = r["섹터"]
        r["섹터"] = sec
        r["세부분류"] = subsector_of(sec, text)
        r["분류신뢰도"] = confidence(score, margin)
        if old != sec:
            moved[f"{old} → {sec}"] += 1

    after = Counter(r["섹터"] for r in rows)

    print("\n섹터별 변화")
    for k in sorted(set(before) | set(after)):
        d = after[k] - before[k]
        print(f"  {k:6s} {before[k]:6,} → {after[k]:6,}  ({d:+,})")

    print("\n많이 옮겨간 갈래 상위 12")
    for k, n in moved.most_common(12):
        print(f"  {n:5,}  {k}")

    fields = list(rows[0].keys())
    with io.open(path, "w", encoding="utf-8-sig", newline="") as f:
        w = csv.DictWriter(f, fieldnames=fields)
        w.writeheader()
        w.writerows(rows)
    print(f"\n다시 저장했습니다 — {path}")

    # 아카이브에서 바로 나오는 두 교차표도 함께 고쳐 둔다.
    # (build_news_archive.py 가 만들지만 그건 네이버를 다시 부른다 —
    #  여기서 안 고치면 섹터가 바뀌었는데 표만 옛날 숫자로 남는다)
    today = os.path.basename(path).rsplit("_", 1)[-1].replace(".csv", "")
    years = sorted({r["보도일"][:4] for r in rows if r["보도일"]}, reverse=True)[:12]

    sub = {}
    for r in rows:
        if not r["세부분류"]:
            continue
        k = (r["섹터"], r["세부분류"])
        sub.setdefault(k, {"섹터": k[0], "세부분류": k[1], "합계": 0})
        y = r["보도일"][:4] or "미상"
        sub[k][y] = sub[k].get(y, 0) + 1
        sub[k]["합계"] += 1
    tbl2 = [{**{"섹터": v["섹터"], "세부분류": v["세부분류"]},
             **{y: v.get(y, 0) for y in years}, "합계": v["합계"]}
            for v in sorted(sub.values(), key=lambda x: (x["섹터"], -x["합계"]))]
    _write(os.path.join(SRC, f"국립공원_세부분류_연도별_{today}.csv"),
           ["섹터", "세부분류"] + years + ["합계"], tbl2)

    names = ["구조활동", "재난안전", "자원보전", "탐방시설", "행정", "기타"]
    cross = {}
    for r in rows:
        y = r["보도일"][:4] or "미상"
        cross.setdefault(y, {"연도": y, "합계": 0})
        cross[y][r["섹터"]] = cross[y].get(r["섹터"], 0) + 1
        cross[y]["합계"] += 1
    tbl = [{**{"연도": v["연도"]}, **{n: v.get(n, 0) for n in names}, "합계": v["합계"]}
           for v in sorted(cross.values(), key=lambda x: x["연도"], reverse=True)]
    _write(os.path.join(SRC, f"국립공원_연도별섹터_{today}.csv"),
           ["연도"] + names + ["합계"], tbl)

    print("\n이어서 build_search_index · build_monthly_report · build_portal_package"
          " · build_databank · publish_dataset 을 돌리십시오.")


def _write(path, header, rows):
    with io.open(path, "w", encoding="utf-8-sig", newline="") as f:
        w = csv.DictWriter(f, fieldnames=header)
        w.writeheader(); w.writerows(rows)
    print(f"  ✓ {os.path.basename(path)}  {len(rows)}행")


if __name__ == "__main__":
    main()
