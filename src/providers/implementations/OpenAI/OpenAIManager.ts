import { AIProvider, ProviderSettings } from '../../../types/AIProvider';
import { OpenAIProvider } from './OpenAIProvider';
import { ProviderManager } from '../../ProviderManager';
import type FlarePlugin from '../../../../main';

export class OpenAIManager extends ProviderManager {
    id = 'openai';
    name = 'OpenAI';
    description = 'OpenAI GPT models';
    protected provider: OpenAIProvider | null = null;

    constructor(plugin: FlarePlugin) {
        super(plugin);
    }

    createProvider(settings: ProviderSettings): AIProvider {
        if (settings.type !== 'openai') {
            throw new Error('Invalid provider type');
        }

        // Reuse existing provider if settings haven't changed
        if (this.provider && 
            this.provider.config.apiKey === settings.apiKey &&
            this.provider.config.endpoint === settings.endpoint) {
            return this.provider;
        }

        // Create new provider
        const provider = new OpenAIProvider(settings.apiKey || '', settings.endpoint);
        provider.setConfig(settings);
        this.provider = provider;
        
        return provider;
    }
} 