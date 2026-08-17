# -*- coding: utf-8 -*-
"""해외 국립공원 뉴스를 모아 데이터셋을 만든다.

  python tools/build_global_news.py [출력폴더]

국내와 결이 다르다. 두 갈래로 모은다.

  (1) 한국 언론의 해외 공원 보도  — 네이버 검색, 한글 공원명
      '요세미티 국립공원' 처럼 한국어 표기로 찾는다. 국내 독자에게
      해외 공원이 어떻게 소개되는지가 담긴다.

  (2) 현지 영문 보도 — 구글 뉴스 RSS (영어)
      공원 정책·사고·보전 현안이 현지에서 어떻게 다뤄지는지.

공원 목록은 assets/data/parks-global.json 의 큐레이션분에서 가져온다.
(한국어 표기가 있는 곳 위주 — 없으면 한글 검색이 성립하지 않는다)
"""
import csv, io, json, os, re, sys, time, urllib.parse, urllib.request
from concurrent.futures import ThreadPoolExecutor

NAVER = "https://parknews.vercel.app/api/naver-news"
GOOGLE = "https://news.google.com/rss/search"
OUT = sys.argv[1] if len(sys.argv) > 1 else os.path.join(
    os.path.expanduser("~"), "Desktop", "데이터뱅크_국립공원뉴스")
REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
UA = {"User-Agent": "Mozilla/5.0 (compatible; ParkNews/1.0)"}
PAGES = int(os.environ.get("PAGES", "3"))          # 한글 질의당 페이지 수

# 영문 기사용 분류어 — 국내용 한글 낱말은 영문에 걸리지 않는다
SECTORS_EN = [
    ("구조활동", ["rescue", "missing", "search", "stranded", "fell", "fall", "injured",
                "died", "death", "body found", "hiker", "airlift", "helicopter",
                "drowned", "hypothermia", "evacuated"]),
    ("재난안전", ["wildfire", "fire", "flood", "storm", "hurricane", "typhoon", "snow",
                "avalanche", "landslide", "earthquake", "closure", "closed", "heat",
                "drought", "warning"]),
    ("자원보전", ["endangered", "species", "wildlife", "conservation", "restoration",
                "habitat", "bear", "wolf", "bird", "reintroduce", "invasive",
                "ecosystem", "biodiversity", "glacier", "forest"]),
    ("탐방시설", ["trail", "campground", "reservation", "permit", "visitor", "tourism",
                "shuttle", "lodge", "fee", "entrance", "reopened", "boardwalk"]),
    ("행정", ["budget", "funding", "staff", "layoff", "policy", "law", "bill", "agency",
             "director", "government", "shutdown", "lawsuit", "plan", "designat"]),
]
SECTORS_KO = [
    ("구조활동", ["구조", "실종", "수색", "조난", "추락", "사망", "부상", "헬기", "고립"]),
    ("재난안전", ["산불", "화재", "홍수", "폭우", "태풍", "폭설", "지진", "폐쇄", "통제", "폭염"]),
    ("자원보전", ["멸종위기", "생태", "복원", "서식", "야생", "보전", "빙하", "생물다양성"]),
    ("탐방시설", ["탐방", "예약", "입장", "관광", "트레킹", "여행", "숙박", "개방", "코스"]),
    ("행정", ["예산", "정책", "법", "정부", "지정", "협약", "폐쇄 조치", "당국"]),
]
NOISE = ["채용", "분양", "주가", "코스피", "편성표", "다시보기", "부고"]
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


def sector_of(text, table):
    low = text.lower()
    best, score = "", 0
    for name, words in table:
        n = sum(1 for w in words if w in low)
        if n > score:
            best, score = name, n
    return best or "기타"


def naver(args):
    q, start = args
    u = NAVER + "?" + urllib.parse.urlencode(
        {"query": q, "display": 100, "start": start, "sort": "date"})
    for _ in range(2):
        try:
            with urllib.request.urlopen(urllib.request.Request(u, headers=UA), timeout=60) as r:
                return q, json.loads(r.read()).get("items", [])
        except Exception:
            time.sleep(1.5)
    return q, []


def google(q):
    u = GOOGLE + "?" + urllib.parse.urlencode({"q": q}) + "&hl=en-US&gl=US&ceid=US:en"
    try:
        with urllib.request.urlopen(urllib.request.Request(u, headers=UA), timeout=25) as r:
            xml = r.read().decode("utf-8", "replace")
    except Exception:
        return q, []
    out = []
    for m in re.finditer(r"<item>([\s\S]*?)</item>", xml):
        b = m.group(1)
        g = lambda t: clean((re.search(rf"<{t}[^>]*>([\s\S]*?)</{t}>", b, re.I) or [None, ""])[1])
        raw = g("title")
        hit = re.match(r"^(.*)\s+-\s+([^-]{2,40})$", raw)
        out.append({"title": (hit.group(1) if hit else raw).strip(),
                    "press": (hit.group(2) if hit else g("source") or "news").strip(),
                    "link": g("link"), "pubDate": g("pubDate")})
    return q, out


