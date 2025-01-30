import { PluginSettings } from '../types/PluginSettings';

export const PLUGIN_NAME = "FLARE.ai";
export const PLUGIN_VERSION = "1.0.0";
export const PLUGIN_DESC = "A powerful and flexible AI chat interface featuring customizable personas (Flares), multiple provider support, and seamless conversation management.";

export const VIEW_TYPE_AI_CHAT = 'ai-chat-view';

export const DEFAULT_SETTINGS: Partial<PluginSettings> = {
    providers: {},
    defaultProvider: '',
    historyFolder: 'FLAREai/history',
    flaresFolder: 'FLAREai/flares',
    autoSaveEnabled: true,
    autoSaveInterval: 30,
    titleSettings: {
        provider: '',
        model: '',
        temperature: 0.7,
        maxTokens: 100,
        prompt: 'Generate a concise title for this chat conversation.',
        autoGenerate: false,
        autoGenerateAfterPairs: 2
    },
    handoffSettings: {
        template: `System: {systemprompt}

Previous conversation context:
{chathistory}

Continue the conversation naturally, maintaining context while following your core instructions.`,
        enabled: true,
        defaultTemplate: `System: {systemprompt}

Previous conversation context:
{chathistory}

Continue the conversation naturally, maintaining context while following your core instructions.`
    }
}; 