// ==UserScript==
// @name         Perguntar — Gemini Gems & Gemini Notebook
// @namespace    local.ricardo.gemini-quick-search
// @version      3.0.0
// @description  Alt+G: escolha um Gem ou Notebook, digite a pergunta, Enter. O script abre o alvo, preenche o campo e envia. Seletores verificados no DOM real (ago/2026).
// @author       Ricardo
// @match        https://gemini.google.com/*
// @match        https://notebook.google.com/*
// @match        https://notebooklm.google.com/*
// @match        *://*/*
// @run-at       document-idle
// @grant        GM_registerMenuCommand
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_openInTab
// @noframes
// ==/UserScript==

/*
 * FLUXO (Alt+G em qualquer site):
 *   1. digite para filtrar seus Gems e Notebooks; Enter escolhe
 *   2. digite a pergunta; Enter envia (Backspace vazio volta; Esc fecha)
 * Em site de terceiros o alvo abre em aba nova; nos sites do Google, na própria aba.
 *
 * SELETORES VERIFICADOS por inspeção direta (Marionette, 15/08/2026):
 *   Notebook  campo:  query-box textarea            (aria-label "Caixa de consulta")
 *             CUIDADO: existe outro textarea parecido dentro de
 *             source-discovery-query-box ("Pesquise novas fontes na web") — não usar.
 *             envio:  query-box button[type="submit"] (aria-label "Enviar";
 *                     fica disabled até o campo ter texto)
 *             escrita: setter nativo de value + InputEvent('input')  [testado ok]
 *   Gem       campo:  rich-textarea div[contenteditable="true"]
 *             envio:  button[aria-label≈enviar/send] ("Enviar mensagem")
 *             escrita: document.execCommand('insertText')  [testado ok]
 *   Listas    gems:      a[href^=".../gem/{id}"] dentro de bot-list-row (/gems/view)
 *             notebooks: project-button > a[href=".../notebook/{uuid}"]
 *   A indexação aceita SÓ URLs nesses formatos exatos — links de conversas
 *   (/gem/{id}/{conversa}) e texto solto ficam de fora (era a origem do lixo).
 *
 * Trusted Types: nada de innerHTML — DOM só via createElement/textContent.
 * CSP: os @grant mantêm o script no sandbox da extensão (com @grant none seria
 * injetado na página e bloqueado).
 */

