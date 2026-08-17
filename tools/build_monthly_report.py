# -*- coding: utf-8 -*-
"""월간 동향 자료를 만든다 — 숫자에 '무슨 일이 있었나'를 붙인다.

  python tools/build_monthly_report.py [폴더]

앞선 스크립트들이 만든 두 자료를 엮는다.
  · 뉴스 아카이브 (공원·섹터·세부분류·보도일)
  · 검색 관심도 (공원·연월)

만드는 것
  1) 월간동향_섹터별.csv   연월 × 섹터 — 건수·비중·전월대비·최다세부분류·대표이슈
  2) 월간동향_공원별.csv   연월 × 공원 — 보도 건수와 검색 관심도를 나란히
  3) 월간해설.md          최근 12개월을 문장으로 정리

왜 필요한가
  건수표만 있으면 '그래서 그달에 무슨 일이 있었나'를 읽는 사람이 다시
  뒤져야 한다. 그달 가장 많이 보도된 사안과 관심도 변화를 함께 적어
  표만 보고도 흐름이 잡히게 한다.
"""
import csv, io, os, re, sys, glob, time
from collections import Counter, defaultdict

D = sys.argv[1] if len(sys.argv) > 1 else os.path.join(
    os.path.expanduser("~"), "Desktop", "데이터뱅크_국립공원뉴스")
SECTOR_ORDER = ["구조출동", "재난안전", "자원보전", "탐방시설", "행정", "기타"]


def newest(pat):
    fs = sorted(glob.glob(os.path.join(D, pat)))
    return fs[-1] if fs else None


def read(path):
    return list(csv.DictReader(io.open(path, encoding="utf-8-sig"))) if path else []


def write(name, header, rows):
    p = os.path.join(D, name)
    with io.open(p, "w", encoding="utf-8-sig", newline="") as f:
        w = csv.DictWriter(f, fieldnames=header)
        w.writeheader(); w.writerows(rows)
    print(f"  ✓ {name}  {len(rows)}행")


