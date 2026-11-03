// A very small DOM - just enough for js/ui/dom.js, js/slip.js and js/qr.js to build a slip in plain Node.
//
// It is STRICT on purpose: anything that would turn a string into markup (innerHTML, outerHTML, insertAdjacentHTML, srcdoc,
// document.write) or touch cookies throws. A test that renders hostile text therefore fails loudly if the code ever starts
// using one of them. (The real browser is covered by the end-to-end tests; this keeps the cheap guarantee in every `npm test`.)

const NOT_ALLOWED = (what) => () => {
  throw new Error(`${what} must never be used: it turns a string into markup (or keeps data on the PC)`);
};

class FakeText {
  constructor(ownerDocument, data) {
    this.ownerDocument = ownerDocument;
    this.nodeType = 3;
    this.data = String(data);
    this.parentNode = null;
  }

  get textContent() {
    return this.data;
  }
}

class FakeElement {
  constructor(ownerDocument, tagName, namespaceURI) {
    this.ownerDocument = ownerDocument;
    this.nodeType = 1;
    this.tagName = tagName;
    this.namespaceURI = namespaceURI;
    this.attributes = new Map();
    this.childNodes = [];
    this.dataset = {};
    this.listeners = [];
    this.parentNode = null;
    this.textWrites = 0;
  }

  setAttribute(name, value) {
    this.attributes.set(String(name), String(value));
  }

  getAttribute(name) {
    return this.attributes.has(name) ? this.attributes.get(name) : null;
  }

  hasAttribute(name) {
    return this.attributes.has(name);
  }

  removeAttribute(name) {
    this.attributes.delete(name);
  }

  appendChild(child) {
    child.parentNode = this;
    this.childNodes.push(child);
    return child;
  }

  replaceChildren(...nodes) {
    for (const child of this.childNodes) child.parentNode = null;
    this.childNodes = [];
    for (const node of nodes) this.appendChild(node);
  }

  addEventListener(type, listener) {
    this.listeners.push({ type, listener });
  }

  get children() {
    return this.childNodes.filter((n) => n.nodeType === 1);
  }

  get textContent() {
    return this.childNodes.map((n) => n.textContent).join('');
  }

  set textContent(value) {
    this.textWrites++;
    const text = String(value);
    this.replaceChildren(...(text === '' ? [] : [new FakeText(this.ownerDocument, text)]));
  }

  get innerHTML() {
    return NOT_ALLOWED('innerHTML')();
  }

  set innerHTML(_value) {
    NOT_ALLOWED('innerHTML')();
  }

  get outerHTML() {
    return NOT_ALLOWED('outerHTML')();
  }

  set outerHTML(_value) {
    NOT_ALLOWED('outerHTML')();
  }

  set srcdoc(_value) {
    NOT_ALLOWED('srcdoc')();
  }

  insertAdjacentHTML() {
    NOT_ALLOWED('insertAdjacentHTML')();
  }
}

/** Puts a fake `document` on globalThis. Call `restore()` when done. */
export function installFakeDom() {
  const registry = new Map();
  const document = {
    createElement: (tag) => new FakeElement(document, String(tag).toLowerCase(), 'http://www.w3.org/1999/xhtml'),
    createElementNS: (namespace, tag) => new FakeElement(document, String(tag), namespace),
    createTextNode: (data) => new FakeText(document, data),
    getElementById: (id) => registry.get(id) ?? null,
    /** Test helper: makes an element findable by id (like markup in index.html). */
    register(id, element) {
      element.setAttribute('id', id);
      registry.set(id, element);
      return element;
    },
    write: NOT_ALLOWED('document.write'),
    writeln: NOT_ALLOWED('document.writeln'),
  };
  Object.defineProperty(document, 'cookie', { get: NOT_ALLOWED('document.cookie'), set: NOT_ALLOWED('document.cookie') });
  globalThis.document = document;
  return {
    document,
    restore() {
      delete globalThis.document;
    },
  };
}

/** Every element below (and including) `root`, in document order. */
export function elementsOf(root) {
  const out = [];
  const visit = (node) => {
    if (node.nodeType !== 1) return;
    out.push(node);
    for (const child of node.childNodes) visit(child);
  };
  visit(root);
  return out;
}

/** Every text node below `root`. */
export function textNodesOf(root) {
  const out = [];
  const visit = (node) => {
    if (node.nodeType === 3) out.push(node);
    else for (const child of node.childNodes) visit(child);
  };
  visit(root);
  return out;
}

export const hasClass = (element, name) => (element.getAttribute('class') ?? '').split(/\s+/).includes(name);
export const byClass = (root, name) => elementsOf(root).filter((e) => hasClass(e, name));
export const byTag = (root, tag) => elementsOf(root).filter((e) => e.tagName === tag);
