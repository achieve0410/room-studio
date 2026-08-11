# Room Studio 시장 준비도

기준일: 2026-08-11

초기 평가: **65/100 — RED**

Cycle 2 후 평가: **83/100 — GREEN**

## 결론

Room Studio는 “브라우저에서 빠르게 실측 도면을 만들고 가구가 실제로 들어가는지 확인한다”는 핵심 작업을 수행할 수 있다. 정밀한 2D 편집, 충돌·높이 검사, 3D 워크스루, 모바일 대응, 로컬 우선 데이터 소유권은 공개 데모 이상의 완성도다.

초기 상태는 강한 편집 기능에 비해 첫 사용자가 가치를 발견하는 경로와 작업 결과를 전달하는 산출물이 약해 65점이었다. 두 번의 구현 cycle로 다음 blocker를 제거했고, 고정 기준에서 83점으로 시장 준비도 통과 상태가 됐다.

1. self-contained 의사결정 리포트가 도면·지표·경고·가구·안전 경계를 한 파일로 전달한다.
2. clean profile은 sample·blank·import 경로를 명확히 제공하고, 기존 local data는 자동 표시하거나 덮어쓰지 않는다.

이 GREEN은 측정 가능한 pilot을 시작할 제품 준비도를 뜻한다. 실제 PMF나 매출 검증을 뜻하지 않으며, 다음 제품 기능을 추가하기 전에 activation·report export·retention·지불 의향 데이터를 수집해야 한다.

## 목표 고객과 차별화 가설

### 초기 ICP

- 이사 또는 가구 구매 전에 실제 치수로 배치를 확인하려는 한국 사용자
- 고객과 빠르게 배치 대안을 확인해야 하는 소형 인테리어·가구 상담자
- 계정 생성이나 설계 데이터 업로드를 원하지 않는 privacy-sensitive 사용자

### 핵심 작업

> “실측 치수와 보유·구매 예정 가구를 넣어 배치 위험을 확인하고, 가족·판매자·상담자에게 하나의 이해 가능한 결과물로 전달한다.”

### 방어 가능한 wedge

- 기본 작업은 로그인 없이 로컬에서 수행
- 센티미터 단위의 빠른 2D 편집과 즉시 3D 확인
- 원본 도면·계정 metadata를 소유자가 통제
- 렌더링 감상보다 **구매 전 배치 의사결정**에 집중

AI 이미지 생성이나 거대한 가구 카탈로그를 정면 경쟁축으로 삼지 않는다. 이 영역은 대형 경쟁사가 이미 규모·데이터·콘텐츠 우위를 가진다.

## 공식 자료 기반 경쟁 비교

가격과 기능은 지역·프로모션에 따라 바뀔 수 있다. 아래 내용은 2026-08-11에 확인한 각 서비스의 공식 페이지 기준이다.

| 서비스 | 공식 포지션과 수익 모델 | 강한 시장 기능 | Room Studio가 피해야 할 정면 경쟁 |
|---|---|---|---|
| Planner 5D | Free, Premium, Professional, Enterprise. 확인 당시 Premium 연간 환산 월 $4.99, Professional 연간 환산 월 $33.33 | 무제한 프로젝트 공유, 10K+ 카탈로그, AI 도면·배치, 4K 렌더, 360° walkthrough, CAD·견적·white label | 카탈로그 규모, 생성형 AI, photorealistic render |
| RoomSketcher | 무료 체험, Pro $12/월(연 결제), Team | 전문 2D/3D 도면, Live 3D, 측정·브랜딩, 팀·대량 작업 | 부동산·전문 도면 생산 workflow |
| Floorplanner | 무료 SD+watermark, 프로젝트별 credit로 HD/4K/8K upgrade | 쉬운 2D/3D 설계와 고해상도 결과물의 credit monetization | 대규모 rendering/export infrastructure |
| Homestyler | Free Basic + Pro/Master/Styler/AI Boost 등 freemium | 대형 3D 모델 라이브러리, 무료 1K render, 고해상도·AI 유료화 | 인테리어 스타일링 콘텐츠와 render economy |
| magicplan | 프로젝트 단위 과금, 모든 기능 포함 | 모바일/LiDAR capture, PDF report, shareable link, estimate, 팀 협업 | 현장 조사·견적·보험·시공 운영 |
| IKEA Kreativ | IKEA 판매 전환을 위한 무료 공간 디자인 | 무료 진입과 IKEA 구매 여정의 직접 연결 | 특정 유통 카탈로그와 commerce integration |

### 공식 출처

- Planner 5D pricing: https://planner5d.com/pricing
- Planner 5D AI tools: https://planner5d.com/use/ai-interior-design
- RoomSketcher pricing: https://www.roomsketcher.com/pricing/
- Floorplanner pricing: https://floorplanner.com/pricing
- Homestyler pricing: https://www.homestyler.com/pricing
- magicplan pricing and features: https://www.magicplan.app/pricing
- IKEA Kreativ home design: https://www.ikea.com/us/en/home-design/

## Room Studio의 객관적 위치

