# Design

## Source of truth
- Status: Active
- Last refreshed: 2026-09-12
- Primary product surfaces: 배경 도면·치수 도구를 포함한 2D 공간·가구·벽·문 편집기, 상세 조정 패널, 3D 1인칭·돌하우스·상공 미리보기
- Evidence reviewed: `src/main.js`, `src/layout-tools.js`, `src/styles.css`, `src/walkthrough3d.js`, `scripts/mobile-browser-audit.mjs`, 390×844·1440×1000 렌더링, RoomSketcher·Planner 5D·Canva·Figma FigJam·SketchUp LayOut의 공식 조작 문서

## Brand
- Personality: 차분하고 정밀한 인테리어 작업 도구
- Trust signals: cm 단위 수치, 충돌·높이 경고, 자동 저장 상태
- Avoid: 장난감 같은 색상, 과도한 애니메이션, 편집 도면을 가리는 장식

## Product goals
- Goals: 상담자가 고객의 실제 공간에 두 배치안을 만들고, 차이와 추천 이유를 설명한 제안서를 전달하며, 다음 상담에서 작업을 이어간다.
- Non-goals: 자유 곡선 CAD, 건축 인허가 도면 제작
- Success signals: 실제 도면을 두 점으로 축척 보정해 빠르게 옮겨 그리고, 영구 치수와 잠금으로 정밀도를 유지하며, 선택 배치를 3D 상공 시점에서 즉시 확인할 수 있음

## Personas and jobs
- Primary personas: 소규모 홈스타일링·인테리어 업체의 상담자. 직접 가구를 배치하는 일반 사용자도 같은 편집 기능을 사용한다.
- User jobs: 고객 요구 기록, 실측 공간 구성, 배치안 A/B 비교, 치수와 경고 확인, 추천 이유가 담긴 제안서 전달
- Key contexts of use: 데스크톱 상담 자리에서는 도면과 상세 정보를 함께 보고, 현장 모바일에서는 도면과 현재 조작에 집중한다. 두 환경에서 같은 데이터와 기능을 제공한다.

## Information architecture
- Primary navigation: 기본은 간편 배치. 데스크톱은 가구·공간을 전환하는 단일 보조 패널과 넓은 도면, 모바일은 도면·공간·가구·상세 탭을 사용한다. 정밀 도구를 켜면 기존 3열 편집기로 전환한다.
- Core routes/screens: 단일 2D 편집 화면, 전체 화면 3D 둘러보기
- Content hierarchy: 내 공간 만들기 > 가구 놓기 > 3D 확인. 현재 선택의 조작만 도면 아래에 표시한다. 상담·배치안 비교·제안서는 접힌 보조 영역에서, 좌표·벽·치수·통계는 정밀 도구에서 연다.

