/*
 * Executed inside each frame via Playwright `evaluate(string)`. Kept as plain
 * JavaScript on purpose: serializing a transpiled TypeScript function can leak
 * bundler helpers (esbuild's __name) into the page, where they are undefined.
 *
 * The caller embeds `args` as JSON and wraps this function in parentheses.
 */
function snapshotFrame(args) {
  var INTERACTIVE_TAGS = new Set([
    'A', 'BUTTON', 'INPUT', 'TEXTAREA', 'SELECT', 'OPTION', 'SUMMARY', 'DETAILS',
  ]);
  var INTERACTIVE_ROLES = new Set([
    'button', 'link', 'textbox', 'searchbox', 'combobox', 'checkbox', 'radio',
    'switch', 'tab', 'menuitem', 'menuitemcheckbox', 'menuitemradio', 'option',
    'slider', 'spinbutton', 'gridcell', 'treeitem',
  ]);
  var VALUE_INPUT_TYPES = new Set([
    '', 'text', 'search', 'email', 'number', 'tel', 'url', 'date', 'time',
    'datetime-local', 'month', 'week',
  ]);
  var SAFE_ATTRS = ['id', 'name', 'type', 'placeholder', 'title', 'aria-label', 'data-testid', 'data-test', 'href'];

  var norm = function (s) {
    return (s || '').replace(/\s+/g, ' ').trim();
  };
  var isRendered = function (el) {
    if (el.hidden) return false;
    var style = window.getComputedStyle(el);
    if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) === 0) return false;
    var rect = el.getBoundingClientRect();
    return rect.width > 0 || rect.height > 0;
  };
  var inViewport = function (rect) {
    return rect.bottom > 0 && rect.right > 0 && rect.top < window.innerHeight && rect.left < window.innerWidth;
  };
  var roleOf = function (el) {
    var explicit = el.getAttribute('role');
    if (explicit) return explicit.toLowerCase();
    var tag = el.tagName.toLowerCase();
    if (tag === 'a') return 'link';
    if (tag === 'button' || tag === 'summary') return 'button';
    if (tag === 'select') return 'combobox';
    if (tag === 'textarea') return 'textbox';
    if (tag === 'input') {
      var t = (el.type || 'text').toLowerCase();
      if (t === 'checkbox') return 'checkbox';
      if (t === 'radio') return 'radio';
      if (t === 'range') return 'slider';
      if (t === 'number') return 'spinbutton';
      if (t === 'search') return 'searchbox';
      if (t === 'button' || t === 'submit' || t === 'reset' || t === 'image') return 'button';
      return 'textbox';
    }
    if (el.getAttribute('contenteditable') === 'true' || el.isContentEditable) return 'textbox';
    return tag;
  };
  var nameOf = function (el) {
    var aria = el.getAttribute('aria-label');
    if (aria && norm(aria)) return norm(aria);
    var labelledBy = el.getAttribute('aria-labelledby');
    if (labelledBy) {
      var text = labelledBy.split(/\s+/).map(function (id) {
        var node = document.getElementById(id);
        return node ? node.textContent : '';
      }).join(' ');
      if (norm(text)) return norm(text);
    }
    if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement) {
      var labels = el.labels;
      if (labels && labels.length > 0) {
        var labelText = Array.prototype.map.call(labels, function (l) { return l.textContent || ''; }).join(' ');
        if (norm(labelText)) return norm(labelText);
      }
      if (el.placeholder && norm(el.placeholder)) return norm(el.placeholder);
    }
    var title = el.getAttribute('title');
    if (title && norm(title)) return norm(title);
    var alt = el.getAttribute('alt');
    if (alt && norm(alt)) return norm(alt);
    var inner = el.innerText != null ? el.innerText : el.textContent;
    if (norm(inner)) return norm(inner).slice(0, 300);
    if (el instanceof HTMLInputElement && ['button', 'submit', 'reset'].indexOf(el.type) >= 0) return el.value.slice(0, 300);
    return '';
  };
  var isInteractive = function (el) {
    if (INTERACTIVE_TAGS.has(el.tagName)) return true;
    var role = (el.getAttribute('role') || '').toLowerCase();
    if (INTERACTIVE_ROLES.has(role)) return true;
    if (el.getAttribute('contenteditable') === 'true') return true;
    var tabindex = el.getAttribute('tabindex');
    if (tabindex !== null && tabindex !== '-1') return true;
    if (el.hasAttribute('onclick')) return true;
    return false;
  };

  var interactive = [];
  var shadowRoots = 0;
  var totalNodes = 0;
  var visit = function (root) {
    var walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT);
    var el = walker.firstChild();
    while (el) {
      totalNodes += 1;
      if (totalNodes > 60000) break;
      if (isInteractive(el)) interactive.push(el);
      if (el.shadowRoot) {
        shadowRoots += 1;
        visit(el.shadowRoot);
      }
      el = walker.nextNode();
    }
  };
  visit(document);

  var collected = [];
  var hiddenTargets = 0;
  var offscreenTargets = 0;
  var i;
  for (i = 0; i < interactive.length; i++) {
    var el = interactive[i];
    if (!isRendered(el)) {
      hiddenTargets += 1;
      continue;
    }
    var rect = el.getBoundingClientRect();
    var visible = inViewport(rect);
    if (!visible) offscreenTargets += 1;
    var role = roleOf(el);
    var name = nameOf(el);
    var tag = el.tagName.toLowerCase();
    var type = el instanceof HTMLInputElement ? (el.type || 'text').toLowerCase() : undefined;
    var value = undefined;
    if (el instanceof HTMLInputElement) {
      if (VALUE_INPUT_TYPES.has(type || 'text')) value = el.value.slice(0, 1000);
      else if (type === 'checkbox' || type === 'radio') value = String(el.checked);
      else value = '[redacted]';
    } else if (el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement) {
      value = el.value.slice(0, 1000);
    }
    var attributes = {};
    for (var a = 0; a < SAFE_ATTRS.length; a++) {
      var attr = SAFE_ATTRS[a];
      var v = el.getAttribute(attr);
      if (v && v.length <= 300) attributes[attr] = v;
    }
    var target = {
      targetId: '',
      frameId: 'main',
      role: role,
      name: name.slice(0, 500),
      tag: tag,
      visible: visible,
      actionable: !el.disabled && visible,
      bbox: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
      attributes: attributes,
      __el: el,
    };
    if (type) target.type = type;
    if (value !== undefined) target.value = value;
    var ph = el.getAttribute('placeholder');
    if (ph) target.placeholder = ph.slice(0, 500);
    if (el instanceof HTMLInputElement && (type === 'checkbox' || type === 'radio')) target.checked = el.checked;
    if (el.disabled) target.disabled = true;
    collected.push(target);
  }

  var counts = new Map();
  for (i = 0; i < collected.length; i++) {
    var key = collected[i].role + '::' + String(collected[i].name).toLowerCase();
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  var ordinals = new Map();
  var targets = [];
  var elements = [];
  var refIndex = 0;
  for (i = 0; i < collected.length; i++) {
    var t = collected[i];
    var k = t.role + '::' + String(t.name).toLowerCase();
    var ordinal = (ordinals.get(k) || 0) + 1;
    ordinals.set(k, ordinal);
    var element = t.__el;
    delete t.__el;
    var ref = args.refPrefix + ':' + (refIndex++);
    element.setAttribute('data-cua-ref', ref);
    t.targetId = ref;
    t.ordinal = ordinal - 1;
    if ((counts.get(k) || 0) > 1) t.duplicateKey = k + '#' + (ordinal - 1);
    if (targets.length < args.maxTargets) { targets.push(t); elements.push(element); }
    else break;
  }

  var rawText = document.body ? (document.body.innerText || '') : '';
  var text = norm(rawText);
  return {
    text: text.slice(0, args.maxText),
    textTruncated: text.length > args.maxText,
    targets: targets,
    elements: elements,
    targetsTruncated: collected.length > args.maxTargets,
    hiddenTargets: hiddenTargets,
    offscreenTargets: offscreenTargets,
    shadowRoots: shadowRoots,
    openDialogs: document.querySelectorAll('dialog[open]').length,
    totalNodes: totalNodes,
  };
}
