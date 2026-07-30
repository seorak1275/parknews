# -*- coding: utf-8 -*-
"""OSM 국립공원 + Natural Earth 국경 → 대륙/지역/국가 계층 데이터 생성"""
import json, os, sys, re, urllib.request, unicodedata
sys.stdout.reconfigure(encoding="utf-8")
from shapely.geometry import shape, Point
from shapely.strtree import STRtree

TMP = r"C:\Users\user\AppData\Local\Temp\parkgeo"
NE_URL = ("https://raw.githubusercontent.com/nvkelso/natural-earth-vector/"
          "master/geojson/ne_50m_admin_0_countries.geojson")
NE_PATH = os.path.join(TMP, "ne50.geojson")
OUT = sys.argv[1]

CONTINENT_KO = {
    "Africa": "아프리카", "Asia": "아시아", "Europe": "유럽",
    "North America": "북아메리카", "South America": "남아메리카",
    "Oceania": "오세아니아", "Antarctica": "남극", "Seven seas (open ocean)": "해양",
}
SUBREGION_KO = {
    "Eastern Africa": "동아프리카", "Middle Africa": "중앙아프리카",
    "Northern Africa": "북아프리카", "Southern Africa": "남아프리카",
    "Western Africa": "서아프리카",
    "Central Asia": "중앙아시아", "Eastern Asia": "동아시아",
    "South-Eastern Asia": "동남아시아", "Southern Asia": "남아시아",
    "Western Asia": "서아시아",
    "Eastern Europe": "동유럽", "Northern Europe": "북유럽",
    "Southern Europe": "남유럽", "Western Europe": "서유럽",
    "Caribbean": "카리브", "Central America": "중앙아메리카",
    "Northern America": "북아메리카", "South America": "남아메리카",
    "Australia and New Zealand": "호주·뉴질랜드", "Melanesia": "멜라네시아",
    "Micronesia": "미크로네시아", "Polynesia": "폴리네시아",
    "Antarctica": "남극", "Seven seas (open ocean)": "해양",
}

# ---------- Natural Earth 내려받기 ----------
if not os.path.exists(NE_PATH):
    print("Natural Earth 50m 내려받는 중…")
    req = urllib.request.Request(NE_URL, headers={"User-Agent": "ParkNews/1.0"})
    with urllib.request.urlopen(req, timeout=300) as r, open(NE_PATH, "wb") as f:
        f.write(r.read())
ne = json.load(open(NE_PATH, encoding="utf-8"))
print("국가 폴리곤:", len(ne["features"]))

geoms, metas = [], []
for f in ne["features"]:
    p = f["properties"]
    iso = p.get("ISO_A3_EH") or p.get("ISO_A3") or p.get("ADM0_A3") or "―"
    if iso == "-99":
        iso = p.get("ADM0_A3", "―")
    geoms.append(shape(f["geometry"]))
    metas.append({
        "iso3": iso,
        "country": p.get("NAME_EN") or p.get("NAME") or "?",
        "countryKo": p.get("NAME_KO") or p.get("NAME_EN") or p.get("NAME") or "?",
        "continent": p.get("CONTINENT") or "?",
        "subregion": p.get("SUBREGION") or p.get("REGION_UN") or "?",
    })
tree = STRtree(geoms)

def locate(lon, lat):
    pt = Point(lon, lat)
    for i in tree.query(pt):
        if geoms[i].contains(pt):
            return metas[i]
    # 해상/도서 — 가장 가까운 국가로 (2도 이내)
    best, bd = None, 2.0
    for i in tree.query(pt.buffer(2.0)):
        dd = geoms[i].distance(pt)
        if dd < bd:
            bd, best = dd, metas[i]
    return best

# ---------- 국내 큐레이션(한국어명/설명) ----------
CURATED = json.load(open(os.path.join(TMP, "curated.json"), encoding="utf-8")) \
    if os.path.exists(os.path.join(TMP, "curated.json")) else []

def slug(s, used):
    t = unicodedata.normalize("NFKD", s).encode("ascii", "ignore").decode()
    t = re.sub(r"[^a-zA-Z0-9]+", "-", t).strip("-").lower()[:38] or "park"
    b, n = t, 2
    while t in used:
        t = f"{b}-{n}"; n += 1
    used.add(t)
    return t

osm = json.load(open(os.path.join(TMP, "osm_parks.json"), encoding="utf-8"))
els = [e for e in osm["elements"] if "center" in e and e.get("tags", {}).get("name")]
print("OSM 공원:", len(els))

used, parks, unmatched = set(), [], 0
for e in els:
    t = e["tags"]
    lat, lon = round(e["center"]["lat"], 5), round(e["center"]["lon"], 5)
    loc = locate(lon, lat)
    if not loc:
        unmatched += 1
        continue
    name_en = t.get("name:en") or t.get("name")
    name_ko = t.get("name:ko")
    parks.append({
        "id": slug(name_en, used),
        "name": name_ko or name_en,
        "nameEn": name_en,
        "nameLocal": t.get("name"),
        "lat": lat, "lng": lon,
        "iso3": loc["iso3"],
        "country": loc["country"], "countryKo": loc["countryKo"],
        "continent": loc["continent"], "continentKo": CONTINENT_KO.get(loc["continent"], loc["continent"]),
        "subregion": loc["subregion"], "subregionKo": SUBREGION_KO.get(loc["subregion"], loc["subregion"]),
        "iucn": t.get("protect_class") or t.get("iucn_level") or None,
        "wikidata": t.get("wikidata"),
        "site": (t.get("website") or t.get("contact:website")
                 or t.get("url") or t.get("website:official") or None),
        "osmId": e["id"],
    })
print("국가 매칭 실패(제외):", unmatched)

# 한국은 별도 공식 데이터(경계도)를 쓰므로 OSM 한국 항목 제외
parks = [p for p in parks if p["iso3"] != "KOR"]

# ---------- 계층 집계 ----------
tree_idx = {}
for p in parks:
    c = tree_idx.setdefault(p["continentKo"], {"name": p["continentKo"], "count": 0, "subregions": {}})
    c["count"] += 1
    s = c["subregions"].setdefault(p["subregionKo"], {"name": p["subregionKo"], "count": 0, "countries": {}})
    s["count"] += 1
    k = s["countries"].setdefault(p["iso3"], {"iso3": p["iso3"], "name": p["countryKo"],
                                              "nameEn": p["country"], "count": 0})
    k["count"] += 1

hierarchy = []
for c in sorted(tree_idx.values(), key=lambda x: -x["count"]):
    subs = []
    for s in sorted(c["subregions"].values(), key=lambda x: -x["count"]):
        subs.append({"name": s["name"], "count": s["count"],
                     "countries": sorted(s["countries"].values(), key=lambda x: -x["count"])})
    hierarchy.append({"name": c["name"], "count": c["count"], "subregions": subs})

os.makedirs(os.path.dirname(OUT), exist_ok=True)
json.dump({"generatedAt": None, "total": len(parks), "hierarchy": hierarchy, "parks": parks},
          open(OUT, "w", encoding="utf-8"), ensure_ascii=False, separators=(",", ":"))

print(f"\n총 {len(parks)}곳 · {os.path.getsize(OUT)/1024:.0f} KB → {OUT}\n")
for c in hierarchy:
    print(f"  {c['name']:8} {c['count']:5}곳  ({len(c['subregions'])}개 지역)")
    for s in c["subregions"][:4]:
        top = ", ".join(f"{k['name']} {k['count']}" for k in s["countries"][:4])
        print(f"      └ {s['name']:12} {s['count']:4}  · {top}")
