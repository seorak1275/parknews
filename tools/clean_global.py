# -*- coding: utf-8 -*-
"""
parks-global.json 정리 — 국립공원이 아닌 항목 제거 + 중복 병합

OSM `boundary=national_park` 에는 나라별 태깅 관습 때문에
주립·도립공원, 생물권보전지역 핵심구역, 장거리 트레일 등이 섞여 들어옵니다.
이 스크립트가 그것들을 걷어내고 같은 공원을 하나로 합칩니다.

  python tools/clean_global.py assets/data/parks-global.json
"""
import json, math, re, sys, collections
sys.stdout.reconfigure(encoding="utf-8")

PATH = sys.argv[1] if len(sys.argv) > 1 else "assets/data/parks-global.json"

# ── 국립공원이 아닌 것 (이름으로 판별) ──────────────────────────
NOT_NP = [
    r"provincial\s+park", r"\bstate\s+park", r"regional\s+park",
    r"county\s+park", r"city\s+park", r"municipal",
    r"zona\s+n[úu]cleo", r"subzona", r"zona\s+de\s+amortiguamiento",
    r"biosph", r"bi[óo]sfera", r"biosfera",
    r"scenic\s+trail", r"national\s+trail", r"heritage\s+area",
    r"wildlife\s+management", r"game\s+reserve", r"hunting",
    r"parque\s+estadual", r"parque\s+municipal",
    r"landschaftsschutzgebiet", r"naturpark",
    r"área\s+de\s+protecci[óo]n\s+de\s+flora",
    r"forest\s+preserve", r"recreation\s+area",
    r"hutan\s+lindung",          # 인니: 보호림 (국립공원은 Taman Nasional)
    r"cagar\s+alam",             # 인니: 자연보호구역
    r"khu\s+b[ảa]o\s+t[ồo]n",    # 베트남: 보전구역 (국립공원은 Vườn quốc gia)
    r"lesnícky",                 # 슬로바키아 등 임업구역
]
NOT_NP_RE = re.compile("|".join(NOT_NP), re.I)

STRIP = re.compile(
    r"\b(national|nature|natural|parks?|nationalpark|parc|parque|nacional|nationaal|"
    r"nasional|nationalpark|reserve|reserva|taman|vườn|quốc|gia|de|del|la|le|du|des|"
    r"of|the|el|los|das|do|dos|and)\b", re.I)

def norm(s):
    s = STRIP.sub(" ", (s or "").lower())
    return re.sub(r"[^a-z0-9가-힣]+", "", s)

def dist_km(a, b):
    return 111.32 * math.hypot(
        a["lat"] - b["lat"], (a["lng"] - b["lng"]) * math.cos(math.radians(a["lat"])))

def richness(p):
    """정보가 더 풍부한 쪽을 남기기 위한 점수"""
    return ((2 if p.get("curated") else 0)
            + (1 if p.get("nameEn") else 0)
            + (1 if p.get("wikidata") else 0)
            + (1 if p.get("desc") else 0)
            + (1 if p.get("iucn") else 0))

def merge(keep, drop):
    """정보를 잃지 않도록 필드 보충 (한국어명·설명 우선 보존)"""
    if drop.get("curated") and not keep.get("curated"):
        keep["name"] = drop["name"]
        keep["desc"] = drop.get("desc", keep.get("desc", ""))
        keep["curated"] = True
    for k in ("nameEn", "wikidata", "desc", "iucn", "wdpaId", "areaKm2"):
        if not keep.get(k) and drop.get(k):
            keep[k] = drop[k]
    return keep


data = json.load(open(PATH, encoding="utf-8"))
parks = data["parks"]
before = len(parks)

# ── 1) 국립공원 아닌 항목 제거 (큐레이션은 보호) ──────────────
removed = collections.Counter()
kept = []
for p in parks:
    label = f"{p.get('nameEn') or ''} {p.get('nameLocal') or ''} {p.get('name') or ''}"
    if not p.get("curated") and NOT_NP_RE.search(label):
        m = NOT_NP_RE.search(label)
        removed[m.group(0).lower()] += 1
        continue
    kept.append(p)
parks = kept
print(f"① 국립공원 아님 제거: {before - len(parks)}건")
for k, v in removed.most_common(10):
    print(f"     {k:34} {v}")

# ── 2) 같은 국가 + 같은 이름 병합 ─────────────────────────────
groups = collections.defaultdict(list)
for p in parks:
    groups[(p["iso3"], norm(p.get("nameEn") or p["name"]))].append(p)

merged_name = 0
parks2 = []
for (iso, key), g in groups.items():
    if not key or len(g) == 1:
        parks2 += g
        continue
    g.sort(key=richness, reverse=True)
    head = g[0]
    for other in g[1:]:
        # 같은 이름이어도 500km 넘게 떨어져 있으면 동명이지(예: 러시아 분리 구역) → 유지
        if dist_km(head, other) > 500:
            parks2.append(other)
        else:
            head = merge(head, other)
            merged_name += 1
    parks2.append(head)
parks = parks2
print(f"\n② 같은 국가·같은 이름 병합: {merged_name}건")

# ── 3) 큐레이션 ↔ OSM 근접 중복 병합 (40km 이내 + 이름 앞부분 일치) ──
merged_near = 0
curated = [p for p in parks if p.get("curated")]
others = [p for p in parks if not p.get("curated")]
drop = set()
for c in curated:
    ck = norm(c.get("nameEn") or c["name"])
    for o in others:
        if id(o) in drop:
            continue
        if o["iso3"] != c["iso3"]:
            continue
        ok = norm(o.get("nameEn") or o["name"])
        if not ck or not ok:
            continue
        if (ck[:5] == ok[:5] or ck in ok or ok in ck) and dist_km(c, o) < 40:
            merge(c, o)
            drop.add(id(o))
            merged_near += 1
            break
parks = [p for p in parks if id(p) not in drop]
print(f"③ 큐레이션↔OSM 근접 중복 병합: {merged_near}건")

# ── 4) 계층 재집계 ────────────────────────────────────────────
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
    hierarchy.append({
        "name": c["name"], "count": c["count"],
        "subregions": [{"name": s["name"], "count": s["count"],
                        "countries": sorted(s["countries"].values(), key=lambda x: -x["count"])}
                       for s in sorted(c["subregions"].values(), key=lambda x: -x["count"])],
    })

data["parks"] = parks
data["total"] = len(parks)
data["hierarchy"] = hierarchy
data["curatedCount"] = sum(1 for p in parks if p.get("curated"))
json.dump(data, open(PATH, "w", encoding="utf-8"), ensure_ascii=False, separators=(",", ":"))

print(f"\n{before}곳 → {len(parks)}곳  (−{before - len(parks)})\n")
for c in hierarchy:
    print(f"  {c['name']:8} {c['count']:5}곳")
    for s in c["subregions"]:
        top = ", ".join(f"{k['name']} {k['count']}" for k in s["countries"][:3])
        print(f"      └ {s['name']:12} {s['count']:4}  · {top}")
