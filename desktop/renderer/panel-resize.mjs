const STORAGE_KEY = 'livetalking-studio-panel-widths';
const HANDLE_WIDTH = 8;
const STAGE_MIN_WIDTH = 320;
const PANEL_MIN_WIDTH = { left: 200, right: 240 };

const clamp = (value, min, max) => Math.min(Math.max(value, min), max);

export function mountPanelResizers({ workspace, leftPanel, rightPanel, leftHandle, rightHandle }) {
  const panels = { left: leftPanel, right: rightPanel };
  const handles = { left: leftHandle, right: rightHandle };
  const preferred = { left: null, right: null };

  try {
    const saved = JSON.parse(window.localStorage.getItem(STORAGE_KEY) || '{}');
    for (const side of ['left', 'right']) {
      if (Number.isFinite(saved[side]) && saved[side] > 0) preferred[side] = saved[side];
    }
  } catch { /* A blocked or invalid local store leaves the default widths in place. */ }

  const panelWidth = side => panels[side].getBoundingClientRect().width;
  const defaultWidth = side => window.matchMedia('(max-width: 1120px)').matches
    ? (side === 'left' ? 210 : 300) : (side === 'left' ? 260 : 320);

  function render() {
    const available = workspace.clientWidth - HANDLE_WIDTH * 2 - STAGE_MIN_WIDTH;
    const left = clamp(preferred.left ?? defaultWidth('left'), PANEL_MIN_WIDTH.left, available - PANEL_MIN_WIDTH.right);
    const right = clamp(preferred.right ?? defaultWidth('right'), PANEL_MIN_WIDTH.right, available - left);
    workspace.style.setProperty('--left-panel-width', `${left}px`);
    workspace.style.setProperty('--right-panel-width', `${right}px`);
    for (const [side, value] of [['left', left], ['right', right]]) {
      handles[side].setAttribute('aria-valuemin', String(PANEL_MIN_WIDTH[side]));
      handles[side].setAttribute('aria-valuemax', String(Math.round(side === 'left'
        ? available - PANEL_MIN_WIDTH.right : available - left)));
      handles[side].setAttribute('aria-valuenow', String(Math.round(value)));
      handles[side].setAttribute('aria-valuetext', `${Math.round(value)} pixels`);
    }
  }

  function save() {
    try { window.localStorage.setItem(STORAGE_KEY, JSON.stringify(preferred)); } catch { /* Resizing still works if storage is unavailable. */ }
  }

  for (const side of ['left', 'right']) {
    const handle = handles[side];
    let drag = null;
    handle.addEventListener('pointerdown', event => {
      if (event.button !== 0) return;
      drag = { pointerId: event.pointerId, startX: event.clientX, startWidth: panelWidth(side) };
      handle.setPointerCapture(event.pointerId);
      handle.classList.add('is-dragging');
      document.body.classList.add('is-resizing-panels');
      event.preventDefault();
    });
    handle.addEventListener('pointermove', event => {
      if (!drag || event.pointerId !== drag.pointerId) return;
      preferred[side] = drag.startWidth + (event.clientX - drag.startX) * (side === 'left' ? 1 : -1);
      render();
    });
    const finishDrag = event => {
      if (!drag || event.pointerId !== drag.pointerId) return;
      preferred[side] = Math.round(panelWidth(side));
      drag = null;
      handle.classList.remove('is-dragging');
      document.body.classList.remove('is-resizing-panels');
      save();
    };
    handle.addEventListener('pointerup', finishDrag);
    handle.addEventListener('pointercancel', finishDrag);
    handle.addEventListener('lostpointercapture', finishDrag);
    handle.addEventListener('keydown', event => {
      if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
      const direction = event.key === 'ArrowRight' ? 1 : -1;
      preferred[side] = panelWidth(side) + direction * (side === 'left' ? 1 : -1) * (event.shiftKey ? 50 : 10);
      render();
      preferred[side] = Math.round(panelWidth(side));
      save();
      event.preventDefault();
    });
  }

  window.addEventListener('resize', render);
  render();
}
