# Design

## Source of truth
- Status: Active
- Last refreshed: 2026-07-28
- Primary product surfaces: 배경 도면·치수 도구를 포함한 2D 공간·가구·벽·문 편집기, 상세 조정 패널, 3D 1인칭·돌하우스·상공 미리보기
- Evidence reviewed: `src/main.js`, `src/layout-tools.js`, `src/styles.css`, `src/walkthrough3d.js`, `scripts/mobile-browser-audit.mjs`, 390×844·1440×1000 렌더링, RoomSketcher·Planner 5D·Canva·Figma FigJam·SketchUp LayOut의 공식 조작 문서

## Brand
- Personality: 차분하고 정밀한 인테리어 작업 도구
- Trust signals: cm 단위 수치, 충돌·높이 경고, 자동 저장 상태
- Avoid: 장난감 같은 색상, 과도한 애니메이션, 편집 도면을 가리는 장식

## Product goals
- Goals: 공간과 가구를 빠르게 구성하고 실제 수용 가능성을 2D·3D로 판단
- Non-goals: 자유 곡선 CAD, 건축 인허가 도면 제작
- Success signals: 실제 도면을 두 점으로 축척 보정해 빠르게 옮겨 그리고, 영구 치수와 잠금으로 정밀도를 유지하며, 선택 배치를 3D 상공 시점에서 즉시 확인할 수 있음

## Personas and jobs
- Primary personas: 이사·인테리어를 준비하며 휴대폰과 데스크톱을 함께 사용하는 일반 사용자
- User jobs: 방 크기 구성, 가구 배치, 치수 조정, 충돌 확인, 3D 체감
- Key contexts of use: 현장에서 치수를 보며 한 손 또는 두 손으로 휴대폰 사용

## Information architecture
- Primary navigation: 모바일 하단의 도면·공간·가구·상세 탭, 데스크톱 3열 작업 공간
- Core routes/screens: 단일 2D 편집 화면, 전체 화면 3D 둘러보기
- Content hierarchy: 도면 > 즉시 편집 명령 > 선택 대상 상세 > 공간·가구 라이브러리 > 통계

## Design principles
- Canvas first: 모바일에서도 도면을 기본 화면으로 유지한다.
- Touch explicit: 키보드 보조 동작에는 터치 가능한 대체 버튼을 제공한다.
- Direct manipulation: 대상을 선택하면 별도의 이동 모드 없이 본체를 끌어 이동하고, 경계 핸들로 크기를 바꾸며, 가구는 선택 상단의 회전 핸들로 연속 회전한다.
- Visible feedback: 선택 테두리와 조작 종류가 구분되는 핸들을 사용하고, 이동·크기·회전 중에는 위치·치수·각도를 캔버스 위에 실시간으로 표시한다.
- Precision ladder: 캔버스 조작은 빠른 배치를, 스냅·키보드는 미세 조정을, 상세 입력은 정확한 수치 입력을 담당한다. 같은 값을 세 경로에서 일관되게 저장한다.
- Trace before redraw: 실제 평면도는 배경으로 가져와 알려진 두 점의 거리로 축척을 보정하며, 투명도와 잠금으로 편집 도형보다 뒤에 머물게 한다.
- Preview before walkthrough: 3D는 돌하우스·상공 시점으로 전체 배치를 먼저 확인하고, 필요할 때 1인칭 통행 검증으로 전환한다.
- Manual structure: 공간 연결부는 자동 문을 가정하지 않고 사용자가 벽과 문의 위치·폭·방향을 결정한다. 선택된 벽·문은 도면 위 양 끝점과 90도 회전 핸들로 직접 조정하며, 문을 다른 축의 벽 가까이 옮기면 해당 벽의 위치·방향·소유권으로 스냅한다.
- Door interaction: 여닫이문은 0~120° 각도, 미닫이문은 앞·뒤 두 패널의 0~100% 겹침으로 상태를 저장하며 선택 패널과 모바일 작업 메뉴에서 열고 닫는다. 3D 문짝과 통행 충돌도 같은 상태를 사용한다.
- Compound circulation: 여러 공간을 합치면 같은 `spaceId`로 정규화하고 공유 경계의 자동 내부벽을 제거해 문 없이 통행한다.
- Tradeoffs: 모바일에서는 동시에 모든 패널을 보여주기보다 하단 탭으로 한 패널씩 집중한다.