(function () {
  'use strict';

  // ------------------------------------------------------------------ utilidades

  const el = (tag, props) => Object.assign(document.createElement(tag), props || {});
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const COMBINING = new RegExp('[\\u0300-\\u036f]', 'g');
  const norm = (s) => (s || '').normalize('NFD').replace(COMBINING, '').toLowerCase();
  const collapse = (s) => (s || '').replace(/\s+/g, ' ').trim();
  const LOG = (...a) => console.log('[Perguntar]', ...a);

  const visible = (n) => !!(n && n.offsetWidth && n.offsetHeight);

  async function waitFor(fn, timeout, step) {
    const deadline = Date.now() + (timeout || 20000);
    while (Date.now() < deadline) {
      let v;
      try { v = fn(); } catch (_) { v = null; }
      if (v) return v;
      await sleep(step || 250);
    }
    return null;
  }

  function score(query, text) {
    const q = norm(query).trim();
    if (!q) return 0;
    const t = norm(text);
    let total = 0;
    for (const term of q.split(/\s+/)) {
      const i = t.indexOf(term);
      if (i >= 0) { total += 1000 - Math.min(i, 200); continue; }
      // subsequência: "rvdec" acha "Revisão de decisões"
      let pos = 0, last = -1, gaps = 0, ok = true;
      for (const ch of term) {
        const f = t.indexOf(ch, pos);
        if (f < 0) { ok = false; break; }
        if (last >= 0) gaps += f - last - 1;
        last = f; pos = f + 1;
      }
      if (!ok) return -1;
      total += Math.max(50, 400 - gaps);
    }
    return total - t.length * 0.001;
  }

  function highlight(text, query) {
    const frag = document.createDocumentFragment();
    const term = (query || '').trim().split(/\s+/)[0];
    const i = term ? norm(text).indexOf(norm(term)) : -1;
    if (i < 0) { frag.appendChild(document.createTextNode(text)); return frag; }
    frag.appendChild(document.createTextNode(text.slice(0, i)));
    frag.appendChild(el('mark', { textContent: text.slice(i, i + term.length) }));
    frag.appendChild(document.createTextNode(text.slice(i + term.length)));
    return frag;
  }

  // --------------------------------------------------------------- armazenamento

  const store = {
    get(key, fallback) {
      try {
        const raw = GM_getValue(key, null);
        if (raw == null) return fallback;
        return typeof raw === 'string' ? JSON.parse(raw) : raw;
      } catch (_) { return fallback; }
    },
    set(key, value) {
      try { GM_setValue(key, JSON.stringify(value)); } catch (_) { /* ignora */ }
    },
  };

  // --------------------------------------------------------------------- atalho

  let hotkey = store.get('hotkey', { key: 'g', alt: true, ctrl: false, shift: false, meta: false });
  const hotkeyLabel = (h) => [h.ctrl && 'Ctrl', h.alt && 'Alt', h.shift && 'Shift', h.meta && 'Meta',
    (h.key || '').toUpperCase()].filter(Boolean).join('+');
  const matchesHotkey = (e, h) =>
    (e.key || '').toLowerCase() === h.key && e.altKey === !!h.alt &&
    e.ctrlKey === !!h.ctrl && e.shiftKey === !!h.shift && e.metaKey === !!h.meta;

  // ----------------------------------------------------------------------- site

  const HOST = location.hostname;
  const IS_GEMINI = HOST === 'gemini.google.com';
  const IS_NOTEBOOK = HOST === 'notebook.google.com' || HOST === 'notebooklm.google.com';
  const ON_APP = IS_GEMINI || IS_NOTEBOOK;

  const GEM_URL = /^https:\/\/gemini\.google\.com\/gem\/[A-Za-z0-9_-]+$/;
  const NOTEBOOK_URL = /^https:\/\/(notebook|notebooklm)\.google\.com\/notebook\/[A-Za-z0-9-]+$/;

  const onGemPage = () => IS_GEMINI && /^\/gem\/[^/]+/.test(location.pathname);
  const onNotebookPage = () => IS_NOTEBOOK && /^\/notebook\/[^/]+/.test(location.pathname);

  // --------------------------------------------------------------------- índice

  const JUNK_LINE = /^(more_vert|person|drag_indicator|keep|push_pin|experimento|experiment|novo|new)$/i;
  const isJunkLine = (s) => !s || s.length < 2 || JUNK_LINE.test(s) || /^[^A-Za-zÀ-ÿ0-9]+$/.test(s);

  function titleFromLines(text) {
    const lines = (text || '').split(/\s*\n\s*/).map(collapse).filter((l) => !isJunkLine(l));
    return { title: (lines[0] || '').slice(0, 120), subtitle: lines.slice(1).join(' · ').slice(0, 140) };
  }

  const validEntry = (e) =>
    e && e.title && e.title.length >= 2 && e.title.length <= 120 &&
    !/[{};]|cls-|stroke|var\(/.test(e.title) &&
    (e.kind === 'gem' ? GEM_URL.test(e.url) : NOTEBOOK_URL.test(e.url));

  function loadIndex() {
    const idx = store.get('targets', {});
    const clean = {};
    let dropped = 0;
    for (const [k, v] of Object.entries(idx)) {
      if (validEntry(v)) clean[k] = v;
      else dropped++;
    }
    if (dropped) {
      store.set('targets', clean);
      LOG('limpeza do índice: removidas', dropped, 'entradas inválidas');
    }
    return clean;
  }

  const targetsList = () =>
    Object.values(loadIndex()).sort((a, b) => (b.seen || 0) - (a.seen || 0));

  function mergeTargets(entries) {
    const idx = loadIndex();
    let added = 0;
    for (const e of entries) {
      if (!validEntry(e)) continue;
      if (!idx[e.url]) added++;
      idx[e.url] = Object.assign({}, idx[e.url], e, { seen: Date.now() });
    }
    if (entries.length) store.set('targets', idx);
    return added;
  }

  /** Coleta apenas das fontes confiáveis; formatos verificados no DOM real. */
  function collectTargets() {
    const out = [];
    if (IS_GEMINI) {
      for (const a of document.querySelectorAll('a[href*="/gem/"]')) {
        const url = (a.href || '').split('?')[0];
        if (!GEM_URL.test(url)) continue; // exclui /gem/{id}/{conversa}
        const { title, subtitle } = titleFromLines(a.innerText);
        out.push({ kind: 'gem', url, title, subtitle });
      }
    }
    if (IS_NOTEBOOK) {
      for (const a of document.querySelectorAll('a[href*="/notebook/"]')) {
        const url = (a.href || '').split('?')[0];
        if (!NOTEBOOK_URL.test(url)) continue;
        // o título fica no project-button pai, não no <a>
        const row = a.closest('project-button') || a;
        const { title, subtitle } = titleFromLines(row.innerText);
        out.push({ kind: 'notebook', url, title, subtitle });
      }
    }
    return out;
  }

  function autoIndex() {
    const added = mergeTargets(collectTargets());
    if (added) LOG('índice: +' + added, '(total', targetsList().length + ')');
    return added;
  }

  // ------------------------------------------------- escrever e enviar (por site)

  function findComposerHere() {
    if (onNotebookPage()) {
      const n = document.querySelector('query-box textarea');
      return n && visible(n) ? { node: n, site: 'notebook' } : null;
    }
    if (onGemPage()) {
      const n = document.querySelector('rich-textarea div[contenteditable="true"]');
      return n && visible(n) ? { node: n, site: 'gem' } : null;
    }
    return null;
  }

  function fillNotebook(node, text) {
    node.focus();
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set;
    setter.call(node, text);
    node.dispatchEvent(new InputEvent('input', { bubbles: true, data: text, inputType: 'insertText' }));
    return node.value.indexOf(text.slice(0, 15)) >= 0;
  }

  function fillGem(node, text) {
    node.focus();
    const range = document.createRange();
    range.selectNodeContents(node);
    const sel = getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
    document.execCommand('insertText', false, text);
    if (collapse(node.textContent).indexOf(text.slice(0, 15)) >= 0) return true;
    // reserva: colagem sintética (componentes tratam paste explicitamente)
    const dt = new DataTransfer();
    dt.setData('text/plain', text);
    node.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
    return collapse(node.textContent).indexOf(text.slice(0, 15)) >= 0;
  }

  function findSendButton(site) {
    if (site === 'notebook') {
      const b = document.querySelector('query-box button[type="submit"]');
      return b && visible(b) && !b.disabled ? b : null;
    }
    for (const b of document.querySelectorAll('button[aria-label]')) {
      if (!visible(b) || b.disabled) continue;
      if (b.getAttribute('aria-disabled') === 'true') continue;
      if (/enviar|send/i.test(b.getAttribute('aria-label'))) return b;
    }
    return null;
  }

  async function askHere(prompt) {
    const found = await waitFor(findComposerHere, 25000, 300);
    if (!found) { toast('Não achei o campo de pergunta nesta página.'); return false; }
    await sleep(400);
    const ok = found.site === 'notebook'
      ? fillNotebook(found.node, prompt)
      : fillGem(found.node, prompt);
    if (!ok) { toast('Não consegui escrever no campo — veja o console.'); LOG('preenchimento falhou', found); return false; }
    const btn = await waitFor(() => findSendButton(found.site), 8000, 200);
    if (btn) { btn.click(); return true; }
    LOG('sem botão de envio habilitado; usando Enter');
    const opts = { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true };
    found.node.dispatchEvent(new KeyboardEvent('keydown', opts));
    found.node.dispatchEvent(new KeyboardEvent('keyup', opts));
    return true;
  }

  // ------------------------------------------------------------- pedido pendente

  const PENDING_TTL = 4 * 60 * 1000;

  function getPending() {
    const p = store.get('pending', null);
    if (!p) return null;
    if (Date.now() - (p.ts || 0) > PENDING_TTL) { store.set('pending', null); return null; }
    return p;
  }

  function launch(target, prompt) {
    store.set('pending', { url: target.url, title: target.title, prompt, ts: Date.now() });
    if (!ON_APP) {
      try { GM_openInTab(target.url, { active: true, insert: true }); }
      catch (_) { window.open(target.url, '_blank'); }
      toast('Abrindo "' + target.title + '" em nova aba…');
      return;
    }
    if (location.href.split('?')[0] === target.url) { tick(); return; }
    location.href = target.url;
  }

  let ticking = false;
  async function tick() {
    if (ticking || !ON_APP) return;
    const p = getPending();
    if (!p) return;
    if (location.href.split('?')[0] !== p.url) return; // ainda navegando
    ticking = true;
    store.set('pending', null);
    try {
      toast('Perguntando em: ' + p.title);
      await askHere(p.prompt);
    } finally { ticking = false; }
  }

  // ------------------------------------------------------------------------- UI

  const CSS_TEXT = `
    :host { all: initial; display: block; }
    .backdrop {
      position: fixed; inset: 0; z-index: 2147483647;
      background: rgba(15,17,21,.55); backdrop-filter: blur(2px);
      display: none; align-items: flex-start; justify-content: center;
      font-family: system-ui, "Segoe UI", Roboto, sans-serif;
    }
    .backdrop.on { display: flex; }
    .panel {
      margin-top: 14vh; width: min(640px, 94vw);
      background: #1e1f22; color: #e8eaed; border: 1px solid #3c4043;
      border-radius: 14px; box-shadow: 0 18px 60px rgba(0,0,0,.5);
      overflow: hidden;
    }
    @media (prefers-color-scheme: light) {
      .panel { background: #fff; color: #1f1f1f; border-color: #dadce0; }
      .row.sel { background: #e8f0fe; }
      .sub, .hint, .kind { color: #5f6368; }
      input { color: #1f1f1f; }
    }
    .head { display: flex; align-items: center; gap: 8px; padding: 4px 14px; }
    .chip {
      flex: none; font-size: 12px; padding: 5px 10px; border-radius: 999px;
      background: #8ab4f8; color: #202124; max-width: 45%;
      white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
    }
    .chip.off { display: none; }
    input {
      border: 0; outline: 0; background: transparent; color: #e8eaed;
      font-size: 17px; padding: 14px 4px; flex: 1; min-width: 0;
    }
    .list { max-height: 46vh; overflow-y: auto; border-top: 1px solid #3c4043; }
    .row {
      padding: 10px 18px; cursor: pointer; border-left: 3px solid transparent;
      display: flex; gap: 10px; align-items: baseline;
    }
    .row.sel { background: #2d2f34; border-left-color: #8ab4f8; }
    .main { min-width: 0; flex: 1; }
    .title { font-size: 14px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .sub { font-size: 12px; color: #9aa0a6; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .kind { flex: none; font-size: 10px; color: #9aa0a6; letter-spacing: .8px; }
    mark { background: #ffd54f; color: #202124; border-radius: 2px; }
    .hint { padding: 8px 14px; font-size: 12px; color: #9aa0a6; border-top: 1px solid #3c4043; }
    .empty { padding: 20px 18px; font-size: 13px; color: #9aa0a6; line-height: 1.5; }
    .toast {
      position: fixed; left: 50%; bottom: 24px; transform: translateX(-50%);
      z-index: 2147483647; background: #202124; color: #e8eaed;
      border: 1px solid #5f6368; border-radius: 8px; padding: 10px 16px;
      font: 13px system-ui, sans-serif; box-shadow: 0 8px 24px rgba(0,0,0,.4);
    }
  `;

  let ui = null;
  const state = { stage: 'target', target: null, items: [], filtered: [], sel: 0, capture: false };

  function buildUI() {
    const host = el('div');
    const shadow = host.attachShadow({ mode: 'open' });
    shadow.appendChild(el('style', { textContent: CSS_TEXT }));
    const backdrop = el('div', { className: 'backdrop' });
    const panel = el('div', { className: 'panel' });
    const head = el('div', { className: 'head' });
    const chip = el('div', { className: 'chip off' });
    const input = el('input', { type: 'text', spellcheck: false });
    const list = el('div', { className: 'list' });
    const hint = el('div', { className: 'hint' });
    head.append(chip, input);
    panel.append(head, list, hint);
    backdrop.appendChild(panel);
    shadow.appendChild(backdrop);
    document.documentElement.appendChild(host);

    backdrop.addEventListener('mousedown', (e) => { if (e.target === backdrop) close(); });
    input.addEventListener('input', render);
    input.addEventListener('keydown', onKey);

    ui = { host, shadow, backdrop, chip, input, list, hint };
  }

  function toast(text) {
    if (!ui) buildUI();
    const t = el('div', { className: 'toast', textContent: text });
    ui.shadow.appendChild(t);
    setTimeout(() => t.remove(), 4000);
  }

  const isOpen = () => ui && ui.backdrop.classList.contains('on');

  function open() {
    if (!ui) buildUI();
    if (ON_APP) autoIndex();
    state.stage = 'target';
    state.target = null;
    state.sel = 0;
    state.items = targetsList();
    ui.input.value = '';
    ui.backdrop.classList.add('on');
    render();
    setTimeout(() => ui.input.focus(), 0);
  }

  function close() {
    if (ui) ui.backdrop.classList.remove('on');
    state.capture = false;
  }

  function render() {
    const q = ui.input.value;
    ui.chip.classList.toggle('off', !state.target);
    if (state.target) ui.chip.textContent = state.target.title;

    while (ui.list.firstChild) ui.list.removeChild(ui.list.firstChild);

    if (state.stage === 'prompt') {
      ui.input.placeholder = 'Digite a pergunta e Enter…';
      ui.hint.textContent = 'Enter envia · Backspace (vazio) troca o alvo · Esc fecha';
      state.filtered = [];
      return;
    }

    ui.input.placeholder = 'Escolha um Gem ou Notebook…';
    ui.hint.textContent = '↑↓ navega · Enter escolhe · Esc fecha';

    const scored = [];
    for (const it of state.items) {
      const s = score(q, it.title + ' ' + (it.subtitle || ''));
      if (s >= 0) scored.push({ it, s });
    }
    scored.sort((a, b) => b.s - a.s);
    state.filtered = scored.slice(0, 100).map((x) => x.it);
    if (state.sel >= state.filtered.length) state.sel = 0;

    if (!state.filtered.length) {
      ui.list.appendChild(el('div', {
        className: 'empty',
        textContent: state.items.length
          ? 'Nada corresponde à busca.'
          : 'Índice vazio. Abra uma vez gemini.google.com/gems/view e notebook.google.com — os alvos são indexados automaticamente.',
      }));
      return;
    }

    state.filtered.forEach((it, i) => {
      const row = el('div', { className: 'row' + (i === state.sel ? ' sel' : '') });
      const main = el('div', { className: 'main' });
      const title = el('div', { className: 'title' });
      title.appendChild(highlight(it.title, q));
      main.appendChild(title);
      if (it.subtitle) main.appendChild(el('div', { className: 'sub', textContent: it.subtitle }));
      row.append(main, el('div', { className: 'kind', textContent: it.kind === 'gem' ? 'GEM' : 'NOTEBOOK' }));
      row.addEventListener('click', () => choose(i));
      row.addEventListener('mousemove', () => {
        if (state.sel === i) return;
        state.sel = i;
        for (const r of ui.list.children) r.classList.remove('sel');
        row.classList.add('sel');
      });
      ui.list.appendChild(row);
    });
  }

  function move(delta) {
    if (!state.filtered.length) return;
    state.sel = (state.sel + delta + state.filtered.length) % state.filtered.length;
    const rows = ui.list.querySelectorAll('.row');
    rows.forEach((r, i) => r.classList.toggle('sel', i === state.sel));
    if (rows[state.sel]) rows[state.sel].scrollIntoView({ block: 'nearest' });
  }

  function choose(index) {
    if (state.stage === 'prompt') {
      const prompt = ui.input.value.trim();
      if (!prompt) return;
      const target = state.target;
      close();
      launch(target, prompt);
      return;
    }
    const it = state.filtered[typeof index === 'number' ? index : state.sel];
    if (!it) return;
    state.target = it;
    state.stage = 'prompt';
    ui.input.value = '';
    render();
    ui.input.focus();
  }

  function onKey(e) {
    if (state.capture) return;
    if (e.key === 'Escape') { e.preventDefault(); close(); return; }
    if (e.key === 'Enter') { e.preventDefault(); choose(); return; }
    if (state.stage === 'prompt') {
      if (e.key === 'Backspace' && !ui.input.value) {
        e.preventDefault();
        state.stage = 'target';
        state.target = null;
        render();
      }
      return;
    }
    if (e.key === 'ArrowDown') { e.preventDefault(); move(1); }
    if (e.key === 'ArrowUp') { e.preventDefault(); move(-1); }
  }

  // ------------------------------------------------------------ troca de atalho

  function startHotkeyCapture() {
    if (!ui) buildUI();
    ui.backdrop.classList.add('on');
    state.capture = true;
    ui.input.value = '';
    ui.input.placeholder = 'Pressione a nova combinação (com Ctrl, Alt ou Shift)…';
    while (ui.list.firstChild) ui.list.removeChild(ui.list.firstChild);
    ui.hint.textContent = 'Atual: ' + hotkeyLabel(hotkey) + ' · Esc cancela · evite Ctrl+K / Ctrl+Shift+K / Ctrl+Shift+P';
    ui.input.focus();
    const handler = (e) => {
      if (e.key === 'Escape') { e.preventDefault(); cleanup(); close(); return; }
      if (['Control', 'Alt', 'Shift', 'Meta'].includes(e.key)) return;
      if (!e.ctrlKey && !e.altKey && !e.metaKey) return;
      e.preventDefault();
      hotkey = { key: (e.key || '').toLowerCase(), alt: e.altKey, ctrl: e.ctrlKey, shift: e.shiftKey, meta: e.metaKey };
      store.set('hotkey', hotkey);
      ui.hint.textContent = 'Novo atalho: ' + hotkeyLabel(hotkey);
      cleanup();
      setTimeout(close, 900);
    };
    const cleanup = () => {
      state.capture = false;
      ui.input.removeEventListener('keydown', handler, true);
    };
    ui.input.addEventListener('keydown', handler, true);
  }

  // -------------------------------------------------------------------- ligação

  document.addEventListener('keydown', (e) => {
    if (state.capture) return;
    if (!matchesHotkey(e, hotkey)) return;
    e.preventDefault();
    e.stopPropagation();
    isOpen() ? close() : open();
  }, true);

  if (ON_APP) {
    let lastHref = location.href;
    const onRoute = () => {
      if (location.href === lastHref) return;
      lastHref = location.href;
      setTimeout(() => { autoIndex(); tick(); }, 900);
    };
    for (const m of ['pushState', 'replaceState']) {
      const orig = history[m];
      history[m] = function () {
        const r = orig.apply(this, arguments);
        setTimeout(onRoute, 0);
        return r;
      };
    }
    window.addEventListener('popstate', () => setTimeout(onRoute, 0));

    setTimeout(async () => {
      autoIndex();
      // ?prompt= / ?q= : pergunta direto na página atual (palavra-chave do Firefox)
      const params = new URLSearchParams(location.search);
      const urlPrompt = params.get('prompt') || params.get('q');
      if (urlPrompt) {
        history.replaceState(history.state, '', location.origin + location.pathname);
        await askHere(urlPrompt);
        return;
      }
      tick();
    }, 1200);

    // listas carregam com atraso; reindexa mais duas vezes por garantia
    setTimeout(autoIndex, 4000);
    setTimeout(autoIndex, 10000);
  }

  try {
    GM_registerMenuCommand('Abrir (' + hotkeyLabel(hotkey) + ')', open);
    GM_registerMenuCommand('Definir atalho…', startHotkeyCapture);
    GM_registerMenuCommand('Limpar índice', () => {
      store.set('targets', {});
      toast('Índice limpo. Visite as listas para reindexar.');
    });
    GM_registerMenuCommand('Diagnóstico (console)', () => {
      LOG('host:', HOST, '| app:', ON_APP, '| atalho:', hotkeyLabel(hotkey));
      LOG('alvos:', targetsList());
      if (!ON_APP) return;
      LOG('coleta ao vivo:', collectTargets());
      LOG('campo aqui:', findComposerHere());
      LOG('pendente:', getPending());
    });
  } catch (_) { /* sem menu */ }
})();
