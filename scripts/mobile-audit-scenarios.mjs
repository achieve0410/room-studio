// Each legacy assertion site belongs to a required, real-surface scenario.
// Line numbers refer to the pre-space/detail-contract mobile-browser-audit.mjs.
export const migrationScenarios = [
  ['viewport', 'A viewport matrix, mobile controls and account accessibility', [482, 550], '2D shell and account modal'],
  ['tabs', 'A tab semantics, inert panels and focus', [551, 606], '2D space-only tabs'],
  ['catalog', 'A eight furniture types, structures and mobile door opening', [607, 679], '3D catalog and inspector; absent 2D detail controls'],
  ['hostile', 'A hostile colors, IDs, numeric and structure normalization', [680, 724], '2D read-only rendering and 3D normalized inspector'],
  ['pan-pinch', 'B native blank pan, pinch release and 5–600% limits', [725, 805], '2D canvas'],
  ['space-touch', 'B first tap, menu Escape, direct drag and blank deselection', [806, 889], '2D space menu; furniture rotation in 3D'],
  ['detail-touch', 'B long-press removal, drag rollback, resize and rotation', [890, 1040], '3D immediate native drag/cancel and numeric resize/rotation; 2D space resize'],
  ['space-group', 'B group actions, equal-delta movement, marquee and hit targets', [1041, 1271], '2D spaces; no furniture grouping or rotation handles'],
  ['breakpoint', 'A same-document breakpoint transition', [1272, 1332], '2D tabs at 768/1024/768'],
  ['walk-mobile', 'C portrait/landscape controls, movement, cancellation, look and reopen', [1374, 1491], '3D native touch navigation'],
  ['space-desktop', 'D mouse wheel, single/group drag, merge, blank selection and resize history', [1492, 1651], '2D spaces; furniture movement also in 3D'],
  ['detail-desktop', 'D exact rotation and accessible maximum, manual wall/door creation and properties', [1652, 1794], '3D catalog/inspector; read-only 2D symbols'],
  ['structure-edit', 'D opening selection, wall length/rotation/movement, door width and relocation', [1795, 1929], '3D selection/numeric/touch alternatives; no detached free-placement command'],
  ['walk-desktop', 'D desktop controls, crosshair door click, WASD, look and close', [1930, 2003], '3D first-person navigation'],
  ['window-custom', 'D wall cascade deletion/undo, low-wall window, custom and eight template types', [2004, 2220], '3D CRUD, properties, window click/repeat-key and custom labels'],
  ['boundary', 'D coincident automatic wall gaps and open-door retargeting', [2221, 2306], '2D observation and 3D real canvas interaction'],
  ['precision', 'E background import/calibration, dimension and protected copy/lock/nudge', [2307, 2450], '2D background, dimensions and spaces; 3D furniture lock/duplicate'],
  ['preview', 'E dollhouse/top/focus, hidden ceilings and PNG', [2451, 2492], '3D preview and actual PNG download'],
  ['portable-modal', 'Additional portable import/report/account focus and keyboard isolation', [], '2D project modal and 3D modal boundary'],
];

// The previous required CI gate advertised 114 assertions. Coverage is not
// traded for a smaller count when an interaction moves to another surface.
export const minimumAssertions = 114;
