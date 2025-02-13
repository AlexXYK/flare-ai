import { PluginSettings } from '../types/PluginSettings';

export const PLUGIN_NAME = "FLARE.ai";
export const PLUGIN_VERSION = "1.0.3";
export const PLUGIN_DESC = "A powerful and flexible AI chat interface featuring customizable personas (Flares), multiple provider support, and seamless conversation management.";

export const VIEW_TYPE_AI_CHAT = 'ai-chat-view';

export const DEFAULT_SETTINGS: Partial<PluginSettings> = {
    providers: {},
    defaultProvider: '',
    historyFolder: 'FLAREai/history',
    flaresFolder: 'FLAREai/flares',
    autoSaveEnabled: true,
    titleSettings: {
        provider: '',
        model: '',
        temperature: 0.7,
        maxTokens: 100,
        prompt: 'Generate a concise title for this chat conversation. Do not be verbose or introduce the task. Only output 3-5 words for direct insertion into a filename.',
        autoGenerate: false,
        autoGenerateAfterPairs: 2
    },
}; 