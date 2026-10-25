# DSH Plus · Native Search

English | [中文](README.zh.md)

A search provider for DSH that uses your current chat model's built-in web search first, and falls back to DSH's standard search when native search isn't available.

Part of [DSH Plus](https://github.com/ArakawaHenri/dshplus) (`@dshplus/native-search`).

## Install

Install `@dshplus/native-search` in the DSH Plugin Manager (or install the [`@dshplus/bundle`](https://github.com/ArakawaHenri/dshplus) bundle):

```text
@dshplus/native-search
```

## How It Works

Out of the box, the plugin reads your existing `@deepseek-ai/dsh-llm-pi-ai` routes and reuses the model and credentials of the session that triggered the search:

- **Anthropic Messages** routes use `web_search_20250305`.
- **OpenAI Responses** routes use `web_search`.
- **Chat Completions** routes, unmapped providers, or any failed native search call automatically fall back to your `standardProvider` (`deepseek-official` by default).

## Configuration

No configuration is needed for standard setups. If a specific gateway or model doesn't support native search, or if you want to configure a custom route, you can override it in `cordis.patch.yml`:

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

### Options

| Option | Default | Description |
| --- | --- | --- |
| `standardProvider` | `deepseek-official` | Fallback search provider |
| `autoResolve` | `true` | Automatically read routes from `dsh-llm-pi-ai` |
| `maxTokens` | `2048` | Max output tokens for native search calls |
| `maxUses` | `3` | Max searches per request on Messages API |
| `timeoutMs` | `60000` | Request timeout in milliseconds |
| `messagesToolType` | `web_search_20250305` | Tool type sent to Messages routes |
| `responsesToolType` | `web_search` | Tool type sent to Responses routes (set `toolType: web_search_preview` on a route if your gateway requires it) |
| `debug` | `false` | Log route selection and fallback reasons |
| `routes` | `{}` | Per-provider route overrides |

## License

MIT
