// Element picker for the built-in browser: arm it, click anything in the page,
// and the element comes back as context for the chat.
//
// The previewed page is untrusted and deliberately has no preload, so there's no
// ipc channel to it. The script below is injected with executeJavaScript and
// answers on the one channel a plain guest always has — console.log with a
// prefix nothing else would emit. Whatever comes back is treated as text: it
// lands in the chat box for the user to read before they send it.

export const PICK_PREFIX = '__CONECODE_PICK__';

export interface PickedElement {
  /** Best-effort CSS path, for telling the agent which element this is. */
  selector: string;
  tag: string;
  text: string;
  html: string;
}

const HIGHLIGHT_CLASS = '__conecode_pick_hl';

/**
 * Source for the injected picker. `accent` paints the outline in the app's own
 * accent colour so the page looks like part of ConeCode while picking.
 */
export function pickerScript(accent: string): string {
  return `(() => {
  if (window.__conecodePicker) window.__conecodePicker.stop();

  const HL = ${JSON.stringify(HIGHLIGHT_CLASS)};
  const style = document.createElement('style');
  style.id = '__conecode_pick_style';
  style.textContent = '.' + HL + '{outline:2px solid ${accent} !important;outline-offset:-2px !important;background:${accent}1a !important;}'
    + 'html.__conecode_picking, html.__conecode_picking *{cursor:crosshair !important;}';
  document.documentElement.appendChild(style);
  document.documentElement.classList.add('__conecode_picking');

  let hovered = null;
  const clear = () => { if (hovered) hovered.classList.remove(HL); hovered = null; };

  const onOver = (e) => {
    const el = e.target;
    if (!el || el.nodeType !== 1 || el === hovered) return;
    clear();
    hovered = el;
    el.classList.add(HL);
  };

  const selectorFor = (el) => {
    const parts = [];
    let node = el;
    while (node && node.nodeType === 1 && parts.length < 4) {
      if (node.id) { parts.unshift('#' + node.id); break; }
      let part = node.tagName.toLowerCase();
      const cls = typeof node.className === 'string'
        ? node.className.trim().split(/\\s+/).filter((c) => c && c !== HL).slice(0, 2)
        : [];
      if (cls.length) {
        part += '.' + cls.join('.');
      } else if (node.parentElement) {
        const sameTag = Array.from(node.parentElement.children).filter((c) => c.tagName === node.tagName);
        if (sameTag.length > 1) part += ':nth-of-type(' + (sameTag.indexOf(node) + 1) + ')';
      }
      parts.unshift(part);
      node = node.parentElement;
    }
    return parts.join(' > ');
  };

  const onClick = (e) => {
    e.preventDefault();
    e.stopPropagation();
    const el = e.target;
    clear();
    const html = el.outerHTML || '';
    const payload = {
      selector: selectorFor(el),
      tag: el.tagName ? el.tagName.toLowerCase() : '',
      text: (el.innerText || el.textContent || '').trim().slice(0, 200),
      html: html.length > 600 ? html.slice(0, 600) + '…' : html,
    };
    stop();
    console.log(${JSON.stringify(PICK_PREFIX)} + JSON.stringify(payload));
  };

  const onKey = (e) => { if (e.key === 'Escape') stop(); };

  function stop() {
    clear();
    document.documentElement.classList.remove('__conecode_picking');
    document.getElementById('__conecode_pick_style')?.remove();
    document.removeEventListener('mouseover', onOver, true);
    document.removeEventListener('click', onClick, true);
    document.removeEventListener('keydown', onKey, true);
    window.__conecodePicker = null;
  }

  document.addEventListener('mouseover', onOver, true);
  document.addEventListener('click', onClick, true);
  document.addEventListener('keydown', onKey, true);
  window.__conecodePicker = { stop };
})()`;
}

/** Source that disarms a picker left running (toggling the button off). */
export const pickerStopScript = 'window.__conecodePicker && window.__conecodePicker.stop()';

/**
 * Read a console line from the guest. Returns the picked element, or null for
 * the ordinary page logging that shares this channel.
 */
export function parsePick(message: string): PickedElement | null {
  if (!message || !message.startsWith(PICK_PREFIX)) return null;
  try {
    const raw = JSON.parse(message.slice(PICK_PREFIX.length));
    if (!raw || typeof raw !== 'object') return null;
    return {
      selector: String(raw.selector || ''),
      tag: String(raw.tag || ''),
      text: String(raw.text || ''),
      html: String(raw.html || ''),
    };
  } catch {
    return null;
  }
}

/** Render a picked element as the chat message the user is about to write. */
export function pickToPrompt(el: PickedElement, lead: string): string {
  const lines = [`${lead} \`${el.selector || el.tag}\``];
  if (el.text) lines.push('', `> ${el.text.replace(/\s+/g, ' ').slice(0, 160)}`);
  if (el.html) lines.push('', '```html', el.html, '```');
  return lines.join('\n') + '\n\n';
}
