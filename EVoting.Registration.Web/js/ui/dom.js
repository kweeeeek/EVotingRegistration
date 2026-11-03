// A tiny element builder. The whole screen is made out of DOM nodes and text nodes: no HTML strings anywhere, so nothing a
// server sends (a member name, an error message) can ever be read as markup. Do not add innerHTML/insertAdjacentHTML/
// outerHTML/document.write here or anywhere else (tests/unit/security.test.mjs fails the build if they appear).

const SVG_NS = 'http://www.w3.org/2000/svg';
const FORBIDDEN_ATTRIBUTES = new Set(['style', 'srcdoc', 'innerhtml', 'outerhtml']);

function applyProps(el, props) {
  if (!props) return;
  for (const [name, value] of Object.entries(props)) {
    if (value === undefined || value === null || value === false) continue;

    if (name === 'class') {
      el.setAttribute('class', Array.isArray(value) ? value.filter(Boolean).join(' ') : String(value));
    } else if (name === 'dataset') {
      for (const [k, v] of Object.entries(value)) if (v !== undefined && v !== null) el.dataset[k] = String(v);
    } else if (name === 'ref') {
      value(el);
    } else if (name.startsWith('on')) {
      if (typeof value !== 'function') throw new Error(`Event handler ${name} must be a function.`);
      el.addEventListener(name.slice(2).toLowerCase(), value);
    } else if (name === 'text') {
      el.textContent = String(value);
    } else {
      if (FORBIDDEN_ATTRIBUTES.has(name.toLowerCase())) throw new Error(`The attribute "${name}" is not allowed.`);
      el.setAttribute(name, value === true ? '' : String(value));
    }
  }
}

function appendChildren(el, children) {
  for (const child of children) {
    if (child === undefined || child === null || child === false) continue;
    if (Array.isArray(child)) appendChildren(el, child);
    else if (typeof child === 'string' || typeof child === 'number') el.appendChild(el.ownerDocument.createTextNode(String(child)));
    else el.appendChild(child);
  }
}

/** h('div', { class: 'x', onclick: fn }, 'text', otherElement, ...) */
export function h(tag, props, ...children) {
  const el = document.createElement(tag);
  applyProps(el, props);
  appendChildren(el, children);
  return el;
}

/** The same for SVG elements. */
export function svg(tag, props, ...children) {
  const el = document.createElementNS(SVG_NS, tag);
  applyProps(el, props);
  appendChildren(el, children);
  return el;
}

/** Replaces all children of `parent` with `children`. */
export function setChildren(parent, ...children) {
  parent.replaceChildren();
  appendChildren(parent, children);
  return parent;
}

/** `text` split into plain pieces and <mark> pieces for the given [{text, match}] parts. */
export function markedText(parts) {
  return parts.map((p) => (p.match ? h('mark', null, p.text) : p.text));
}

/** Sets the text of an element only when it changed (keeps screen readers from re-announcing the same sentence). */
export function setText(el, text) {
  const next = text == null ? '' : String(text);
  if (el.textContent !== next) el.textContent = next;
}

/** Shows or hides an element with the `hidden` attribute. */
export function setHidden(el, hidden) {
  if (hidden) el.setAttribute('hidden', '');
  else el.removeAttribute('hidden');
}

let idCounter = 0;
export const uniqueId = (prefix = 'id') => `${prefix}-${++idCounter}`;
