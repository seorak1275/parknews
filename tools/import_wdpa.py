# -*- coding: utf-8 -*-
"""
IUCN / UNEP-WCMC  WDPA → assets/data/parks-global.json 교체 임포터

  IUCN 카테고리 II(National Park) 보호구역을 국가별로 내려받아
  대륙▸지역▸국가▸공원 계층 데이터로 재생성합니다.
  현재 OSM 기반 데이터의 한계(캐나다 주립공원 혼입, 오세아니아 누락)를 해소합니다.

사용법
  1) https://api.protectedplanet.net/request 에서 토큰 발급 (무료·승인제)
  2) set WDPA_TOKEN=발급받은_토큰          (PowerShell: $env:WDPA_TOKEN="…")
  3) python tools/import_wdpa.py assets/data/parks-global.json

옵션
  --keep-curated   기존 파일의 한국어명·설명(curated=true)을 좌표로 대조해 이어붙임 (기본 켜짐)
  --limit N        국가당 최대 N곳 (테스트용)

⚖️ WDPA는 비상업적 이용 시 출처 표기 조건입니다.
   출처: UNEP-WCMC and IUCN (연도), Protected Planet: The World Database on
        Protected Areas (WDPA), Cambridge, UK. www.protectedplanet.net
"""
import argparse, json, math, os, sys, time, urllib.parse, urllib.request

sys.stdout.reconfigure(encoding="utf-8")

API = "https://api.protectedplanet.net/v4/protected_areas/search"
IUCN_CATEGORY_II = "II"
UA = {"User-Agent": "ParkNews/1.0 (national park news dashboard)"}

CONTINENT_KO = {
    "Africa": "아프리카", "Asia": "아시아", "Europe": "유럽",
    "North America": "북아메리카", "South America": "남아메리카",
    "Oceania": "오세아니아", "Antarctica": "남극", "Seven seas (open ocean)": "해양",
}
SUBREGION_KO = {
    "Eastern Africa": "동아프리카", "Middle Africa": "중앙아프리카", "Northern Africa": "북아프리카",
    "Southern Africa": "남아프리카", "Western Africa": "서아프리카", "Central Asia": "중앙아시아",
    "Eastern Asia": "동아시아", "South-Eastern Asia": "동남아시아", "Southern Asia": "남아시아",
    "Western Asia": "서아시아", "Eastern Europe": "동유럽", "Northern Europe": "북유럽",
    "Southern Europe": "남유럽", "Western Europe": "서유럽", "Caribbean": "카리브",
    "Central America": "중앙아메리카", "Northern America": "북아메리카", "South America": "남아메리카",
    "Australia and New Zealand": "호주·뉴질랜드", "Melanesia": "멜라네시아",
    "Micronesia": "미크로네시아", "Polynesia": "폴리네시아",
    "Antarctica": "남극", "Seven seas (open ocean)": "해양",
}


def fetch(token, iso3, page, per_page=50):
    qs = urllib.parse.urlencode({
        "token": token, "country": iso3, "iucn_category": IUCN_CATEGORY_II,
        "page": page, "per_page": per_page, "with_geometry": "false",
    })
    req = urllib.request.Request(f"{API}?{qs}", headers=UA)
    for attempt in range(4):
        try:
            with urllib.request.urlopen(req, timeout=60) as r:
                return json.load(r)
        except urllib.error.HTTPError as e:
            if e.code == 401:
                sys.exit("토큰이 거부되었습니다 (401). WDPA_TOKEN 을 확인하세요.")
            if e.code in (429, 502, 503, 504) and attempt < 3:
                time.sleep(2 ** attempt); continue
            raise
        except Exception:
            if attempt < 3:
                time.sleep(2 ** attempt); continue
            raise
    return {"protected_areas": []}


def iso3_list():
    """Natural Earth 국경 파일에서 ISO3 목록을 뽑아 쓴다 (build 단계 산출물 재사용)."""
    ne = os.path.join(os.path.dirname(__file__), "ne50.geojson")
    if not os.path.exists(ne):
        url = ("https://raw.githubusercontent.com/nvkelso/natural-earth-vector/"
               "master/geojson/ne_50m_admin_0_countries.geojson")
        print("Natural Earth 내려받는 중…")
        with urllib.request.urlopen(urllib.request.Request(url, headers=UA), timeout=300) as r, \
             open(ne, "wb") as f:
            f.write(r.read())
    data = json.load(open(ne, encoding="utf-8"))
    out = {}
    for f in data["features"]:
        p = f["properties"]
        iso = p.get("ISO_A3_EH") or p.get("ISO_A3") or p.get("ADM0_A3")
        if not iso or iso == "-99":
            iso = p.get("ADM0_A3")
        if not iso or iso in out:
            continue
        out[iso] = {
            "country": p.get("NAME_EN") or p.get("NAME"),
            "countryKo": p.get("NAME_KO") or p.get("NAME_EN") or p.get("NAME"),
            "continent": p.get("CONTINENT") or "?",
            "subregion": p.get("SUBREGION") or "?",
        }
    return out


