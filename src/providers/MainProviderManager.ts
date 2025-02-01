import { ProviderManager } from './ProviderManager';
import { ProviderSettings } from '../types/AIProvider';
import { AIProvider } from './aiProviders';
import { OllamaProvider } from './implementations/Ollama/OllamaProvider';
import { OpenAIProvider } from './implementations/OpenAI/OpenAIProvider';
import { OpenRouterProvider } from './implementations/OpenRouter/OpenRouterProvider';

export class MainProviderManager extends ProviderManager {
    public createProvider(settings: ProviderSettings): AIProvider | null {
        try {
            let provider: AIProvider;
            
            switch (settings.type) {
                case 'ollama': {
                    const ollamaProvider = new OllamaProvider(settings.baseUrl || 'http://localhost:11434');
                    ollamaProvider.setConfig(settings);
                    provider = ollamaProvider;
                    break;
                }
                case 'openai': {
                    const openaiProvider = new OpenAIProvider(settings.apiKey || '', settings.baseUrl);
                    openaiProvider.setConfig(settings);
                    provider = openaiProvider;
                    break;
                }
                case 'openrouter': {
                    const openrouterProvider = new OpenRouterProvider(settings.apiKey || '');
                    openrouterProvider.setConfig(settings);
                    provider = openrouterProvider;
                    break;
                }
                default:
                    console.warn(`Unknown provider type: ${settings.type}`);
                    return null;
            }
            
            return provider;
        } catch (error) {
            console.error('Failed to create provider:', error);
            return null;
        }
    }
} 