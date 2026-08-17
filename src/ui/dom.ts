// Minimal DOM builders for the report screen. Deliberately tiny and dependency-free: the report is
// built once, from a finished log, so there is no need for a framework or a diffing layer.
//
// `el` and `svgEl` take (tag, attrs, children) and return the element, which lets a whole subtree be
// written as one nested expression instead of a run of intermediate `const` bindings. `text` and
// `class` are spelled out as attribute keys because they are by far the most common.

const SVGNS = 'http://www.w3.org/2000/svg';

export function el(tag: string, attrs?: Record<string, string>, children?: Array<Node | string>): HTMLElement {
  const node = document.createElement(tag);
  if (attrs) {
    for (const [k, v] of Object.entries(attrs)) {
      if (k === 'class') node.className = v;
      else if (k === 'text') node.textContent = v;
      else node.setAttribute(k, v);
    }
  }
  if (children) for (const c of children) node.append(c);
  return node;
}

export function svgEl(tag: string, attrs?: Record<string, string>, children?: Array<Node>): SVGElement {
  const node = document.createElementNS(SVGNS, tag);
  if (attrs) for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
  if (children) for (const c of children) node.append(c);
  return node;
}

/** A titled report section. */
export function section(title: string, ...children: Node[]): HTMLElement {
  return el('section', { class: 'r-sec' }, [el('h2', { class: 'r-sec-title', text: title }), ...children]);
}

export function prefersReducedMotion(): boolean {
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

/** Drive `onFrame(progress 0→1)` for `durationMs`, then call it once more with exactly 1.
 *  A no-op under prefers-reduced-motion, where the caller's final state must already be correct. */
export function animateOver(durationMs: number, onFrame: (progress: number) => void): void {
  const startedAt = performance.now();
  const frame = (now: number): void => {
    const progress = Math.min(1, (now - startedAt) / durationMs);
    onFrame(progress);
    if (progress < 1) requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);
}
