/**
 * dsh-sidechat —— host 半端（v0.3）
 * ============================================================================
 * 职责：给「侧边聊天」会话注入**主对话上下文**，但不让它出现在聊天记录里。
 *
 * 做法：
 *   · 客户端创建侧边会话时把父会话 id 编进 session id：
 *       `session-sidechat-<base64url(parentSessionId)>-<rand>`
 *   · 这里监听 `agent/created`，认出这种会话，然后通过
 *       `agent.ctx.inject(['systemPrompt'], scope => scope.systemPrompt.section(...))`
 *     给**这一个 agent** 注册一段系统提示词 section（每会话作用域，不影响别的会话）。
 *   · section 的 `text` 是个函数：每次组装系统提示词时重新读取主对话历史，
 *     所以侧边聊天里继续追问时，上下文也是最新的。
 *   · 系统提示词不进聊天记录 —— 侧边面板里只有你自己的提问和模型回答。
 *
 * 边界：
 *   · 只取主对话的「真人输入 + 助手文本」，跳过工具调用/结果；总体积约 24k 字符，留最近的部分；
 *   · 父会话不在线（或读不到）就静默跳过，不阻塞侧边聊天；
 *   · 全部注册挂在 agent.ctx 上，agent 释放/插件卸载时一并回收。
 * ============================================================================
 */

export const name = 'side-chat'

/** 不强制依赖某个服务：都通过 ctx.get() 容错获取。 */
export const inject = []

/** 侧边会话 id 前缀；必须与 client.js 保持一致。 */
const SESSION_PREFIX = 'session-sidechat-'

/** agent.id → disposer（agent.ctx.inject 返回的 fiber）。 */
const fibers = new Map()

/** parentSessionId → { at, text }：短缓存，避免每步都重排整段历史。 */
const historyCache = new Map()

const HISTORY_LIMIT = Number.isSafeInteger(Number(process.env.SIDE_CHAT_HISTORY_LIMIT))
  ? Number(process.env.SIDE_CHAT_HISTORY_LIMIT)
  : 24000
const HISTORY_CACHE_MS = 3000

/**
 * 从侧边会话 id 里解出父会话 id。
 * @param {string} sessionId 会话/agent id。
 * @returns {string | undefined}
 */
function parseParentSessionId(sessionId) {
  if (typeof sessionId !== 'string' || !sessionId.startsWith(SESSION_PREFIX)) return undefined
  const rest = sessionId.slice(SESSION_PREFIX.length)
  const cut = rest.lastIndexOf('-')
  if (cut <= 0) return undefined
  const encoded = rest.slice(0, cut)
  try {
    const parent = Buffer.from(encoded, 'base64url').toString('utf8')
    return parent.startsWith('session-') ? parent : undefined
  } catch {
    return undefined
  }
}

/** 取一条消息里的纯文本内容。 */
function messageText(message) {
  if (!message || !Array.isArray(message.content)) return ''
  const parts = []
  for (const block of message.content) {
    if (block && block.type === 'text' && typeof block.text === 'string') parts.push(block.text)
  }
  return parts.join('\n').trim()
}

/** 把父会话的事件流折成「用户/助手」对话文本（跳过工具调用与系统事件）。 */
function formatHistory(session) {
  const lines = []
  let events
  try {
    events = session.snapshotEvents()
  } catch {
    return lines
  }
  for (const event of events) {
    if (!event || typeof event.type !== 'string') continue
    if (event.type === 'user/message') {
      const source = event.data && event.data.source
      if (!source || source.kind !== 'user') continue
      const text = messageText(event.data)
      if (text) lines.push('用户：' + text)
    } else if (event.type === 'assistant/message') {
      const data = event.data
      const text = messageText(data && data.message)
      if (text) lines.push('助手：' + text)
    }
  }
  return lines
}

/**
 * 生成注入用的上下文文本（带 3 秒缓存）。
 * @param ctx cordis 上下文
 * @param parentSessionId 主对话会话 id
 * @returns {string} 空串表示这次没有可注入的内容
 */
