/**
 * 远程协作 · 设置面板
 *
 * Client half of dsh-remote-access. Plain-DOM React (only the `react` module
 * from the browser module table) and theme tokens only, so it keeps working
 * when the Harness Client packages change.
 */
window.__ModuleLoader__.load({
  id: 'dsh-remote-access',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    const zh = {
      short: '远程协作',
      title: '远程协作',
      lede: '把本机的 DSH Harness Web GUI 通过隧道暴露给另一台机器上的浏览器。打开下面的链接就等于在这台机器上使用 DSH（同一批会话）。',
      state: '状态',
      states: {
        idle: '未启动',
        starting: '启动中…',
        ready: '已就绪',
        restarting: '重连中…',
        stopping: '停止中…',
        failed: '失败'
      },
      target: '本地地址',
      provider: '隧道方式',
      tunnel: '隧道地址',
      link: '连接链接',
      linkHint: '把这条链接发到另一台机器上，用浏览器打开即可。链接里带着本进程的访问令牌，等同于本机控制权，请勿外传。',
      accessHint: 'DSH Desktop 这个版本已经没有「允许在浏览器中打开」这个开关了：普通浏览器直接走「隧道域名在 trustedHosts 里 + 链接里带令牌」，所以这条链接在任何浏览器里都能打开，不需要额外授权。',
      accessRefused: '刚才的探测被 403 拒绝了：隧道域名可能还没写进 trustedHosts，这条链接在别的浏览器里会被挡住。点一次「重启」让插件重新发布信任域名，再看详情里的探测结果。',
      accessMode: '访问方式',
      accessState: '探测结果',
      accessGate: 'Desktop 开关',
      copy: '复制',
      copied: '已复制',
      open: '打开',
      start: '启动',
      stop: '停止',
      restart: '重启',
      starting: '正在启动…',
      logs: '日志',
      hideLogs: '收起日志',
      advanced: '详情',
      path: '状态目录',
      attempts: '重试次数',
      localLink: '本机链接（可配 ssh -L 使用）',
      keepAlive: 'origin keep-alive',
      tunnelLog: '隧道日志',
      localHint: '不想走隧道也可以：在另一台机器上执行 ssh -N -L 8080:127.0.0.1:{port} 用户名@这台机器，然后打开这条链接。',
      copyLocal: '复制本机链接',
      failHint: '隧道没有起来。常见原因：网络不可用、cloudflared 缺失、provider 配置不完整。',
      notReady: '还没有连接链接：隧道未就绪。',
      security: '注意：隧道一旦就绪，任何拿到这条链接的人都能操作这台机器上的 DSH。不用时请点「停止」。'
    }
    const en = {
      short: 'Remote access',
      title: 'Remote access',
      lede: 'Expose this machine\u2019s DSH Harness Web GUI to a browser on another machine through a tunnel. Opening the link below runs DSH here, with the same sessions.',
      state: 'State',
      states: {
        idle: 'Stopped',
        starting: 'Starting…',
        ready: 'Ready',
        restarting: 'Reconnecting…',
        stopping: 'Stopping…',
        failed: 'Failed'
      },
      target: 'Local origin',
      provider: 'Tunnel',
      tunnel: 'Tunnel URL',
      link: 'Share link',
      linkHint: 'Send this link to the other machine and open it in a browser. It carries this process\u2019s launch token, so it is as powerful as local control — keep it private.',
      accessHint: 'This DSH Desktop release no longer has an\u201callow opening in a browser\u201d switch: a browser gets in through the API trust fence (tunnel authority in trustedHosts) plus the launch token inside the link, so this link opens in any browser with no extra authorisation.',
      accessRefused: 'The last probe was refused with 403: the tunnel authority may be missing from trustedHosts, so this link would be blocked in another browser. Hit Restart so the plugin republishes it, then check the probe result under Details.',
      accessMode: 'Access mode',
      accessState: 'Probe result',
      accessGate: 'Desktop switch',
      copy: 'Copy',
      copied: 'Copied',
      open: 'Open',
      start: 'Start',
      stop: 'Stop',
      restart: 'Restart',
      starting: 'Starting…',
      logs: 'Logs',
      hideLogs: 'Hide logs',
      advanced: 'Details',
      path: 'State directory',
      attempts: 'Attempts',
      localLink: 'Local link (works with ssh -L)',
      keepAlive: 'origin keep-alive',
      tunnelLog: 'Tunnel log',
      localHint: 'No tunnel needed: on the other machine run ssh -N -L 8080:127.0.0.1:{port} user@this-machine, then open this link.',
      copyLocal: 'Copy local link',
      failHint: 'The tunnel did not come up. Usual causes: no network, cloudflared missing, incomplete provider config.',
      notReady: 'No share link yet: the tunnel is not ready.',
      security: 'Note: once the tunnel is ready, anyone holding this link can drive DSH on this machine. Stop it when you are done.'
    }

    function strings() {
      const docLang = (document.documentElement && document.documentElement.getAttribute('lang')) || ''
      const lang = docLang || navigator.language || 'en'
      return String(lang).toLowerCase().startsWith('zh') ? zh : en
    }

    const MONO = 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace'

    function api(action, method, body) {
      const url = new URL(`remote-access/${action}`, document.baseURI).href
      const verb = method || (action === 'status' ? 'GET' : 'POST')
      return fetch(url, {
        method: verb,
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json' },
        body: verb === 'GET' ? undefined : JSON.stringify(body || {})
      }).then(async (response) => {
        const text = await response.text()
        let payload = {}
        try {
          payload = text ? JSON.parse(text) : {}
        } catch {
          payload = { error: text }
        }
        if (!response.ok) throw new Error(payload.error || `HTTP ${response.status}`)
        return payload
      })
    }

    const token = (name, fallback) => `var(${name}, ${fallback})`
    const C = {
      text: token('--dsw-alias-label-primary', '#111'),
      text2: token('--dsw-alias-label-secondary', '#555'),
      text3: token('--dsw-alias-label-tertiary', '#888'),
      error: token('--dsw-alias-label-error', '#c0392b'),
      bg1: token('--dsw-alias-bg-layer-1', '#fff'),
      bg2: token('--dsw-alias-bg-layer-2', '#f6f6f6'),
      border: token('--dsw-alias-border-l2', 'rgba(0,0,0,.12)'),
      border3: token('--dsw-alias-border-l3', 'rgba(0,0,0,.2)'),
      hover: token('--dsw-alias-interactive-bg-hover', 'rgba(0,0,0,.04)'),
      primary: token('--dsw-alias-button-primary-fill', '#2f6feb'),
      primaryHover: token('--dsw-alias-button-primary-hover', '#2560d4'),
      onPrimary: token('--dsw-alias-label-primary-foreground', '#fff'),
      link: token('--dsw-alias-link', '#2f6feb'),
      ok: token('--dsw-alias-state-success-primary', '#2e8b57'),
      warn: token('--dsw-alias-state-warn-primary', '#b7791f'),
      idle: token('--dsw-alias-state-idle-primary', '#888')
    }

    const stateColor = (state) =>
      state === 'ready' ? C.ok : state === 'failed' ? C.error : state === 'starting' || state === 'restarting' ? C.warn : C.idle

    /**
     * No React hooks in here on purpose: the number of buttons changes between
     * renders (the access warning block appears once the status response
     * lands), and a hook count that changes between renders makes
     * React bail out with "Rendered more hooks than during the previous
     * render" — which blanks the whole slot. Hover is applied on the DOM node
     * directly instead of through state.
     */
    function button(kind, label, onClick, disabled) {
      const primary = kind === 'primary'
      const idle = primary ? C.primary : 'transparent'
      const active = primary ? C.primaryHover : C.hover
      return h(
        'button',
        {
          type: 'button',
          disabled: Boolean(disabled),
          onClick,
          onMouseEnter: (event) => {
            if (!disabled) event.currentTarget.style.background = active
          },
          onMouseLeave: (event) => {
            if (!disabled) event.currentTarget.style.background = idle
          },
          style: {
            font: 'inherit',
            fontSize: 13,
            lineHeight: '20px',
            padding: '6px 14px',
            borderRadius: token('--dsw-radius-md', '6px'),
            border: primary ? '1px solid transparent' : `1px solid ${C.border3}`,
            background: idle,
            color: primary ? C.onPrimary : C.text,
            cursor: disabled ? 'default' : 'pointer',
            opacity: disabled ? 0.55 : 1,
            transition: 'background 120ms ease'
          }
        },
        label
      )
    }

    function row(label, value, mono) {
      return h(
        'div',
        { style: { display: 'flex', gap: 12, alignItems: 'baseline', padding: '5px 0', fontSize: 13 } },
        h('span', { style: { color: C.text3, minWidth: 84, flex: '0 0 auto' } }, label),
        h(
          'span',
          {
            style: {
              color: C.text2,
              fontFamily: mono ? MONO : 'inherit',
              wordBreak: 'break-all',
              userSelect: 'text'
            }
          },
          value
        )
      )
    }

    function RemoteAccessSection() {
      const t = strings()
      const [status, setStatus] = React.useState(null)
      const [error, setError] = React.useState(null)
      const [busy, setBusy] = React.useState(null)
      const [copied, setCopied] = React.useState(null)
      const [showLogs, setShowLogs] = React.useState(false)
      const [showDetails, setShowDetails] = React.useState(false)
      const input = React.useRef(null)
      const localInput = React.useRef(null)

      const refresh = React.useCallback(() => {
        api('status')
          .then((next) => {
            setStatus(next)
            setError(null)
          })
          .catch((cause) => setError(String(cause.message || cause)))
      }, [])

      React.useEffect(() => {
        let alive = true
        const tick = () => {
          if (!alive) return
          refresh()
        }
        tick()
        const timer = setInterval(tick, 4000)
        return () => {
          alive = false
          clearInterval(timer)
        }
      }, [refresh])

      const run = React.useCallback(
        (action, body) => {
          setBusy(action)
          setError(null)
          api(action, undefined, body)
            .then((next) => setStatus(next))
            .catch((cause) => setError(String(cause.message || cause)))
            .finally(() => setBusy(null))
        },
        []
      )

      const copy = React.useCallback((value, node, key) => {
        if (!value) return
        const done = () => {
          setCopied(key)
          setTimeout(() => setCopied(null), 1600)
        }
        const manual = () => {
          if (node && node.current) {
            node.current.select()
            document.execCommand('copy')
            done()
          }
        }
        if (navigator.clipboard && navigator.clipboard.writeText) {
          navigator.clipboard.writeText(value).then(done, manual)
          return
        }
        manual()
      }, [])

      const current = status || {}
      const state = current.state || 'idle'
      const link = current.link || ''
      const localLink = current.localLink || ''
      const running = state === 'ready' || state === 'starting' || state === 'restarting'
      const access = current.access || {}
      // `refused` = the webserver will not accept even a tokenless request from
      // the tunnel authority, so the share link would be rejected as well
      const accessRefused = access.state === 'refused'
      let port = 'PORT'
      if (current.target) {
        try {
          port = new URL(current.target).port || port
        } catch {
          port = 'PORT'
        }
      }

      const card = {
        border: `1px solid ${C.border}`,
        borderRadius: token('--dsw-radius-lg', '10px'),
        background: C.bg1,
        padding: '14px 16px',
        marginTop: 12
      }

      const inputStyle = {
        flex: 1,
        minWidth: 0,
        fontFamily: MONO,
        fontSize: 12,
        padding: '6px 8px',
        borderRadius: token('--dsw-radius-sm', '6px'),
        border: `1px solid ${C.border}`,
        background: C.bg2,
        color: C.text2
      }

      return h(
        'div',
        { style: { color: C.text, fontSize: 14, lineHeight: '22px', maxWidth: 720 } },
        h('div', { style: { fontSize: 16, fontWeight: 600 } }, t.title),
        h('div', { style: { color: C.text3, fontSize: 12.5, marginTop: 4 } }, t.lede),

        h(
          'div',
          { style: card },
          h(
            'div',
            { style: { display: 'flex', alignItems: 'center', gap: 10 } },
            h('span', {
              style: {
                width: 8,
                height: 8,
                borderRadius: 4,
                background: stateColor(state),
                flex: '0 0 auto'
              }
            }),
            h('span', { style: { fontWeight: 600, fontSize: 13.5 } }, (t.states[state] || state)),
            h('span', { style: { color: C.text3, fontSize: 12.5 } }, busy ? t.starting : '')
          ),
          h('div', { style: { marginTop: 8 } }, row(t.target, current.target || '—', true)),
          h('div', null, row(t.provider, current.providerLabel || current.provider || '—')),
          current.tunnelUrl ? h('div', null, row(t.tunnel, current.tunnelUrl, true)) : null,
          error || current.error
            ? h(
                'div',
                {
                  style: {
                    marginTop: 10,
                    padding: '8px 10px',
                    borderRadius: token('--dsw-radius-sm', '6px'),
                    background: C.bg2,
                    border: `1px solid ${C.border}`,
                    color: C.error,
                    fontSize: 12.5,
                    whiteSpace: 'pre-wrap',
                    userSelect: 'text'
                  }
                },
                error || current.error
              )
            : null,
          accessRefused
            ? h(
                'div',
                {
                  style: {
                    marginTop: 10,
                    padding: '8px 10px',
                    borderRadius: token('--dsw-radius-sm', '6px'),
                    border: `1px solid ${C.border}`,
                    background: C.bg2,
                    color: C.warn,
                    fontSize: 12.5
                  }
                },
                t.accessRefused
              )
            : null,

          h(
            'div',
            { style: { display: 'flex', gap: 8, marginTop: 14 } },
            running
              ? button('secondary', t.stop, () => run('stop'), busy !== null)
              : button('primary', busy ? t.starting : t.start, () => run('start'), busy !== null),
            button('secondary', t.restart, () => run('restart'), busy !== null),
            h('span', { style: { flex: 1 } }),
            button('secondary', showDetails ? t.hideLogs.replace(t.logs, t.advanced) : t.advanced, () => setShowDetails(!showDetails)),
            button('secondary', showLogs ? t.hideLogs : t.logs, () => setShowLogs(!showLogs))
          )
        ),

        link
          ? h(
              'div',
              { style: card },
              h('div', { style: { fontWeight: 600, fontSize: 13 } }, t.link),
              h(
                'div',
                { style: { display: 'flex', gap: 8, marginTop: 8, alignItems: 'center' } },
                h('input', {
                  ref: input,
                  readOnly: true,
                  value: link,
                  onFocus: (event) => event.target.select(),
                  style: inputStyle
                }),
                button('secondary', copied === 'link' ? t.copied : t.copy, () => copy(link, input, 'link')),
                button('primary', t.open, () => window.open(link, '_blank', 'noopener'))
              ),
              h('div', { style: { fontSize: 12, color: C.text3, marginTop: 8 } }, t.linkHint),
              h('div', { style: { fontSize: 12, color: C.text3, marginTop: 6 } }, t.accessHint),
              h('div', { style: { fontSize: 12, color: C.warn, marginTop: 6 } }, t.security)
            )
          : h('div', { style: { fontSize: 12.5, color: C.text3, marginTop: 10 } }, running ? t.notReady : ''),

        localLink
          ? h(
              'div',
              { style: card },
              h('div', { style: { fontWeight: 600, fontSize: 13 } }, t.localLink),
              h(
                'div',
                { style: { display: 'flex', gap: 8, marginTop: 8, alignItems: 'center' } },
                h('input', {
                  ref: localInput,
                  readOnly: true,
                  value: localLink,
                  onFocus: (event) => event.target.select(),
                  style: inputStyle
                }),
                button('secondary', copied === 'local' ? t.copied : t.copy, () => copy(localLink, localInput, 'local'))
              ),
              h('div', { style: { fontSize: 12, color: C.text3, marginTop: 8 } }, t.localHint.replace('{port}', port))
            )
          : null,

        showDetails
          ? h(
              'div',
              { style: card },
              row(t.path, current.remoteDir || '—', true),
              row(t.attempts, String(current.attempts ?? 0)),
              row('cloudflared', current.cloudflared || '—', true),
              row('trustedHosts', (current.trustedHosts || []).join(', ') || '—', true),
              row(t.accessMode, String(access.mode || 'token-link')),
              row(t.accessState, String(access.state || 'unknown')),
              row(t.accessGate, String(access.gate || 'absent')),
              row(
                t.keepAlive,
                current.keepAliveMs === 0
                  ? 'off'
                  : `${current.keepAliveMs ?? '—'}ms / proxy ${current.proxyKeepAliveMs ?? '—'}ms${current.proxyKeepAliveMs === 0 ? ' (off)' : ''}${
                      current.keepAlive?.applied === false ? ` (not applied: ${current.keepAlive?.reason ?? '—'})` : ''
                    }`
              ),
              row(t.tunnelLog, String(current.tunnelLogFile || '—'), true)
            )
          : null,

        showLogs
          ? h(
              'div',
              { style: card },
              h(
                'pre',
                {
                  style: {
                    margin: 0,
                    maxHeight: 260,
                    overflow: 'auto',
                    fontFamily: MONO,
                    fontSize: 11.5,
                    lineHeight: '17px',
                    color: C.text2,
                    whiteSpace: 'pre-wrap',
                    userSelect: 'text'
                  }
                },
                (current.logs || []).map((entry) => (typeof entry === 'string' ? entry : `${entry.at} ${entry.text}`)).join('\n') ||
                  '—'
              )
            )
          : null
      )
    }

    return {
      name: 'dsh-remote-access',
      inject: ['slots'],
      apply(ctx) {
        ctx.slots.inject('settings.section', () =>
          ctx.slots.register(
            {
              name: 'settings.section',
              id: 'remote-access',
              order: 120,
              label: () => strings().short
            },
            RemoteAccessSection
          )
        )
      }
    }
  }
})
