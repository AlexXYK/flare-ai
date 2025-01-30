import { TitleSettings } from '../types';
import { ProviderSettings } from './AIProvider';
import { FlareConfig } from '../flares/FlareConfig';

export interface HandoffSettings {
    enabled: boolean;
    template: string;
    defaultTemplate: string;
}

export interface PluginSettings {
    providers: { [key: string]: ProviderSettings };
    flares: { [key: string]: FlareConfig };
    defaultProvider: string;
    defaultFlare: string;
    flaresFolder: string;
    historyFolder: string;
    debugLoggingEnabled: boolean;
    autoSaveEnabled: boolean;
    autoSaveInterval: number;
    maxHistoryFiles: number;
    titleSettings: TitleSettings;
    handoffSettings: HandoffSettings;
}

export const DEFAULT_SETTINGS: Partial<PluginSettings> = {
    providers: {},
    flares: {},
    defaultFlare: 'default',
    flaresFolder: 'FLAREai/flares',
    historyFolder: 'FLAREai/history',
    autoSaveEnabled: true,
    autoSaveInterval: 30,
    maxHistoryFiles: 100,
    debugLoggingEnabled: false,
    titleSettings: {
        provider: '',
        model: '',
        temperature: 0.7,
        maxTokens: 50,
        prompt: 'Based on the chat history above, generate a concise and descriptive title that captures the main topic or purpose of the conversation. The title should be clear and informative, avoiding generic descriptions. Keep it under 50 characters.',
        autoGenerate: false,
        autoGenerateAfterPairs: 2
    },
    handoffSettings: {
        enabled: true,
        template: `System: {systemprompt}

Previous conversation context:
{chathistory}

Continue the conversation naturally, maintaining context while following your core instructions.`,
        defaultTemplate: `System: {systemprompt}

Previous conversation context:
{chathistory}

Continue the conversation naturally, maintaining context while following your core instructions.`
    }
}; 