function buildContextText(ctx, parentSessionId) {
  const now = Date.now()
  const cached = historyCache.get(parentSessionId)
  if (cached !== undefined && now - cached.at < HISTORY_CACHE_MS) return cached.text

  let text = ''
  try {
    const agents = ctx.get('agents')
    const parent = agents && typeof agents.get === 'function' ? agents.get(parentSessionId) : undefined
    const session = parent && parent.session
    if (session) {
      const lines = formatHistory(session)
      if (lines.length > 0) {
        let body = lines.join('\n\n')
        if (body.length > HISTORY_LIMIT) body = '（更早的对话已省略）\n' + body.slice(body.length - HISTORY_LIMIT)
        text = [
          '【侧边聊天：主对话上下文】',
          '以下是用户在主对话里的最近记录，用于理解本次侧边提问。它不是本会话里的发言：不要复述它，也不要假设用户已经在这里说过这些内容。',
          '=== 主对话开始 ===',
          body,
          '=== 主对话结束 ===',
        ].join('\n')
      }
    }
  } catch {
    text = ''
  }

  historyCache.set(parentSessionId, { at: now, text })
  while (historyCache.size > 32) historyCache.delete(historyCache.keys().next().value)
  return text
}

/**
 * 给一个侧边聊天 agent 注册「主对话上下文」系统提示词 section。
 * @param ctx cordis 上下文
 * @param agent 新建的 agent
 */
function attachContext(ctx, agent) {
  if (!agent || typeof agent.id !== 'string') return
  if (fibers.has(agent.id)) return
  const sessionId = agent.session && typeof agent.session.id === 'string' ? agent.session.id : agent.id
  const parentSessionId = parseParentSessionId(sessionId)
  if (parentSessionId === undefined) return

  try {
    const fiber = agent.ctx.inject(['systemPrompt'], (scope) => {
      scope.systemPrompt.section({
        name: 'side-chat:main-history',
        order: 9000,
        interpolate: false,
        text: () => buildContextText(ctx, parentSessionId),
      })
    })
    fibers.set(agent.id, fiber)
  } catch (error) {
    try { console.warn('[dsh-sidechat] 注入主对话上下文失败：', error) } catch { /* 忽略 */ }
  }
}

/**
 * 挂载 host 半端。
 * @param ctx cordis 上下文
 */
export function apply(ctx) {
  // `agent/created` / `agent/disposed` 是普通事件（不是 serial middleware）：单参监听，别 return next()。
  ctx.on('agent/created', ({ agent }) => {
    try {
      attachContext(ctx, agent)
    } catch (error) {
      try { console.warn('[dsh-sidechat] agent/created 处理失败：', error) } catch { /* 忽略 */ }
    }
  })

  ctx.on('agent/disposed', ({ agent }) => {
    try {
      if (!agent) return
      const fiber = fibers.get(agent.id)
      if (fiber !== undefined) {
        fibers.delete(agent.id)
        if (typeof fiber.dispose === 'function') fiber.dispose()
      }
    } catch (error) {
      try { console.warn('[dsh-sidechat] agent/disposed 处理失败：', error) } catch { /* 忽略 */ }
    }
  })

  // 插件晚于 agent 挂载时（热重载 / 后装），把已经在跑的侧边会话补一遍
  try {
    const agents = ctx.get('agents')
    if (agents && typeof agents.list === 'function') {
      for (const agent of agents.list()) {
        try { attachContext(ctx, agent) } catch { /* 单个失败不影响其它 */ }
      }
    }
  } catch { /* 没有 agents 服务就只靠事件 */ }

  ctx.effect(() => () => {
    for (const fiber of fibers.values()) {
      try { if (typeof fiber.dispose === 'function') fiber.dispose() } catch { /* 忽略 */ }
    }
    fibers.clear()
    historyCache.clear()
  }, 'dsh-sidechat: 回收上下文注入')
}
