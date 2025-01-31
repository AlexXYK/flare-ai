import { ProviderManager } from './ProviderManager';
import { ProviderSettings } from '../types/AIProvider';
import { AIProvider } from './aiProviders';
import { OllamaProvider } from './implementations/Ollama/OllamaProvider';
import { OpenAIProvider } from './implementations/OpenAI/OpenAIProvider';
import { OpenRouterProvider } from './implementations/OpenRouter/OpenRouterProvider';

export class MainProviderManager extends ProviderManager {
    public createProvider(settings: ProviderSettings): AIProvider | null {
        try {
            switch (settings.type) {
                case 'ollama':
                    const ollamaProvider = new OllamaProvider(settings.baseUrl || 'http://localhost:11434');
                    ollamaProvider.setConfig(settings);
                    return ollamaProvider;
                case 'openai':
                    const openaiProvider = new OpenAIProvider(settings.apiKey || '', settings.baseUrl);
                    openaiProvider.setConfig(settings);
                    return openaiProvider;
                case 'openrouter':
                    const openrouterProvider = new OpenRouterProvider(settings.apiKey || '');
                    openrouterProvider.setConfig(settings);
                    return openrouterProvider;
                default:
                    console.warn(`Unknown provider type: ${settings.type}`);
                    return null;
            }
        } catch (error) {
            console.error('Failed to create provider:', error);
            return null;
        }
    }
} 