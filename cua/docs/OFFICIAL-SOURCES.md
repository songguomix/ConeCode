# Public API references checked

Checked on 2026-11-07. This runtime is independently implemented using public
APIs. Documentation availability does not prove this account's model access.

- [OpenAI computer use](https://developers.openai.com/api/docs/guides/tools-computer-use)
- [Environment integration recipes](https://developers.openai.com/api/docs/guides/tools-computer-use-integration)
- [Browser and desktop driver contracts](https://developers.openai.com/api/docs/guides/tools-computer-use-sdk-drivers)
- [Chat Completions request API](https://developers.openai.com/api/reference/resources/chat/subresources/completions/methods/create)
- [Playwright BrowserContext](https://playwright.dev/docs/api/class-browsercontext)
- [Node.js permission model](https://nodejs.org/docs/latest-v22.x/api/permissions.html)
- [MCP tools specification](https://modelcontextprotocol.io/specification/2025-11-25/server/tools)
- [Zod runtime schemas](https://zod.dev/api)

The project retains its existing driver/function-tool integration. The native
Responses `computer` action protocol is a separate capability and is reported
unsupported by this adapter. Tool calling, image input and structured output
are separate capabilities; only explicit configuration enables images or
structured output. A model identifier and provider access must be supplied by
the operator. No current model choice, price, or account entitlement is guessed.

The Chat Completions adapter sends function tool definitions and parses tool
calls/usage, omits tool fields when no tools are requested, supports configurable
token parameter names, and omits sampling temperature unless configured.
Model-tool execution remains subject to the local executor. The provider's API
does not own GUI authorization, persistent browser handles, or final acceptance.

OS isolation is the code boundary. Node permissions and VM context restrictions
are additional protections, not substitutes for a sandbox. The verified macOS
path uses Seatbelt file/network/process restrictions; the Linux branch must be
validated on its deployment host and must fail closed when unavailable.
