/**
 * Element identity that survives a redeploy.
 *
 * This is the core of the recorder, and the answer to the only question that
 * decides whether a recorded test is worth keeping: **how do you point at an
 * input today so that you still find it next month?**
 *
 * No single selector answers that. A CSS path breaks on a refactor, an id
 * breaks when the framework regenerates it, text breaks on a copy change. So we
 * do what Chrome's own Recorder and Playwright's codegen do: record SEVERAL
 * independent locators per element, ranked by how well each survives change,
 * and at replay try them in that order.
 *
 * Our ranking has one advantage neither of those has. This extension already
 * perceives pages as an accessibility tree — role plus accessible name is how
 * the agent addresses elements everywhere else. Recording the same identity
 * means the recorder and the agent agree about what an element *is*, and
 * role+name is unusually durable: it survives restyling, DOM restructuring, and
 * class-name churn, because it is derived from what the control means rather
 * than where it sits.
 *
 * The order, most durable first:
 *
 *   1. testid    an explicit hook (data-testid/-test/-qa/-cy). If the team put
 *                one there, it is a promise not to move it.
 *   2. role+name the accessibility identity. Best default for form controls.
 *   3. label     the <label> text bound to a control. Breaks only on copy edits.
 *   4. text      shortest unique visible text. Good for buttons and links.
 *   5. css       built from STABLE attributes only — never from generated
 *                classes or ids (see looksGenerated).
 *   6. xpath     always available, first to break. Last resort, and when it is
 *                the one that matched we say so, because that is a warning.
 *
 * Plus a fingerprint — tag, type, name, placeholder, nearest heading, ordinal —
 * which is not used to find the element. It exists so that when NOTHING
 * matches, replay can say what it was looking for in human terms and name the
 * closest thing it did find, instead of "selector not found".
 *
 * ## Why this file is a string
 *
 * Both halves have to run inside the page: the recorder describes elements the
 * user touches, the replayer resolves them again. Shipping one source keeps
 * them from drifting — a locator kind can never be generated in a form the
 * resolver does not understand, because there is only one definition of each.
 *
 * ## Escaping
 *
 * Everything below is injected as a template literal and parsed twice, so every
 * regex escape is doubled (`\\s`, not `\s`). A single backslash is silently
 * swallowed by the template literal and the page runs a different regex — that
 * cost this codebase thirteen versions of quietly corrupted text output in
 * `snapshot.js`. Self-test #13 scans for it.
 */

/**
 * Attributes treated as deliberate test hooks, in priority order.
 * Kept configurable because teams disagree, and the disagreement is cheap.
 */
export const TESTID_ATTRIBUTES = ['data-testid', 'data-test-id', 'data-test', 'data-qa', 'data-cy'];

