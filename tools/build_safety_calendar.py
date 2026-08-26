# -*- coding: utf-8 -*-
"""안전 캘린더 집계 — 아카이브에서 '언제 어떤 위험 보도가 많았나'를 미리 계산한다.

  python tools/build_safety_calendar.py

data/dataset/국립공원공단_국립공원뉴스정보_YYYYMMDD.zip (통합본)에서
재난안전·구조활동 두 분야의 세부분류를 월×공원으로 집계해
assets/data/safety-calendar.json 하나로 굽는다.

서버도 AI도 쓰지 않는다 — 정적 JSON 하나라 종량 과금이 없고,
프론트(assets/js/safety.js)는 이 파일만 읽는다.

집계에 넣는 것은 '위험 유형'뿐이다. 예방·훈련, 통제·입산금지, 출동·대응,
헬기·이송, 기타는 기관의 활동이지 위험 자체가 아니라 뺀다.

담는 각도 — ① 월별 패턴 ② 연도별 건수(추세는 프론트가 '그해 비중'으로 계산)
③ 공원×유형 월별 ④ 유형×월 대표 사례 기사 1건.

※ 이 수치는 언론 보도량이지 실제 사고 건수가 아니다. 프론트에도 같은
   단서를 반드시 표기한다 (근거 없는 수치를 보여주지 않는 사이트 원칙).
※ 연도별 '건수'는 수집 깊이가 최근일수록 깊어(네이버 검색 소급 한계)
   그대로 추세로 읽으면 왜곡된다. 추세는 반드시 그해 전체 위험 보도에서
   차지하는 비중으로만 말한다.
"""
import csv, io, json, os, re, sys, zipfile
from collections import defaultdict

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC_DIR = os.path.join(ROOT, "data", "dataset")
OUT = os.path.join(ROOT, "assets", "data", "safety-calendar.json")

# 위험 유형 — (세부분류명, 출신 분야). 순서가 그대로 화면 순서의 기본값이 된다.
RISK_TYPES = [
    ("산불",           "재난안전"),
    ("호우·태풍",      "재난안전"),
    ("폭설·한파",      "재난안전"),
    ("산사태·낙석",    "재난안전"),
    ("폭염·가뭄",      "재난안전"),
    ("지진",           "재난안전"),
    ("물놀이 위험지역", "재난안전"),
    ("실족·추락",      "구조활동"),
    ("수난사고",       "구조활동"),
    ("조난·고립",      "구조활동"),
    ("실종·수색",      "구조활동"),
    ("심정지·응급질환", "구조활동"),
    ("벌쏘임·뱀",      "구조활동"),
]
RISK_SET = {name for name, _ in RISK_TYPES}
SECTORS = {"재난안전", "구조활동"}

# 원본 세부분류 '벌쏘임·동물피해'는 멧돼지 ASF 방역·개물림 같은 기사가 절반
# 넘게 섞여 있다(2026-08-26 실측: 42건 중 벌·뱀 14건). 캘린더에는 탐방객
# 위험인 벌·뱀 기사만 추려 '벌쏘임·뱀'으로 담는다.
RENAME = {"벌쏘임·동물피해": "벌쏘임·뱀"}

BEE_WORDS = ("벌쏘임", "말벌", "벌떼", "땅벌", "벌에 쏘", "벌 쏘", "쏘임", "쏘여")

def bee_snake(title):
    if any(k in title for k in BEE_WORDS):
        return True
    if "독사" in title or "살모사" in title:
        return True
    # '뱀사골'(지리산 지명)은 뱀이 아니다
    return "뱀" in title.replace("뱀사골", "")


def find_source():
    """통합본 zip 중 가장 최신 것 — 섹터별 zip(…_재난안전_날짜.zip)은 제외."""
    pat = re.compile(r"^국립공원공단_국립공원뉴스정보_(\d{8})\.zip$")
    hits = sorted(f for f in os.listdir(SRC_DIR) if pat.match(f))
    if not hits:
        sys.exit("통합본 zip을 찾지 못했습니다: " + SRC_DIR)
    return os.path.join(SRC_DIR, hits[-1])


