import { resolveProvider } from '../config.js';
import { ProviderError } from './errors.js';
import { createOpenAIProvider } from './openai.js';
import { createAnthropicProvider } from './anthropic.js';
import { createGoogleProvider } from './google.js';

export function createProvider(config, { name = null, model = null } = {}) {
  const runtime = resolveProvider(config, name);
  if (model) runtime.model = model;

  if (!runtime.baseUrl && runtime.type !== 'anthropic' && runtime.type !== 'google') {
    throw new ProviderError(
      `${runtime.label} has no base URL. Run \`hasty setup\` to configure it.`,
      { provider: runtime.label },
    );
  }
  if (runtime.type === 'anthropic' && !runtime.baseUrl) {
    runtime.baseUrl = 'https://api.anthropic.com/v1';
  }
  if (runtime.type === 'google' && !runtime.baseUrl) {
    runtime.baseUrl = 'https://generativelanguage.googleapis.com/v1beta';
  }

  switch (runtime.type) {
    case 'anthropic':
      return createAnthropicProvider(runtime);
    case 'google':
      return createGoogleProvider(runtime);
    case 'openai':
      return createOpenAIProvider(runtime);
    default:
      throw new ProviderError(`Unknown provider type: ${runtime.type}`, {
        provider: runtime.label,
      });
  }
}

export { ProviderError, friendlyProviderError, isAbortError } from './errors.js';
