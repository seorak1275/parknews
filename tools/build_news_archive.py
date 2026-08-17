# -*- coding: utf-8 -*-
"""네이버 검색으로 국립공원 뉴스를 과거까지 훑어 데이터셋을 만든다.

  python tools/build_news_archive.py [출력폴더]

구글 뉴스 RSS 는 한 질의당 100건이 끝이라 '요즘 기사'만 모였다.
네이버 검색은 display 100 · start 1000 까지 페이지를 넘길 수 있어
한 검색어로 최대 1,000건, 몇 년 전 기사까지 거슬러 올라간다.

  · 질의: 공원 24곳 × 5각도 + 공통 → 127개
  · 페이지: 질의당 최대 10쪽 (100건 × 10)
  · 이론상 최대 127,000건 → 중복 제거 후 저장

키는 서버(Vercel)가 들고 있고 이 스크립트는 /api/naver-news 만 부른다.
기사 본문은 담지 않는다 — 제목·요약·언론사·링크만 싣는다.
"""
import csv, io, json, os, re, sys, time, urllib.parse, urllib.request
from concurrent.futures import ThreadPoolExecutor

API = "https://parknews.vercel.app/api/naver-news"
OUT = sys.argv[1] if len(sys.argv) > 1 else os.path.join(
    os.path.expanduser("~"), "Desktop", "데이터뱅크_국립공원뉴스")
PAGES = int(os.environ.get("PAGES", "10"))       # 질의당 페이지 수 (1쪽=100건)

PARKS = [
    ("지리산", "전남·전북·경남"), ("경주", "경북 경주"), ("계룡산", "대전·충남"),
    ("한려해상", "경남·전남"), ("설악산", "강원"), ("속리산", "충북·경북"),
    ("한라산", "제주"), ("내장산", "전북·전남"), ("가야산", "경북·경남"),
    ("덕유산", "전북·경남"), ("오대산", "강원"), ("주왕산", "경북"),
    ("태안해안", "충남 태안"), ("다도해해상", "전남"), ("북한산", "서울·경기"),
    ("치악산", "강원 원주"), ("월악산", "충북·경북"), ("소백산", "충북·경북"),
    ("월출산", "전남"), ("변산반도", "전북 부안"), ("무등산", "광주·전남"),
    ("태백산", "강원·경북"), ("팔공산", "대구·경북"), ("금정산", "부산·경남"),
]
SECTORS = [
    ("구조활동", ["구조", "구조대", "조난", "실종", "수색", "추락", "고립", "심정지",
                "심폐소생", "응급", "이송", "후송", "헬기", "119", "소방", "구급",
                "탈진", "저체온", "온열질환", "벌쏘임", "낙상", "골절", "안전사고", "실족"]),
    ("재난안전", ["산불", "화재", "진화", "통제", "폭우", "호우", "태풍", "폭설", "한파",
                "폭염", "산사태", "낙석", "지진", "대피", "출입금지", "입산통제", "경보",
                "주의보", "특보", "재난", "예방", "점검", "훈련"]),
    ("자원보전", ["멸종위기", "복원", "생태", "서식", "천연기념물", "깃대종", "반달가슴곰",
                "산양", "수달", "여우", "개화", "만개", "식물", "조류", "철새", "외래종",
                "보호", "보전", "자연유산", "생물", "방사", "증식", "군락", "희귀"]),
    ("탐방시설", ["탐방로", "탐방", "케이블카", "야영장", "대피소", "개방", "개장", "폐쇄",
                "시설", "둘레길", "탐방객", "예약", "조성", "정비", "설치", "프로그램",
                "축제", "체험", "해설", "전망대", "주차장", "무장애", "데크"]),
    ("행정", ["공단", "인사", "임명", "취임", "조직", "예산", "정책", "지정", "승격",
             "협약", "업무협약", "조례", "국정감사", "위원회", "공모", "고시", "행정",
             "법안", "개정", "이사장", "청장", "소장", "간담회", "심의", "용역"]),
]
NOISE = ["채용", "입찰", "공고", "모집공고", "분양", "아파트", "주가", "코스피",
         "다시보기", "편성표", "재방송", "부고", "인사동정"]

