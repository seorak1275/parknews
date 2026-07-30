# -*- coding: utf-8 -*-
"""큐레이션 96곳을 parks-global.json 에 병합
   · 좌표가 가까운 OSM 항목이 있으면 → 한국어명·설명을 덮어씌워 승급
   · 없으면 → 신규 추가 (오세아니아 등 OSM 태깅 공백 보완)
"""
import json, re, sys, os, math, unicodedata
sys.stdout.reconfigure(encoding="utf-8")
from shapely.geometry import shape, Point
from shapely.strtree import STRtree

GLOBAL = sys.argv[1]
CURATED_JS = sys.argv[2]
NE = r"C:\Users\user\AppData\Local\Temp\parkgeo\ne50.geojson"

CONTINENT_KO = {"Africa":"아프리카","Asia":"아시아","Europe":"유럽","North America":"북아메리카",
                "South America":"남아메리카","Oceania":"오세아니아","Antarctica":"남극",
                "Seven seas (open ocean)":"해양"}
SUBREGION_KO = {"Eastern Africa":"동아프리카","Middle Africa":"중앙아프리카","Northern Africa":"북아프리카",
  "Southern Africa":"남아프리카","Western Africa":"서아프리카","Central Asia":"중앙아시아",
  "Eastern Asia":"동아시아","South-Eastern Asia":"동남아시아","Southern Asia":"남아시아",
  "Western Asia":"서아시아","Eastern Europe":"동유럽","Northern Europe":"북유럽","Southern Europe":"남유럽",
  "Western Europe":"서유럽","Caribbean":"카리브","Central America":"중앙아메리카",
  "Northern America":"북아메리카","South America":"남아메리카","Australia and New Zealand":"호주·뉴질랜드",
  "Melanesia":"멜라네시아","Micronesia":"미크로네시아","Polynesia":"폴리네시아","Antarctica":"남극",
  "Seven seas (open ocean)":"해양"}

# ---------- 국가 판정기 ----------
ne = json.load(open(NE, encoding="utf-8"))
geoms, metas = [], []
for f in ne["features"]:
    p = f["properties"]
    iso = p.get("ISO_A3_EH") or p.get("ISO_A3") or p.get("ADM0_A3") or "―"
    if iso == "-99": iso = p.get("ADM0_A3", "―")
    geoms.append(shape(f["geometry"]))
    metas.append({"iso3": iso,
                  "country": p.get("NAME_EN") or p.get("NAME") or "?",
                  "countryKo": p.get("NAME_KO") or p.get("NAME_EN") or "?",
                  "continent": p.get("CONTINENT") or "?",
                  "subregion": p.get("SUBREGION") or "?"})
tree = STRtree(geoms)

def locate(lon, lat):
    pt = Point(lon, lat)
    for i in tree.query(pt):
        if geoms[i].contains(pt): return metas[i]
    best, bd = None, 3.0
    for i in tree.query(pt.buffer(3.0)):
        d = geoms[i].distance(pt)
        if d < bd: bd, best = d, metas[i]
    return best

# ---------- 큐레이션 파싱 ----------
src = open(CURATED_JS, encoding="utf-8").read()
cur = []
for m in re.finditer(
    r"\{\s*id:\s*'([^']+)',\s*name:\s*'([^']+)',\s*cat:\s*'global',\s*"
    r"lng:\s*(-?[\d.]+),\s*lat:\s*(-?[\d.]+),\s*\n?\s*q:\s*'([^']+)',\s*lang:\s*'en',\s*"
    r"desc:\s*'([^']+)'", src):
    cur.append({"id": m.group(1), "name": m.group(2), "lng": float(m.group(3)),
                "lat": float(m.group(4)), "q": m.group(5), "desc": m.group(6)})
print("큐레이션 파싱:", len(cur))

data = json.load(open(GLOBAL, encoding="utf-8"))
parks = data["parks"]
byid = {p["id"] for p in parks}

def dist(a, b):
    return math.hypot(a["lat"] - b["lat"], (a["lng"] - b["lng"]) * math.cos(math.radians(a["lat"])))

