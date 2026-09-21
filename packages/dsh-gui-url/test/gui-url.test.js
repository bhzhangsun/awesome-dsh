import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { apply, TOOL_NAME } from '../src/index.js'

/*
 * 这个工具只有两种失败方式，都在这里钉住：把 bind-anywhere 地址当成浏览器能打开的
 * 地址，以及在服务器还没监听时给出一个看起来正常、但访问必然失败的 URL。
 */
describe('gui_url 工具', () => {
  const register = services => {
    let definition
    apply({
      get: name => services[name],
      tools: { register: value => { definition = value } },
      logger: { info: () => {}, warn: () => {} },
    })
    return definition
  }
  const server = (port, host = '127.0.0.1') => ({ port, host })
  const connection = url => ({ authenticatedUrl: url })
  const tokenFor = base => `${base}?token=SECRET`

  it('注册成模型工具，名字与描述都到位', () => {
    const definition = register({})
    assert.equal(definition.name, TOOL_NAME)
    assert.match(definition.description, /CHANGES ON EVERY RESTART/)
  })

  /*
   * 工具被选中的依据是描述里的**场景**，不是名字。这条测试挡的是"把描述精简成一句话"
   * 这种改动 —— 那种描述读起来更干净，但模型在需要调试客户端时就想不起这个工具。
   */
  it('描述里点名了触发场景与后续动作，而不只是"要看 GUI 时用"', () => {
    const { description } = register({})
    const mustSay = [
      /client you are running in/i,          // 它就是这个客户端本身，不是别的 dev server
      /client-side code/i,                   // 场景一：改了客户端代码要验证
      /Slot/i,                               //   把具体的客户端概念点出来
      /theme token/i,
      /asks for the GUI address/i,           // 场景二：用户直接要地址
      /debug URL/i,
      /real state rather than inferring/i,   // 场景三：要真实界面状态
      /REFRESHED/,                           // 后续动作：改完要刷新才可见
      /never\s+report a UI change as working from source alone/i,
      /no arguments/i,
    ]
    for (const pattern of mustSay) {
      assert.match(description, pattern, `描述缺少触发场景: ${String(pattern)}`)
    }
  })

  it('返回服务器实际监听端口上的带 token 地址', async () => {
    const definition = register({
      webServer: server(43120),
      connection: connection(tokenFor),
    })
    const value = await definition.execute({}, {})
    assert.match(value.text, /^http:\/\/127\.0\.0\.1:43120\/\?token=SECRET/)
  })

  it('不把 bind-anywhere 地址当成浏览器可访问的 URL', async () => {
    const definition = register({
      webServer: server(43120, '0.0.0.0'),
      connection: connection(tokenFor),
    })
    const value = await definition.execute({}, {})
    assert.match(value.text, /^http:\/\/127\.0\.0\.1:43120\//)
  })

  it('服务器还没监听时说清楚，而不是给一个必然失败的地址', async () => {
    /* 这里必须没有 url 字段：给了就等于把"还没到时候"伪装成"地址就是这样"。 */
    const definition = register({
      webServer: server(undefined),
      connection: connection(tokenFor),
    })
    const value = await definition.execute({}, {})
    assert.equal(value.url, undefined)
    assert.match(value.text, /not listening yet/)
    assert.doesNotMatch(value.text, /http:\/\//)
  })

  it('没有 Web GUI 的 profile 明确回答，不报错', async () => {
    const definition = register({})
    const value = await definition.execute({}, {})
    assert.match(value.text, /no Web GUI/)
  })
})
