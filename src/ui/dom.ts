// The app's DOM builders. Deliberately tiny and dependency-free: every screen is built once, from
// finished state, so there is nothing for a framework or a diffing layer to do.
//
// `el` and `svgEl` take (tag, props, children) and return the element, which lets a whole subtree be
// written as one nested expression instead of a run of intermediate `const` bindings.

const SVGNS = 'http://www.w3.org/2000/svg';

/** Props accepted by `el`. Three keys are special-cased because they are what a builder is
 *  overwhelmingly used for: `class` and `text` set the property rather than an attribute, and any
 *  `onX` function is attached as a listener. Everything else becomes an attribute; a `true` boolean
 *  becomes a bare attribute and a `false` one is omitted, matching how HTML spells them. */
type Props = Record<string, string | number | boolean | EventListener>;

/** Build an element and its subtree in one expression. Generic over the tag so the return type is
 *  the real element interface — `el('input', …)` is an HTMLInputElement, not an HTMLElement, which
 *  is what lets a caller read `.value` without a cast. */
export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props?: Props,
  children?: Array<Node | string>,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (props) {
    for (const [key, val] of Object.entries(props)) {
      if (key.startsWith('on') && typeof val === 'function') {
        node.addEventListener(key.slice(2).toLowerCase(), val);
      } else if (key === 'class') {
        node.className = String(val);
      } else if (key === 'text') {
        node.textContent = String(val);
      } else if (typeof val === 'boolean') {
        if (val) node.setAttribute(key, '');
      } else {
        node.setAttribute(key, String(val));
      }
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
