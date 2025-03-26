import { AIProvider, AIProviderOptions, ProviderSettings } from '../../types/AIProvider';

export interface StreamingOptions {
    stream?: boolean;
    onToken?: (token: string) => void;
    signal?: AbortSignal;
}

/**
 * Base class for all AI providers.
 * Implements common functionality and defines the interface that all providers must follow.
 */
export abstract class BaseProvider implements AIProvider {
    abstract name: string;
    protected models: string[] = [];
    public config: ProviderSettings = {
        type: '',
        name: '',
        enabled: false
    };
    protected abortController?: AbortController;

    /**
     * Set the provider configuration
     */
    setConfig(config: ProviderSettings) {
        this.config = config;
    }

    /**
     * Get a list of available models from the provider.
     * Should be implemented by each provider to fetch their specific models.
     */
    abstract getAvailableModels(): Promise<string[]>;

    /**
     * Send a message to the AI provider and get a response.
     * Should be implemented by each provider to handle their specific API.
     * If streaming is enabled, the provider should call onToken with each token
     * and still return the complete response at the end.
     */
    abstract sendMessage(message: string, options?: AIProviderOptions & StreamingOptions): Promise<string>;

    /**
     * Stop any ongoing request
     */
    stopRequest() {
        if (this.abortController) {
            this.abortController.abort();
            this.abortController = undefined;
        }
    }

    /**
     * Alias for stopRequest for backwards compatibility
     */
    cancelRequest() {
        this.stopRequest();
    }
} 