// Re-export types from AIProvider
export type { 
    AIProvider, 
    AIProviderOptions, 
    ProviderSettings,
    HandoffSettings
} from '../types/AIProvider';

// Re-export plugin settings
export type { PluginSettings } from '../types/PluginSettings';

// Export base provider
export { BaseProvider } from './base/BaseProvider';

// Export OpenAI implementation
export { OpenAIProvider } from './implementations/OpenAI/OpenAIProvider';
export { OpenAIManager } from './implementations/OpenAI/OpenAIManager';

// Export Ollama implementation
export { OllamaProvider } from './implementations/Ollama/OllamaProvider';
export { OllamaManager } from './implementations/Ollama/OllamaManager';

// Export OpenRouter implementation
export { OpenRouterProvider } from './implementations/OpenRouter/OpenRouterProvider';
export { OpenRouterManager } from './implementations/OpenRouter/OpenRouterManager';

// Export Anthropic implementation
export { AnthropicProvider } from './implementations/Anthropic/AnthropicProvider';
export { AnthropicManager } from './implementations/Anthropic/AnthropicManager';

// Export Gemini implementation
export { GeminiProvider } from './implementations/Gemini/GeminiProvider';
export { GeminiManager } from './implementations/Gemini/GeminiManager'; 