def main():
    news = read(newest("국립공원_뉴스아카이브_네이버_*.csv"))
    trend = read(newest("국립공원_검색관심도_월별_*.csv"))
    if not news:
        print("뉴스 아카이브가 없습니다. build_news_archive.py 를 먼저 돌리세요."); return
    print(f"뉴스 {len(news):,}건 · 관심도 {len(trend):,}행")

    # ---------- 월 × 섹터 ----------
    by_ms = defaultdict(list)
    for r in news:
        m = (r.get("보도일") or "")[:7]
        if len(m) == 7:
            by_ms[(m, r["섹터"])].append(r)
    months = sorted({m for m, _ in by_ms}, reverse=True)

    month_tot = Counter()
    for (m, _s), rs in by_ms.items():
        month_tot[m] += len(rs)

    # 일렬로 늘어놓으면 엑셀에서 다시 피벗을 걸어야 한다.
    # 처음부터 교차표로 낸다 — 열어서 바로 읽히게.
    RECENT = months[:36]                       # 최근 36개월만 (열이 너무 늘어나지 않게)

    def pivot(name, row_key, rows_order, counter, extra=None):
        """rows_order × RECENT 교차표. counter[(행, 연월)] = 값"""
        out = []
        for k in rows_order:
            rec = {row_key: k}
            tot = 0
            for m in RECENT:
                v = counter.get((k, m), 0)
                rec[m] = v
                tot += v
            if not tot and not extra:
                continue
            rec["합계"] = tot
            if extra:
                rec.update(extra(k))
            out.append(rec)
        head = [row_key] + RECENT + ["합계"] + (list(extra(rows_order[0]).keys()) if extra else [])
        write(name, head, out)
        return out

    # ── 월 × 섹터 ──
    cnt_ms = Counter({(s, m): len(rs) for (m, s), rs in by_ms.items()})
    pivot("국립공원_피벗_섹터×월.csv", "섹터", SECTOR_ORDER, cnt_ms)

    # ── 월 × 공원 (보도 건수) ──
    ti = {(r["공원"], r["연월"]): float(r["검색관심도_환산"]) for r in trend} if trend else {}
    cnt_mp = Counter()
    for r in news:
        m = (r.get("보도일") or "")[:7]
        if len(m) == 7:
            cnt_mp[(r["공원"], m)] += 1
    parks = [p for p, _ in Counter(r["공원"] for r in news).most_common()]
    pivot("국립공원_피벗_공원×월_보도건수.csv", "공원", parks, cnt_mp)

    # ── 월 × 공원 (검색 관심도) ──
    if ti:
        tp = sorted({p for p, _ in ti})
        rows = []
        for p in tp:
            rec = {"공원": p}
            vals = []
            for m in RECENT:
                v = ti.get((p, m))
                rec[m] = round(v, 1) if v is not None else ""
                if v is not None:
                    vals.append(v)
            rec["평균"] = round(sum(vals) / len(vals), 1) if vals else ""
            rec["최고"] = round(max(vals), 1) if vals else ""
            rows.append(rec)
        rows.sort(key=lambda r: -(r["평균"] or 0))
        write("국립공원_피벗_공원×월_검색관심도.csv", ["공원"] + RECENT + ["평균", "최고"], rows)

    # ── 공원 × 섹터 ──
    cnt_ps = Counter((r["공원"], r["섹터"]) for r in news)
    rows = []
    for p in parks:
        rec = {"공원": p}
        tot = 0
        for s in SECTOR_ORDER:
            v = cnt_ps.get((p, s), 0); rec[s] = v; tot += v
        rec["합계"] = tot
        rec["최다분야"] = max(SECTOR_ORDER, key=lambda s: rec[s]) if tot else ""
        rows.append(rec)
    write("국립공원_피벗_공원×섹터.csv", ["공원"] + SECTOR_ORDER + ["합계", "최다분야"], rows)

    # ── 공원 × 구조출동 세부유형 ── (구조대 업무용)
    subs = [s for s, _ in Counter(
        r["세부분류"] for r in news if r["섹터"] == "구조출동" and r.get("세부분류")).most_common()]
    cnt_pr = Counter((r["공원"], r["세부분류"])
                     for r in news if r["섹터"] == "구조출동" and r.get("세부분류"))
    rows = []
    for p in parks:
        rec = {"공원": p}
        tot = 0
        for s in subs:
            v = cnt_pr.get((p, s), 0); rec[s] = v; tot += v
        if not tot:
            continue
        rec["합계"] = tot
        rows.append(rec)
    rows.sort(key=lambda r: -r["합계"])
    write("국립공원_피벗_공원×구조유형.csv", ["공원"] + subs + ["합계"], rows)

    # ---------- 해설 ----------
    L = ["# 국립공원 월간 동향", "",
         f"- 생성일: {time.strftime('%Y-%m-%d')}",
         f"- 대상 기사: {len(news):,}건",
         f"- 대상 기간: {months[-1]} ~ {months[0]}", "",
         "표만 보면 '그래서 그달에 무슨 일이 있었나'가 안 잡혀 문장으로 함께 정리했습니다.",
         "건수는 **보도량**이고, 관심도는 **네이버 검색량**입니다. 둘은 다른 것을 잽니다.", ""]

    for m in months[:12]:
        secs = sorted(((s, len(by_ms.get((m, s), []))) for s in SECTOR_ORDER),
                      key=lambda x: -x[1])
        secs = [x for x in secs if x[1]]
        if not secs:
            continue
        tot = month_tot[m]
        top_parks = Counter(r["공원"] for r in news
                            if (r.get("보도일") or "")[:7] == m
                            and r["공원"] != "(전체·공통)").most_common(3)
        rescue = len(by_ms.get((m, "구조출동"), []))
        rsub = Counter(r.get("세부분류") or "-" for r in by_ms.get((m, "구조출동"), [])).most_common(2)

        L.append(f"## {m}")
        L.append("")
        L.append(f"보도 **{tot:,}건**. "
                 + " · ".join(f"{s} {n}건({n/tot*100:.0f}%)" for s, n in secs[:4]) + ".")
        if top_parks:
            L.append("공원별로는 " + ", ".join(f"**{p}** {n}건" for p, n in top_parks) + " 순입니다.")
        if rescue:
            det = " · ".join(f"{k} {v}건" for k, v in rsub if k != "-")
            L.append(f"구조출동 관련은 {rescue}건이며" + (f", 유형은 {det} 입니다." if det else "."))
        if ti:
            vals = [(p, ti[(p, m)]) for p in {x["공원"] for x in trend} if (p, m) in ti]
            if vals:
                vals.sort(key=lambda x: -x[1])
                L.append("검색 관심도는 "
                         + ", ".join(f"**{p}** {v:.0f}" for p, v in vals[:3]) + " 순으로 높았습니다.")
        L.append("")

    L += ["---", "",
          "### 읽을 때 유의할 점", "",
          "- 보도 건수는 네이버 검색 색인에 잡힌 기사 기준이라 **전수가 아닙니다.**",
          "- 섹터·세부분류는 제목·요약의 낱말로 자동 분류해 **일부 오분류가 있습니다.**",
          "- 검색 관심도는 절대 검색 횟수가 아니라 **상대지수**입니다.",
          "- 최근 연도의 건수가 많은 것은 이슈가 늘어서가 아니라 **색인이 촘촘하기 때문**일 수 있습니다.",
          ""]
    p = os.path.join(D, "국립공원_월간해설.md")
    io.open(p, "w", encoding="utf-8").write("\n".join(L))
    print(f"  ✓ 국립공원_월간해설.md  ({len(months[:12])}개월)")


if __name__ == "__main__":
    sys.stdout.reconfigure(encoding="utf-8")
    main()
