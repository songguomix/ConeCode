import { type ReactNode } from 'react';

// Minimal, dependency-free syntax highlighter shared by the chat code blocks and
// the file editor. A hand-written scanner (no regex over the whole source) keeps
// it robust across languages and avoids escaping pitfalls. Tokens are emitted as
// <span class="syntax-*"> and colored by CSS variables (see index.css), so the
// palette tracks the active theme and reads like VS Code's default themes.

const KEYWORDS = new Set(
  ('const let var function return if else elif for while import from export class new await async ' +
   'try catch finally throw typeof instanceof switch case break continue default extends super this ' +
   'interface type enum namespace public private protected readonly static as satisfies keyof infer ' +
   'abstract implements def lambda and or not pass with yield struct impl match fn pub use ' +
   'mut trait where echo then fi do done esac in func package defer go chan map range print ' +
   'select_from where_clause begin end module require module.exports').split(' ')
);

// Language-independent constants/literals get their own (keyword-ish) color.
const CONSTANTS = new Set(['true', 'false', 'null', 'undefined', 'nan', 'none', 'nil', 'self']);

const HASH_LANGS = new Set(['bash', 'sh', 'shell', 'zsh', 'python', 'py', 'yaml', 'yml', 'toml', 'ruby', 'rb', 'makefile', 'dockerfile', 'ini', 'conf', 'r']);
const TICK = String.fromCharCode(96);

export function highlightCode(code: string, lang: string): ReactNode[] {
  try {
    const allowHash = HASH_LANGS.has((lang || '').toLowerCase());
    const out: ReactNode[] = [];
    let plain = '';
    let key = 0;
    const flush = () => { if (plain) { out.push(<span key={key++}>{plain}</span>); plain = ''; } };
    const push = (cls: string, text: string) => { flush(); out.push(<span key={key++} className={cls}>{text}</span>); };
    const isWord = (c: string) => /[A-Za-z0-9_$]/.test(c);
    let i = 0;
    const n = code.length;
    while (i < n) {
      const c = code[i];
      const c2 = code[i + 1];
      // line comment //
      if (c === '/' && c2 === '/') { let j = i; while (j < n && code[j] !== '\n') j++; push('syntax-comment', code.slice(i, j)); i = j; continue; }
      // hash comment (only in languages that use it, so we don't mis-color JS '#private' etc.)
      if (c === '#' && allowHash) { let j = i; while (j < n && code[j] !== '\n') j++; push('syntax-comment', code.slice(i, j)); i = j; continue; }
      // block comment /* */
      if (c === '/' && c2 === '*') { let j = i + 2; while (j < n && !(code[j] === '*' && code[j + 1] === '/')) j++; j = Math.min(j + 2, n); push('syntax-comment', code.slice(i, j)); i = j; continue; }
      // strings
      if (c === '"' || c === "'" || c === TICK) {
        let j = i + 1;
        while (j < n) { if (code[j] === '\\') { j += 2; continue; } if (code[j] === c) { j++; break; } j++; }
        // Property key? A string immediately followed by ':' (JSON keys, JS/TS
        // object keys) gets the distinct "property" color, like VS Code.
        let k = j; while (k < n && (code[k] === ' ' || code[k] === '\t')) k++;
        push(code[k] === ':' ? 'syntax-property' : 'syntax-string', code.slice(i, j));
        i = j; continue;
      }
      // numbers
      if (c >= '0' && c <= '9') { let j = i; while (j < n && /[0-9._a-fxA-FX]/.test(code[j])) j++; push('syntax-number', code.slice(i, j)); i = j; continue; }
      // identifiers / keywords / function calls / types
      if (/[A-Za-z_$]/.test(c)) {
        let j = i; while (j < n && isWord(code[j])) j++;
        const word = code.slice(i, j);
        if (KEYWORDS.has(word)) push('syntax-keyword', word);
        else if (CONSTANTS.has(word.toLowerCase())) push('syntax-constant', word);
        else {
          let k = j; while (k < n && code[k] === ' ') k++;
          if (code[k] === '(') push('syntax-function', word);     // call / definition
          else if (/^[A-Z]/.test(word)) push('syntax-type', word); // Class / Type / Component
          else plain += word;
        }
        i = j; continue;
      }
      plain += c; i++;
    }
    flush();
    return out;
  } catch {
    return [code];
  }
}
