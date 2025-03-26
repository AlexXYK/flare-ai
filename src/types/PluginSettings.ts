import { TitleSettings } from '../types';
import { ProviderSettings } from './AIProvider';
import { FlareConfig } from '../flares/FlareConfig';

export interface HandoffSettings {
    enabled: boolean;
    template: string;
    defaultTemplate: string;
}

/** Settings for chat export */
export interface ExportSettings {
    /** Where exported chats are saved */
    exportFolder: string;
    /** Template for frontmatter in exported chats */
    frontmatterTemplate: string;
    /** Template for message metadata in exported chats */
    metadataTemplate: string;
    /** Whether to include system messages in exports */
    includeSystemMessages: boolean;
    /** Whether to include reasoning blocks in exports */
    includeReasoningBlocks: boolean;
}

export interface PluginSettings {
    version: string;
    flaresFolder: string;
    historyFolder: string;
    exportFolder: string;
    providers: { [key: string]: ProviderSettings };
    defaultProvider: string;
    defaultFlare: string;
    autoSaveEnabled: boolean;
    autoSaveInterval: number;
    maxHistoryFiles: number;
    dateFormat: string;
    titleSettings: TitleSettings;
    handoffSettings: HandoffSettings;
    exportSettings: ExportSettings;
}

export const DEFAULT_SETTINGS: Partial<PluginSettings> = {
    version: '1.0.0',
    flaresFolder: 'FLAREai/flares',
    historyFolder: 'FLAREai/history',
    exportFolder: 'FLAREai/exports',
    providers: {},
    defaultProvider: '',
    defaultFlare: '',
    autoSaveEnabled: true,
    autoSaveInterval: 30,
    maxHistoryFiles: 100,
    dateFormat: 'MM-DD-YYYY',
    titleSettings: {
        provider: '',
        model: '',
        temperature: 0.7,
        maxTokens: 50,
        autoGenerate: false,
        autoGenerateAfterPairs: 2,
        prompt: `Generate a short, descriptive title (5-7 words) for this chat conversation. 
The title should reflect the main topic or purpose of the conversation.
Return ONLY the title text without quotes, bullets, or any formatting.`
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
    },
    exportSettings: {
        exportFolder: 'FLAREai/exports',
        frontmatterTemplate: `---
title: {{title}}
date: {{date}}
---`,
        metadataTemplate: '',
        includeSystemMessages: true,
        includeReasoningBlocks: true
    }
}; 