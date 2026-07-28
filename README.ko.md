# Room Studio

[English](README.md)
[![CI](https://github.com/achieve0410/room-studio/actions/workflows/ci.yml/badge.svg)](https://github.com/achieve0410/room-studio/actions/workflows/ci.yml)
[![License](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE)
[![공개 데모](https://img.shields.io/badge/demo-open-DA7956.svg)](https://achieve0410.github.io/room-studio/)

여러 직사각형 조각을 하나의 공간으로 합쳐 직교 다각형 평면을 만들고, 공간과 가구의 높이를 함께 확인하는 2D/3D 배치 시뮬레이터입니다.

## 공개 데모

[Room Studio 공개 데모](https://achieve0410.github.io/room-studio/)를 바로 사용할 수 있습니다. 공개 데모에는 Supabase 설정과 로그인 기능이 없으며, 도면은 해당 브라우저의 `localStorage`에만 남습니다. 사이트 데이터를 삭제하면 도면도 삭제되므로 실제 주소나 보안상 민감한 도면은 입력하지 마세요.

## 화면

| 2D 편집기 | 1인칭 3D 워크스루 |
| --- | --- |
| ![Room Studio 데스크톱 2D 편집기](docs/images/room-studio-2d.png) | ![Room Studio 1인칭 3D 워크스루](docs/images/room-studio-3d.png) |

모바일 편집 화면:

<img src="docs/images/room-studio-mobile.png" alt="다중 선택 조작이 표시된 Room Studio 모바일 편집기" width="320">

## 주요 기능

- 방, 거실, 주방, 다용도실 등 공간 추가·이동·크기 조정·삭제
- 한 공간에 여러 조각을 붙이거나 선택한 기존 공간을 합쳐 거실+복도 같은 ㄱ자형·직교 다각형 공간 구성, 합쳐진 공간 사이 경계벽 없이 이동
- 얇은 수동 벽 추가와 가로·세로 방향, 길이·높이·두께 조정 및 도면 위 끝점·90도 회전 핸들
- 연결부마다 문을 자동 생성하지 않고 사용자가 여닫이문·미닫이문을 직접 배치
- 문 너비·가로/세로 방향·여닫이 경첩/열림 방향·미닫이 이동 방향을 2D 기호·3D 문짝·통행 개구부에 반영
- 문을 인접한 가로·세로 벽으로 옮기면 위치·방향·연결 벽을 자동 전환하고, 도면 위 끝점·90도 회전 핸들로 직접 조정
- 여닫이문 0~120° 열림 각도와 미닫이문 0~100% 개방률 조작, 닫기·반 열기·완전히 열기 액션을 2D/3D와 통행 충돌에 반영
- 미닫이문은 앞·뒤 두 짝으로 설치되며 이동문이 지정 방향의 고정문 앞으로 겹쳐져 최대 절반 폭이 열리는 일반적인 2짝 바이패스 구조로 표현
- 공간별 천장 높이 설정 및 가구의 `바닥 높이 Z + 높이 H` 수용 여부 검사
- 직사각형, 원, 둥근 사각형, 타원 가구 제공
- 사용자 지정 가구 이름·도형·가로·세로·높이·색상
- 2D 드래그 배치, PPT 방식 8방향 크기 조절 핸들 및 10cm 격자 스냅
- `Ctrl/Cmd+Z`, `Ctrl/Cmd+Shift+Z` 실행 취소·다시 실행 및 화면 버튼
- Shift 클릭 또는 빈 캔버스 드래그 박스를 이용한 공간·가구·벽·문 다중 선택과 묶음 이동
- 이동 중 다른 공간·가구의 경계와 중심에 맞추는 정렬 가이드 및 정확한 스냅
- 마우스 휠 또는 5~600% 확대·축소 버튼과 포인터 위치 중심 줌, 전체 보기
- 모바일 첫 탭 선택과 작업 메뉴, 선택한 대상 즉시 드래그 이동, 미선택 대상 길게 눌러 이동, 빈 도면 탭 선택 해제
- 모바일 그룹 선택 작업바, 두 손가락 확대·축소, 터치 크기 조절, 44px 입력·조작 영역과 3D 방향 패드
- 자연스러운 바닥 재질, 천장 조명, 사용자가 배치한 문 개구부와 가구별 실제 형태를 반영한 1인칭 WebGL 워크스루
- 마우스 클릭·드래그 시선 이동, WASD·방향키 이동, 전체 화면 및 가구·벽 충돌 처리
- 실시간 미니맵과 공간 전환 안내로 현재 위치와 이동 방향 표시
- 바닥 면적과 높이 구간을 함께 비교하는 3차원 충돌 검사
- 공간 중복과 집 밖 가구 경고, 합집합 면적·점유율 계산
- 브라우저 로컬 자동 저장 및 모바일 반응형 UI
- Google·이메일 매직 링크 로그인과 사용자별 클라우드 도면 저장, 수동 버전 이력

## 실행

```bash
nvm use
npm ci
npm run dev
```

Node.js 22.12 이상 25 미만을 지원합니다.

## 로그인과 클라우드 도면 저장

Room Studio는 Supabase 설정이 없으면 기존처럼 브라우저 로컬 저장만 사용합니다. 로그인과 여러 기기 동기화를 활성화하려면 다음 순서로 설정합니다.

1. Supabase 프로젝트를 만들고 `supabase/migrations/20260721000000_auth_projects.sql`을 적용합니다.
2. Supabase Auth에서 이메일 로그인과 Google 공급자를 활성화합니다.
3. Auth URL 설정에 개발 URL과 공개 URL을 등록합니다.
   - 로컬: `http://localhost:5173`
   - Tailscale: 실제 배포에 사용할 `https://<MagicDNS-host>:<port>`
4. `.env.example`을 `.env`로 복사하고 프로젝트 값을 입력합니다.

```bash
cp .env.example .env
```

```dotenv
VITE_SUPABASE_URL=https://YOUR_PROJECT.supabase.co
VITE_SUPABASE_PUBLISHABLE_KEY=sb_publishable_YOUR_KEY
```

브라우저에는 Publishable Key만 사용합니다. `service_role` 키와 Google Client Secret은 `.env`나 프런트엔드 코드에 넣지 않습니다. Google Client Secret은 Supabase Dashboard의 Auth 공급자 설정에만 입력합니다.

저장 동작은 다음과 같습니다.

- 비로그인: 기존 `localStorage` 자동 저장
- 최초 로그인: 현재 로컬 도면을 사용자 계정으로 가져오기
- 로그인 후 편집: 1.2초 디바운스 클라우드 자동 저장
- 다른 탭·기기에서 먼저 저장한 경우: 이전 revision 덮어쓰기를 막고 다시 열어 확인하도록 안내
- `지금 저장`: 현재 도면을 저장하고 버전 이력 추가
- `현재 도면 복사 저장`: 같은 배치를 별도 도면으로 저장
- 다른 저장 도면 선택: 해당 도면을 로컬 캐시로 불러와 편집

## 검증 및 빌드

```bash
npm run check
```

## Tailscale 비공개 운영

스크립트는 현재 기기의 MagicDNS 호스트를 자동 감지하고 기본적으로 `8443 → 127.0.0.1:4173` 프록시를 구성합니다. 기존 기본 설정은 그대로 유지되며 다른 사용자는 환경변수로 호스트와 포트를 바꿀 수 있습니다.

```bash
npm run build
./scripts/tailscale-private-serve.sh start
./scripts/tailscale-private-serve.sh status
./scripts/tailscale-private-serve.sh stop
```

자세한 설정, 사용자별 재정의 방법과 안전한 중지 절차는 [`docs/TAILSCALE.md`](docs/TAILSCALE.md)를 참고하세요.

## 기여와 라이선스

- 기여 절차: [`CONTRIBUTING.md`](CONTRIBUTING.md)
- 보안 신고: [`SECURITY.md`](SECURITY.md)
- 로드맵: [`ROADMAP.md`](ROADMAP.md)
- 라이선스: [Apache License 2.0](LICENSE)

Apache-2.0은 상업적 이용도 허용하지만, 현재 메인테이너는 Room Studio를 유료 상품으로 운영하지 않습니다.