### 이미 시장가치가 있는 부분

- 별도 설치 없이 실행되는 정밀 2D/3D 편집기
- 배경 도면 보정, 치수선, 구조물, 문·창문, 높이를 포함한 실제 배치 workflow
- 충돌, 집 밖 배치, 공간 높이, 구역 중첩 경고
- 모바일 portrait/landscape에서 유지되는 canvas-first 편집
- portable JSON과 명시적 삭제를 포함한 데이터 lifecycle
- 공개 코드와 로컬 우선 동작이 제공하는 신뢰·확장성

### 현재 부족한 부분

| 우선순위 | 격차 | 시장 영향 | 이번 loop |
|---|---|---|---|
| P0 | 사람에게 전달할 의사결정 산출물 없음 | 작업 완료 후 공유·상담·구매 행동으로 이어지지 않음 | self-contained HTML report |
| P0 | 첫 사용 경로가 불명확 | 강한 기능을 발견하기 전에 이탈 가능 | 조건부 starter surface |
| P1 | cloud conflict recovery 부족 | 여러 기기에서 신뢰 저하 | 후속 lifecycle cycle |
| P1 | full account export 부족 | 데이터 이동권·B2B 신뢰 한계 | 후속 lifecycle cycle |
| P1 | 실제 screen-reader entity operation 부족 | 접근성·공공/기업 도입 한계 | 후속 accessibility cycle |
| P2 | rotated collision 정밀도·대규모 성능 | 복잡한 도면에서 오탐·지연 | 사용량 근거 후 최적화 |
| P2 | collaboration·public link 없음 | 상담자 반복사용·viral loop 제한 | 권한 모델 설계 후 검토 |

## 고정 100점 scorecard

반복 구현 중 배점이나 통과선을 변경하지 않는다. 상세 machine-readable 근거는 `.omo/evidence/market-readiness/scorecard-baseline.json`에 있다.

| 차원 | 배점 | 초기 점수 | 최소 통과 | 판단 |
|---|---:|---:|---:|---|
| Core planning job | 25 | 22 | 15 | PASS |
| First-session activation | 15 | 6 | 9 | FAIL |
| Trust and data lifecycle | 15 | 13 | 9 | PASS |
| Decision output/shareability | 15 | 5 | 9 | FAIL |
| Mobile usability/accessibility | 10 | 8 | 6 | PASS |
| Differentiation | 10 | 7 | 6 | PASS |
| Monetization/distribution readiness | 10 | 4 | 6 | FAIL |
| **합계** | **100** | **65** | **80** | **RED** |

통과 조건:

- 총점 80 이상
- 모든 차원이 배점의 60% 이상
- critical blocker 0개
- 점수를 뒷받침하는 실제 브라우저·테스트 증거 존재

## 구현 loop

### Cycle 1 — 의사결정 리포트

한 번의 export로 다음을 전달하는 self-contained HTML을 만든다.

- 프로젝트명과 생성 시각
- 현재 2D 도면
- 전체 면적·가구 점유율·경고
- 가구별 크기와 배치 목록
- “기획·배치 확인용이며 전문가 판단을 대체하지 않는다”는 경계

성공하면 decision-output과 differentiation을 재평가한다. HTML은 서버나 계정 없이 열리고, 사용자 입력으로 executable markup이 생성되지 않아야 한다.

### Cycle 2 — first-session starter

Cycle 1 후 score가 통과하지 못하면 첫 방문에 다음 세 경로를 제공한다.

- 빈 도면으로 시작
- 가구가 포함된 검증 가능한 샘플 열기
- 기존 Room Studio 파일 가져오기

기존 로컬 데이터가 있으면 자동 표시하거나 덮어쓰지 않는다.

### 후속 선택 원칙

Cycle 2 후에도 통과하지 못하면 scorecard의 최저 차원만 대상으로 다음 increment를 정한다. 후보는 cloud conflict recovery, full account export, keyboard entity list, permissioned share link 순으로 검토한다.

## 수익화·시장 검증 가설

현재 score는 제품 준비도이며 product-market fit이나 매출 검증이 아니다. 실제 시장가치는 사용자 행동으로 별도 검증해야 한다.

### packaging 가설

- **Community**: 로컬 2D/3D 편집, portable file, 기본 report
- **Plus 가설**: 고급 report template, 비교안, 대형 프로젝트 library
- **Consultant 가설**: 브랜딩 report, 고객별 project 관리, permissioned link

결제 기능부터 구현하지 않는다. 먼저 report export가 실제 완료 행동인지 확인한다.

### 통과 후 측정할 지표

- 새 방문자의 10분 내 첫 valid layout 생성률
- valid layout 중 report export 비율
- report export 사용자의 7일 내 재방문률
- 샘플 시작 대비 빈 도면 시작의 완료율
- 상담자 인터뷰에서 branded report 또는 customer link의 지불 의향

이 지표가 없으면 “시장 준비도 통과”는 출시·검증 가능한 제품 상태를 뜻할 뿐, PMF 달성을 뜻하지 않는다.
