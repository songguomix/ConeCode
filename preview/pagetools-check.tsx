// Runs the REAL injected scripts against a REAL DOM, including a React
// controlled input — the case the native-setter path in fillScript exists for.
// Unit tests only prove the script text is well-formed; this proves it works.
import React, { useState } from 'react';
import ReactDOM from 'react-dom/client';
import {
  snapshotScript, clickScript, fillScript, evalScript,
  parseSnapshot, parseActionResult, formatSnapshot,
} from '../src/core/preview/pagetools';

function TodoApp() {
  const [draft, setDraft] = useState('');
  const [items, setItems] = useState<string[]>(['Buy milk']);
  const [done, setDone] = useState(false);
  return (
    <div style={{ fontFamily: 'system-ui', padding: 16 }}>
      <h1>Todo</h1>
      {/* Controlled input: assigning .value directly would be swallowed by React */}
      <input aria-label="New task" value={draft} onChange={(e) => setDraft(e.target.value)} />
      <button onClick={() => { if (draft) { setItems((v) => [...v, draft]); setDraft(''); } }}>Add</button>
      <label><input type="checkbox" checked={done} onChange={(e) => setDone(e.target.checked)} /> Done</label>
      <ul>{items.map((item, i) => <li key={i}>{item}</li>)}</ul>
      <p className="total">{items.length} items</p>
    </div>
  );
}

const results: string[] = [];
const check = (name: string, pass: boolean, detail = '') =>
  results.push(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`);

// eslint-disable-next-line no-eval
const run = (code: string) => eval(code);

async function verify() {
  // ---- snapshot ---------------------------------------------------------
  const snap = parseSnapshot(run(snapshotScript()));
  if (!snap.ok) { check('snapshot', false, snap.message); return; }
  const text = formatSnapshot(snap.snapshot);

  check('snapshot finds the heading', /heading "Todo" level=1/.test(text));
  check('snapshot finds the textbox with a ref', /textbox "New task".*\[e\d+\]/.test(text));
  check('snapshot finds the button with a ref', /button "Add" \[e\d+\]/.test(text));
  check('snapshot finds the checkbox', /checkbox.*\[e\d+\]/.test(text));
  check('snapshot reports list content', /Buy milk/.test(text));
  check('snapshot reports the total text', /1 items/.test(text));
  check('snapshot omits refs from non-interactive nodes',
    !/heading "Todo" level=1 \[e/.test(text));

  const refOf = (pattern: RegExp) => text.match(pattern)?.[1];
  const inputRef = refOf(/textbox "New task"[^\n]*\[(e\d+)\]/);
  const addRef = refOf(/button "Add" \[(e\d+)\]/);
  const boxRef = refOf(/checkbox[^\n]*\[(e\d+)\]/);

  // ---- fill a React controlled input -------------------------------------
  const filled = parseActionResult(run(fillScript(inputRef!, 'Write tests', false)));
  check('fill reports success', filled.ok, filled.message);
  await new Promise((r) => setTimeout(r, 50));
  const liveValue = (document.querySelector('input[aria-label="New task"]') as HTMLInputElement)?.value;
  check('React actually received the value (native setter path)', liveValue === 'Write tests', `value=${JSON.stringify(liveValue)}`);

  // ---- click -------------------------------------------------------------
  const clicked = parseActionResult(run(clickScript(addRef!)));
  check('click reports success', clicked.ok, clicked.message);
  await new Promise((r) => setTimeout(r, 50));
  check('click had a real effect (item was added)',
    !!document.body.textContent?.includes('Write tests'));

  const boxClicked = parseActionResult(run(clickScript(boxRef!)));
  check('clicking a checkbox toggles it', boxClicked.ok
    && (document.querySelector('input[type=checkbox]') as HTMLInputElement).checked);

  // ---- state flags show up on a re-snapshot ------------------------------
  const snap2 = parseSnapshot(run(snapshotScript()));
  check('re-snapshot shows the checkbox as checked',
    snap2.ok && /checkbox[^\n]*checked/.test(formatSnapshot(snap2.snapshot)));

  // ---- stale refs --------------------------------------------------------
  const stale = parseActionResult(run(clickScript('e9999')));
  check('an unknown ref is refused, not silently ignored',
    !stale.ok && /out of date/.test(stale.message), stale.message);

  // ---- eval --------------------------------------------------------------
  const evaluated = parseActionResult(run(evalScript('document.querySelector(".total").textContent')));
  check('eval returns page state', evaluated.ok && evaluated.message === '2 items', evaluated.message);

  const threw = parseActionResult(run(evalScript('nope.nope')));
  check('eval reports a thrown error instead of hanging', !threw.ok && /nope/.test(threw.message), threw.message);

  // ---- injection attempt -------------------------------------------------
  (window as any).__pwned = false;
  const injected = parseActionResult(run(clickScript('e1"); window.__pwned = true; //')));
  check('a ref crafted to inject code stays inert',
    !(window as any).__pwned && !injected.ok, injected.message);

  const out = document.createElement('pre');
  out.id = 'results';
  out.style.cssText = 'font:12px ui-monospace;padding:12px;background:#111;color:#eee;white-space:pre-wrap';
  const failed = results.filter((r) => r.startsWith('FAIL')).length;
  out.textContent = results.join('\n') + `\n\n${results.length - failed}/${results.length} checks passed`;
  document.body.appendChild(out);
}

ReactDOM.createRoot(document.getElementById('root')!).render(<TodoApp />);
setTimeout(verify, 300);
