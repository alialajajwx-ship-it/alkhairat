// Shared pagination bar for the browse and owner listings.
//
// Built with DOM nodes (never innerHTML), it hides itself when everything
// fits on one page, and it only ever shows a window of pages around the
// current one plus the first/last — a 1525-product catalog must not turn into
// 64 buttons.

const PAGE_WINDOW = 2;

/**
 * Render (or clear) a pagination bar inside `containerId`.
 *
 * @param {string} containerId
 * @param {{ page: number, pages: number, onSelect?: (page: number) => void }} options
 */
export function renderPager(containerId, { page, pages, onSelect } = {}) {
  const container = document.getElementById(containerId);
  if (!container) return;

  container.innerHTML = '';

  // One page (or none) — nothing to navigate
  if (!Number.isFinite(pages) || pages <= 1 || !Number.isFinite(page)) {
    container.style.display = 'none';
    return;
  }

  container.style.display = '';

  const makeButton = (className, text, targetPage, disabled) => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = className;
    btn.dataset.page = String(targetPage);
    btn.textContent = text;
    if (disabled) btn.disabled = true;
    if (targetPage === page && typeof btn.setAttribute === 'function') {
      btn.setAttribute('aria-current', 'page');
    }
    return btn;
  };

  // First, last, and a window around the current page
  const wanted = new Set([1, pages]);
  for (let p = page - PAGE_WINDOW; p <= page + PAGE_WINDOW; p += 1) {
    if (p >= 1 && p <= pages) wanted.add(p);
  }
  const numbers = [...wanted].sort((a, b) => a - b);

  container.appendChild(makeButton('pager-step', '› السابق', page - 1, page <= 1));

  let previous = 0;
  numbers.forEach((p) => {
    if (previous && p - previous > 1) {
      const gap = document.createElement('span');
      gap.className = 'pager-gap';
      gap.textContent = '…';
      container.appendChild(gap);
    }
    container.appendChild(
      makeButton('pager-num' + (p === page ? ' active' : ''), String(p), p, false)
    );
    previous = p;
  });

  container.appendChild(makeButton('pager-step', 'التالي ‹', page + 1, page >= pages));

  if (typeof onSelect !== 'function') return;

  // Re-rendering the bar must never stack a second listener on the container
  if (container.__pagerHandler && typeof container.removeEventListener === 'function') {
    container.removeEventListener('click', container.__pagerHandler);
  }

  container.__pagerHandler = (event) => {
    const btn = event.target && event.target.closest
      ? event.target.closest('button[data-page]')
      : null;
    if (!btn || btn.disabled) return;

    const target = Number(btn.dataset.page);
    if (!Number.isFinite(target) || target === page) return;
    onSelect(target);
  };

  container.addEventListener('click', container.__pagerHandler);
}