export const LOCATOR_SOURCE = `
(() => {
  if (window.__g9loc) return;

  const TESTIDS = ${JSON.stringify(TESTID_ATTRIBUTES)};

  // ---------------------------------------------------------------- stability

  /**
   * Does this id or class look machine-generated?
   *
   * Generated identifiers are the single largest source of recorded-test
   * flakiness: they are stable within one build and different in the next.
   * Every pattern here is something a real framework emits —
   * CSS Modules (Button_root__1a2b3), styled-components (sc-bdVaJa),
   * emotion (css-1x2y3z), React 18 useId (:r1:), Radix (radix-:r2:),
   * Angular (ng-tns-c12-3), and raw hashes or uuids.
   */
  const looksGenerated = (value) => {
    if (!value) return true;
    return (
      /^:r[0-9a-z]+:$/i.test(value) ||
      /^radix-/i.test(value) ||
      /^ng-tns-/.test(value) ||
      /^(sc|css|emotion)-[a-z0-9]{5,}$/i.test(value) ||
      /^[a-z]+_[a-z]+__[a-z0-9]{4,}$/i.test(value) ||
      /^[0-9a-f]{8}-[0-9a-f]{4}-/i.test(value) ||
      /[0-9a-f]{16,}/i.test(value) ||
      /^[0-9]+$/.test(value) ||
      /^(mui|chakra|mantine)-[0-9]{3,}$/i.test(value)
    );
  };

  const clean = (s) => String(s == null ? '' : s).replace(/\\s+/g, ' ').trim();

  const visible = (el) => {
    if (!el || !el.isConnected) return false;
    const r = el.getBoundingClientRect();
    if (r.width <= 0 && r.height <= 0) return false;
    const s = getComputedStyle(el);
    return s.visibility !== 'hidden' && s.display !== 'none';
  };

  // ------------------------------------------------------- accessible identity

  /**
   * Implicit ARIA role for the tags that matter to a recorder.
   * Deliberately partial: a wrong role is worse than no role, so anything
   * ambiguous returns '' and the locator is simply not offered.
   */
  const roleOf = (el) => {
    const explicit = clean(el.getAttribute('role'));
    if (explicit) return explicit.split(' ')[0];
    const tag = el.tagName.toLowerCase();
    if (tag === 'a') return el.hasAttribute('href') ? 'link' : '';
    if (tag === 'button') return 'button';
    if (tag === 'select') return el.multiple ? 'listbox' : 'combobox';
    if (tag === 'textarea') return 'textbox';
    if (tag === 'option') return 'option';
    if (tag === 'summary') return 'button';
    if (/^h[1-6]$/.test(tag)) return 'heading';
    if (tag === 'input') {
      const t = (el.getAttribute('type') || 'text').toLowerCase();
      if (t === 'checkbox') return 'checkbox';
      if (t === 'radio') return 'radio';
      if (t === 'range') return 'slider';
      if (t === 'number') return 'spinbutton';
      if (t === 'search') return 'searchbox';
      if (['button', 'submit', 'reset', 'image'].indexOf(t) >= 0) return 'button';
      if (['hidden', 'file', 'color', 'date', 'time', 'datetime-local', 'month', 'week'].indexOf(t) >= 0) return '';
      return 'textbox';
    }
    return '';
  };

  /**
   * The <label> bound to a control, by for= or by wrapping.
   *
   * The control's own subtree is removed before reading the text. A wrapping
   * <label> CONTAINS the control, so plain textContent picks up whatever the
   * control renders — for a <select> that is every <option>, turning the label
   * "Environment" into "Environment Development Staging Production".
   *
   * That is not a cosmetic difference. The accessibility tree calls this
   * element combobox "Environment", and if the recorder calls it something else
   * then the recorder and the agent disagree about what the element IS — which
   * is the one thing this whole file exists to prevent.
   */
  const labelFor = (el) => {
    const own = (el.labels && el.labels.length) ? el.labels[0] : el.closest('label');
    if (!own) return '';
    const clone = own.cloneNode(true);
    for (const ctrl of clone.querySelectorAll('input, select, textarea, button, [role=combobox], [role=textbox]')) {
      ctrl.remove();
    }
    return clean(clone.textContent);
  };

  /**
   * Accessible name, following the parts of accname that matter here:
   * aria-label, aria-labelledby, <label>, then the element's own text, then
   * the placeholder/title/alt fallbacks.
   */
  const nameOf = (el) => {
    const aria = clean(el.getAttribute('aria-label'));
    if (aria) return aria;

    const ref = clean(el.getAttribute('aria-labelledby'));
    if (ref) {
      const parts = ref.split(' ')
        .map((id) => document.getElementById(id))
        .filter(Boolean)
        .map((n) => clean(n.textContent));
      if (parts.length) return parts.join(' ');
    }

    const label = labelFor(el);
    if (label) return label;

    const tag = el.tagName.toLowerCase();
    if (tag === 'input') {
      const t = (el.getAttribute('type') || 'text').toLowerCase();
      if (['button', 'submit', 'reset'].indexOf(t) >= 0) return clean(el.value);
      if (t === 'image') return clean(el.getAttribute('alt'));
    }
    if (tag === 'img') return clean(el.getAttribute('alt'));

    // A form control's text content is its VALUE, not its name — the options of
    // a <select>, the text typed into a textarea. Only non-control elements
    // (buttons, links, headings) are named by what they contain.
    if (['input', 'select', 'textarea'].indexOf(tag) < 0) {
      const own = clean(el.textContent);
      if (own && own.length <= 120) return own;
    }

    return clean(el.getAttribute('placeholder') || el.getAttribute('title') || '');
  };

  // -------------------------------------------------------------- css / xpath

  /**
   * One CSS segment for an element, built only from attributes that a redeploy
   * is unlikely to change. Generated ids and classes are skipped outright —
   * including one would produce a selector that works now and silently stops
   * matching after the next build, which is the failure this whole file exists
   * to avoid.
   */
  const cssSegment = (el) => {
    const tag = el.tagName.toLowerCase();

    const id = el.getAttribute('id');
    if (id && !looksGenerated(id)) return tag + '#' + CSS.escape(id);

    const bits = [tag];
    for (const attr of ['name', 'type', 'placeholder', 'aria-label']) {
      const v = el.getAttribute(attr);
      if (v && v.length <= 60 && !looksGenerated(v)) {
        bits.push('[' + attr + '=' + JSON.stringify(v) + ']');
        break;
      }
    }
    if (bits.length === 1 && typeof el.className === 'string') {
      const stable = el.className.trim().split(/\\s+/).filter((c) => c && !looksGenerated(c));
      if (stable.length) bits.push('.' + CSS.escape(stable[0]));
    }
    return bits.join('');
  };

  /** Shortest CSS path that resolves to exactly this element. */
  const cssPath = (el) => {
    const parts = [];
    let node = el;
    for (let depth = 0; node && node.nodeType === 1 && depth < 8; depth++) {
      let seg = cssSegment(node);

      const parent = node.parentElement;
      if (parent) {
        const twins = Array.prototype.filter.call(parent.children, (c) => {
          try { return c.matches(seg); } catch (e) { return false; }
        });
        if (twins.length > 1) seg += ':nth-child(' + (Array.prototype.indexOf.call(parent.children, node) + 1) + ')';
      }

      parts.unshift(seg);
      const candidate = parts.join(' > ');
      try {
        if (document.querySelectorAll(candidate).length === 1) return candidate;
      } catch (e) { /* a segment we cannot query is no use */ }

      node = parent;
    }
    return parts.length ? parts.join(' > ') : '';
  };

  const xPath = (el) => {
    const parts = [];
    let node = el;
    while (node && node.nodeType === 1 && node !== document.documentElement) {
      const tag = node.tagName.toLowerCase();
      const parent = node.parentElement;
      if (!parent) break;
      const twins = Array.prototype.filter.call(parent.children, (c) => c.tagName === node.tagName);
      const index = twins.indexOf(node) + 1;
      parts.unshift(twins.length > 1 ? tag + '[' + index + ']' : tag);
      node = parent;
    }
    return '/html/' + parts.join('/');
  };

  // ------------------------------------------------------------- fingerprint

  /** The nearest heading above this element — human context for an error. */
  const nearestHeading = (el) => {
    let scope = el.closest('section, article, form, dialog, main, [role=region], [role=dialog]') || document.body;
    for (let i = 0; i < 3 && scope; i++) {
      const h = scope.querySelector('h1, h2, h3, h4, [role=heading]');
      if (h) return clean(h.textContent).slice(0, 80);
      scope = scope.parentElement ? scope.parentElement.closest('section, article, form, dialog, main') : null;
    }
    return '';
  };

  /**
   * Everything needed to DESCRIBE the element to a human, and nothing used to
   * find it. When every locator misses, this is the error message.
   */
  const fingerprint = (el) => {
    const role = roleOf(el);
    const peers = role
      ? Array.prototype.filter.call(document.querySelectorAll('*'), (n) => roleOf(n) === role && visible(n))
      : [];
    return {
      tag: el.tagName.toLowerCase(),
      type: el.getAttribute('type') || null,
      role: role || null,
      name: nameOf(el) || null,
      label: labelFor(el) || null,
      placeholder: el.getAttribute('placeholder') || null,
      heading: nearestHeading(el) || null,
      ordinal: peers.length ? peers.indexOf(el) : -1,
      peerCount: peers.length,
    };
  };

  // ------------------------------------------------------------------ describe

  /** Shortest visible text that identifies exactly one element. */
  const uniqueText = (el) => {
    const text = clean(el.textContent);
    if (!text || text.length > 80) return '';
    const matches = Array.prototype.filter.call(
      document.querySelectorAll('a, button, [role=button], [role=link], label, summary, li, td, th'),
      (n) => clean(n.textContent) === text && visible(n),
    );
    return matches.length === 1 ? text : '';
  };

  const describe = (el) => {
    if (!el || el.nodeType !== 1) return null;

    const locators = [];

    for (const attr of TESTIDS) {
      const v = el.getAttribute(attr);
      if (v) { locators.push({ kind: 'testid', attr, value: v }); break; }
    }

    const role = roleOf(el);
    const name = nameOf(el);
    if (role && name) locators.push({ kind: 'role', role, name });

    const label = labelFor(el);
    if (label && /^(input|textarea|select)$/.test(el.tagName.toLowerCase())) {
      locators.push({ kind: 'label', label });
    }

    const text = uniqueText(el);
    if (text) locators.push({ kind: 'text', text });

    const css = cssPath(el);
    if (css) locators.push({ kind: 'css', css });

    locators.push({ kind: 'xpath', xpath: xPath(el) });

    return { locators, fingerprint: fingerprint(el) };
  };

  // ------------------------------------------------------------------- resolve

  /**
   * A locator only counts when it identifies exactly ONE visible element.
   * Two matches means we cannot tell which the user meant, and guessing is how
   * a replay silently does the wrong thing — the failure this tool exists to
   * make impossible.
   */
  const candidatesFor = (loc) => {
    try {
      if (loc.kind === 'testid') {
        return Array.prototype.slice.call(document.querySelectorAll('[' + loc.attr + '=' + JSON.stringify(loc.value) + ']'));
      }
      if (loc.kind === 'role') {
        return Array.prototype.filter.call(
          document.querySelectorAll('*'),
          (n) => roleOf(n) === loc.role && nameOf(n) === loc.name,
        );
      }
      if (loc.kind === 'label') {
        return Array.prototype.filter.call(
          document.querySelectorAll('input, textarea, select'),
          (n) => labelFor(n) === loc.label,
        );
      }
      if (loc.kind === 'text') {
        return Array.prototype.filter.call(
          document.querySelectorAll('a, button, [role=button], [role=link], label, summary, li, td, th'),
          (n) => clean(n.textContent) === loc.text,
        );
      }
      if (loc.kind === 'css') {
        return Array.prototype.slice.call(document.querySelectorAll(loc.css));
      }
      if (loc.kind === 'xpath') {
        const out = [];
        const it = document.evaluate(loc.xpath, document, null, XPathResult.ORDERED_NODE_ITERATOR_TYPE, null);
        for (let n = it.iterateNext(); n; n = it.iterateNext()) out.push(n);
        return out;
      }
    } catch (e) { /* a malformed locator is a miss, not a crash */ }
    return [];
  };

  /**
   * Try each locator in recorded order and report WHICH one matched.
   *
   * The winning kind is as valuable as the element. Matching on \`testid\` means
   * the page is behaving; falling through to \`xpath\` means every durable
   * identity has changed and the step is one refactor from breaking. Replay
   * surfaces that as a warning rather than waiting for the failure.
   */
  const resolve = (target) => {
    const tried = [];
    for (const loc of target.locators || []) {
      const found = candidatesFor(loc).filter(visible);
      if (found.length === 1) return { ok: true, el: found[0], matchedBy: loc.kind, tried };
      tried.push({ kind: loc.kind, matches: found.length });
    }
    return { ok: false, el: null, matchedBy: null, tried, nearest: nearestCandidate(target) };
  };

  /**
   * When nothing matched, name the closest thing on the page.
   *
   * "Selector not found" tells the user nothing they can act on. "Looked for a
   * textbox labelled 'Email' under 'Billing details'; the nearest match is a
   * textbox labelled 'E-mail address'" tells them the label was renamed.
   */
  const nearestCandidate = (target) => {
    const fp = target.fingerprint || {};
    if (!fp.role && !fp.tag) return null;

    let best = null;
    let bestScore = 0;
    const all = document.querySelectorAll(fp.tag || '*');
    for (const el of all) {
      if (!visible(el)) continue;
      let score = 0;
      if (fp.role && roleOf(el) === fp.role) score += 3;
      if (fp.type && el.getAttribute('type') === fp.type) score += 1;
      if (fp.placeholder && el.getAttribute('placeholder') === fp.placeholder) score += 2;
      if (fp.label && labelFor(el) === fp.label) score += 3;
      // Same section of the page. A control that moved is less likely the one.
      if (fp.heading && nearestHeading(el) === fp.heading) score += 2;
      if (fp.name) {
        const n = nameOf(el);
        // The name is the strongest signal by far, so it is weighted above
        // everything else combined. A control that stayed put but is a
        // different control must not outrank the one that was renamed.
        if (n === fp.name) score += 6;
        else if (n) score += 6 * similarity(fp.name, n);
      }
      if (score > bestScore) { bestScore = score; best = el; }
    }
    // Below this, the "nearest match" is just the first textbox on the page,
    // and naming it would mislead more than saying nothing.
    if (!best || bestScore < 4) return null;
    return { describe: describeBriefly(best), score: Math.round(bestScore * 10) / 10 };
  };

  /**
   * Dice coefficient over character bigrams, 0..1.
   *
   * Character-level rather than word-level on purpose. The common label edit
   * splits or joins words — "Username" becomes "User name", "Email" becomes
   * "E-mail address" — and a word-set comparison scores both of those ZERO
   * while a bigram comparison scores them high. Punctuation and spacing are
   * stripped first so that "E-mail" and "Email" are the same string.
   *
   * The Persian range is included because the pages this gets pointed at are
   * often RTL, and a Latin-only tokenizer would score every Persian label as
   * completely unlike every other one.
   */
  const similarity = (a, b) => {
    const norm = (s) => String(s).toLowerCase().replace(/[^a-z0-9\\u0600-\\u06ff]+/g, '');
    const x = norm(a);
    const y = norm(b);
    if (!x || !y) return 0;
    if (x === y) return 1;
    if (x.length < 2 || y.length < 2) return x === y ? 1 : 0;

    const grams = (s) => {
      const m = new Map();
      for (let i = 0; i < s.length - 1; i++) {
        const g = s.slice(i, i + 2);
        m.set(g, (m.get(g) || 0) + 1);
      }
      return m;
    };
    const A = grams(x);
    const B = grams(y);
    let shared = 0;
    for (const [g, count] of A) shared += Math.min(count, B.get(g) || 0);
    return (2 * shared) / (x.length - 1 + y.length - 1);
  };

  const describeBriefly = (el) => {
    const role = roleOf(el) || el.tagName.toLowerCase();
    const name = nameOf(el);
    return name ? role + ' "' + name.slice(0, 60) + '"' : role;
  };

  window.__g9loc = { describe, resolve, describeBriefly, roleOf, nameOf, visible, clean };
})();
`;
