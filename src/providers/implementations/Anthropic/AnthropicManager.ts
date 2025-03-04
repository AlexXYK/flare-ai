import { AIProvider, ProviderSettings } from '../../../types/AIProvider';
import { AnthropicProvider } from './AnthropicProvider';
import { ProviderManager } from '../../ProviderManager';
import type FlarePlugin from '../../../../main';

export class AnthropicManager extends ProviderManager {
    id = 'anthropic';
    name = 'Anthropic';
    description = 'Anthropic Claude models';
    protected provider: AnthropicProvider | null = null;

    constructor(plugin: FlarePlugin) {
        super(plugin);
    }

    createProvider(settings: ProviderSettings): AIProvider {
        if (settings.type !== 'anthropic') {
            throw new Error('Invalid provider type');
        }

        // Reuse existing provider if settings haven't changed
        if (this.provider && 
            this.provider.config.apiKey === settings.apiKey &&
            this.provider.config.baseUrl === settings.baseUrl) {
            return this.provider;
        }

        // Create new provider
        const provider = new AnthropicProvider(settings.apiKey || '', settings.baseUrl);
        provider.setConfig(settings);
        this.provider = provider;
        
        return provider;
    }
} 