## Visual language
- Color: 기존 종이색 배경, 먹색 텍스트, 주황 강조색 유지
- Typography: 기존 Pretendard/시스템 글꼴과 Georgia 제목 유지
- Spacing/layout rhythm: 4·8·12·16px 기반, 모바일 터치 목표 최소 44px
- Shape/radius/elevation: 얕은 테두리와 낮은 모서리 반경, 패널에만 제한된 그림자
- Motion: 150~220ms의 짧은 패널·상태 전환
- Imagery/iconography: 텍스트와 단순 기호 중심

## Components
- Existing components to reuse: 캔버스 툴바, 공간 목록, 가구 라이브러리, 상세 입력, 3D HUD
- New/changed components: 배경 도면 가져오기·투명도·2점 축척 패널, 영구 치수선, 복제·복사/붙여넣기·잠금 명령, 벽·문·창 라이브러리, 모바일 하단 내비게이션과 작업 메뉴, 선택 경계·크기·회전 핸들·실시간 변형 HUD, 3D 시점·천장·선택 초점·PNG 도구, 모바일 3D 방향 패드
- Variants and states: 선택됨, 이동 중, 크기 조절 중, 회전 중, 정렬 스냅됨, 길게 누르기 이동, 그룹 이동 준비, 비활성, 경고, 열린 모바일 패널
- Token/component ownership: `src/styles.css`의 기존 CSS 변수와 클래스 사용

## Accessibility
- Target standard: WCAG 2.1 AA를 지향
- Keyboard/focus behavior: 방향키는 1cm, Shift+방향키는 40cm 이동하며 `Ctrl/Cmd+C·V·D`로 복사·붙여넣기·복제한다. 회전 핸들은 Enter·Space로 15°씩 회전하고 모든 모바일 기능은 버튼이나 상세 수치 입력으로도 접근한다.
- Contrast/readability: 기존 본문 대비 유지, 모바일 보조 글자 최소 10px 이상 우선
- Screen-reader semantics: 내비게이션·버튼에 명시적 레이블과 선택 상태 제공
- Reduced motion and sensory considerations: `prefers-reduced-motion` 존중

## Responsive behavior
- Supported breakpoints/devices: 320px 이상 모바일·태블릿 집중 레이아웃, 901~1180px 유연한 데스크톱/태블릿, 1181px 이상 데스크톱
- Layout adaptations: 900px 이하에서 도면 중심 화면과 고정 하단 탭, 공간·가구·상세는 스크롤 가능한 오버레이 패널
- Touch/hover differences: 첫 탭은 선택과 작업 메뉴, 선택된 대상은 바로 드래그 이동, 미선택 대상은 길게 누르기 이동, 빈 도면 탭은 선택 해제, 두 손가락은 5~600% 확대·축소로 동작한다. 회전·크기 핸들은 시각 크기와 별개의 최소 44px 터치 목표를 가지며 Shift 대신 그룹 선택 작업바를 제공한다.

## Interaction states
- Loading: 3D 준비 버튼 상태 유지
- Empty: 기존 빈 상세 안내 유지
- Error: 충돌·높이·경계 경고 유지
- Success: 자동 저장 상태와 정상 배치 상태 유지
- Disabled: 실행 취소·다시 실행 비활성 표시 유지
- Offline/slow network: 정적 앱과 로컬 저장소 기반으로 핵심 2D 편집 가능

## Content voice
- Tone: 짧고 직접적인 작업 안내
- Terminology: 공간, 공간 조각, 가구, 벽, 여닫이문, 미닫이문, 높이 H, 바닥 높이 Z
- Microcopy rules: 모바일 버튼은 명사 또는 한 동작으로 표기

## Implementation constraints
- Framework/styling system: Vite, 바닐라 JavaScript, 단일 CSS 파일
- Design-token constraints: 기존 `--ink`, `--muted`, `--line`, `--paper`, `--accent` 재사용
- Performance constraints: 새 UI 라이브러리와 의존성 추가 금지
- Compatibility constraints: 기존 저장 데이터와 데스크톱 편집 동작, Supabase·Tailscale·공개 localStorage 전용 데모 경계를 보존
- Test/screenshot expectations: 390×844, 768×1024, 1440×1000에서 44px 조작 영역, 배경 도면·치수·잠금·복제, 직접 변형, 3D 3개 시점·선택 초점·PNG 흐름을 포함한 113개 브라우저 검증을 확인

## Open questions
- [ ] 실제 사용자 테스트 후 모바일 도면 패닝 제스처의 필요성 재평가 / 제품 / 탐색 효율