def main():
    os.makedirs(OUT, exist_ok=True)
    data = json.load(io.open(os.path.join(REPO, "assets", "data", "parks-global.json"),
                             encoding="utf-8"))
    parks = [p for p in data["parks"] if p.get("curated")]
    ko_parks = [p for p in parks if p.get("nameLocal") and p["nameLocal"] != p.get("nameEn")]
    print(f"큐레이션 {len(parks)}곳 · 한국어명 보유 {len(ko_parks)}곳")

    rows = []

    # ── (1) 한국 언론 (네이버) ──
    kq = {}
    for p in ko_parks:
        q = p["nameLocal"]
        if "국립공원" not in q:
            q += " 국립공원"
        kq[q] = p
    jobs = [(q, 1 + i * 100) for q in kq for i in range(PAGES)]
    print(f"한글 질의 {len(kq)}개 × {PAGES}쪽 = {len(jobs)}회")
    seen = set()
    with ThreadPoolExecutor(max_workers=8) as ex:
        for q, items in ex.map(naver, jobs):
            p = kq[q]
            short = re.sub(r"\s*국립공원\s*$", "", p["nameLocal"]).strip()
            for a in items:
                t, d = clean(a.get("title")), clean(a.get("description"))
                link = a.get("originallink") or a.get("link") or ""
                if not t or not link or any(w in t for w in NOISE):
                    continue
                if short and short not in f"{t} {d}":
                    continue                       # 다른 기사에 섞여 들어온 것
                k = re.sub(r"\W", "", t)[:40]
                if k in seen:
                    continue
                seen.add(k)
                rows.append({
                    "공원": p.get("nameLocal") or p["name"], "영문명": p.get("nameEn") or p["name"],
                    "국가": p.get("countryKo", ""), "대륙": p.get("continentKo", ""),
                    "언어": "한국어", "섹터": sector_of(f"{t} {d}", SECTORS_KO),
                    "보도일": kst(a.get("pubDate", "")), "제목": t, "요약": d[:200],
                    "매체": re.sub(r"^https?://(www\.)?", "", link).split("/")[0],
                    "링크": link,
                })
    print(f"  한국어 {len(rows):,}건")

    # ── (2) 현지 영문 (구글 뉴스) ──
    eq = {}
    for p in parks:
        n = p.get("nameEn") or p["name"]
        eq[n if "ational" in n else f"{n} national park"] = p
    print(f"영문 질의 {len(eq)}개")
    n0 = len(rows)
    with ThreadPoolExecutor(max_workers=6) as ex:
        for q, items in ex.map(google, list(eq)):
            p = eq[q]
            base = re.sub(r"(?i)\s*national\s*park.*$", "", p.get("nameEn") or p["name"]).strip()
            for a in items:
                t = a["title"]
                if not t or not a["link"]:
                    continue
                if base and base.lower() not in t.lower():
                    continue
                k = re.sub(r"\W", "", t)[:40]
                if k in seen:
                    continue
                seen.add(k)
                rows.append({
                    "공원": p.get("nameLocal") or p["name"], "영문명": p.get("nameEn") or p["name"],
                    "국가": p.get("countryKo", ""), "대륙": p.get("continentKo", ""),
                    "언어": "영어", "섹터": sector_of(t, SECTORS_EN),
                    "보도일": kst(a["pubDate"]), "제목": t, "요약": "",
                    "매체": a["press"], "링크": a["link"],
                })
    print(f"  영어 {len(rows)-n0:,}건 · 합계 {len(rows):,}건")

    rows.sort(key=lambda r: r["보도일"], reverse=True)
    today = time.strftime("%Y%m%d")

    def write(name, header, data):
        p = os.path.join(OUT, name)
        with io.open(p, "w", encoding="utf-8-sig", newline="") as f:
            w = csv.DictWriter(f, fieldnames=header)
            w.writeheader(); w.writerows(data)
        print(f"  ✓ {name}  {len(data):,}행  {os.path.getsize(p)/1024:.0f}KB")

    write(f"해외국립공원_뉴스_{today}.csv",
          ["공원", "영문명", "국가", "대륙", "언어", "섹터", "보도일",
           "제목", "요약", "매체", "링크"], rows)

    # 피벗 — 대륙/국가 × 섹터
    from collections import Counter
    SEC = ["구조활동", "재난안전", "자원보전", "탐방시설", "행정", "기타"]
    for key, fname in (("대륙", "해외국립공원_피벗_대륙×섹터"),
                       ("국가", "해외국립공원_피벗_국가×섹터")):
        cnt = Counter((r[key], r["섹터"]) for r in rows if r[key])
        keys = [k for k, _ in Counter(r[key] for r in rows if r[key]).most_common()]
        out = []
        for k in keys:
            rec = {key: k}
            tot = 0
            for s in SEC:
                v = cnt.get((k, s), 0); rec[s] = v; tot += v
            rec["합계"] = tot
            out.append(rec)
        write(f"{fname}_{today}.csv", [key] + SEC + ["합계"], out)


if __name__ == "__main__":
    sys.stdout.reconfigure(encoding="utf-8")
    main()
