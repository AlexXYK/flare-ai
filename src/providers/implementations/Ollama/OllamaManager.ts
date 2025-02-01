import { AIProvider, ProviderSettings } from '../../../types/AIProvider';
import { OllamaProvider } from './OllamaProvider';
import { ProviderManager } from '../../ProviderManager';
import type FlarePlugin from '../../../../main';

export class OllamaManager extends ProviderManager {
    id = 'ollama';
    name = 'Ollama';
    description = 'Local AI models running through Ollama';

    constructor(plugin: FlarePlugin) {
        super(plugin);
    }

    createProvider(settings: ProviderSettings): AIProvider {
        if (settings.type !== 'ollama') {
            throw new Error('Invalid provider type');
        }

        // Reuse existing provider if settings haven't changed
        if (this.provider && 
            this.provider.config.baseUrl === settings.baseUrl) {
            return this.provider;
        }

        // Create new provider with the configured URL
        const provider = new OllamaProvider(settings.baseUrl || 'http://localhost:11434');
        
        // Set the full config to ensure we have access to visibleModels and other settings
        provider.setConfig(settings);
        
        // Store the provider instance
        this.provider = provider;
        
        return provider;
    }
} 