## Design principles
- Canvas first: 모바일에서도 도면을 기본 화면으로 유지한다.
- Simple by default: 첫 사용은 가로·세로 두 치수로 빈 방을 바로 만든다. 실제 아파트 샘플, 완전한 빈 도면, 파일 가져오기도 시작 화면에서 선택할 수 있다. 저장된 작업은 그대로 복구하며 화면 모드는 도면 데이터에 저장하지 않는다.
- Progressive tools: 기본 화면은 가구 놓기·공간 편집·3D 확인을 우선한다. 접힌 기능은 이름이 있는 버튼이나 disclosure로 접근하며, 기능을 사용한 뒤에도 해당 패널과 입력 상태를 유지한다. 정밀 도구는 같은 도면을 편집하며 전환으로 도면·실행 취소를 초기화하지 않는다.
- Nonblocking selection: 간편 모드의 터치 선택은 모달을 열지 않는다. 도면 아래 선택 막대에서 회전·복제·크기·상세·삭제를 실행한다. 가구 본체는 첫 터치부터 끌 수 있고, 이동 전 탭은 선택만 한다. 두 손가락 확대 전환과 취소 시 미완료 이동은 되돌린다.
- Small-object manipulation: 간편 모드의 기본 선택은 테두리만 표시한다. 크기 버튼을 열었을 때만 크기·회전 손잡이를 표시해 작은 가구의 이동 영역을 덮지 않는다. 정밀 모드는 기존 상시 손잡이를 유지한다.
- Touch explicit: 키보드 보조 동작에는 터치 가능한 대체 버튼을 제공한다.
- Direct manipulation: 대상을 선택하면 별도의 이동 모드 없이 본체를 끌어 이동하고, 경계 핸들로 크기를 바꾸며, 가구는 선택 상단의 회전 핸들로 연속 회전한다.
- Visible feedback: 선택 테두리와 조작 종류가 구분되는 핸들을 사용하고, 이동·크기·회전 중에는 위치·치수·각도를 캔버스 위에 실시간으로 표시한다.
- Precision ladder: 캔버스 조작은 빠른 배치를, 스냅·키보드는 미세 조정을, 상세 입력은 정확한 수치 입력을 담당한다. 같은 값을 세 경로에서 일관되게 저장한다.
- Trace before redraw: 실제 평면도는 배경으로 가져와 알려진 두 점의 거리로 축척을 보정하며, 투명도와 잠금으로 편집 도형보다 뒤에 머물게 한다.
- Preview before walkthrough: 3D는 돌하우스·상공 시점으로 전체 배치를 먼저 확인하고, 필요할 때 1인칭 통행 검증으로 전환한다.
- Compact 3D controls: 3D 기본 제어는 전체 보기·위에서·걸어보기·닫기와 도구 더보기만 표시한다. 천장·발표용 벽·선택 초점·PNG는 더보기에서 열며, 모바일의 닫힌 제어판이 장면 위 230px을 차지하지 않도록 134px 이내로 줄인다. 메뉴는 Escape로 닫고 초점을 복귀하며 화면·내보내기 카메라 구도와 실제 통행 계약은 유지한다.
- 3D input boundary: 3D는 이름 있는 모달이며 배경 편집기를 inert로 만든다. 방향키·단축키는 2D 도면을 바꾸지 않는다. 진입 시 보이는 3D 조작으로 초점을 옮기고 Tab을 안에서 순환하며, 닫기와 정리 후 현재 2D 미리보기 버튼으로 복귀한다.
- Overview framing: 3D 전체보기는 실제 공간·가구·열린 문·프레임의 범위를 화면 비율과 시야각으로 맞추며 가장자리 여백을 둔다. 바닥 배경이나 숨긴 천장은 구도 계산에서 제외한다. PNG도 같은 카메라 구도를 사용한다.
- Manual structure: 공간 연결부는 자동 문을 가정하지 않고 사용자가 벽과 문의 위치·폭·방향을 결정한다. 선택된 벽·문은 도면 위 양 끝점과 90도 회전 핸들로 직접 조정하며, 문을 다른 축의 벽 가까이 옮기면 해당 벽의 위치·방향·소유권으로 스냅한다.
- Door interaction: 여닫이문은 0~120° 각도, 미닫이문은 앞·뒤 두 패널의 0~100% 겹침으로 상태를 저장하며 선택 패널과 모바일 작업 메뉴에서 열고 닫는다. 3D 문짝과 통행 충돌도 같은 상태를 사용한다.
- Compound circulation: 여러 공간을 합치면 같은 `spaceId`로 정규화하고 공유 경계의 자동 내부벽을 제거해 문 없이 통행한다.
- Regional samples: 대치동·압구정동·도곡동의 공개 단위세대 평면을 참고한 재구성 샘플을 우선 제공한다. 침실·욕실의 문은 원본의 복도 연결을 따르고, 열린 거실·주방·현관은 같은 `spaceId`로 연결한다. 현관에서 시작해 모든 모델링 공간을 통행할 수 있어야 하며 문짝과 가구가 통로를 막지 않아야 한다.
- Gallery previews: `--demo-preview-height: 200px` 안에 문짝의 범위까지 맞춰 표시한다. 미닫이문과 여닫이문은 서로 다른 기호로 구분하고, 출처와 추정 범위는 각 카드에 표시한다.
- Source fidelity: 단지·평형의 출처 링크와 확인된 표기 면적을 표시하되 편집기 구역 면적과 구분한다. 도면에 없는 치수·가구 배치는 추정임을 밝힌다. 원본 이미지, 거주자·호수 정보, 임시 다운로드 URL의 인증 쿼리는 포함하지 않는다. 기존 LH 자료의 이용 조건을 다른 출처에 적용하지 않는다.
- Tradeoffs: 모바일에서는 동시에 모든 패널을 보여주기보다 하단 탭으로 한 패널씩 집중한다.
- Consultation continuity: 고객명·업체명·요구사항은 프로젝트 공통이며, 배치안 이름·추천 이유·수정 사항은 A/B 각각에 속한다. 배치안 전환은 상대 안을 덮어쓰지 않으며 실행 취소가 다른 안을 바꾸지 않는다.
- Honest checks: 경고는 해당 가구·공간 이름과 함께 표시한다. 바닥 점유는 실제 통행 폭이나 설치 가능성을 보증하는 수치로 사용하지 않는다.
- Recovery before replacement: 저장 실패는 계속 보이는 상태와 파일 내보내기·다시 저장 경로로 알린다. 충돌 해결은 현재 작업의 복사본 보존과 원격 도면 다시 열기를 명시적으로 구분한다.

