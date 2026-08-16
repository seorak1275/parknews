# -*- coding: utf-8 -*-
"""해외 국립공원 목록을 Wikidata 에서 새로 만든다.

  python tools/build_wikidata.py assets/data/parks-global.json

왜 Wikidata 인가
  · 처음에는 OSM Overpass 로 모았는데 나라별 수록률이 1%~133% 로 벌어졌다.
    (호주 5곳 · 미국 233곳 — 미국엔 주립 해변까지 섞여 있었다)
    OSM 은 그 나라 자원봉사자가 얼마나 입력했는지에 좌우된다.
  · WDPA 가 권위 있는 원본이지만 공개 CSV(22.7MB)에는 좌표 열이 없다.
    좌표는 4GB 짜리 SHP 에만 들어 있어 이 규모의 사이트에는 과하다.
  · Wikidata 는 좌표·국가·다국어 이름을 한 번의 질의로 주고 토큰이 필요 없다.

기존 큐레이션 보존
  좌표 0.6도 이내 + 이름이 겹치는 항목을 찾아 id·한글명·설명·홈페이지를
  그대로 이어받는다. 딥링크(#p=<id>)가 끊기지 않게 하기 위함이다.
  짝을 못 찾은 큐레이션 항목은 지우지 않고 그대로 남긴다.
"""
import json, math, re, sys, unicodedata, urllib.parse, urllib.request

OUT = sys.argv[1] if len(sys.argv) > 1 else "assets/data/parks-global.json"
UA = {"User-Agent": "ParkNewsBot/1.0 (https://parknews.vercel.app)",
      "Accept": "application/sparql-results+json"}

PARKS_Q = """
SELECT ?item ?en ?ko ?coord ?iso WHERE {
  ?item wdt:P31/wdt:P279* wd:Q46169 .
  ?item wdt:P625 ?coord .
  OPTIONAL { ?item wdt:P17 ?c . ?c wdt:P298 ?iso . }
  OPTIONAL { ?item rdfs:label ?en FILTER(LANG(?en)="en") }
  OPTIONAL { ?item rdfs:label ?ko FILTER(LANG(?ko)="ko") }
}
"""
COUNTRY_Q = """
SELECT DISTINCT ?iso ?cEn ?cKo ?contEn WHERE {
  ?c wdt:P298 ?iso .
  OPTIONAL { ?c wdt:P30 ?cont . ?cont rdfs:label ?contEn FILTER(LANG(?contEn)="en") }
  OPTIONAL { ?c rdfs:label ?cEn FILTER(LANG(?cEn)="en") }
  OPTIONAL { ?c rdfs:label ?cKo FILTER(LANG(?cKo)="ko") }
}
"""
CONT_KO = {"Asia": "아시아", "Europe": "유럽", "Africa": "아프리카",
           "North America": "북아메리카", "South America": "남아메리카",
           "Oceania": "오세아니아", "Insular Oceania": "오세아니아",
           "Americas": "북아메리카", "Antarctica": "남극"}


def sparql(q):
    url = "https://query.wikidata.org/sparql?" + urllib.parse.urlencode({"query": q, "format": "json"})
    with urllib.request.urlopen(urllib.request.Request(url, headers=UA), timeout=300) as r:
        return json.loads(r.read())["results"]["bindings"]


def norm(s):
    s = unicodedata.normalize("NFKD", (s or "").lower())
    s = re.sub(r"\b(national|nature|natural|parks?|parc|parque|nacional|de|del|la|le|du|des|of|the|el|los|and)\b", " ", s)
    return re.sub(r"[^a-z0-9]", "", s)


def slug(s):
    return re.sub(r"-+", "-", re.sub(r"[^a-z0-9]+", "-", (s or "").lower())).strip("-") or "park"


