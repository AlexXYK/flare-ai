export interface TitleSettings {
    provider: string;
    model: string;
    temperature: number;
    maxTokens: number;
    prompt: string;
    autoGenerate: boolean;
    autoGenerateAfterPairs: number;
}

export interface ProviderSettings {
    name: string;
    type: string;
    enabled: boolean;
    apiKey?: string;
    baseUrl?: string;
    defaultModel?: string;
    models?: string[];
    visibleModels?: string[];
}

export interface PluginSettings {
    debugLoggingEnabled: boolean;
    autoSaveEnabled: boolean;
    autoSaveInterval: number;
    historyFolder: string;
    flaresFolder: string;
    defaultProvider: string;
    providers: Record<string, ProviderSettings>;
    titleSettings: TitleSettings;
} 