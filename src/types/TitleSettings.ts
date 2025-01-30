export interface TitleSettings {
    provider: string;
    model: string;
    temperature: number;
    maxTokens: number;
    prompt: string;
    autoGenerate: boolean;
    autoGenerateAfterPairs: number;
} 