## Visual language
- Color: 기존 종이색 배경과 먹색 텍스트를 유지한다. 글자 대비를 위해 주황 강조색은 `--accent: #ad4b32`, 보조 글자는 `--muted: #6b6c63`을 사용한다.
- Typography: 기존 Pretendard/시스템 글꼴과 Georgia 제목 유지
- Consultation type scale: `--text-body: 14px`, `--text-control: 13px`, `--text-caption: 12px`, `--text-title: 24px`. 모바일 텍스트 입력은 16px로 표시해 브라우저의 입력 확대를 피한다. 치수·좌표는 tabular figures를 사용한다.
- Consultation tokens: `--muted-readable: #62635b`, `--error: #a34836`; 배경 덮개는 `rgba(29,30,27,.48)`. 간격은 4·8·12·16·24px, 조작 목표는 44px, 입력 모서리는 4px, 패널 모서리는 8px이다. 상담 폼 최대 폭은 720px, 비교 창은 1200px, 비교 도면 높이는 320px이다.
- Spacing/layout rhythm: 4·8·12·16px 기반, 모바일 터치 목표 최소 44px
- Shape/radius/elevation: 얕은 테두리와 낮은 모서리 반경, 패널에만 제한된 그림자
- Motion: 150~220ms의 짧은 패널·상태 전환
- Imagery/iconography: 텍스트와 단순 기호 중심

