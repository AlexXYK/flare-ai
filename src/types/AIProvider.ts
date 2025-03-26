import type { ProviderManager } from '../providers/ProviderManager';

export interface AIProvider {
    sendMessage(message: string, options?: AIProviderOptions): Promise<string>;
    getModels?(): Promise<string[]>;
    getAvailableModels(): Promise<string[]>;
    config: ProviderSettings;
    setConfig(config: ProviderSettings): void;
    cancelRequest?(): void;
}

export interface AIProviderOptions {
    model?: string;
    temperature?: number;
    maxTokens?: number;
    systemPrompt?: string;
    messageHistory?: Array<{role: string; content: string; settings?: any}>;
    contextWindow?: number;
    flare?: string;
    handoffSettings?: HandoffSettings;
    isFlareSwitch?: boolean;
    stream?: boolean;
    onToken?: (token: string) => void;
    signal?: AbortSignal;
}

export interface ProviderSettings {
    type: string;
    name: string;
    enabled: boolean;
    apiKey?: string;
    baseUrl?: string;
    defaultModel?: string;
    visibleModels?: string[];
    availableModels?: string[];
    [key: string]: any;
}

export interface HandoffSettings {
    template: string;
    enabled: boolean;
    defaultTemplate: string;
}

export interface PluginSettings {
    providers: { [key: string]: ProviderSettings };
    defaultProvider: string;
    flaresFolder: string;
    historyFolder: string;
    autoSaveEnabled: boolean;
    autoSaveInterval: number;
    maxHistoryFiles: number;
    defaultFlare?: string;
    flareSwitchPrompt?: string;
    titleSettings: {
        provider: string;
        model: string;
        temperature: number;
        maxTokens: number;
        prompt: string;
    };
    handoffSettings: HandoffSettings;
}

export interface FlarePlugin {
    settings: PluginSettings;
    providerManager: ProviderManager;
    saveData(settings: PluginSettings): Promise<void>;
    loadData(): Promise<void>;
    app: any;
}

export interface MessageSettings {
    provider: string;
    model: string;
    temperature: number;
    flare?: string;
    timestamp?: number;
    maxTokens?: number;
    contextWindow?: number;
    handoffContext?: number;
    isFlareSwitch?: boolean;
    stream?: boolean;
}

export interface MessageOptions {
    messageHistory?: Array<{role: string; content: string}>;
    stream?: boolean;
    temperature?: number;
    maxTokens?: number;
    contextWindow?: number;
    handoffContext?: number;
    flare?: string;
    provider?: string;
    model?: string;
    onToken?: (token: string) => void;
    signal?: AbortSignal;
} 