def main():
    old = json.load(open(OUT, encoding="utf-8"))
    oldp = old["parks"]
    # 기존 대륙/소지역 구분을 이어받아 탐색기 계층(대륙>소지역>국가)을 유지한다
    prev = {}
    for x in oldp:
        prev.setdefault(x["iso3"], (x["continentKo"], x["subregionKo"], x["countryKo"], x["country"]))

    ctry = {}
    for x in sparql(COUNTRY_Q):
        e = ctry.setdefault(x["iso"]["value"], {"en": None, "ko": None, "cont": set()})
        e["en"] = e["en"] or x.get("cEn", {}).get("value")
        e["ko"] = e["ko"] or x.get("cKo", {}).get("value")
        if "contEn" in x:
            e["cont"].add(x["contEn"]["value"])
    print("국가 매핑", len(ctry))

    def meta(iso):
        if iso in prev:
            return prev[iso]
        m = ctry.get(iso) or {}
        c = next((CONT_KO[x] for x in m.get("cont", []) if x in CONT_KO), None)
        if not c:
            return None
        return c, c, (m.get("ko") or m.get("en") or iso), (m.get("en") or iso)

    seen, cand = set(), []
    for r in sparql(PARKS_Q):
        qid = r["item"]["value"].rsplit("/", 1)[-1]
        if qid in seen:
            continue
        seen.add(qid)
        iso = r.get("iso", {}).get("value")
        if not iso or iso == "KOR":          # 국내 24곳은 regions.js 가 담당
            continue
        mm = meta(iso)
        if not mm:
            continue
        m = re.match(r"Point\(([-\d.]+) ([-\d.]+)\)", r["coord"]["value"])
        if not m:
            continue
        lng, lat = round(float(m.group(1)), 5), round(float(m.group(2)), 5)
        if not (-90 <= lat <= 90 and -180 <= lng <= 180):
            continue
        en = r.get("en", {}).get("value") or r.get("ko", {}).get("value")
        if not en or re.fullmatch(r"Q\d+", en):
            continue
        cand.append({"qid": qid, "en": en, "ko": r.get("ko", {}).get("value"),
                     "lat": lat, "lng": lng, "iso": iso, "meta": mm})
    print("후보", len(cand))

    cur = [x for x in oldp if x.get("curated")]
    link = {}
    for c in cur:
        k = norm(c.get("nameEn") or c["name"])
        best, bd = None, 0.6
        for x in cand:
            if x["qid"] in link:
                continue
            d = math.hypot(c["lat"] - x["lat"], (c["lng"] - x["lng"]) * math.cos(math.radians(c["lat"])))
            nx = norm(x["en"])
            if d < bd and (k == nx or k in nx or nx in k):
                best, bd = x, d
        if best:
            link[best["qid"]] = c
    print("큐레이션 연결", len(link), "/", len(cur))

    parks, ids = [], set()
    for x in cand:
        c = link.get(x["qid"])
        contKo, subKo, koName, enName = x["meta"]
        pid = c["id"] if c else slug(x["en"])
        while pid in ids:
            pid += "-" + x["qid"].lower()
        ids.add(pid)
        rec = {"id": pid, "name": (c or {}).get("name") or x["ko"] or x["en"],
               "nameEn": x["en"], "lat": x["lat"], "lng": x["lng"], "iso3": x["iso"],
               "country": enName, "countryKo": koName,
               "continentKo": contKo, "subregionKo": subKo,
               "iucn": "2", "wikidata": x["qid"]}
        if x["ko"] and x["ko"] != x["en"]:
            rec["nameLocal"] = x["ko"]        # 탐색기 검색이 nameLocal 도 본다
        if c:
            rec["curated"] = True
            for k in ("desc", "site"):
                if c.get(k):
                    rec[k] = c[k]
        parks.append(rec)

    for c in cur:                              # 짝 못 찾은 큐레이션은 살린다
        if c not in link.values() and c["id"] not in ids:
            ids.add(c["id"])
            parks.append(c)

    idx = {}
    for p in parks:
        cc = idx.setdefault(p["continentKo"], {"name": p["continentKo"], "count": 0, "subregions": {}})
        cc["count"] += 1
        s = cc["subregions"].setdefault(p["subregionKo"], {"name": p["subregionKo"], "count": 0, "countries": {}})
        s["count"] += 1
        k = s["countries"].setdefault(p["iso3"], {"iso3": p["iso3"], "name": p["countryKo"],
                                                  "nameEn": p["country"], "count": 0})
        k["count"] += 1
    hier = [{"name": c["name"], "count": c["count"],
             "subregions": [{"name": s["name"], "count": s["count"],
                             "countries": sorted(s["countries"].values(), key=lambda x: -x["count"])}
                            for s in sorted(c["subregions"].values(), key=lambda x: -x["count"])]}
            for c in sorted(idx.values(), key=lambda x: -x["count"])]

    out = {"generatedAt": old.get("generatedAt"), "total": len(parks), "hierarchy": hier,
           "parks": parks, "curatedCount": sum(1 for p in parks if p.get("curated")),
           "note": "IUCN II 국립공원 · 좌표·국가는 Wikidata(P31/P279* Q46169, P625) · 큐레이션 설명은 수작업"}
    json.dump(out, open(OUT, "w", encoding="utf-8"), ensure_ascii=False, separators=(",", ":"))
    print(f"{len(parks)}곳 · 큐레이션 {out['curatedCount']}")
    for c in hier:
        print(f"  {c['name']:8}{c['count']:6}")


if __name__ == "__main__":
    sys.stdout.reconfigure(encoding="utf-8")
    main()
