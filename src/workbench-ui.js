const escapeHtml = (value) => String(value ?? '').replaceAll('&', '&amp;')
  .replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&#039;');

/** The same project and editing boundary remain visible in both workspaces. */
export function renderWorkbenchNavigation(projectName, mode) {
  return `<div class="workbench-project">
    <span class="brand-mark" aria-hidden="true"><i></i><i></i><i></i></span>
    <div><span class="workbench-product">Room Studio</span><h1 title="${escapeHtml(projectName)}">${escapeHtml(projectName)}</h1></div>
  </div>
  <nav class="workbench-modes" aria-label="공간과 가구 편집 전환">
    <button type="button" aria-pressed="${mode === 'space'}" ${mode === 'studio' ? 'class="walkthrough-exit" data-walkthrough-exit aria-label="2D 공간 편집으로 돌아가기"' : ''}><span>2D</span> 공간</button>
    <button type="button" aria-pressed="${mode === 'studio'}" ${mode === 'space' ? 'id="open-walkthrough"' : ''}><span>3D</span> 꾸미기</button>
  </nav>`;
}