def slugify(s, used):
    import re, unicodedata
    t = unicodedata.normalize("NFKD", s).encode("ascii", "ignore").decode()
    t = re.sub(r"[^a-zA-Z0-9]+", "-", t).strip("-").lower()[:38] or "park"
    base, n = t, 2
    while t in used:
        t = f"{base}-{n}"; n += 1
    used.add(t)
    return t


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("out")
    ap.add_argument("--limit", type=int, default=0)
    ap.add_argument("--keep-curated", action="store_true", default=True)
    args = ap.parse_args()

    token = os.environ.get("WDPA_TOKEN")
    if not token:
        sys.exit("환경변수 WDPA_TOKEN 이 없습니다. https://api.protectedplanet.net/request 에서 발급하세요.")

    # 기존 큐레이션(한국어명·설명) 보존용
    curated = []
    if args.keep_curated and os.path.exists(args.out):
        old = json.load(open(args.out, encoding="utf-8"))
        curated = [p for p in old.get("parks", []) if p.get("curated")]
        print(f"기존 큐레이션 {len(curated)}곳 보존 예정")

    countries = iso3_list()
    print(f"대상 국가 {len(countries)}개 · IUCN 카테고리 II 조회 시작\n")

    used, parks = set(), []
    for i, (iso, meta) in enumerate(sorted(countries.items()), 1):
        page, got = 1, 0
        while True:
            d = fetch(token, iso, page)
            areas = d.get("protected_areas") or []
            if not areas:
                break
            for a in areas:
                # 좌표: geojson 미요청 시 centroid 필드가 없을 수 있어 방어적으로 처리
                lat = a.get("latitude") or (a.get("centroid") or {}).get("lat")
                lon = a.get("longitude") or (a.get("centroid") or {}).get("lon")
                if lat is None or lon is None:
                    continue
                name = a.get("name_english") or a.get("name") or "?"
                parks.append({
                    "id": slugify(name, used),
                    "name": name, "nameEn": name, "nameLocal": a.get("name"),
                    "lat": round(float(lat), 5), "lng": round(float(lon), 5),
                    "iso3": iso,
                    "country": meta["country"], "countryKo": meta["countryKo"],
                    "continent": meta["continent"],
                    "continentKo": CONTINENT_KO.get(meta["continent"], meta["continent"]),
                    "subregion": meta["subregion"],
                    "subregionKo": SUBREGION_KO.get(meta["subregion"], meta["subregion"]),
                    "iucn": "2",
                    "wdpaId": a.get("wdpa_id") or a.get("site_id"),
                    "areaKm2": a.get("reported_area") or a.get("gis_area"),
                })
                got += 1
                if args.limit and got >= args.limit:
                    break
            if args.limit and got >= args.limit:
                break
            if len(areas) < 50:
                break
            page += 1
            time.sleep(0.25)
        if got:
            print(f"  [{i:3}/{len(countries)}] {iso} {meta['countryKo'][:14]:16} {got:4}곳")

    # 큐레이션 한국어명 재적용 (좌표 0.6° 이내 최근접)
    def d(a, b):
        return math.hypot(a["lat"] - b["lat"], (a["lng"] - b["lng"]) * math.cos(math.radians(a["lat"])))

    applied = 0
    for c in curated:
        near = sorted((p for p in parks if d(c, p) < 0.6), key=lambda p: d(c, p))
        if near:
            near[0]["name"] = c["name"]
            near[0]["desc"] = c.get("desc", "")
            near[0]["curated"] = True
            applied += 1
    print(f"\n큐레이션 재적용: {applied}/{len(curated)}")

    # 계층 집계
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

    json.dump({
        "source": "UNEP-WCMC and IUCN, Protected Planet: WDPA (IUCN Category II)",
        "sourceUrl": "https://www.protectedplanet.net",
        "total": len(parks), "curatedCount": applied,
        "hierarchy": hierarchy, "parks": parks,
    }, open(args.out, "w", encoding="utf-8"), ensure_ascii=False, separators=(",", ":"))

    print(f"\n총 {len(parks)}곳 → {args.out} ({os.path.getsize(args.out)/1024:.0f} KB)")
    for c in hierarchy:
        print(f"  {c['name']:8} {c['count']:5}곳")


if __name__ == "__main__":
    main()