# 이름 정규화 — 거리만으로 매칭하면 엉뚱한 공원에 덮어쓴다.
# (예: Grand Canyon 큐레이션 → 60km 떨어진 'Ancestral Footprints ... National Monument')
_STRIP = re.compile(
    r"\b(national|nature|natural|parks?|parc|parque|nacional|monument|reserve|reserva|"
    r"de|del|la|le|du|des|of|the|el|los|and)\b", re.I)
def key(s):
    return re.sub(r"[^a-z0-9]+", "", _STRIP.sub(" ", (s or "").lower()))

def name_match(c, p):
    a = key(c["name"]) or key(c["q"])
    b = key(p.get("nameEn") or "") or key(p.get("name") or "")
    if not a or not b:
        return False
    return a == b or a.startswith(b[:5]) or b.startswith(a[:5]) or a in b or b in a

promoted = added = 0
for c in cur:
    # 거리 AND 이름이 함께 맞아야 승급 (거리는 넉넉히 1.2도까지 허용)
    near = [p for p in parks if dist(c, p) < 1.2 and name_match(c, p)]
    near.sort(key=lambda p: dist(c, p))
    if near:
        p = near[0]
        p["name"] = c["name"]
        p["desc"] = c["desc"]
        p["curated"] = True
        if not p.get("nameEn"): p["nameEn"] = c["q"]
        promoted += 1
    else:
        loc = locate(c["lng"], c["lat"])
        if not loc:
            print("  !! 국가 판정 실패:", c["name"]); continue
        pid = c["id"] if c["id"] not in byid else c["id"] + "-c"
        byid.add(pid)
        parks.append({
            "id": pid, "name": c["name"], "nameEn": c["q"], "nameLocal": c["name"],
            "lat": c["lat"], "lng": c["lng"],
            "iso3": loc["iso3"], "country": loc["country"], "countryKo": loc["countryKo"],
            "continent": loc["continent"], "continentKo": CONTINENT_KO.get(loc["continent"], loc["continent"]),
            "subregion": loc["subregion"], "subregionKo": SUBREGION_KO.get(loc["subregion"], loc["subregion"]),
            "iucn": "2", "desc": c["desc"], "curated": True,
        })
        added += 1
print(f"승급 {promoted} · 신규 {added} · 총 {len(parks)}")

# ---------- 계층 재집계 ----------
idx = {}
for p in parks:
    c = idx.setdefault(p["continentKo"], {"name": p["continentKo"], "count": 0, "subregions": {}})
    c["count"] += 1
    s = c["subregions"].setdefault(p["subregionKo"], {"name": p["subregionKo"], "count": 0, "countries": {}})
    s["count"] += 1
    k = s["countries"].setdefault(p["iso3"], {"iso3": p["iso3"], "name": p["countryKo"],
                                              "nameEn": p["country"], "count": 0})
    k["count"] += 1

hierarchy = []
for c in sorted(idx.values(), key=lambda x: -x["count"]):
    subs = [{"name": s["name"], "count": s["count"],
             "countries": sorted(s["countries"].values(), key=lambda x: -x["count"])}
            for s in sorted(c["subregions"].values(), key=lambda x: -x["count"])]
    hierarchy.append({"name": c["name"], "count": c["count"], "subregions": subs})

data["parks"] = parks
data["total"] = len(parks)
data["hierarchy"] = hierarchy
data["curatedCount"] = sum(1 for p in parks if p.get("curated"))
json.dump(data, open(GLOBAL, "w", encoding="utf-8"), ensure_ascii=False, separators=(",", ":"))

print(f"\n{os.path.getsize(GLOBAL)/1024:.0f} KB · 큐레이션 표기 {data['curatedCount']}곳\n")
for c in hierarchy:
    print(f"  {c['name']:8} {c['count']:5}곳")
    for s in c["subregions"]:
        print(f"      └ {s['name']:12} {s['count']:4}  ({len(s['countries'])}개국)")
