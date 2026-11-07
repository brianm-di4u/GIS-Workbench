// Lazy Anthropic SDK block (REQ-AI-02/03): the official @anthropic-ai/sdk (MIT) behind the AI
// Assistant's Claude connections. Loaded on the first request a Claude connection sends
// (ai/providers.js AnthropicProvider), so the file's start-up does not parse it.

import Anthropic from '@anthropic-ai/sdk';

(globalThis.__lib ??= {})['js-anthropic'] = { Anthropic };