# 세부 분류 — 섹터 안에서 한 단계 더 나눈다.
# 5만 건이 넘으니 '구조활동 1만 건'만으로는 무엇이 늘고 주는지 안 보인다.
# 위에서부터 먼저 맞는 것을 쓰므로, 구체적인 것을 앞에 둔다.
SUBSECTORS = {
    "구조활동": [
        ("심정지·응급질환", ["심정지", "심폐소생", "심장", "쓰러", "의식", "지병", "발작",
                          "온열질환", "열사병", "저체온", "탈진", "탈수", "호흡곤란",
                          "응급처치", "제세동", "경련", "뇌출혈", "돌연사"]),
        ("벌쏘임·동물피해", ["벌쏘임", "벌에", "말벌", "뱀", "독사", "물려", "멧돼지",
                          "진드기", "쏘여", "교상"]),
        ("실족·추락", ["실족", "추락", "미끄러", "굴러", "낙상", "골절", "부상", "다쳐",
                     "다친", "삐끗", "염좌", "발목", "떨어져"]),
        ("수난사고", ["익사", "물놀이", "계곡", "표류", "수난", "빠져", "익수", "휩쓸"]),
        ("실종·수색", ["실종", "수색", "찾지", "행방", "연락 두절", "발견되지", "시신"]),
        ("조난·고립", ["조난", "고립", "길을 잃", "길 잃", "하산", "야간 산행", "갇힌",
                    "갇혀", "탈진해"]),
        ("헬기·이송", ["헬기", "이송", "후송", "닥터헬기", "항공대"]),
        # 위 어디에도 안 걸리는 '구조 활동 일반' — 출동·훈련·장비·인력 기사
        ("출동·대응", ["구조대", "구조요원", "산악구조", "119", "소방", "구급대",
                       "출동", "특수구조", "안전관리", "구조훈련", "장비", "합동",
                       "안전사고", "인명구조", "구조 활동", "구조작업", "레스큐"]),
    ],
    "재난안전": [
        ("산불", ["산불", "화재", "진화", "발화", "잔불"]),
        ("호우·태풍", ["호우", "폭우", "태풍", "침수", "범람", "물폭탄"]),
        ("폭설·한파", ["폭설", "대설", "한파", "결빙", "빙판", "적설"]),
        ("산사태·낙석", ["산사태", "낙석", "토사", "붕괴"]),
        ("폭염·가뭄", ["폭염", "가뭄", "무더위"]),
        ("지진", ["지진", "여진"]),
        ("통제·입산금지", ["통제", "출입금지", "입산통제", "폐쇄", "제한"]),
        ("예방·훈련", ["예방", "훈련", "점검", "캠페인", "경보", "주의보"]),
    ],
    "자원보전": [
        ("멸종위기종", ["멸종위기", "천연기념물", "깃대종", "1급", "2급"]),
        ("복원·방사", ["복원", "방사", "증식", "재도입", "이식"]),
        ("포유류", ["반달가슴곰", "산양", "수달", "여우", "삵", "담비", "노루", "멧토끼"]),
        ("조류", ["조류", "철새", "독수리", "매", "올빼미", "딱따구리", "탐조"]),
        ("식생·개화", ["개화", "만개", "단풍", "군락", "식물", "야생화", "나무", "숲"]),
        ("외래종·병해", ["외래종", "생태교란", "재선충", "병해충", "방제"]),
        ("자연유산·지질", ["자연유산", "지질", "람사르", "유네스코", "습지"]),
    ],
    "탐방시설": [
        ("탐방로", ["탐방로", "등산로", "둘레길", "코스", "데크", "계단"]),
        ("야영장·대피소", ["야영장", "대피소", "캠핑", "산장", "숙박"]),
        ("케이블카·삭도", ["케이블카", "삭도", "곤돌라", "리프트"]),
        ("예약제·개방", ["예약", "개방", "개장", "휴식년", "탐방예약"]),
        ("축제·행사", ["축제", "행사", "걷기", "대회", "페스티벌"]),
        ("해설·교육", ["해설", "교육", "체험", "프로그램", "생태관광", "학교"]),
        ("편의·무장애", ["무장애", "화장실", "주차장", "전망대", "편의", "정비", "설치"]),
        ("탐방객 동향", ["탐방객", "방문객", "입장객", "이용객", "인파"]),
    ],
    "행정": [
        ("인사·조직", ["인사", "임명", "취임", "이사장", "소장", "청장", "조직", "직원"]),
        ("예산·재정", ["예산", "재정", "투입", "지원금", "국비"]),
        ("지정·구역", ["지정", "승격", "해제", "확대", "구역", "타당성"]),
        ("협약·협력", ["협약", "업무협약", "MOU", "협력", "공동"]),
        ("의회·국정감사", ["국정감사", "국감", "의원", "국회", "행정사무감사", "조례"]),
        ("법령·제도", ["법", "개정", "제도", "고시", "시행"]),
        ("연구·용역", ["연구", "용역", "조사", "발표", "보고서", "학술"]),
    ],
}

