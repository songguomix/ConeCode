// The phone-facing web app, served as one self-contained document (no build
// step, no deps) so it is always present inside the packaged main bundle. It
// mirrors the desktop ConeCode chat (Codex dark theme) but at mobile
// proportions: full-width bubbles, an off-canvas conversation drawer, a sticky
// approvals/todos strip, and a bottom composer with safe-area insets.
//
// IMPORTANT: this whole document is returned from a template literal, so the
// embedded JS/CSS must contain NO raw backtick characters. Triple-backtick code
// fences are detected at runtime via String.fromCharCode(96).

export function getMobileClientHtml(): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no, viewport-fit=cover">
<meta name="theme-color" content="#0d0d0d">
<title>ConeCode Remote</title>
<style>
  :root{
    --bg-0:#0d0d0d; --bg-1:#141414; --bg-2:#1b1b1b; --bg-3:#242424;
    --border:#2a2a2a; --text:#ececec; --muted:#8a8a8a; --faint:#5e5e5e;
    --accent:#10a37f; --accent-soft:rgba(16,163,127,.15);
    --ok:#10a37f; --no:#e05260;
    --mono:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;
  }
  *{box-sizing:border-box;-webkit-tap-highlight-color:transparent}
  html,body{margin:0;height:100%;background:var(--bg-0);color:var(--text);
    font:15px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;
    overscroll-behavior:none}
  #app{display:flex;flex-direction:column;height:100dvh}
  /* Header */
  #hdr{display:flex;align-items:center;gap:10px;padding:calc(env(safe-area-inset-top) + 10px) 14px 10px;
    background:var(--bg-0);border-bottom:1px solid var(--border);flex:none}
  #menuBtn{background:none;border:none;color:var(--text);font-size:22px;line-height:1;padding:4px 6px;cursor:pointer}
  #title{flex:1;font-weight:600;font-size:15px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  #model{font:12px/1 var(--mono);color:var(--muted);max-width:38%;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  #dot{width:9px;height:9px;border-radius:50%;background:var(--faint);flex:none;transition:background .3s}
  #dot.on{background:var(--accent);box-shadow:0 0 6px var(--accent)}
  /* Message list */
  #list{flex:1;overflow-y:auto;padding:14px 12px 8px;-webkit-overflow-scrolling:touch}
  .row{display:flex;margin-bottom:14px}
  .row.user{justify-content:flex-end}
  .bubble.user{background:var(--bg-3);border:1px solid var(--border);border-radius:16px 16px 4px 16px;
    padding:9px 13px;max-width:82%;word-break:break-word}
  .row.asst .msg{max-width:100%;width:100%;word-break:break-word}
  .empty{color:var(--muted);text-align:center;padding:40px 12px}
  .prose{white-space:normal}
  .prose code,.code{font-family:var(--mono);font-size:13px}
  .prose code{background:var(--bg-2);padding:1px 5px;border-radius:5px}
  pre.code{background:var(--bg-1);border:1px solid var(--border);border-radius:10px;
    padding:10px 12px;overflow-x:auto;margin:8px 0;white-space:pre}
  .tool{font-family:var(--mono);font-size:13px;color:var(--muted);margin:5px 0;
    display:flex;gap:7px;align-items:baseline}
  .tool-verb{color:var(--accent)}
  .tool-verb::before{content:"\\203A  ";color:var(--faint)}
  .tool-detail{color:var(--text);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  .thinking{color:var(--faint);font-style:italic;font-size:13px;margin-bottom:6px;white-space:pre-wrap}
  .cursor{display:inline-block;width:7px;height:15px;background:var(--accent);
    margin-left:2px;vertical-align:-2px;animation:blink 1s steps(2) infinite}
  @keyframes blink{50%{opacity:0}}
  /* Sticky panels (todos + approvals) */
  #panels{flex:none}
  #panels:empty{display:none}
  .todos{background:var(--bg-1);border-top:1px solid var(--border);padding:8px 14px;max-height:30vh;overflow-y:auto}
  .todo{font-size:13px;padding:2px 0;color:var(--muted);display:flex;gap:8px}
  .todo .tmark{color:var(--faint);width:14px;flex:none}
  .todo.s-completed{color:var(--faint);text-decoration:line-through}
  .todo.s-in_progress{color:var(--text)}
  .todo.s-in_progress .tmark{color:var(--accent)}
  .changes{background:var(--bg-1);border-top:1px solid var(--border);padding:10px 12px;max-height:42vh;overflow-y:auto}
  .chg-all{display:flex;gap:8px;margin-bottom:8px}
  .chg{background:var(--bg-2);border:1px solid var(--border);border-radius:10px;padding:9px 11px;margin-bottom:8px}
  .chg-h{display:flex;gap:8px;align-items:baseline;margin-bottom:8px;overflow:hidden}
  .chg-kind{font:11px/1 var(--mono);color:var(--accent);text-transform:uppercase;flex:none}
  .chg-name{font-family:var(--mono);font-size:13px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  .chg-btns{display:flex;gap:8px}
  .btn{flex:1;border:1px solid var(--border);background:var(--bg-3);color:var(--text);
    border-radius:9px;padding:9px;font-size:14px;font-weight:600;cursor:pointer}
  .btn.ok{background:var(--accent-soft);border-color:var(--accent);color:var(--accent)}
  .btn.no{color:var(--no)}
  .btn:active{opacity:.7}
  /* Composer */
  #composer{flex:none;display:flex;gap:8px;align-items:flex-end;padding:10px 12px;
    padding-bottom:calc(env(safe-area-inset-bottom) + 10px);
    background:var(--bg-0);border-top:1px solid var(--border)}
  #ta{flex:1;resize:none;max-height:120px;background:var(--bg-2);color:var(--text);
    border:1px solid var(--border);border-radius:18px;padding:10px 14px;font-size:16px;
    line-height:1.4;outline:none}
  #ta:focus{border-color:var(--accent)}
  #sendBtn{flex:none;width:44px;height:44px;border-radius:50%;border:none;background:var(--accent);
    color:#fff;font-size:20px;cursor:pointer;display:flex;align-items:center;justify-content:center}
  #sendBtn.stop{background:var(--no)}
  #sendBtn:disabled{opacity:.4}
  /* Drawer */
  #scrim{position:fixed;inset:0;background:rgba(0,0,0,.5);opacity:0;pointer-events:none;
    transition:opacity .2s;z-index:20}
  #scrim.open{opacity:1;pointer-events:auto}
  #drawer{position:fixed;top:0;left:0;bottom:0;width:78%;max-width:320px;z-index:21;
    background:var(--bg-1);border-right:1px solid var(--border);transform:translateX(-100%);
    transition:transform .22s ease;overflow-y:auto;
    padding:calc(env(safe-area-inset-top) + 14px) 12px 14px}
  #drawer.open{transform:translateX(0)}
  .drawer-h{display:flex;align-items:center;justify-content:space-between;
    font-weight:600;margin-bottom:10px;padding:0 6px}
  .drawer-h .btn{flex:none;padding:6px 12px;font-size:13px}
  .conv{padding:11px 12px;border-radius:10px;color:var(--muted);font-size:14px;cursor:pointer;
    white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  .conv.active{background:var(--bg-3);color:var(--text)}
</style>
</head>
<body>
<div id="app">
  <header id="hdr">
    <button id="menuBtn" onclick="toggleDrawer(true)">&#9776;</button>
    <div id="title">ConeCode</div>
    <div id="model"></div>
    <button id="lockBtn" onclick="setPass()" title="Password"
      style="background:none;border:none;color:var(--muted);font-size:15px;padding:4px 6px;cursor:pointer">&#128274;</button>
    <span id="dot"></span>
  </header>
  <main id="list"><div class="empty">Connecting&hellip;</div></main>
  <div id="panels"></div>
  <footer id="composer">
    <textarea id="ta" rows="1" placeholder="Message ConeCode&hellip;"></textarea>
    <button id="sendBtn" onclick="onSend()">&#8593;</button>
  </footer>
</div>
<div id="scrim" onclick="toggleDrawer(false)"></div>
<nav id="drawer"></nav>
<script>
(function(){
  var BT = String.fromCharCode(96);
  var FENCE = BT + BT + BT;
  var token = new URLSearchParams(location.search).get('t') || '';
  var pass = sessionStorage.getItem('cc_pass') || '';
  var state = null;
  var es = null;

  // Token (from the QR) plus the optional password (entered here, not in the QR).
  function authQS(){
    return '?t=' + encodeURIComponent(token) + (pass ? '&p=' + encodeURIComponent(pass) : '');
  }

  var listEl = document.getElementById('list');
  var panelsEl = document.getElementById('panels');
  var titleEl = document.getElementById('title');
  var modelEl = document.getElementById('model');
  var dotEl = document.getElementById('dot');
  var drawerEl = document.getElementById('drawer');
  var scrimEl = document.getElementById('scrim');
  var taEl = document.getElementById('ta');
  var sendEl = document.getElementById('sendBtn');

  var VERB = {
    read_file:'Read', list_dir:'List', search:'Search', glob:'Glob',
    edit_file:'Edit', create_file:'Create', create_dir:'Make dir', delete:'Delete',
    rename:'Rename', copy:'Copy', exec:'Run', open_app:'Open app', open_path:'Open',
    system_info:'System', web_fetch:'Fetch', web_search:'Web search', mcp_call:'MCP',
    update_todos:'Plan', ask_user:'Question', spawn_agent:'Sub-agent', git_status:'Git status', git_diff:'Git diff'
  };

  function esc(s){
    return String(s == null ? '' : s)
      .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')
      .replace(/"/g,'&quot;').replace(/'/g,'&#39;');
  }
  function trunc(s,n){ s = String(s||''); return s.length > n ? s.slice(0,n) + '\\u2026' : s; }
  function fileName(p){ p = String(p||''); var i = p.lastIndexOf('/'); return i >= 0 ? p.slice(i+1) : p; }

  function setDot(on){ dotEl.className = on ? 'on' : ''; }

  function connect(){
    if (es) es.close();
    es = new EventSource('/events' + authQS());
    es.onmessage = function(e){
      setDot(true);
      try { var frame = JSON.parse(e.data); if (frame.type === 'state') { state = frame.snapshot; render(); } } catch(_){}
    };
    es.onerror = function(){ setDot(false); };
  }

  function cmd(obj){
    fetch('/cmd' + authQS(), {
      method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify(obj)
    }).catch(function(){});
  }

  // ---- content rendering ----
  function splitFences(text){
    var out = [], idx = 0;
    while (true){
      var start = text.indexOf(FENCE, idx);
      if (start === -1){ out.push({text:text.slice(idx)}); break; }
      if (start > idx) out.push({text:text.slice(idx,start)});
      var afterStart = start + 3;
      var nl = text.indexOf('\\n', afterStart);
      var lang = (nl === -1 ? text.slice(afterStart) : text.slice(afterStart,nl)).trim();
      var bodyStart = nl === -1 ? text.length : nl + 1;
      var end = text.indexOf(FENCE, bodyStart);
      if (end === -1){ out.push({fence:true,lang:lang,code:text.slice(bodyStart)}); break; }
      out.push({fence:true,lang:lang,code:text.slice(bodyStart,end)});
      idx = end + 3;
    }
    return out;
  }
  function toolCard(lang, code){
    if ((lang||'').toLowerCase() !== 'json') return null;
    var obj; try { obj = JSON.parse(code.trim()); } catch(_){ return null; }
    if (!obj || !obj.action) return null;
    var verb = VERB[obj.action] || obj.action;
    var detail = obj.path || obj.command || obj.query || obj.url || obj.pattern || obj.name || '';
    return '<div class="tool"><span class="tool-verb">' + esc(verb) + '</span><span class="tool-detail">' + esc(String(detail)) + '</span></div>';
  }
  function renderProse(text){
    if (!text || !text.trim()) return '';
    var h = esc(text);
    h = h.replace(/\\*\\*([^*]+)\\*\\*/g, '<b>$1</b>');
    var codeRe = new RegExp(BT + '([^' + BT + ']+)' + BT, 'g');
    h = h.replace(codeRe, '<code>$1</code>');
    h = h.replace(/\\n/g, '<br>');
    return '<div class="prose">' + h + '</div>';
  }
  function nativeToolRows(calls){
    if (!calls || !calls.length) return '';
    var out = '';
    for (var i=0;i<calls.length;i++){
      var name = calls[i].name || '';
      var verb = VERB[name] || (name.indexOf('mcp__') === 0 ? 'MCP' : name);
      out += '<div class="tool"><span class="tool-verb">' + esc(verb) + '</span></div>';
    }
    return out;
  }
  function renderContent(text){
    if (!text) return '';
    var parts = splitFences(text), html = '';
    for (var i=0;i<parts.length;i++){
      var p = parts[i];
      if (p.fence){ var card = toolCard(p.lang, p.code); html += card ? card : '<pre class="code">' + esc(p.code) + '</pre>'; }
      else html += renderProse(p.text);
    }
    return html;
  }

  function messagesHtml(){
    var msgs = (state.messages || []).filter(function(m){ return !m.isLocalNotice && !m.isToolResult; });
    var html = '';
    for (var i=0;i<msgs.length;i++){
      var m = msgs[i];
      if (m.role === 'user') html += '<div class="row user"><div class="bubble user">' + renderProse(m.content) + '</div></div>';
      else {
        // Native tool calls carry no text, so render their names as tool rows —
        // otherwise a tool-only turn shows up as an empty bubble.
        var body = renderContent(m.content) + nativeToolRows(m.toolCalls);
        if (body) html += '<div class="row asst"><div class="msg">' + body + '</div></div>';
      }
    }
    if (state.isStreaming){
      var s = '';
      if (state.streamingStatus === 'thinking' && state.streamingReasoningContent)
        s += '<div class="thinking">' + esc(trunc(state.streamingReasoningContent, 700)) + '</div>';
      s += renderContent(state.streamingContent || '');
      if (!state.streamingContent && state.streamingToolName)
        s += '<div class="tool"><span class="tool-verb">' + esc(VERB[state.streamingToolName] || state.streamingToolName) + '</span></div>';
      s += '<span class="cursor"></span>';
      html += '<div class="row asst"><div class="msg">' + s + '</div></div>';
    }
    return html || '<div class="empty">No messages yet.</div>';
  }

  function panelsHtml(){
    var html = '';
    var todos = state.todos || [];
    if (todos.length){
      html += '<div class="todos">';
      for (var i=0;i<todos.length;i++){
        var t = todos[i];
        var mark = t.status === 'completed' ? '\\u2713' : (t.status === 'in_progress' ? '\\u25D0' : '\\u25CB');
        html += '<div class="todo s-' + esc(t.status) + '"><span class="tmark">' + mark + '</span>' + esc(t.content) + '</div>';
      }
      html += '</div>';
    }
    var pending = (state.changes || []).filter(function(c){ return c.status === 'pending'; });
    var bulk = pending.filter(function(c){ return c.kind !== 'exec'; });
    if (pending.length){
      html += '<div class="changes">';
      if (bulk.length > 1)
        html += '<div class="chg-all"><button class="btn ok" onclick="approveAll()">Approve files (' + bulk.length + ')</button><button class="btn no" onclick="rejectAll()">Reject files</button></div>';
      for (var j=0;j<pending.length;j++){
        var c = pending[j];
        var label = c.filePath === '[Command]' ? c.newCode : fileName(c.filePath);
        var kind = c.kind === 'exec' ? 'Run' : (c.kind || 'edit');
        html += '<div class="chg"><div class="chg-h"><span class="chg-kind">' + esc(kind) + '</span><span class="chg-name">' + esc(String(label)) + '</span></div>'
              + '<div class="chg-btns"><button class="btn ok" onclick="approve(\\'' + c.id + '\\')">Approve</button>'
              + '<button class="btn no" onclick="reject(\\'' + c.id + '\\')">Reject</button></div></div>';
      }
      html += '</div>';
    }
    return html;
  }

  function drawerHtml(){
    var convs = state.conversations || [];
    var html = '<div class="drawer-h"><span>Chats</span><button class="btn ok" onclick="newChat()">+ New</button></div>';
    for (var i=0;i<convs.length;i++){
      var c = convs[i];
      var active = c.id === state.activeConversationId ? ' active' : '';
      html += '<div class="conv' + active + '" onclick="switchConv(\\'' + c.id + '\\')">' + esc(c.title || 'New chat') + '</div>';
    }
    return html;
  }

  function render(){
    if (!state){ return; }
    var conv = (state.conversations || []).filter(function(c){ return c.id === state.activeConversationId; })[0];
    titleEl.textContent = conv ? (conv.title || 'New chat') : 'ConeCode';
    modelEl.textContent = state.model ? state.model.name : '';
    sendEl.className = state.isStreaming ? 'stop' : '';
    sendEl.innerHTML = state.isStreaming ? '&#9632;' : '&#8593;';

    var nearBottom = listEl.scrollHeight - listEl.scrollTop - listEl.clientHeight < 120;
    listEl.innerHTML = messagesHtml();
    panelsEl.innerHTML = panelsHtml();
    drawerEl.innerHTML = drawerHtml();
    if (nearBottom) listEl.scrollTop = listEl.scrollHeight;
  }

  // ---- actions (exposed for inline handlers) ----
  window.toggleDrawer = function(open){
    drawerEl.className = open ? 'open' : '';
    scrimEl.className = open ? 'open' : '';
  };
  window.setPass = function(){
    var v = prompt('Password');
    if (v !== null){ pass = v; try { sessionStorage.setItem('cc_pass', v); } catch(_){} connect(); }
  };
  window.switchConv = function(id){ cmd({type:'switchConversation', id:id}); window.toggleDrawer(false); };
  window.newChat = function(){ cmd({type:'newConversation'}); window.toggleDrawer(false); };
  window.approve = function(id){ cmd({type:'approve', id:id}); };
  window.reject = function(id){ cmd({type:'reject', id:id}); };
  window.approveAll = function(){ cmd({type:'approveAll'}); };
  window.rejectAll = function(){ cmd({type:'rejectAll'}); };
  window.onSend = function(){
    if (state && state.isStreaming){ cmd({type:'stop'}); return; }
    var text = taEl.value.trim();
    if (!text) return;
    cmd({type:'send', text:text});
    taEl.value = '';
    taEl.style.height = 'auto';
  };

  taEl.addEventListener('input', function(){
    taEl.style.height = 'auto';
    taEl.style.height = Math.min(taEl.scrollHeight, 120) + 'px';
  });

  connect();
})();
</script>
</body>
</html>`;
}
