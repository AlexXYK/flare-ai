import { AIProvider, ProviderSettings } from '../../../types/AIProvider';
import { GeminiProvider } from './GeminiProvider';
import { ProviderManager } from '../../ProviderManager';
import type FlarePlugin from '../../../../main';

export class GeminiManager extends ProviderManager {
    id = 'gemini';
    name = 'Gemini';
    description = 'Google Gemini AI models';
    protected provider: GeminiProvider | null = null;

    constructor(plugin: FlarePlugin) {
        super(plugin);
    }

    createProvider(settings: ProviderSettings): AIProvider {
        if (settings.type !== 'gemini') {
            throw new Error('Invalid provider type');
        }

        // Reuse existing provider if settings haven't changed
        if (this.provider && 
            this.provider.config.apiKey === settings.apiKey &&
            this.provider.config.baseUrl === settings.baseUrl) {
            return this.provider;
        }

        // Create new provider
        const provider = new GeminiProvider(settings.apiKey || '', settings.baseUrl);
        provider.setConfig(settings);
        
        // Only initialize visibleModels if it's missing entirely
        // This preserves any custom models that the user has added
        if (!settings.visibleModels) {
            settings.visibleModels = [];
        }
        
        this.provider = provider;
        
        return provider;
    }
} 