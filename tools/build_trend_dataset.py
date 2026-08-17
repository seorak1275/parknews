# -*- coding: utf-8 -*-
"""국립공원 24곳의 검색 관심도 10년치를 내려받아 데이터셋으로 만든다.

  python tools/build_trend_dataset.py [출력폴더]

왜 이 자료가 쓸모 있나
  경계·기본통계는 이미 공개돼 있지만, **공원별로 사람들이 언제 얼마나
  관심을 가졌는지**는 정리된 자료가 없다. 탐방 수요·성수기·이슈 시점을
  10년 시계열로 볼 수 있다.

비교 가능하게 만드는 법
  데이터랩은 한 번 요청 안에서 가장 큰 값을 100으로 두는 **상대지수**를
  준다. 요청이 다르면 기준이 달라 그대로는 24곳을 비교할 수 없다.
  → 모든 요청에 공통 기준어 '국립공원' 을 함께 넣고, 그 값으로 나눠
    같은 잣대로 환산한다.

  키는 서버(Vercel)가 들고 있고 이 스크립트는 /api/datalab 만 부른다.
"""
import csv, io, json, os, sys, time, urllib.parse, urllib.request

API = "https://parknews.vercel.app/api/datalab"
REF = "국립공원"                    # 공통 기준어
START, UNIT = "2016-01-01", "month"
OUT = sys.argv[1] if len(sys.argv) > 1 else os.path.join(
    os.path.expanduser("~"), "Desktop", "데이터뱅크_국립공원뉴스")

PARKS = ["지리산", "경주", "계룡산", "한려해상", "설악산", "속리산", "한라산", "내장산",
         "가야산", "덕유산", "오대산", "주왕산", "태안해안", "다도해해상", "북한산",
         "치악산", "월악산", "소백산", "월출산", "변산반도", "무등산", "태백산",
         "팔공산", "금정산"]


def fetch(keywords, end):
    q = urllib.parse.urlencode({
        "keywords": ",".join(keywords), "start": START, "end": end, "unit": UNIT})
    for attempt in range(3):
        try:
            req = urllib.request.Request(API + "?" + q, headers={"User-Agent": "ParkNews/1.0"})
            with urllib.request.urlopen(req, timeout=120) as r:
                return json.loads(r.read())
        except Exception as e:
            if attempt == 2:
                print("   실패:", keywords, e)
                return None
            time.sleep(3)


def main():
    os.makedirs(OUT, exist_ok=True)
    end = time.strftime("%Y-%m-%d", time.gmtime(time.time() - 86400))
    rows, meta = [], []

    # 기준어 1개 + 공원 4개씩 → 요청당 5개 (데이터랩 한도)
    chunks = [PARKS[i:i + 4] for i in range(0, len(PARKS), 4)]
    print(f"요청 {len(chunks)}회 · 공원 {len(PARKS)}곳 · {START} ~ {end} ({UNIT})")

    for n, chunk in enumerate(chunks, 1):
        kws = [f"{p} 국립공원" for p in chunk] + [REF]
        data = fetch(kws, end)
        if not data:
            continue
        series = {g["title"]: {d["period"]: d["ratio"] for d in g.get("data", [])}
                  for g in data.get("results", [])}
        ref = series.get(REF, {})
        ref_max = max(ref.values()) if ref else 0
        if not ref_max:
            print(f"   [{n}] 기준어 값이 없어 환산 불가"); continue

        for p in chunk:
            s = series.get(f"{p} 국립공원", {})
            if not s:
                print(f"   [{n}] {p} 자료 없음"); continue
            # 같은 요청 안의 기준어 최대값으로 나눠 요청 간 잣대를 맞춘다
            for period, v in sorted(s.items()):
                rows.append({
                    "공원": p,
                    "연월": period[:7],
                    "검색관심도_원값": round(v, 2),
                    "검색관심도_환산": round(v / ref_max * 100, 2),
                })
            vals = [v for _, v in sorted(s.items())]
            top = max(sorted(s.items()), key=lambda x: x[1])
            meta.append({
                "공원": p,
                "관측개월수": len(vals),
                "최고시점": top[0][:7],
                "최고값_환산": round(top[1] / ref_max * 100, 2),
                "평균_환산": round(sum(vals) / len(vals) / ref_max * 100, 2),
                "최근값_환산": round(vals[-1] / ref_max * 100, 2),
            })
        print(f"   [{n}/{len(chunks)}] {', '.join(chunk)} ✓")
        time.sleep(1)

    if not rows:
        print("수집된 자료가 없습니다."); return

    def write(name, header, data):
        p = os.path.join(OUT, name)
        with io.open(p, "w", encoding="utf-8-sig", newline="") as f:
            w = csv.DictWriter(f, fieldnames=header)
            w.writeheader(); w.writerows(data)
        print(f"  ✓ {name}  {len(data)}행  {os.path.getsize(p)/1024:.0f}KB")

    today = time.strftime("%Y%m%d")
    rows.sort(key=lambda r: (r["공원"], r["연월"]))
    write(f"국립공원_검색관심도_월별_{START[:4]}-{end[:4]}_{today}.csv",
          ["공원", "연월", "검색관심도_원값", "검색관심도_환산"], rows)
    meta.sort(key=lambda r: -r["평균_환산"])
    write(f"국립공원_검색관심도_요약_{today}.csv",
          ["공원", "관측개월수", "최고시점", "최고값_환산", "평균_환산", "최근값_환산"], meta)

    note = f"""
## 국립공원 검색 관심도 (월별, {START[:4]}~{end[:4]})

- 출처: 네이버 데이터랩 검색어 트렌드 (NAVER API HUB)
- 검색어: `<공원명> 국립공원`
- 기간: {START} ~ {end}, 월 단위 ({len(rows)}행)

### 값 읽는 법

- `검색관심도_원값` — 데이터랩이 준 상대지수. **요청이 다르면 기준이 달라
  그대로 비교하면 안 됩니다.**
- `검색관심도_환산` — 모든 요청에 공통으로 넣은 기준어 `{REF}` 의 최대값을
  100으로 두고 환산한 값. **24곳을 서로 비교할 때는 이 값을 쓰십시오.**

### 유의사항

- 데이터랩은 검색 **횟수의 절대값을 제공하지 않습니다.** 상대지수뿐입니다.
- 동명 지명(예: 경주·한라산)은 공원 밖 검색이 섞일 수 있어
  검색어에 `국립공원` 을 붙여 좁혔습니다.
- 2016-01-01 이전 자료는 데이터랩이 제공하지 않습니다.
"""
    p = os.path.join(OUT, "검색관심도_설명.md")
    io.open(p, "w", encoding="utf-8").write(note.strip() + "\n")
    print(f"  ✓ 검색관심도_설명.md\n출력 폴더: {OUT}")


if __name__ == "__main__":
    sys.stdout.reconfigure(encoding="utf-8")
    main()