def main():
    src = find_source()
    with zipfile.ZipFile(src) as z:
        inner = z.infolist()[0]
        with z.open(inner) as f:
            rows = list(csv.reader(io.TextIOWrapper(f, encoding="utf-8-sig")))
    header, rows = rows[0], rows[1:]
    # 열: 게시일자, 공원명, 소재지, 분야_자동분류, 세부분류_자동분류, …
    assert header[0].startswith("게시일자"), header

    total_rows = len(rows)
    used = 0
    nat = {name: [0] * 12 for name, _ in RISK_TYPES}          # 전국 월별
    years = {name: defaultdict(int) for name, _ in RISK_TYPES}  # 유형 → 연도 → 건수
    parks = defaultdict(lambda: defaultdict(lambda: [0] * 12))  # 공원 → 유형 → 월별
    bucket = defaultdict(list)   # (유형, 월) → 기사들 — 대표 사례 고르기용
    dmin, dmax = "9999", "0000"

    for x in rows:
        if len(x) < 8:
            continue
        date, park, sector, sub = x[0], x[1], x[3], x[4]
        title, press, url = x[5], x[6], x[7]
        sub = RENAME.get(sub, sub)
        if sector not in SECTORS or sub not in RISK_SET:
            continue
        if sub == "벌쏘임·뱀" and not bee_snake(title):
            continue
        if len(date) < 7 or not date[:4].isdigit() or not date[5:7].isdigit():
            continue
        m = int(date[5:7]) - 1
        if not 0 <= m <= 11:
            continue
        used += 1
        nat[sub][m] += 1
        years[sub][date[:4]] += 1
        bucket[(sub, m)].append((date[:10], title, press, url))
        dmin, dmax = min(dmin, date[:10]), max(dmax, date[:10])
        if park and park != "(전체·공통)":
            parks[park][sub][m] += 1

    # 대표 사례 — 그 (유형, 월)에서 보도가 가장 몰린 연도의 최신 기사 1건.
    # '가장 많이 보도된 해'가 그 시기의 대표 사건일 가능성이 제일 높다.
    examples = defaultdict(dict)
    for (sub, m), arts in bucket.items():
        per_year = defaultdict(list)
        for a in arts:
            per_year[a[0][:4]].append(a)
        top_year = max(per_year, key=lambda y: len(per_year[y]))
        date, title, press, url = max(per_year[top_year])  # 그 해 최신 날짜
        examples[sub][str(m + 1)] = {
            "y": int(top_year), "n": len(per_year[top_year]),
            "t": title, "p": press, "u": url,
        }

    out = {
        "generated": None,   # 아래에서 원본 파일 날짜로 채움 — 실행일이 아니라 데이터 기준일
        "basis": "언론 보도량 기준 · 실제 사고 통계 아님",
        "source": {
            "file": os.path.basename(src),
            "rows_total": total_rows,
            "rows_used": used,
            "range": [dmin, dmax],
        },
        "types": [
            {"key": name, "sector": sector, "total": sum(nat[name]),
             "months": nat[name],
             "years": dict(sorted(years[name].items())),
             "examples": examples.get(name, {})}
            for name, sector in RISK_TYPES
        ],
        "parks": {
            p: {t: mm for t, mm in sorted(d.items(), key=lambda kv: -sum(kv[1]))}
            for p, d in sorted(parks.items())
        },
    }
    out["generated"] = re.search(r"(\d{8})", os.path.basename(src)).group(1)

    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    with io.open(OUT, "w", encoding="utf-8") as f:
        json.dump(out, f, ensure_ascii=False, separators=(",", ":"))

    kb = os.path.getsize(OUT) / 1024
    print("원본:", os.path.basename(src), "전체", total_rows, "행")
    print("위험 유형 집계:", used, "행 · 기간", dmin, "~", dmax)
    print("공원:", len(parks), "곳 · 출력:", OUT, "(%.1f KB)" % kb)
    for name, _ in RISK_TYPES:
        print("  %-10s %5d건  %s" % (name, sum(nat[name]), nat[name]))


if __name__ == "__main__":
    main()
