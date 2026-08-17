# -*- coding: utf-8 -*-
"""데이터뱅크 제출용 뉴스 데이터셋을 만든다.

  python tools/build_databank.py [출력폴더]

무엇을 만드나
  구글 뉴스에서 국립공원 관련 기사를 모아 **공원 24곳 × 섹터 5개**로
  분류하고, 같은 사안끼리 묶어 보도량을 센 자료다.
  경계·통계 같은 원본 공개데이터와 달리 우리가 직접 가공한 자료다.

  1) 기사 원장   공원·섹터·제목·언론사·보도일·링크
  2) 이슈 집계   같은 사안 묶음별 보도 건수·언론사 수
  3) 공원별 요약 공원 x 섹터 교차 건수
  4) 명세서     컬럼 설명·수집 방법·한계

주의
  기사 본문은 담지 않는다. 제목·언론사·링크만 싣는다.
  (언론사 저작물이므로 원문은 링크로만 연결)
"""
import csv, io, json, os, re, sys, time, unicodedata
import urllib.parse, urllib.request
from concurrent.futures import ThreadPoolExecutor

OUT = sys.argv[1] if len(sys.argv) > 1 else os.path.join(
    os.path.expanduser("~"), "Desktop", "데이터뱅크_국립공원뉴스")
UA = {"User-Agent": "Mozilla/5.0 (compatible; ParkNews/1.0; +https://parknews.vercel.app)"}
TODAY = time.strftime("%Y%m%d")

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
         "다시보기", "편성표", "재방송"]


def strip_tags(s):
    s = re.sub(r"<!\[CDATA\[|\]\]>", "", s or "")
    s = (s.replace("&lt;", "<").replace("&gt;", ">").replace("&quot;", '"')
          .replace("&#39;", "'").replace("&nbsp;", " ").replace("&amp;", "&"))
    return re.sub(r"\s+", " ", re.sub(r"<[^>]*>", " ", s)).strip()


def fetch(query):
    url = ("https://news.google.com/rss/search?q="
           + urllib.parse.quote(query) + "&hl=ko&gl=KR&ceid=KR:ko")
    for attempt in range(2):
        try:
            with urllib.request.urlopen(urllib.request.Request(url, headers=UA), timeout=20) as r:
                xml = r.read().decode("utf-8", "replace")
            out = []
            for m in re.finditer(r"<item>([\s\S]*?)</item>", xml):
                b = m.group(1)
                g = lambda t: strip_tags((re.search(rf"<{t}[^>]*>([\s\S]*?)</{t}>", b, re.I) or [None, ""])[1])
                raw = g("title")
                hit = re.match(r"^(.*)\s+-\s+([^-]{2,40})$", raw)
                out.append({
                    "title": (hit.group(1) if hit else raw).strip(),
                    "press": (hit.group(2) if hit else g("source") or "뉴스").strip(),
                    "link": g("link"), "pubDate": g("pubDate"), "query": query,
                })
            return out
        except Exception:
            if attempt == 0:
                time.sleep(0.8)
    return []


def kst_date(s):
    """RFC822 → YYYY-MM-DD (KST)"""
    try:
        from email.utils import parsedate_to_datetime
        import datetime
        d = parsedate_to_datetime(s)
        return (d.astimezone(datetime.timezone(datetime.timedelta(hours=9)))).strftime("%Y-%m-%d")
    except Exception:
        return ""


def sector_of(text):
    best, score = "", 0
    for name, words in SECTORS:
        n = sum(1 for w in words if w in text)
        if n > score:
            best, score = name, n
    return best or "기타"


STOP = {"국립공원", "공원", "기사", "지난", "올해", "관련", "이날", "위해", "국립"}
JOSA = re.compile(r"(에서|에게|으로|과의|와의|은|는|이|가|을|를|에|의|서|와|과|도|로)$")


def tokens(t):
    ws = re.sub(r"[^\w\s]", " ", t).split()
    return {JOSA.sub("", w) if len(w) >= 3 else w for w in ws
            if len(w) >= 2 and w not in STOP}


