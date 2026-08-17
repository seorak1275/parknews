# -*- coding: utf-8 -*-
"""공공데이터포털 등록 관례에 맞춘 제출 묶음을 만든다.

  python tools/build_portal_package.py [폴더]

참고한 기존 등록 사례
  · 한국수자원공사_가뭄뉴스정보        게시일자/뉴스제목/키워드/뉴스매체/url
  · 한국언론진흥재단_뉴스빅데이터_메타데이터_{주제}   주제별로 쪼개 여러 건 등록
  · 한국언론진흥재단_뉴스빅데이터_고빈도사용명사_{지면}  원자료에서 한 번 더 뽑은 재가공물

거기서 가져온 규칙
  1) 파일명 = 기관_데이터명_YYYYMMDD
  2) 주제(섹터)별로 쪼개 여러 건으로 낸다 — 쓰는 사람이 필요한 것만 받는다
  3) 원자료 외에 '고빈도 키워드' 같은 재가공물을 함께 낸다
  4) 제공속성(컬럼명·설명·샘플)을 문서로 붙인다

만드는 것
  국립공원공단_국립공원뉴스정보_YYYYMMDD.csv          전체
  국립공원공단_국립공원뉴스정보_{섹터}_YYYYMMDD.csv    섹터별 5건
  국립공원공단_국립공원뉴스_고빈도키워드_YYYYMMDD.csv   재가공
  국립공원공단_해외국립공원뉴스정보_YYYYMMDD.csv       해외
  메타데이터_제공속성.md                              등록용 설명
"""
import csv, glob, io, os, re, sys, time
from collections import Counter

D = sys.argv[1] if len(sys.argv) > 1 else os.path.join(
    os.path.expanduser("~"), "Desktop", "데이터뱅크_국립공원뉴스")
ORG = "국립공원공단"
TODAY = time.strftime("%Y%m%d")
SECTORS = ["구조활동", "재난안전", "자원보전", "탐방시설", "행정"]

# 키워드 추출에서 뺄 낱말 — 너무 흔해 정보가 없다
STOP = set("""국립공원 공원 기사 사진 영상 뉴스 기자 지난 올해 이번 오늘 내일 관련 위해 대한
있다 없다 한다 된다 이다 통해 대해 따라 위한 등의 로써 에서 에게 우리 그는 이날 최근 지역
당시 다시 모두 가장 함께 계속 이어 이후 이전 하는 하며 했다 한편 특히 또한 실시 진행 개최""".split())


def newest(pat):
    fs = sorted(glob.glob(os.path.join(D, pat)))
    return fs[-1] if fs else None


def read(p):
    return list(csv.DictReader(io.open(p, encoding="utf-8-sig"))) if p else []


def write(name, header, rows):
    p = os.path.join(D, name)
    with io.open(p, "w", encoding="utf-8-sig", newline="") as f:
        w = csv.DictWriter(f, fieldnames=header, extrasaction="ignore")
        w.writeheader(); w.writerows(rows)
    print(f"  ✓ {name}  {len(rows):,}행")


def to_portal(r, overseas=False):
    """가뭄뉴스정보 컬럼 관례에 맞춘다 — 게시일자/뉴스제목/키워드/뉴스매체/url

    AI 친화 체크리스트를 따른다.
      · 빈 셀을 두지 않는다 — '해당없음'/'미분류' 처럼 뜻이 있는 값으로 채운다
      · 사람이 아니라 규칙이 붙인 값(분야·세부분류)은 그렇다고 밝힌다
        ("기계가 자동으로 단 주석이 포함된 경우 이를 명확히 구분하여 표기")
    """
    blank = lambda v, alt: (v or "").strip() or alt
    base = {
        "게시일자": r.get("보도일", ""),
        "뉴스제목": r.get("제목", ""),
        "분야_자동분류": blank(r.get("섹터"), "기타"),
        "세부분류_자동분류": blank(r.get("세부분류"), "미분류"),
        "뉴스매체": blank(r.get("매체도메인") or r.get("매체"), "미상"),
        "url": r.get("링크", ""),
        "분류방법": "규칙기반 자동분류(제목·요약 낱말 대조)",
    }
    if overseas:
        base.update({"공원명": r.get("공원", ""), "영문공원명": r.get("영문명", ""),
                     "국가": blank(r.get("국가"), "미상"),
                     "대륙": blank(r.get("대륙"), "미상"),
                     "기사언어": r.get("언어", "")})
    else:
        base.update({"공원명": r.get("공원", ""),
                     "소재지": blank(r.get("소재지"), "전국·공통"),
                     "공원판정근거": blank(r.get("공원판정"), "해당없음")})
    return base