TAG = re.compile(r"<[^>]+>")


def clean(s):
    s = TAG.sub("", s or "")
    for a, b in (("&lt;", "<"), ("&gt;", ">"), ("&quot;", '"'),
                 ("&#39;", "'"), ("&nbsp;", " "), ("&amp;", "&")):
        s = s.replace(a, b)
    return re.sub(r"\s+", " ", s).strip()


def kst(s):
    try:
        from email.utils import parsedate_to_datetime
        import datetime
        d = parsedate_to_datetime(s)
        return d.astimezone(datetime.timezone(datetime.timedelta(hours=9))).strftime("%Y-%m-%d")
    except Exception:
        return ""


def page(args):
    query, start = args
    q = urllib.parse.urlencode({"query": query, "display": 100, "start": start, "sort": "date"})
    for attempt in range(3):
        try:
            req = urllib.request.Request(API + "?" + q, headers={"User-Agent": "ParkNews/1.0"})
            with urllib.request.urlopen(req, timeout=60) as r:
                j = json.loads(r.read())
            return query, j.get("items", [])
        except Exception:
            if attempt == 2:
                return query, []
            time.sleep(2)
    return query, []


def sector_of(text):
    best, score = "", 0
    for name, words in SECTORS:
        n = sum(1 for w in words if w in text)
        if n > score:
            best, score = name, n
    return best or "기타"


def subsector_of(sector, text):
    """섹터 안에서 한 단계 더 나눈다. 맞는 게 없으면 '기타'."""
    best, score = "", 0
    for name, words in SUBSECTORS.get(sector, []):
        n = sum(1 for w in words if w in text)
        if n > score:
            best, score = name, n
    return best or ("기타" if sector != "기타" else "")


