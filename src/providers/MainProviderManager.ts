import { ProviderManager } from './ProviderManager';
import { ProviderSettings } from '../types/AIProvider';
import { AIProvider } from './aiProviders';
import { OllamaProvider } from './implementations/Ollama/OllamaProvider';
import { OpenAIProvider } from './implementations/OpenAI/OpenAIProvider';
import { OpenRouterProvider } from './implementations/OpenRouter/OpenRouterProvider';
import { AnthropicProvider } from './implementations/Anthropic/AnthropicProvider';
import { GeminiProvider } from './implementations/Gemini/GeminiProvider';

export class MainProviderManager extends ProviderManager {
    public createProvider(settings: ProviderSettings): AIProvider | null {
        try {
            let provider: AIProvider;
            
            switch (settings.type) {
                case 'ollama': {
                    const ollamaProvider = new OllamaProvider(
                        settings.baseUrl !== undefined && settings.baseUrl !== null && settings.baseUrl !== '' 
                            ? settings.baseUrl 
                            : 'http://localhost:11434'
                    );
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
                case 'anthropic': {
                    const anthropicProvider = new AnthropicProvider(settings.apiKey || '', settings.baseUrl);
                    anthropicProvider.setConfig(settings);
                    provider = anthropicProvider;
                    break;
                }
                case 'gemini': {
                    const geminiProvider = new GeminiProvider(settings.apiKey || '', settings.baseUrl);
                    geminiProvider.setConfig(settings);
                    provider = geminiProvider;
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
    
    async cleanup(): Promise<void> {
        // Clean up all providers if needed
        for (const [id, provider] of this.plugin.providers.entries()) {
            try {
                await provider.cleanup?.();
            } catch (error) {
                console.error(`Error cleaning up provider ${id}:`, error);
            }
        }
        return Promise.resolve();
    }
} 