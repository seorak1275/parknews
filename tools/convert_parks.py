# -*- coding: utf-8 -*-
"""전국국립공원 경계(EPSG:5179) → 웹용 WGS84 GeoJSON + 마커 좌표 목록"""
import json, sys, os, re
sys.stdout.reconfigure(encoding="utf-8")
from pyproj import Transformer
from shapely.geometry import shape, mapping
from shapely.ops import transform as shp_transform

SRC = sys.argv[1]
OUT_GEO = sys.argv[2]
OUT_JS = sys.argv[3]
TOL = float(sys.argv[4]) if len(sys.argv) > 4 else 0.0006

# 번호 → (id, 정식명칭, 지정연도, 소재지)
META = {
    "01": ("jirisan",     "지리산국립공원",     1967, "전남·전북·경남 · 제1호 국립공원"),
    "02": ("gyeongju",    "경주국립공원",       1968, "경북 경주 · 국내 유일 사적형"),
    "03": ("gyeryongsan", "계룡산국립공원",     1968, "대전·충남 공주·계룡"),
    "04": ("hallyeo",     "한려해상국립공원",   1968, "경남·전남 · 최초의 해상 국립공원"),
    "05": ("seoraksan",   "설악산국립공원",     1970, "강원 속초·양양·인제·고성"),
    "06": ("songnisan",   "속리산국립공원",     1970, "충북 보은 · 법주사"),
    "07": ("hallasan",    "한라산국립공원",     1970, "제주 · 유네스코 세계자연유산"),
    "08": ("naejangsan",  "내장산국립공원",     1971, "전북 정읍·순창, 전남 장성"),
    "09": ("gayasan",     "가야산국립공원",     1972, "경북 성주, 경남 합천·거창"),
    "10": ("deogyusan",   "덕유산국립공원",     1975, "전북 무주·장수, 경남 거창·함양"),
    "11": ("odaesan",     "오대산국립공원",     1975, "강원 평창·홍천·강릉"),
    "12": ("juwangsan",   "주왕산국립공원",     1976, "경북 청송·영덕"),
    "13": ("taeanhaean",  "태안해안국립공원",   1978, "충남 태안 · 서해안 유일 해안형"),
    "14": ("dadohae",     "다도해해상국립공원", 1981, "전남 신안·여수 등 · 국내 최대 면적"),
    "15": ("bukhansan",   "북한산국립공원",     1983, "서울·경기 · 세계 최대 도심형"),
    "16": ("chiaksan",    "치악산국립공원",     1984, "강원 원주·횡성·영월"),
    "17": ("woraksan",    "월악산국립공원",     1984, "충북 제천·충주·단양, 경북 문경"),
    "18": ("sobaeksan",   "소백산국립공원",     1987, "충북 단양, 경북 영주·봉화"),
    "19": ("wolchulsan",  "월출산국립공원",     1988, "전남 영암·강진 · 최소 면적"),
    "20": ("byeonsan",    "변산반도국립공원",   1988, "전북 부안 · 유일한 반도형"),
    "21": ("mudeungsan",  "무등산국립공원",     2013, "광주·전남 · 주상절리대"),
    "22": ("taebaeksan",  "태백산국립공원",     2016, "강원 태백·영월·정선, 경북 봉화"),
}
NAMED = {
    "팔공산국립공원": ("palgongsan", "팔공산국립공원", 2023, "대구·경북 · 제23호 국립공원"),
    "금정산국립공원": ("geumjeongsan", "금정산국립공원", 2025, "부산·경남 양산 · 제24호 국립공원"),
}
BY_SOURCE = {"북한산": "15"}


def meta_of(props):
    nm = props.get("NLPRK_NM")
    if nm and nm in NAMED:
        return NAMED[nm]
    key = props.get("공원명") or ""
    m = re.match(r"^(\d{2})_", key)
    if m and m.group(1) in META:
        return META[m.group(1)]
    src = props.get("_source_file") or ""
    for frag, no in BY_SOURCE.items():
        if frag in src:
            return META[no]
    return None


to_wgs = Transformer.from_crs("EPSG:5179", "EPSG:4326", always_xy=True).transform

data = json.load(open(SRC, encoding="utf-8"))
feats, rows = [], []

for f in data["features"]:
    md = meta_of(f["properties"])
    if not md:
        print("!! 미매칭:", json.dumps(f["properties"], ensure_ascii=False)[:120]); continue
    pid, name, year, desc = md

    geom = shp_transform(to_wgs, shape(f["geometry"]))
    simple = geom.simplify(TOL, preserve_topology=True)
    if simple.is_empty:
        simple = geom
    if not simple.is_valid:
        simple = simple.buffer(0)

    # 마커 좌표 = 가장 큰 폴리곤의 대표점(내부 보장)
    parts = list(simple.geoms) if simple.geom_type == "MultiPolygon" else [simple]
    biggest = max(parts, key=lambda p: p.area)
    pt = biggest.representative_point()
    minx, miny, maxx, maxy = simple.bounds

    feats.append({
        "type": "Feature",
        "properties": {"id": pid, "name": name, "year": year},
        "geometry": mapping(simple),
    })
    rows.append({
        "id": pid, "name": name, "year": year, "desc": desc,
        "lng": round(pt.x, 5), "lat": round(pt.y, 5),
        "bbox": [round(minx, 4), round(miny, 4), round(maxx, 4), round(maxy, 4)],
        "areaKm2": round(geom.area * 111.32 * 111.32 * 0.75, 1),
    })

rows.sort(key=lambda r: r["year"])
fc = {"type": "FeatureCollection", "features": feats}
os.makedirs(os.path.dirname(OUT_GEO), exist_ok=True)
with open(OUT_GEO, "w", encoding="utf-8") as fp:
    json.dump(fc, fp, ensure_ascii=False, separators=(",", ":"))

with open(OUT_JS, "w", encoding="utf-8") as fp:
    for r in rows:
        fp.write(
            f"  {{ id: '{r['id']}', name: '{r['name']}', cat: 'kr', "
            f"lng: {r['lng']}, lat: {r['lat']},\n"
            f"    q: '{r['name'][:-4]} 국립공원', lang: 'ko',\n"
            f"    desc: '{r['desc']} · {r['year']}년 지정' }},\n"
        )

verts = sum(len(json.dumps(ft["geometry"])) for ft in feats)
print(f"공원 {len(feats)}개 · 파일 {os.path.getsize(OUT_GEO)/1024/1024:.2f} MB (tol={TOL})")
for r in rows:
    print(f"  {r['year']}  {r['name']:16} {r['lat']:.4f}, {r['lng']:.4f}")
