# -*- coding: utf-8 -*-
"""만들어 둔 데이터셋을 사이트에서 내려받을 수 있게 저장소에 싣는다.

  python tools/publish_dataset.py [원본폴더]

왜 필요한가
  생성 스크립트는 결과를 바탕화면에 만든다. 그런데 실제 업무는 가상
  데스크톱(VDI) 안에서 하기 때문에 파일을 옮기는 단계가 하나 더 든다.
  저장소에 실어 두면 VDI 브라우저로 parknews.vercel.app 에 들어가
  바로 받을 수 있다.

  · gzip 으로 실어 31.6MB → 8.3MB (저장소가 매달 불어나는 걸 줄인다)
  · 데이터뱅크 첨부 허용 목록에 GZ 가 있으므로 받은 파일을 그대로 올려도 된다
  · 목록(data/dataset/index.json)을 함께 만들어 내려받기 화면이 읽는다
"""
import gzip, io, json, os, shutil, sys, time

SRC = sys.argv[1] if len(sys.argv) > 1 else os.path.join(
    os.path.expanduser("~"), "Desktop", "데이터뱅크_국립공원뉴스")
REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DST = os.path.join(REPO, "data", "dataset")

DESC = {
    "국립공원_뉴스아카이브_네이버": "국립공원 뉴스 기사 (공원·섹터·세부분류 포함)",
    "국립공원_이슈집계": "같은 사안끼리 묶은 이슈별 보도량",
    "국립공원_뉴스기사_원장": "구글 뉴스 수집분 (네이버 아카이브와 별개)",
    "국립공원_검색관심도_월별": "공원 24곳의 월별 검색 관심도 (2016~)",
    "국립공원_검색관심도_요약": "공원별 평균·최고 검색 관심도",
    "국립공원_세부분류_연도별": "세부분류 43종 × 연도 교차표",
    "국립공원_연도별섹터": "연도 × 섹터 5종 교차표",
    "국립공원_공원별섹터요약": "공원 × 섹터 교차표",
}


def label(name):
    base = name.rsplit(".", 1)[0]
    for k, v in DESC.items():
        if base.startswith(k):
            return v
    return ""


def main():
    if not os.path.isdir(SRC):
        print("원본 폴더가 없습니다:", SRC); return
    os.makedirs(DST, exist_ok=True)

    # 이전 판은 지운다 — 최신본만 싣는다 (저장소가 계속 불어나지 않게)
    for f in os.listdir(DST):
        os.remove(os.path.join(DST, f))

    # 압축 형식 고르기
    #   .gz 는 윈도우가 기본으로 못 연다 — 엑셀은 더더욱.
    #   작은 파일은 그냥 CSV 로 두어 눌러서 바로 엑셀로 열리게 하고,
    #   큰 파일만 ZIP 으로 싼다 (윈도우 탐색기가 기본 지원, 데이터뱅크도 ZIP 허용).
    PLAIN_LIMIT = 2 * 1024 * 1024        # 2MB 이하는 압축하지 않는다

    items = []
    for f in sorted(os.listdir(SRC)):
        p = os.path.join(SRC, f)
        if not os.path.isfile(p):
            continue
        if f.endswith(".csv"):
            raw = open(p, "rb").read()
            rows = raw.count(b"\n") - 1
            if len(raw) <= PLAIN_LIMIT:
                shutil.copy2(p, os.path.join(DST, f))
                items.append({"file": f, "name": f, "desc": label(f), "rows": rows,
                              "size": len(raw), "rawSize": len(raw),
                              "gz": True, "packed": False})
            else:
                out = f[:-4] + ".zip"
                import zipfile
                with zipfile.ZipFile(os.path.join(DST, out), "w",
                                     zipfile.ZIP_DEFLATED, compresslevel=9) as z:
                    z.writestr(f, raw)
                items.append({"file": out, "name": f, "desc": label(f), "rows": rows,
                              "size": os.path.getsize(os.path.join(DST, out)),
                              "rawSize": len(raw), "gz": True, "packed": True})
        elif f.endswith(".md"):
            shutil.copy2(p, os.path.join(DST, f))
            items.append({"file": f, "name": f, "desc": "설명 문서",
                          "rows": 0, "size": os.path.getsize(p),
                          "rawSize": os.path.getsize(p), "gz": False})

    idx = {"generatedAt": time.strftime("%Y-%m-%dT%H:%M:%S+09:00"),
           "note": "CSV 는 눌러서 바로 엑셀로 열립니다. 큰 파일만 ZIP 으로 묶여 있으니 "
                   "압축을 풀고 쓰십시오. 데이터뱅크는 CSV·ZIP 을 모두 허용합니다.",
           "items": items}
    io.open(os.path.join(DST, "index.json"), "w", encoding="utf-8").write(
        json.dumps(idx, ensure_ascii=False, indent=1))

    tot = sum(i["size"] for i in items)
    raw = sum(i["rawSize"] for i in items)
    print(f"{len(items)}개 · {raw/1024/1024:.1f}MB → {tot/1024/1024:.1f}MB")
    for i in items:
        print(f"  {i['size']/1024/1024:6.2f}MB  {i['name'][:46]}")
    print("\n대상:", DST)


if __name__ == "__main__":
    sys.stdout.reconfigure(encoding="utf-8")
    main()
