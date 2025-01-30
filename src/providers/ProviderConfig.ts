export interface ProviderSettings {
    name: string;
    type: string;
    enabled: boolean;
    defaultModel?: string;
    visibleModels?: string[];
    apiKey?: string;
    baseUrl?: string;
}

export interface ProviderConfig {
    [key: string]: ProviderSettings;
}

export const DEFAULT_PROVIDER_SETTINGS: ProviderSettings = {
    name: '',
    type: '',
    enabled: true,
    defaultModel: '',
    visibleModels: [],
    apiKey: '',
    baseUrl: ''
}; 