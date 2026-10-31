/**
 * dsh-side-chat —— 浏览器半端（v0.2）
 * ============================================================================
 * Codex 风格的「侧边聊天」：右侧栏里一个**临时**的空对话面板，和主对话并排。
 *
 *   会话 header 的「侧边聊天」按钮（或在主对话里选中文字 →「侧边提问」）
 *        └─▶ 建一个空白会话（同工作区，随机 id，不复用旧 blank）
 *        └─▶ 用资源地址 dsh-resource://sidechat/session/<id> 在右栏开 tab
 *        └─▶ 若是从选区进来，再把「引用片段」写进侧边输入框草稿
 *
 * 临时性（对齐 Codex 的「关闭应用后会消失」）：
 *   · 关掉 tab → 立即归档该会话（从会话列表消失）；
 *   · 应用重启 → 把上一次仍开着的侧边会话统一归档（localStorage 记账）；
 *   · 会话本身是普通 Session（复用既有 create/archive），不魔改宿主。
 *
 * 面板本体复用宿主的 `conversation.content` Component Factory（embedded + 固定
 * view=chat），所以输入框、历史、工具行、@ 引用、模型选择全部与主对话一致。
 * ============================================================================
 */

window.__ModuleLoader__.load({
  id: 'dsh-sidechat',
  factory: function (require) {
    var React = require('react');
    var h = React.createElement;

    var PLUGIN_ID = 'dsh-sidechat';
    var TAB_ID = 'dsh-side-chat/tab';
    var ADDRESS = 'dsh-resource://sidechat/session/';
    /** localStorage：本次运行里还开着的侧边会话 id（用于重启后归档）。 */
    var SESSIONS_KEY = 'dsh-side-chat:sessions';
    /** sessionStorage：本页是否已经做过「上次运行残留」清扫。 */
    var PAGE_MARK_KEY = 'dsh-side-chat:page';

    var services = {
      sessions: null,
      workspaces: null,
      sidebarRight: null,
      slots: null,
    };

    /** sessionId → 该会话输入框的动作面（用于把片段写进侧边草稿）。 */
    var inputActionsBySession = new Map();

    var styleEl = null;
    var toastEl = null;
    var toastTimer = 0;

    //#region ---------------------------------------------------------------- CSS

    var CSS = [
      '.dsc-sidechat-root{display:flex;flex-direction:column;height:100%;min-height:0;overflow:hidden;}',
      '.dsc-sidechat-strip{display:flex;align-items:baseline;gap:8px;flex:none;padding:7px 14px 6px;border-bottom:.5px solid var(--dsw-alias-border-l3,rgba(0,0,0,.08));',
      'font:12px/1.3 -apple-system,BlinkMacSystemFont,"PingFang SC","Microsoft YaHei",sans-serif;color:var(--dsw-alias-label-tertiary,#6b7280);}',
      '.dsc-sidechat-strip-title{font-weight:600;color:var(--dsw-alias-label-primary,#111);}',
      '.dsc-sidechat-strip-note{opacity:.8;}',
      '.dsc-sidechat-body{display:flex;flex-direction:column;flex:1;min-height:0;overflow:hidden;}',
      '.dsc-sidechat-btn{appearance:none;display:inline-flex;align-items:center;gap:5px;height:26px;padding:0 9px;border-radius:7px;border:0;',
      'background:transparent;color:var(--dsw-alias-label-secondary,#4b5563);font:12px/1 -apple-system,BlinkMacSystemFont,"PingFang SC","Microsoft YaHei",sans-serif;cursor:pointer;white-space:nowrap;user-select:none;-webkit-app-region:no-drag;}',
      '.dsc-sidechat-btn:hover{background:rgba(127,127,127,.14);color:var(--dsw-alias-label-primary,#111);}',
      '.dsc-sidechat-btn:disabled{opacity:.55;cursor:default;}',
      '.dsc-sidechat-toast{position:fixed;pointer-events:none;-webkit-app-region:no-drag;left:50%;bottom:72px;transform:translateX(-50%);z-index:2147483000;max-width:70vw;',
      'padding:8px 12px;border-radius:9px;background:rgba(30,30,30,.94);color:#fff;font:12px/1.5 -apple-system,BlinkMacSystemFont,"PingFang SC",sans-serif;',
      'box-shadow:0 8px 28px rgba(0,0,0,.3);}',
    ].join('');

    function ensureStyle() {
      if (styleEl && styleEl.isConnected) return;
      styleEl = document.createElement('style');
      styleEl.setAttribute('data-plugin-css', PLUGIN_ID);
      styleEl.textContent = CSS;
      document.head.appendChild(styleEl);
    }

    function toast(message) {
      try {
        if (toastEl && toastEl.parentNode) toastEl.parentNode.removeChild(toastEl);
        toastEl = document.createElement('div');
        toastEl.className = 'dsc-sidechat-toast';
        toastEl.setAttribute('data-plugin', PLUGIN_ID);
        toastEl.textContent = String(message);
        document.body.appendChild(toastEl);
        if (toastTimer) window.clearTimeout(toastTimer);
        toastTimer = window.setTimeout(function () {
          toastTimer = 0;
          if (toastEl && toastEl.parentNode) toastEl.parentNode.removeChild(toastEl);
          toastEl = null;
        }, 4000);
      } catch (error) { /* 忽略 */ }
    }

    //#endregion

    //#region --------------------------------------------------------- 地址与工具

    function parseAddress(value) {
      try {
        var url = new URL(String(value));
        if (url.protocol !== 'dsh-resource:') return null;
        if (url.hostname.toLowerCase() !== 'sidechat') return null;
        var parts = url.pathname.split('/').filter(Boolean);
        if (parts.length !== 2 || parts[0] !== 'session') return null;
        var sessionId = decodeURIComponent(parts[1]);
        return sessionId ? { sessionId: sessionId } : null;
      } catch (error) {
        return null;
      }
    }

    function addressFor(sessionId) {
      return ADDRESS + encodeURIComponent(sessionId);
    }

    function sessionIdOf(result) {
      if (typeof result === 'string' && result) return result;
      if (!result || typeof result !== 'object') return null;
      if (typeof result.sessionId === 'string' && result.sessionId) return result.sessionId;
      if (result.value && typeof result.value.sessionId === 'string' && result.value.sessionId) return result.value.sessionId;
      return null;
    }

    function describe(error) {
      if (!error) return '未知错误';
      return error.message ? String(error.message) : String(error);
    }

    /** base64url（session id 是 ASCII，直接 btoa 即可）。 */
    function base64UrlEncode(text) {
      try {
        return btoa(String(text)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
      } catch (error) {
        return '';
      }
    }

    /**
     * 侧边会话 id 里编码父会话 id：`session-sidechat-<b64url(parent)>-<rand>`。
     * host 半端靠这个前缀认出侧边聊天，再给该 agent 注入主对话上下文。
     * @param parentSessionId 主对话会话 id
     */
    function newSessionId(parentSessionId) {
      var tail = Math.random().toString(16).slice(2, 10);
      var encoded = parentSessionId ? base64UrlEncode(parentSessionId) : '';
      if (encoded) return 'session-sidechat-' + encoded + '-' + tail;
      try { return 'session-' + crypto.randomUUID(); } catch (error) { /* 走退路 */ }
      return 'session-' + Date.now().toString(16) + '-' + tail;
    }

    //#endregion

    //#region ------------------------------------------------------------- 记账

    function readTracked() {
      try {
        var value = JSON.parse(window.localStorage.getItem(SESSIONS_KEY) || '[]');
        if (!Array.isArray(value)) return [];
        return value.filter(function (id) { return typeof id === 'string' && id; });
      } catch (error) {
        return [];
      }
    }

    function writeTracked(list) {
      try { window.localStorage.setItem(SESSIONS_KEY, JSON.stringify(Array.from(new Set(list)).slice(-50))); } catch (error) { /* 忽略 */ }
    }

    function rememberSession(sessionId) {
      var list = readTracked();
      if (list.indexOf(sessionId) < 0) { list.push(sessionId); writeTracked(list); }
    }

    function forgetSession(sessionId) {
      writeTracked(readTracked().filter(function (id) { return id !== sessionId; }));
    }

    //#endregion

    //#region ------------------------------------------------------------- 建会话

    function workspaceIdOf(sourceSessionId) {
      try {
        var workspaces = services.workspaces;
        if (!workspaces || !workspaces.list) return undefined;
        var snapshot = workspaces.list.getSnapshot();
        var items = snapshot && snapshot.items ? snapshot.items : [];
        for (var i = 0; i < items.length; i += 1) {
          var item = items[i];
          if (item && item.sessionIds && item.sessionIds.indexOf(sourceSessionId) >= 0) return item.workspaceId;
        }
      } catch (error) { /* 忽略 */ }
      return undefined;
    }

    /**
     * 建一个**空白**侧边会话（同工作区、随机 id，不复用旧 blank）；
     * 万一 create 被拒，再退回 fork 当前对话。
     * @param sourceSessionId - 当前主对话的 session id。
     * @returns {Promise<{id: string, mode: 'blank'|'fork'}>}
     */
    function createSideSession(sourceSessionId) {
      var sessions = services.sessions;
      if (!sessions) return Promise.reject(new Error('sessions 服务不可用'));

      var request = { sessionId: newSessionId(sourceSessionId) };
      var workspaceId = workspaceIdOf(sourceSessionId);
      if (workspaceId !== undefined) request.workspaceId = workspaceId;

      return Promise.resolve()
        .then(function () { return sessions.create(request); })
        .then(function (created) {
          var id = sessionIdOf(created);
          if (!id) throw new Error('create 没有返回会话 id');
          return { id: id, mode: 'blank' };
        })
        .catch(function (createError) {
          return sessions.fork({ sessionId: sourceSessionId, increaseTitle: true }).then(function (forked) {
            var id = sessionIdOf(forked);
            if (!id) throw new Error('建会话失败：' + describe(createError));
            return { id: id, mode: 'fork' };
          });
        });
    }

    /** 建会话并在右栏打开。 */
    function openSideChat(sourceSessionId) {
      if (!sourceSessionId) return Promise.reject(new Error('没有当前会话'));
      var sidebarRight = services.sidebarRight;
      if (!sidebarRight) return Promise.reject(new Error('右侧栏服务不可用'));
      return createSideSession(sourceSessionId).then(function (created) {
        rememberSession(created.id);
        sidebarRight.openResource(addressFor(created.id));
        return created;
      });
    }

    //#endregion

    //#region --------------------------------------------------------- 片段注入

    function waitForInputActions(sessionId, timeoutMs) {
      return new Promise(function (resolve, reject) {
        var deadline = Date.now() + timeoutMs;
        (function tick() {
          var actions = inputActionsBySession.get(sessionId);
          if (actions) { resolve(actions); return; }
          if (Date.now() > deadline) { reject(new Error('侧边输入框没有就绪')); return; }
          window.setTimeout(tick, 120);
        })();
      });
    }

    function writeDraft(sessionId, text) {
      return waitForInputActions(sessionId, 6000).then(function (actions) {
        var written = false;
        try { written = actions.insertText(text, actions.captureInsertion()) === true; } catch (error) { written = false; }
        if (!written) {
          try { written = actions.insertText(text, actions.captureInsertion()) === true; } catch (error) { written = false; }
        }
        return written;
      });
    }

    /**
     * 开会话 + 把选中片段写进侧边输入框草稿（Codex 的「在侧边聊天中提问」）。
     * @param sourceSessionId - 主对话 session id。
     * @param text - 已经拼好的引用片段文本。
     * @returns {Promise<{id: string, mode: string, seeded: boolean}>}
     */
    function openSideChatWithSnippet(sourceSessionId, text) {
      return openSideChat(sourceSessionId).then(function (created) {
        return writeDraft(created.id, String(text || ''))
          .then(function (seeded) { return { id: created.id, mode: created.mode, seeded: seeded }; })
          .catch(function () { return { id: created.id, mode: created.mode, seeded: false }; });
      });
    }

    //#endregion

    //#region ------------------------------------------------------------- 归档

    /** 走 Host 的 workspace/archiveSession RPC（同源 fetch，cookie 鉴权）。 */
    function archiveViaRpc(sessionId) {
      try {
        var rpcId;
        try { rpcId = crypto.randomUUID(); } catch (error) { rpcId = 'sidechat-' + Date.now() + '-' + Math.random().toString(16).slice(2); }
        return fetch('/api/workspace/archiveSession', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            type: 'client-request',
            rpcId: rpcId,
            method: 'workspace/archiveSession',
            payload: { args: { request: { sessionId: sessionId, stopActivity: true } } },
          }),
        }).then(function (response) {
          if (!response.ok) return { ok: false, error: 'HTTP ' + response.status };
          return response.json().then(function (json) {
            var result = json && json.result;
            if (result && result.ok === true) return { ok: true };
            var error = result && result.error
              ? String(result.error.code || '') + ': ' + String(result.error.message || '')
              : 'unexpected rpc result';
            return { ok: false, error: error };
          });
        }).catch(function (error) { return { ok: false, error: describe(error) }; });
      } catch (error) {
        return Promise.resolve({ ok: false, error: describe(error) });
      }
    }

    function archiveSideSessionDetailed(sessionId) {
      forgetSession(sessionId);
      return archiveViaRpc(sessionId);
    }

    function archiveSideSession(sessionId) {
      return archiveSideSessionDetailed(sessionId).then(function (result) { return result.ok === true; });
    }

    /**
     * 应用启动时清扫上一次运行残留的侧边会话（对齐「关闭应用后会消失」）。
     * 只在**本页第一次** apply 时执行；HMR 重载不会误伤还开着的会话。
     * apply 可能早于 Remote 就绪，所以延迟 + 重试，并把结果记在 localStorage 里便于排查。
     */
    function sweepPreviousRun() {
      try {
        if (window.sessionStorage.getItem(PAGE_MARK_KEY)) return;
        window.sessionStorage.setItem(PAGE_MARK_KEY, String(Date.now()));
      } catch (error) {
        return;
      }
      var pending = readTracked();
      if (!pending.length) return;
      var attempts = 0;

      function note(result, sessionId) {
        try {
          var log = JSON.parse(window.localStorage.getItem('dsh-side-chat:sweep') || '[]');
          if (!Array.isArray(log)) log = [];
          log.push({ at: new Date().toISOString(), sessionId: sessionId, ok: result.ok === true, error: result.ok === true ? undefined : result.error });
          while (log.length > 20) log.shift();
          window.localStorage.setItem('dsh-side-chat:sweep', JSON.stringify(log));
        } catch (error) { /* 忽略 */ }
      }

      function step() {
        if (!pending.length || attempts >= 10) return;
        attempts += 1;
        var sessionId = pending[0];
        Promise.resolve(archiveSideSessionDetailed(sessionId)).then(function (result) {
          note(result, sessionId);
          if (result.ok === true) pending.shift();
          window.setTimeout(step, result.ok === true ? 200 : 1500);
        });
      }

      window.setTimeout(step, 2000);
    }

    //#endregion

    //#region ------------------------------------------------------------- 资源

    function sideChatResourceProvider(sessions) {
      return {
        protocol: 'sidechat',
        async *open(resourceAddress, options) {
          var parsed = parseAddress(resourceAddress);
          if (!parsed) throw new Error('dsh-side-chat: 无效的侧边聊天地址 ' + String(resourceAddress));
          var signal = options && options.signal;
          if (signal && signal.aborted) return;
          var reference = sessions.retain(parsed.sessionId, { source: 'sideChat', signal: signal });
          try {
            yield { ok: true, value: { sessionId: parsed.sessionId, reference: reference } };
            if (!signal) return;
            await new Promise(function (resolve) {
              if (signal.aborted) resolve();
              else signal.addEventListener('abort', resolve, { once: true });
            });
          } finally {
            try { reference.release(); } catch (error) { /* 忽略 */ }
          }
        },
      };
    }

    //#endregion

    //#region ------------------------------------------------------------- 渲染

    function FixedChat(props) {
      return props.renderSlot('conversation.session', { view: 'chat' });
    }

    function SideChatTab(props) {
      var useResource = props.useResource;
      var useTabInfo = props.useTabInfo;
      var SessionProvider = props.SessionProvider;
      var renderSlot = props.renderSlot;

      var tabInfo = useTabInfo();
      var contentId = tabInfo && tabInfo.tab ? tabInfo.tab.contentId : undefined;
      var resource = contentId === undefined ? undefined : useResource(contentId);
      var value = resource && resource.value;

      return h('div', { className: 'dsc-sidechat-root', 'data-side-chat': '' },
        h('div', { className: 'dsc-sidechat-strip' },
          h('span', { className: 'dsc-sidechat-strip-title' }, '侧边聊天'),
          h('span', { className: 'dsc-sidechat-strip-note' }, '临时对话 · 关标签页即归档 · 已带入主对话上下文')),
        h('div', { className: 'dsc-sidechat-body' },
          value && value.reference
            ? h(SessionProvider, { session: value.reference },
                renderSlot('sidechat.conversation', {}))
            : null));
    }

    /**
     * 会话正文：复用 conversation.content factory（embedded + 固定 Chat view）。
     * 阶段判定与 subagent 的侧栏聊天保持一致。
     */
    function SideChatConversation(props) {
      var sessionId = props.sessionId;
      var useSession = props.useSession;
      var useConversation = props.useConversation;
      var useSessions = props.useSessions;
      var renderFactorySlot = props.renderFactorySlot;

      var session = useSession(function (value) { return value; });
      var active = false;
      try {
        active = useConversation(function (value) { return value; }).activeTargets.size > 0;
      } catch (error) { /* 忽略 */ }

      var shellPhase = active || (!session.blank && !session.awaitingFirstTurn) || session.running
        ? 'active'
        : (session.promptAttempted ? 'engaging' : 'blank');
      var summaryBlank;
      try {
        summaryBlank = useSessions(function (state) {
          var row = state.byId[sessionId];
          return row ? row.blank : undefined;
        });
      } catch (error) { summaryBlank = undefined; }

      var settling = shellPhase === 'blank' && session.openState === 'loading' && summaryBlank !== true;
      var hero = shellPhase === 'blank' && (session.openState === 'open' || summaryBlank === true);
      return renderFactorySlot('conversation.content', {
        variant: 'embedded',
        phase: settling ? 'settling' : hero ? 'hero' : 'active',
        hero: hero,
      }, { slots: { views: FixedChat } });
    }

    //#endregion

    //#region ----------------------------------------------------------- 输入框桥

    /**
     * 记录每个会话的 inputActions（含侧边聊天自己的输入框），
     * 供「把选中片段写进侧边草稿」使用。渲染 null。
     */
    function InputDock(props) {
      var p = props || {};
      var sessionId = p.sessionId;
      var actions = p.inputActions;
      if (sessionId && actions) inputActionsBySession.set(sessionId, actions);
      React.useEffect(function () {
        if (sessionId && actions) inputActionsBySession.set(sessionId, actions);
        return function () {
          if (sessionId && inputActionsBySession.get(sessionId) === actions) inputActionsBySession.delete(sessionId);
        };
      }, [sessionId, actions]);
      return null;
    }

    //#endregion

    //#region --------------------------------------------------------------- 入口

    function SideChatButton(props) {
      var sessionId = props.sessionId;
      var busyState = React.useState(false);
      var busy = busyState[0];
      var setBusy = busyState[1];

      var onClick = function () {
        if (busy) return;
        setBusy(true);
        openSideChat(sessionId)
          .catch(function (error) { toast('侧边聊天开不了：' + describe(error)); })
          .then(function () { setBusy(false); });
      };

      return h('button', {
        type: 'button',
        className: 'dsc-sidechat-btn',
        disabled: busy,
        title: '在右侧栏开一个临时对话（关掉标签页就归档）',
        'data-sidechat-open': '',
        onClick: onClick,
      }, busy ? '开启中…' : '侧边聊天');
    }

    //#endregion

    //#region --------------------------------------------------------------- apply

    function register(ctx) {
      var slots = services.slots;
      var sessions = services.sessions;
      var tabs = (typeof ctx.get === 'function' ? ctx.get('sidebarRightTabs') : undefined) || ctx.sidebarRightTabs;
      var resources = (typeof ctx.get === 'function' ? ctx.get('resources') : undefined) || ctx.resources;
      var sidebarRight = services.sidebarRight;
      if (!slots || !sessions || !tabs) {
        console.warn('[dsh-side-chat] 缺少必要服务（slots/sessions/sidebarRightTabs），未启用');
        return;
      }

      if (resources && typeof resources.register === 'function') {
        ctx.effect(function () { return resources.register(sideChatResourceProvider(sessions)); }, PLUGIN_ID + ': sidechat resource');
      }

      ctx.effect(function () {
        return tabs.register({
          id: TAB_ID,
          kind: 'sidechat',
          patterns: [ADDRESS + '**'],
          priority: 'builtin',
          canOpen: function (address) { return parseAddress(address) !== null; },
          title: function () { return '侧边聊天'; },
        });
      }, PLUGIN_ID + ': sidechat tab type');

      ctx.effect(function () {
        return slots.inject('sidebar.right.pane.tab', function () {
          return slots.register({
            name: 'sidebar.right.pane.tab',
            key: TAB_ID,
            children: { 'sidechat.conversation': { kind: 'single', scope: 'session' } },
          }, SideChatTab);
        });
      }, PLUGIN_ID + ': sidechat tab body');

      ctx.effect(function () {
        return slots.inject('sidechat.conversation', function () {
          return slots.register({ name: 'sidechat.conversation' }, SideChatConversation);
        });
      }, PLUGIN_ID + ': sidechat conversation');

      ctx.effect(function () {
        return slots.inject('conversation.input.dock', function () {
          return slots.register({ name: 'conversation.input.dock', id: 'sidechat-input-dock', order: 96 }, InputDock);
        });
      }, PLUGIN_ID + ': sidechat input dock');

      ctx.effect(function () {
        return slots.inject('conversation.session.header.actions', function () {
          return slots.register({ name: 'conversation.session.header.actions', id: 'sidechat-open', order: 40 }, SideChatButton);
        });
      }, PLUGIN_ID + ': sidechat button');

      // 关掉侧边 tab → 归档该会话（临时性）
      if (sidebarRight && typeof sidebarRight.registerCloseHandler === 'function') {
        ctx.effect(function () {
          return sidebarRight.registerCloseHandler('sidechat', function (_sessionId, tab) {
            var parsed = tab && tab.contentId ? parseAddress(tab.contentId) : null;
            if (parsed) archiveSideSession(parsed.sessionId);
          });
        }, PLUGIN_ID + ': sidechat close handler');
      }
    }

    function apply(ctx) {
      try {
        try { window.localStorage.setItem('dsh-side-chat:applied', new Date().toISOString()); } catch (ignore) { /* 诊断 */ }
        ensureStyle();
        services.sessions = (typeof ctx.get === 'function' ? ctx.get('sessions') : undefined) || ctx.sessions || null;
        services.workspaces = (typeof ctx.get === 'function' ? ctx.get('workspaces') : undefined) || ctx.workspaces || null;
        services.sidebarRight = (typeof ctx.get === 'function' ? ctx.get('sidebarRight') : undefined) || ctx.sidebarRight || null;
        services.slots = (typeof ctx.get === 'function' ? ctx.get('slots') : undefined) || ctx.slots || null;

        // 给同页插件（dsh-selection-chat）用的桥
        window.__DSH_SIDE_CHAT__ = {
          version: 2,
          open: function (sourceSessionId) { return openSideChat(sourceSessionId); },
          openWithSnippet: function (sourceSessionId, text) { return openSideChatWithSnippet(sourceSessionId, text); },
        };

        register(ctx);
        sweepPreviousRun();
      } catch (error) {
        try { console.warn('[dsh-side-chat] 启动失败：', error); } catch (ignore) { /* 忽略 */ }
      }
    }

    //#endregion

    return {
      inject: ['sessions', 'workspaces', 'slots', 'sidebarRight'],
      apply: apply,
      __selftest: {
        parseAddress: parseAddress,
        addressFor: addressFor,
        sessionIdOf: sessionIdOf,
      },
    };
  },
});
