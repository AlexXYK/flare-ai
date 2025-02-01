import { AIProvider, ProviderSettings } from '../../../types/AIProvider';
import { OpenRouterProvider } from './OpenRouterProvider';
import { ProviderManager } from '../../ProviderManager';
import type FlarePlugin from '../../../../main';

export class OpenRouterManager extends ProviderManager {
    id = 'openrouter';
    name = 'OpenRouter';
    description = 'OpenRouter API provider';

    constructor(plugin: FlarePlugin) {
        super(plugin);
    }

    createProvider(settings: ProviderSettings): AIProvider {
        if (settings.type !== 'openrouter') {
            throw new Error('Invalid provider type');
        }

        // Reuse existing provider if settings haven't changed
        if (this.provider && 
            this.provider.config.apiKey === settings.apiKey) {
            return this.provider;
        }

        // Create new provider
        this.provider = new OpenRouterProvider(settings.apiKey || '');
        this.provider.setConfig(settings);
        
        return this.provider;
    }
} 