def group_issues(rows):
    groups = []
    for r in rows:
        tk = tokens(r["제목"])
        hit = None
        for g in groups:
            inter = len(g["tk"] & tk)
            if not inter:
                continue
            if max(inter / len(g["tk"] | tk), inter / min(len(g["tk"]), len(tk))) >= 0.5:
                hit = g
                break
        if hit:
            hit["rows"].append(r); hit["tk"] |= tk
        else:
            groups.append({"tk": tk, "rows": [r]})
    return groups


def main():
    os.makedirs(OUT, exist_ok=True)
    queries = []
    for name, _ in PARKS:
        queries += [f"{name} 국립공원", f"{name} 국립공원 사고", f"{name} 국립공원 탐방",
                    f"{name} 국립공원 생태", f"{name} 국립공원 구조"]
    queries += ["국립공원공단", "국립공원 정책", "국립공원 산불", "국립공원 멸종위기",
                "국립공원 안전사고", "국립공원 구조", "국산악구조"]
    print(f"질의 {len(queries)}개 수집 중…")

    with ThreadPoolExecutor(max_workers=6) as ex:
        batches = list(ex.map(fetch, queries))
    raw = [a for b in batches for a in b]
    print(f"  원시 {len(raw)}건")

    seen, rows = set(), []
    for a in raw:
        if not a["title"] or not a["link"]:
            continue
        if any(w in a["title"] for w in NOISE):
            continue
        key = re.sub(r"\W", "", a["title"])[:40] + "|" + a["press"]
        if key in seen:
            continue
        seen.add(key)
        text = a["title"]
        park = next((n for n, _ in PARKS if n in text), "")
        if not park and "국립공원" not in text and "공원공단" not in text:
            continue
        rows.append({
            "공원": park or "(전체·공통)",
            "소재지": next((loc for n, loc in PARKS if n == park), ""),
            "섹터": sector_of(text),
            "제목": a["title"],
            "언론사": a["press"],
            "보도일": kst_date(a["pubDate"]),
            "링크": a["link"],
            "수집질의": a["query"],
        })
    rows.sort(key=lambda r: (r["보도일"], r["공원"]), reverse=True)
    print(f"  선별 {len(rows)}건")

    def write(name, header, data):
        p = os.path.join(OUT, name)
        with io.open(p, "w", encoding="utf-8-sig", newline="") as f:
            w = csv.DictWriter(f, fieldnames=header)
            w.writeheader()
            w.writerows(data)
        print(f"  ✓ {name}  {len(data)}행  {os.path.getsize(p)/1024:.0f}KB")

    write(f"국립공원_뉴스기사_원장_{TODAY}.csv",
          ["공원", "소재지", "섹터", "제목", "언론사", "보도일", "링크", "수집질의"], rows)

    issues = []
    for g in group_issues(rows):
        rs = sorted(g["rows"], key=lambda r: r["보도일"], reverse=True)
        press = sorted({r["언론사"] for r in rs})
        issues.append({
            "공원": rs[0]["공원"], "섹터": rs[0]["섹터"],
            "대표제목": rs[0]["제목"], "보도건수": len(rs), "언론사수": len(press),
            "언론사목록": " · ".join(press[:10]),
            "최초보도일": min(r["보도일"] for r in rs if r["보도일"]) if any(r["보도일"] for r in rs) else "",
            "최종보도일": max(r["보도일"] for r in rs),
            "대표링크": rs[0]["링크"],
        })
    issues.sort(key=lambda x: (-x["언론사수"], -x["보도건수"]))
    write(f"국립공원_이슈집계_{TODAY}.csv",
          ["공원", "섹터", "대표제목", "보도건수", "언론사수", "언론사목록",
           "최초보도일", "최종보도일", "대표링크"], issues)

    cross = {}
    for r in rows:
        cross.setdefault(r["공원"], {"공원": r["공원"], "소재지": r["소재지"], "합계": 0})
        cross[r["공원"]][r["섹터"]] = cross[r["공원"]].get(r["섹터"], 0) + 1
        cross[r["공원"]]["합계"] += 1
    names = [s[0] for s in SECTORS] + ["기타"]
    summary = []
    for v in sorted(cross.values(), key=lambda x: -x["합계"]):
        summary.append({**{"공원": v["공원"], "소재지": v["소재지"]},
                        **{n: v.get(n, 0) for n in names}, "합계": v["합계"]})
    write(f"국립공원_공원별섹터요약_{TODAY}.csv",
          ["공원", "소재지"] + names + ["합계"], summary)

    spec = f"""# 국립공원 뉴스 이슈 데이터셋 명세서

- 작성 기관: 국립공원공단
- 생성일: {time.strftime('%Y-%m-%d')}
- 수집 도구: tools/build_databank.py (파크뉴스 프로젝트)

## 무엇을 담은 자료인가

국립공원 관련 언론 보도를 모아 **공원 24곳**과 **업무 섹터 5개**로 분류하고,
같은 사안을 다룬 기사끼리 묶어 보도량을 집계한 자료입니다.
경계·기본통계 같은 원본 공개데이터와 달리 **직접 수집·가공한 2차 자료**입니다.

## 파일 구성

| 파일 | 행 수 | 내용 |
|---|--:|---|
| 국립공원_뉴스기사_원장_{TODAY}.csv | {len(rows)} | 기사 1건 = 1행 |
| 국립공원_이슈집계_{TODAY}.csv | {len(issues)} | 같은 사안 묶음 1개 = 1행 |
| 국립공원_공원별섹터요약_{TODAY}.csv | {len(summary)} | 공원 × 섹터 교차 건수 |

## 컬럼 설명 — 기사 원장

| 컬럼 | 설명 |
|---|---|
| 공원 | 제목에서 식별한 국립공원. 특정 공원이 없으면 `(전체·공통)` |
| 소재지 | 해당 공원의 행정구역 |
| 섹터 | 구조활동 / 재난안전 / 자원보전 / 탐방시설 / 행정 / 기타 |
| 제목 | 기사 제목 |
| 언론사 | 보도 매체 |
| 보도일 | 보도 일자 (KST) |
| 링크 | 원문 주소 |
| 수집질의 | 어떤 검색어로 수집됐는지 |

## 컬럼 설명 — 이슈 집계

| 컬럼 | 설명 |
|---|---|
| 대표제목 | 묶음에서 가장 최근 기사의 제목 |
| 보도건수 | 그 사안을 다룬 기사 수 |
| 언론사수 | 그 사안을 다룬 **서로 다른 언론사** 수 |
| 언론사목록 | 보도 매체 (최대 10곳) |

## 수집·가공 방법

1. 구글 뉴스 RSS에 {len(queries)}개 질의 (공원 24곳 × 5 + 공통 7)
2. 제목 기준 중복 제거, 채용·입찰·편성표 등 비기사 제외
3. 국립공원 관련어가 없는 기사 제외
4. 제목 낱말로 섹터 분류 (가장 많이 맞는 섹터)
5. 제목 낱말 유사도 0.5 이상이면 같은 사안으로 묶음

## 한계 · 유의사항

- **본문은 담지 않았습니다.** 언론사 저작물이므로 제목·링크로만 연결합니다.
- 섹터 분류는 제목 낱말 기반이라 **일부 오분류가 있습니다.**
- 같은 사안 묶기도 제목 유사도 기반이라 완벽하지 않습니다.
- 구글 뉴스 색인에 잡힌 기사만 대상이라 **전수가 아닙니다.**
- '언론사수'는 조회수가 아니라 **보도 매체 수**입니다. 화제성이 아니라
  '언론이 얼마나 중요하게 다뤘나'를 재는 지표로 보시는 게 맞습니다.
"""
    p = os.path.join(OUT, "데이터_명세서.md")
    io.open(p, "w", encoding="utf-8").write(spec)
    print(f"  ✓ 데이터_명세서.md")
    print(f"\n출력 폴더: {OUT}")


if __name__ == "__main__":
    sys.stdout.reconfigure(encoding="utf-8")
    main()