def main():
    os.makedirs(OUT, exist_ok=True)
    queries = []
    for name, _ in PARKS:
        queries += [f"{name} 국립공원", f"{name} 국립공원 사고", f"{name} 국립공원 탐방",
                    f"{name} 국립공원 생태", f"{name} 국립공원 구조"]
    queries += ["국립공원공단", "국립공원 정책", "국립공원 산불", "국립공원 멸종위기",
                "국립공원 안전사고", "국립공원 구조", "국립공원 탐방객"]

    jobs = [(q, 1 + i * 100) for q in queries for i in range(PAGES)]
    print(f"질의 {len(queries)}개 × {PAGES}쪽 = 요청 {len(jobs)}회")

    raw, done = [], 0
    with ThreadPoolExecutor(max_workers=8) as ex:
        for query, items in ex.map(page, jobs):
            for it in items:
                it["_q"] = query
            raw += items
            done += 1
            if done % 200 == 0:
                print(f"   {done}/{len(jobs)} · 누적 {len(raw):,}건")
    print(f"  원시 {len(raw):,}건")

    seen, rows = set(), []
    for a in raw:
        title = clean(a.get("title"))
        desc = clean(a.get("description"))
        link = a.get("originallink") or a.get("link") or ""
        if not title or not link:
            continue
        if any(w in title for w in NOISE):
            continue
        text = f"{title} {desc}"
        if "국립공원" not in text and "공원공단" not in text:
            continue
        key = re.sub(r"\W", "", title)[:40]
        if key in seen:
            continue
        seen.add(key)
        # 공원 판정 — 제목에 있으면 그 기사의 주제일 가능성이 높고,
        # 요약에만 있으면 다른 사건을 설명하며 예로 든 것일 수 있다.
        # (예: '충북 봄철 산악사고' 기사가 본문에서 주왕산 사고를 언급)
        # 근거를 남겨 통계를 낼 때 걸러 쓸 수 있게 한다.
        park = next((n for n, _ in PARKS if n in title), "")
        basis = "제목" if park else ""
        if not park:
            park = next((n for n, _ in PARKS if n in desc), "")
            basis = "요약" if park else ""
        press = re.sub(r"^https?://(www\.)?", "", link).split("/")[0]
        sec = sector_of(text)
        rows.append({
            "공원": park or "(전체·공통)",
            "공원판정": basis,
            "소재지": next((loc for n, loc in PARKS if n == park), ""),
            "섹터": sec,
            "세부분류": subsector_of(sec, text),
            "보도일": kst(a.get("pubDate", "")),
            "제목": title,
            "요약": desc[:200],
            "매체도메인": press,
            "링크": link,
            "수집질의": a["_q"],
        })
    rows.sort(key=lambda r: r["보도일"], reverse=True)
    print(f"  선별 {len(rows):,}건")

    dates = [r["보도일"] for r in rows if r["보도일"]]
    span = f"{min(dates)} ~ {max(dates)}" if dates else "-"
    print(f"  기간 {span}")

    today = time.strftime("%Y%m%d")
    name = f"국립공원_뉴스아카이브_네이버_{today}.csv"
    p = os.path.join(OUT, name)
    with io.open(p, "w", encoding="utf-8-sig", newline="") as f:
        w = csv.DictWriter(f, fieldnames=["공원", "공원판정", "소재지", "섹터", "세부분류", "보도일",
                                          "제목", "요약", "매체도메인", "링크", "수집질의"])
        w.writeheader(); w.writerows(rows)
    print(f"  ✓ {name}  {len(rows):,}행  {os.path.getsize(p)/1024/1024:.1f}MB")

    # 세부분류 × 연도 교차표 — 무엇이 늘고 주는지 보이게
    sub = {}
    for r in rows:
        if not r["세부분류"]:
            continue
        k = (r["섹터"], r["세부분류"])
        sub.setdefault(k, {"섹터": k[0], "세부분류": k[1], "합계": 0})
        y = r["보도일"][:4] or "미상"
        sub[k][y] = sub[k].get(y, 0) + 1
        sub[k]["합계"] += 1
    years = sorted({r["보도일"][:4] for r in rows if r["보도일"]}, reverse=True)[:12]
    tbl2 = [{**{"섹터": v["섹터"], "세부분류": v["세부분류"]},
             **{y: v.get(y, 0) for y in years}, "합계": v["합계"]}
            for v in sorted(sub.values(), key=lambda x: (x["섹터"], -x["합계"]))]
    p3 = os.path.join(OUT, f"국립공원_세부분류_연도별_{today}.csv")
    with io.open(p3, "w", encoding="utf-8-sig", newline="") as f:
        w = csv.DictWriter(f, fieldnames=["섹터", "세부분류"] + years + ["합계"])
        w.writeheader(); w.writerows(tbl2)
    print(f"  ✓ 국립공원_세부분류_연도별_{today}.csv  {len(tbl2)}행")
    for t in tbl2:
        if t["섹터"] == "구조활동":
            print(f"     {t['세부분류']:14} 총 {t['합계']:5,}")

    # 연도 × 섹터 교차표
    cross = {}
    names = [s[0] for s in SECTORS] + ["기타"]
    for r in rows:
        y = r["보도일"][:4] or "미상"
        cross.setdefault(y, {"연도": y, "합계": 0})
        cross[y][r["섹터"]] = cross[y].get(r["섹터"], 0) + 1
        cross[y]["합계"] += 1
    tbl = [{**{"연도": v["연도"]}, **{n: v.get(n, 0) for n in names}, "합계": v["합계"]}
           for v in sorted(cross.values(), key=lambda x: x["연도"], reverse=True)]
    p2 = os.path.join(OUT, f"국립공원_연도별섹터_{today}.csv")
    with io.open(p2, "w", encoding="utf-8-sig", newline="") as f:
        w = csv.DictWriter(f, fieldnames=["연도"] + names + ["합계"])
        w.writeheader(); w.writerows(tbl)
    print(f"  ✓ 국립공원_연도별섹터_{today}.csv  {len(tbl)}행")
    for t in tbl[:12]:
        print(f"     {t['연도']}  총 {t['합계']:5,}  구조활동 {t['구조활동']:4,}")
    print(f"\n출력 폴더: {OUT}")


if __name__ == "__main__":
    sys.stdout.reconfigure(encoding="utf-8")
    main()
