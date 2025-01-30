export interface FlareConfig {
    name: string;
    provider: string;
    model: string;
    enabled: boolean;
    description?: string;
    temperature?: number;
    maxTokens?: number;
    historyWindow?: number;
    handoffWindow?: number;
    systemPrompt?: string;
    stream?: boolean;
    isReasoningModel?: boolean;
    reasoningHeader?: string;
}

export type FlareSettings = FlareConfig;

export interface FlareFile {
    name: string;
    path: string;
}