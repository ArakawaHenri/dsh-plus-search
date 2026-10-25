# DSH Plus · 原生搜索

[English](README.md) | 中文

让 DSH 的 `web_search` 优先调用当前对话模型自带的原生搜索，不支持或调用失败时自动回退到普通搜索。

属于 [DSH Plus](https://github.com/ArakawaHenri/dshplus) 系列插件（`@dshplus/native-search`）。

## 安装

在 DSH 插件管理器中安装 `@dshplus/native-search`（或直接安装 [`@dshplus/bundle`](https://github.com/ArakawaHenri/dshplus) 总包）：

```text
@dshplus/native-search
```

## 工作方式

插件会自动读取 `@deepseek-ai/dsh-llm-pi-ai` 中已配置的模型路由，并直接沿用当前会话的模型与 API Key：

- **Anthropic Messages** 路由使用 `web_search_20250305`。
- **OpenAI Responses** 路由使用 `web_search`。
- **Chat Completions** 等不支持的协议，或者中转站不支持搜索、请求报错时，会自动回退到 `standardProvider`（默认 `deepseek-official`），不会打断对话。

## 配置

默认开箱即用。如果某个中转站或特定模型不支持原生搜索，可以在 profile 的 `cordis.patch.yml` 里单独关掉，或手动补充路由：

```yaml
- id: dshplus-native-search
  config:
    routes:
      my-gateway:
        nativeSearch: false
      custom-route:
        api: responses
        baseURL: https://gateway.example
        apiKeyEnv: GATEWAY_API_KEY
        models:
          model-without-search:
            nativeSearch: false
```

### 常用配置项

| 字段 | 默认值 | 说明 |
| --- | --- | --- |
| `standardProvider` | `deepseek-official` | 普通搜索及失败回退使用的 provider |
| `autoResolve` | `true` | 自动从 `dsh-llm-pi-ai` 读取路由信息 |
| `maxTokens` | `2048` | 原生搜索请求的最大输出 token 数 |
| `maxUses` | `3` | Messages 单次请求最多搜索次数 |
| `timeoutMs` | `60000` | 请求超时时间（毫秒） |
| `messagesToolType` | `web_search_20250305` | Messages 搜索工具类型 |
| `responsesToolType` | `web_search` | Responses 搜索工具类型（需要旧版预览名的网关可在路由上配 `toolType: web_search_preview`） |
| `debug` | `false` | 在日志中输出路由选择与回退原因 |
| `routes` | `{}` | 按 provider 名称覆盖路由配置 |

## 许可

MIT
