// Lazy 2.4 local AI block (REQ-GAP-56/57, REQ-LAI-04/05; 2.4 group extai): whole-scene detection,
// the SAM 2.1 benchmark, Moondream2 drafts, the change mask and user ONNX models
// (features/ai-local24.js, ai/user-models.js, ai/bpe-tokenizer.js). Loaded the first time one of
// those commands or app.aiLocal functions runs (features/ai-local.js). Its imports of the app's
// stateful modules are the app's own (build/host-modules.mjs).

import { installAi24 } from '../features/ai-local24.js';

(globalThis.__lib ??= {})['js-ai24'] = { installAi24 };