def main():
    news = read(newest("국립공원_뉴스아카이브_네이버_*.csv"))
    glob_news = read(newest("해외국립공원_뉴스_*.csv"))
    if not news:
        print("국내 아카이브가 없습니다."); return
    print(f"국내 {len(news):,}건 · 해외 {len(glob_news):,}건")

    KR_H = ["게시일자", "공원명", "소재지", "분야_자동분류", "세부분류_자동분류",
            "뉴스제목", "뉴스매체", "url", "공원판정근거", "분류방법"]
    GL_H = ["게시일자", "공원명", "영문공원명", "국가", "대륙", "기사언어",
            "분야_자동분류", "뉴스제목", "뉴스매체", "url", "분류방법"]

    kr = [to_portal(r) for r in news]
    write(f"{ORG}_국립공원뉴스정보_{TODAY}.csv", KR_H, kr)

    # 주제(분야)별로 쪼갠다 — 언론재단이 주제별로 나눠 등록하는 방식
    for s in SECTORS:
        part = [x for x in kr if x["분야_자동분류"] == s]
        if part:
            write(f"{ORG}_국립공원뉴스정보_{s}_{TODAY}.csv", KR_H, part)

    if glob_news:
        write(f"{ORG}_해외국립공원뉴스정보_{TODAY}.csv",
              GL_H, [to_portal(r, True) for r in glob_news])

    # ── 재가공물: 고빈도 키워드 (분야 × 연도) ──
    # 언론재단 '고빈도사용명사' 를 본떴다. 원자료를 그대로 내는 데서 그치지 않고
    # 무엇이 화두였는지 바로 읽히게 한다.
    rows = []
    for s in SECTORS:
        for y in sorted({r["보도일"][:4] for r in news if r.get("보도일")}, reverse=True)[:11]:
            texts = [r["제목"] for r in news
                     if r["섹터"] == s and (r.get("보도일") or "").startswith(y)]
            if len(texts) < 20:
                continue
            c = Counter()
            for t in texts:
                for w in re.sub(r"[^\w\s]", " ", t).split():
                    if len(w) >= 2 and w not in STOP and not w.isdigit():
                        c[w] += 1
            for rank, (w, n) in enumerate(c.most_common(20), 1):
                rows.append({"분야": s, "연도": y, "순위": rank, "키워드": w,
                             "빈도": n, "기사수": len(texts),
                             "출현율(%)": round(n / len(texts) * 100, 1)})
    write(f"{ORG}_국립공원뉴스_고빈도키워드_{TODAY}.csv",
          ["분야", "연도", "순위", "키워드", "빈도", "기사수", "출현율(%)"], rows)

    # ── 등록용 메타데이터 ──
    sample = kr[0] if kr else {}
    doc = f"""# 공공데이터 등록용 메타데이터

## 기본 정보

| 항목 | 내용 |
|---|---|
| 파일데이터명 | {ORG}_국립공원뉴스정보_{TODAY} |
| 분류체계 | 환경 - 자연환경 |
| 제공기관 | {ORG} |
| 업데이트 주기 | 월간 |
| 확장자 | CSV (UTF-8 BOM) |
| 등록 파일 수 | 전체 1 + 분야별 {len(SECTORS)} + 해외 1 + 재가공 1 |

## 개요

국립공원 관련 언론 보도를 수집해 **공원 24곳**과 **업무 분야 5종**으로 분류하고,
분야 안에서 다시 **세부분류 43종**으로 나눈 자료입니다.
기사 본문은 담지 않으며 제목·매체·링크만 제공합니다(언론사 저작물).

## 제공 속성 — 국립공원뉴스정보

| 컬럼 | 설명 | 샘플 |
|---|---|---|
| 게시일자 | 보도 일자 (KST) | {sample.get('게시일자','2026-08-14')} |
| 공원명 | 국립공원 24곳 중 하나. 특정 공원이 없으면 (전체·공통) | {sample.get('공원명','지리산')} |
| 소재지 | 해당 공원의 행정구역 | {sample.get('소재지','전남·전북·경남')} |
| 분야 | 구조활동 / 재난안전 / 자원보전 / 탐방시설 / 행정 / 기타 | {sample.get('분야','구조활동')} |
| 세부분류 | 분야 안의 세부 유형 (43종) | {sample.get('세부분류','실족·추락')} |
| 뉴스제목 | 기사 제목 | {sample.get('뉴스제목','')[:36]} |
| 뉴스매체 | 보도 매체 도메인 | {sample.get('뉴스매체','yna.co.kr')} |
| url | 원문 주소 | {sample.get('url','')[:44]} |
| 공원판정근거 | 공원명을 제목에서 찾았는지(제목) 요약에서 찾았는지(요약) | 제목 |

> **공원판정근거** 를 반드시 함께 보십시오. '요약' 인 건은 다른 사건 기사가
> 본문에서 그 공원을 예로 든 경우가 섞여 있습니다. 공원별 통계를 낼 때는
> '제목' 만 쓰는 것을 권합니다.

## 제공 속성 — 고빈도키워드 (재가공)

| 컬럼 | 설명 |
|---|---|
| 분야 / 연도 | 집계 단위 |
| 순위 / 키워드 / 빈도 | 그 해 그 분야 제목에서 많이 쓰인 낱말 상위 20 |
| 기사수 / 출현율(%) | 모수와 비중 |

## 수집·가공 방법

1. 네이버 검색 API 로 공원 24곳 × 5각도 + 공통 = 127개 질의, 질의당 최대 1,000건
2. 제목 기준 중복 제거, 채용·입찰·편성표 등 비기사 제외
3. 국립공원 관련어가 없는 기사 제외
4. 제목·요약의 낱말로 분야 → 세부분류 2단계 분류
5. 해외분은 한국어 표기(네이버)와 영문(구글 뉴스) 두 갈래로 수집

## 한계

- 검색 색인에 잡힌 기사 기준이라 **전수가 아닙니다.**
- 분류는 낱말 기반 자동 분류로 **일부 오분류가 있습니다.**
- 최근 연도의 건수가 많은 것은 이슈 증가가 아니라 **색인이 촘촘하기 때문**일 수 있습니다.
"""
    io.open(os.path.join(D, "메타데이터_제공속성.md"), "w", encoding="utf-8").write(doc)
    print("  ✓ 메타데이터_제공속성.md")


if __name__ == "__main__":
    sys.stdout.reconfigure(encoding="utf-8")
    main()