## Components
- Existing components to reuse: 캔버스 툴바, 공간 목록, 가구 라이브러리, 상세 입력, 3D HUD
- New/changed components: 배경 도면 가져오기·투명도·2점 축척 패널, 영구 치수선, 복제·복사/붙여넣기·잠금 명령, 벽·문·창 라이브러리, 모바일 하단 내비게이션과 작업 메뉴, 선택 경계·크기·회전 핸들·실시간 변형 HUD, 3D 시점·천장·선택 초점·PNG 도구, 모바일 3D 방향 패드
- Variants and states: 선택됨, 이동 중, 크기 조절 중, 회전 중, 정렬 스냅됨, 길게 누르기 이동, 그룹 이동 준비, 비활성, 경고, 열린 모바일 패널
- Token/component ownership: `src/styles.css`의 기존 CSS 변수와 클래스 사용
- Consultation primitives: 프로젝트 제목과 상담 정보 버튼, A/B 선택 버튼 묶음, 비교 보기, 업체·고객·요구사항 폼, 배치안별 추천·수정 메모, 저장 복구 안내. 버튼은 기본·선택·키보드 초점·비활성 상태를 구분하고 폼은 취소 시 원본을 유지한다.
- Simple workspace primitives: 방 크기 시작 폼, 보조 패널 탭, 가구 검색, 가구 카드, 선택 조작 막대, 크기 입력 disclosure, 상담·정밀 기능 disclosure. 기존 버튼·입력·초점·비활성 토큰을 재사용한다. 가구 검색은 이름으로 즉시 필터링하고 결과 없음과 검색 지우기를 제공한다.
- Simple workspace tokens: `--workspace-rail: 264px`, `--workspace-header: 64px`, `--workspace-mobile-nav: 64px`, `--text-section: 18px`, `--workspace-canvas-min: 200px`. 간격은 기존 4·8·12·16·24px, 색상은 paper·ink·accent·line, 터치 목표는 44px을 유지한다.
- Simple containment: 간편 데스크톱의 도면은 남은 화면 높이를 차지하고 보조 패널만 독립 스크롤한다. 모바일은 도면 위 제어를 한 줄로 줄이고 선택 막대가 도면을 가리지 않도록 흐름에 둔다. 짧은 화면에서는 중앙 작업 영역이 스크롤하며 모달만 화면 전체를 막는다.
- Workspace containment: 데스크톱은 도면을 중심으로 라이브러리와 상세 패널을 배치하며 각 보조 패널이 자신의 스크롤을 소유한다. 모바일은 도면 문서와 열린 패널을 구분하고, 모달이 열리면 배경을 inert로 만든다. 비교 보기는 넓은 화면에서 두 열, 좁은 화면에서 한 열이다.
- Reference patterns: [supporting-pane](https://github.com/changeroa/StyleGallery/blob/main/patterns/split-sidebar/supporting-pane.md)의 주 작업·보조 패널 분리와 기존 모달의 초점 복귀 규칙을 사용한다. 새로운 장식적 애니메이션이나 UI 의존성을 추가하지 않는다.
- Interaction reference: [beui drawer](https://beui.dev/r/drawer/raw)의 배경·패널 분리와 Escape·스크롤 경계를 참고하되 기존 바닐라 모달의 키보드 초점 순환을 유지한다. 폼 닫기와 배경 클릭은 저장하지 않는 취소 동작이다.

## Accessibility
- Target standard: WCAG 2.1 AA를 지향
- Keyboard/focus behavior: 방향키는 1cm, Shift+방향키는 40cm 이동하며 `Ctrl/Cmd+C·V·D`로 복사·붙여넣기·복제한다. 회전 핸들은 Enter·Space로 15°씩 회전하고 모든 모바일 기능은 버튼이나 상세 수치 입력으로도 접근한다.
- Contrast/readability: 상담 정보와 조작 레이블은 위의 글자 크기 기준을 따르며, 보조 글자도 읽을 수 있는 대비를 유지한다. 색상만으로 배치안·경고·저장 상태를 구분하지 않는다.
- Screen-reader semantics: 내비게이션·버튼에 명시적 레이블과 선택 상태 제공
- Reduced motion and sensory considerations: `prefers-reduced-motion` 존중

## Responsive behavior
- Supported breakpoints/devices: 320px 이상 모바일·태블릿 집중 레이아웃, 901~1180px 유연한 데스크톱/태블릿, 1181px 이상 데스크톱
- Layout adaptations: 900px 이하에서 도면 중심 화면과 고정 하단 탭, 공간·가구·상세는 스크롤 가능한 오버레이 패널
- Touch/hover differences: 첫 탭은 선택과 작업 메뉴, 선택된 대상은 바로 드래그 이동, 미선택 대상은 길게 누르기 이동, 빈 도면 탭은 선택 해제, 두 손가락은 5~600% 확대·축소로 동작한다. 회전·크기 핸들은 시각 크기와 별개의 최소 44px 터치 목표를 가지며 Shift 대신 그룹 선택 작업바를 제공한다.
- Mobile editing: 선택 작업 메뉴가 열린 동안 별도 수치 입력판을 겹쳐 놓지 않는다. 메뉴를 닫거나 상세 입력으로 이동한 뒤 수치를 조정한다. 짧은 가로 화면에서도 도면·닫기·복귀 동작을 유지하고 열린 폼만 스크롤한다.
- Small display containment: 도면의 내부 표시 높이는 최소 150px이며 테두리를 포함한 `--canvas-min`은 152px이다. 긴 프로젝트 제목은 한 줄로 줄임 표시하고 전체 이름은 상담 정보에서 확인한다. 복구본 안내는 도면 뒤에 배치하며, 저장 실패는 도면 위에서 즉시 알린다.
- Desktop canvas: 노트북에서도 도면 내부 높이 480px을 유지하도록 `--canvas-desktop-min: 482px`을 사용한다. 보조 통계·복구 안내는 중앙 패널에서 스크롤하며, 배치 안내판은 취소 버튼을 제외한 영역에서 도면 클릭을 가로채지 않는다.
- Display matrix: 320×568, 375×812, 390×844, 768×1024, 844×390, 1280×800, 1440×1000, 1920×1080. 가로 넘침, 가려진 버튼, 긴 한국어 고객명, 화면 키보드로 줄어든 높이를 확인한다.

## Client recommendation document
- Format: 외부 리소스와 스크립트가 없는 한국어 HTML. 화면에서는 반응형 문서이며 A4 인쇄를 지원한다.
- Reading order: 업체·고객·프로젝트·배치안 > 추천 이유 > 도면과 치수·문 표현 > 대상별 확인 사항 > 가구 목록 > 수정 사항과 사용 범위. 빈 메모를 임의의 추천 문장으로 채우지 않는다.
- Fidelity: 편집기와 같은 공간·가구·문·창·치수 데이터를 사용한다. 저장된 배경 도면은 허용된 이미지 data URL만 사용하고, 화면 선택 표시나 조작 핸들은 포함하지 않는다.
- Comparison: 두 안을 만든 경우 각각의 이름·추천 이유·도면·확인 사항을 구분해 전달한다. 현재 안과 비교안의 데이터가 섞이지 않는다.
- Continuation labels: 긴 문서에서 도면이 다음 페이지로 넘어가도 A/B와 배치안 이름을 도면 제목에 다시 표시한다.
- Print: A4, 12mm 여백, 도면과 짧은 경고를 한 덩어리로 유지하되 긴 메모와 가구 목록은 페이지 사이에서 자연스럽게 흐르게 한다. 인쇄된 모든 페이지를 실제로 확인한다.

## Interaction states
- Loading: 3D 준비 버튼 상태 유지
- Empty: 기존 빈 상세 안내 유지
- Simple empty: 공간이 없으면 방 만들기, 공간은 있으나 가구가 없으면 가구 선택을 다음 동작으로 안내한다. 안내는 한 문장과 한 동작으로 제한한다.
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
- Test/screenshot expectations: 390×844, 768×1024, 1440×1000에서 44px 조작 영역, 배경 도면·치수·잠금·복제, 직접 변형, 3D 3개 시점·선택 초점·PNG 흐름을 포함한 114개 브라우저 검증과 실제 평면 문의 가시성·반응형·전 공간 통행 검증을 확인

## Open questions
- [ ] 실제 사용자 테스트 후 모바일 도면 패닝 제스처의 필요성 재평가 / 제품 / 탐색 효율
- [ ] 개선된 핵심 흐름의 실제 고객 완료율과 학습 부담은 고객 파일럿으로 확인한다. 자동화된 브라우저 통과를 고객 적합성 검증으로 해석하지 않는다.
