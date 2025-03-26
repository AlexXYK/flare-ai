import { TFile, TFolder, Notice, normalizePath, MarkdownRenderer } from 'obsidian';
import type FlarePlugin from '../../main';
import { getErrorMessage } from '../utils/errors';

interface ChatMessage {
    role: 'user' | 'assistant' | 'system';
    content: string;
    timestamp: number;
    settings: {
        provider?: string;
        providerName?: string;
        providerType?: string;
        model: string;
        temperature: number;
        flare?: string;
        timestamp?: number;
        isReasoningModel?: boolean;
        reasoningHeader?: string;
        maxTokens?: number;
        contextWindow?: number;
        handoffContext?: number;
    };
}

interface ChatHistory {
    date: number;
    lastModified: number;
    title: string;
    flare?: string;
    provider?: string;
    providerName?: string;
    providerType?: string;
    model: string;
    temperature: number;
    messages: ChatMessage[];
}

interface FrontMatter {
    date?: number;
    lastModified?: number;
    title?: string;
    flare?: string;
    [key: string]: string | number | undefined;  // Allow for additional string/number properties
}

export class ChatHistoryManager {
    private currentHistory: ChatHistory | null = null;
    private currentFile: TFile | null = null;
    private unsavedChanges: boolean = false;

    constructor(private plugin: FlarePlugin) {}

    async createNewHistory(title?: string) {
        try {
            // Create new history object with default values
            const now = new Date();
            
            // Get default provider info
            const defaultProviderId = this.plugin.settings.defaultProvider || 'default';
            const defaultProvider = this.plugin.settings.providers[defaultProviderId];
            const defaultModel = defaultProvider?.defaultModel || 'default';
            
            // Include provider name and type for better cross-device compatibility
            this.currentHistory = {
                date: now.getTime(),
                lastModified: now.getTime(),
                title: title || 'New Chat',
                messages: [],
                provider: defaultProviderId,
                providerName: defaultProvider?.name || 'Default Provider',
                providerType: defaultProvider?.type || '',
                model: defaultModel,
                temperature: 0.7
            };

            // Only create file if auto-save is enabled
            if (this.plugin.settings.autoSaveEnabled) {
                // Create file path
                const basePath = this.plugin.settings.historyFolder;
                
                // Ensure folder exists
                await this.ensureFolderExists(basePath);

                // Create a user-friendly date-based filename
                const dateStr = this.formatDate(now, this.plugin.settings.dateFormat || 'MM-DD-YYYY');
                
                // Try to create file with date-based name, append number if exists
                let counter = 0;
                let fileName: string;
                let filePath: string;
                
                do {
                    fileName = counter === 0 ? 
                        `chat-${dateStr}.md` : 
                        `chat-${dateStr}-${counter}.md`;
                    filePath = `${basePath}/${fileName}`;
                    counter++;
                } while (await this.plugin.app.vault.adapter.exists(filePath));

                // Use the filename (without extension) as the title
                this.currentHistory.title = fileName.slice(0, -3); // Remove .md extension

                // Create file with empty frontmatter first
                this.currentFile = await this.plugin.app.vault.create(filePath, '---\n---\n');
                
                if (!this.currentFile) {
                    throw new Error('Failed to create history file');
                }

                // Initialize frontmatter and content
                await this.saveCurrentHistory(true, false);
            }

            this.unsavedChanges = false;
            return this.currentHistory;
        } catch (error: unknown) {
            const errorMessage = `Failed to create new history: ${getErrorMessage(error)}`;
            new Notice(errorMessage);
            console.error(errorMessage, error);
            throw new Error(errorMessage);
        }
    }

    private formatDate(date: Date, format: string): string {
        const year = date.getFullYear();
        const month = String(date.getMonth() + 1).padStart(2, '0');
        const day = String(date.getDate()).padStart(2, '0');
        const shortYear = String(year).slice(-2);

        switch (format) {
            case 'DD-MM-YYYY':
                return `${day}-${month}-${year}`;
            case 'YYYY-MM-DD':
                return `${year}-${month}-${day}`;
            case 'MM-DD-YY':
                return `${month}-${day}-${shortYear}`;
            case 'DD-MM-YY':
                return `${day}-${month}-${shortYear}`;
            case 'YY-MM-DD':
                return `${shortYear}-${month}-${day}`;
            case 'MM-DD-YYYY':
            default:
                return `${month}-${day}-${year}`;
        }
    }

    async loadHistory(file: TFile): Promise<void> {
        try {
            // Save current history if exists
            if (this.unsavedChanges) {
                await this.saveCurrentHistory(false, false);
            }

            // Reset current history first
            this.currentHistory = null;
            this.currentFile = null;

            // Get file metadata from cache
            const fileCache = this.plugin.app.metadataCache.getFileCache(file);
            if (!fileCache || !fileCache.frontmatter) {
                throw new Error('Invalid history file format: missing frontmatter');
            }

            // Read file content using cached read for better performance
            const content = await this.plugin.app.vault.cachedRead(file);
            
            // Extract content after frontmatter in a way that won't be confused by "---" in the content
            let messagesContent = '';
            if (content.startsWith('---\n')) {
                const secondFrontmatterMarker = content.indexOf('\n---\n', 4);
                if (secondFrontmatterMarker !== -1) {
                    messagesContent = content.substring(secondFrontmatterMarker + 5); // Skip past the frontmatter
                }
            }
            
            const messages = this.parseMessages(messagesContent);

            // Create new history object
            const providerId = fileCache.frontmatter.provider || this.plugin.settings.defaultProvider || 'default';
            const providerSettings = this.plugin.settings.providers[providerId];
            
            this.currentHistory = {
                date: fileCache.frontmatter.date || Date.now(),
                lastModified: fileCache.frontmatter['last-modified'] || Date.now(),
                title: fileCache.frontmatter.title || file.basename.split('-').slice(1).join('-'), // Remove timestamp prefix
                flare: fileCache.frontmatter.flare,
                provider: providerId,
                providerName: fileCache.frontmatter.providerName || providerSettings?.name || 'Default Provider',
                providerType: fileCache.frontmatter.providerType || providerSettings?.type || '',
                model: fileCache.frontmatter.model || providerSettings?.defaultModel || 'default',
                temperature: typeof fileCache.frontmatter.temperature === 'number' ? fileCache.frontmatter.temperature : 0.7,
                messages: messages || []
            };

            this.currentFile = file;
            this.unsavedChanges = false;
        } catch (error) {
            const errorMessage = 'Failed to load history: ' + getErrorMessage(error);
            console.error('Error loading history:', error);
            new Notice(errorMessage);
            // Reset state on error
            this.currentHistory = null;
            this.currentFile = null;
            throw new Error(errorMessage);
        }
    }

    async addMessage(message: Partial<ChatMessage>): Promise<void> {
        if (!this.currentHistory) {
            await this.createNewHistory();
        }

        if (this.currentHistory) {
            const time = message.timestamp ?? Date.now();
            const fullMessage: ChatMessage = {
                role: message.role || 'user',
                content: message.content || '',
                timestamp: time,
                settings: {
                    ...(message.settings ?? {}), 
                    timestamp: time,
                    provider: message.settings?.provider || this.currentHistory.provider || 'default',
                    providerName: message.settings?.providerName || this.currentHistory.providerName || 'Default Provider',
                    providerType: message.settings?.providerType || this.currentHistory.providerType || '',
                    model: message.settings?.model || this.currentHistory.model || 'default',
                    temperature: Number(message.settings?.temperature || this.currentHistory.temperature || 0),
                }
            } as ChatMessage;
            
            this.currentHistory.messages.push(fullMessage);
            this.currentHistory.lastModified = Date.now();
            this.unsavedChanges = true;

            // Only save to disk if auto-save is enabled
            if (this.plugin.settings.autoSaveEnabled) {
                await this.saveCurrentHistory(false, false);
            }
            
            // Notify other components about the change
            this.plugin.app.workspace.trigger('chat-history-changed');
        }
    }

    async saveCurrentHistory(force: boolean = false, showNotice: boolean = false): Promise<void> {
        if (!this.currentHistory || (!this.unsavedChanges && !force)) {
            return;
        }

        try {
            // If we don't have a file yet and we need to save, create one
            if (!this.currentFile && (this.plugin.settings.autoSaveEnabled || force)) {
                const basePath = this.plugin.settings.historyFolder;
                await this.ensureFolderExists(basePath);

                const now = new Date();
                const dateStr = this.formatDate(now, this.plugin.settings.dateFormat || 'MM-DD-YYYY');
                
                let counter = 0;
                let fileName: string;
                let filePath: string;
                
                do {
                    fileName = counter === 0 ? 
                        `chat-${dateStr}.md` : 
                        `chat-${dateStr}-${counter}.md`;
                    filePath = normalizePath(`${basePath}/${fileName}`);
                    counter++;
                } while (await this.plugin.app.vault.adapter.exists(filePath));

                this.currentHistory.title = fileName.slice(0, -3);
                
                // Create file with empty frontmatter first
                this.currentFile = await this.plugin.app.vault.create(filePath, '---\n---\n');
            }

            // Only save to disk if we have a file and either auto-save is enabled or we're forced
            if (this.currentFile && (this.plugin.settings.autoSaveEnabled || force)) {
                // Deduplicate messages before saving
                const uniqueMessages = new Map<string, ChatMessage>();
                for (const msg of this.currentHistory.messages) {
                    // Use role, timestamp, and content hash as key to ensure truly unique messages
                    const key = `${msg.role}-${msg.timestamp}-${msg.content.length}`;
                    if (!uniqueMessages.has(key) || force) {
                        uniqueMessages.set(key, msg);
                    }
                }

                this.currentHistory.messages = Array.from(uniqueMessages.values());
                this.currentHistory.lastModified = Date.now();

                // Update frontmatter
                await this.plugin.app.fileManager.processFrontMatter(this.currentFile, (frontmatter) => {
                    frontmatter.date = this.currentHistory?.date;
                    frontmatter['last-modified'] = this.currentHistory?.lastModified;
                    frontmatter.title = this.currentHistory?.title;
                    frontmatter.flare = this.currentHistory?.flare;
                    frontmatter.provider = this.currentHistory?.provider;
                    frontmatter.providerName = this.currentHistory?.providerName;
                    frontmatter.providerType = this.currentHistory?.providerType;
                    frontmatter.model = this.currentHistory?.model;
                    frontmatter.temperature = this.currentHistory?.temperature;
                });

                // Format messages
                const messages = this.currentHistory.messages
                    .filter(msg => msg && msg.role && ['system', 'user', 'assistant'].includes(msg.role))
                    .map(msg => {
                        const header = `## ${msg.role.charAt(0).toUpperCase() + msg.role.slice(1)}`;
                        
                        // Add settings JSON comment with all necessary fields
                        const settings = {
                            provider: msg.settings?.provider || 'default',
                            model: msg.settings?.model || 'default',
                            temperature: Number(msg.settings?.temperature || 0),
                            timestamp: msg.timestamp,
                            flare: msg.settings?.flare,
                            isReasoningModel: msg.settings?.isReasoningModel,
                            reasoningHeader: msg.settings?.reasoningHeader,
                            maxTokens: msg.settings?.maxTokens,
                            contextWindow: msg.settings?.contextWindow,
                            handoffContext: msg.settings?.handoffContext,
                        };
                        
                        return `${header}\n${msg.content}\n<!-- settings: ${JSON.stringify(settings)} -->\n`;
                    }).join('\n');

                // Read current content to preserve frontmatter
                const content = await this.plugin.app.vault.read(this.currentFile);
                
                // Instead of using regex to match frontmatter, which can be confused with "---" in content,
                // check if the file starts with "---" and find the end of the first frontmatter block
                let newContent = content;
                if (content.startsWith('---\n')) {
                    const secondFrontmatterMarker = content.indexOf('\n---\n', 4);
                    if (secondFrontmatterMarker !== -1) {
                        // Extract just the frontmatter block
                        const frontmatterBlock = content.substring(0, secondFrontmatterMarker + 5); // include the trailing \n
                        // Append new message content
                        newContent = `${frontmatterBlock}\n${messages}`;
                        await this.plugin.app.vault.modify(this.currentFile, newContent);
                    } else {
                        // Fallback: create properly formatted content
                        newContent = `---\n---\n\n${messages}`;
                        await this.plugin.app.vault.modify(this.currentFile, newContent);
                    }
                } else {
                    // If for some reason there is no frontmatter, create it
                    newContent = `---\n---\n\n${messages}`;
                    await this.plugin.app.vault.modify(this.currentFile, newContent);
                }
                
                if (showNotice) {
                    new Notice("Chat history saved successfully");
                }
                
                // Trigger event for other components
                this.plugin.app.workspace.trigger('chat-history-changed');
            }

            this.unsavedChanges = false;
        } catch (error) {
            const errorMessage = `Failed to save chat history: ${getErrorMessage(error)}`;
            console.error("Failed to save history:", error);
            if (showNotice) {
                new Notice(errorMessage);
            }
            throw new Error(errorMessage);
        }
    }

    private parseMessages(content: string): ChatMessage[] {
        const messages: ChatMessage[] = [];
        
        // If no content, return empty array
        if (!content || content.trim().length === 0) {
            return messages;
        }
        
        try {
            // First, find all message headers (lines starting with ## )
            const headerMatches = Array.from(content.matchAll(/^## (User|Assistant|System)\s*$/gim));
            
            // If no headers found, return empty array
            if (headerMatches.length === 0) {
                return messages;
            }
            
            // Create message blocks by finding the content between headers
            for (let i = 0; i < headerMatches.length; i++) {
                const match = headerMatches[i];
                
                // Skip if no match index
                if (match.index === undefined) continue;
                
                // Find current header and next header positions
                const currentHeaderPos = match.index;
                const nextHeaderPos = (i < headerMatches.length - 1) ? headerMatches[i+1].index : content.length;
                
                // Extract the entire block including the header
                const fullBlock = content.substring(currentHeaderPos, nextHeaderPos).trim();
                
                // Parse the role from the header (the capture group in the regex)
                const role = match[1].toLowerCase() as 'user' | 'assistant' | 'system';
                
                // Skip if not a valid role
                if (!['user', 'assistant', 'system'].includes(role)) {
                    continue;
                }
                
                // Find the settings comment at the end of the block
                // We'll use a more specific pattern that looks for settings at the end
                const settingsMatch = fullBlock.match(/<!-- settings: (.*?) -->\s*$/);
                let settingsData: Record<string, any> = {
                    provider: 'default',
                    model: 'default',
                    temperature: 0
                };
                
                // Extract and parse settings
                if (settingsMatch && settingsMatch[1]) {
                    try {
                        // Handle complex JSON that might have nested structures
                        let jsonStr = settingsMatch[1];
                        const parsedSettings = JSON.parse(jsonStr);
                        
                        // Validate and merge with default settings
                        settingsData = {
                            ...settingsData,
                            ...parsedSettings,
                            // Ensure required properties have the correct types
                            provider: typeof parsedSettings.provider === 'string' ? parsedSettings.provider : 'default',
                            model: typeof parsedSettings.model === 'string' ? parsedSettings.model : 'default',
                            temperature: typeof parsedSettings.temperature === 'number' ? parsedSettings.temperature : 0
                        };
                    } catch (e) {
                        console.warn('Failed to parse settings JSON:', e);
                    }
                }
                
                // Get timestamp from settings or default to now
                const timestamp = settingsData?.timestamp || Date.now();
                
                // Extract message content - everything after the header line up to the settings comment
                let messageContent = '';
                
                // Find the end of the header line
                const headerEndPos = fullBlock.indexOf('\n');
                if (headerEndPos !== -1) {
                    // Get everything after the header
                    messageContent = fullBlock.substring(headerEndPos + 1);
                    
                    // Remove the settings comment at the end if it exists
                    if (settingsMatch) {
                        const settingsPos = messageContent.lastIndexOf('<!-- settings:');
                        if (settingsPos !== -1) {
                            messageContent = messageContent.substring(0, settingsPos).trim();
                        }
                    }
                }
                
                // Create settings object
                const settings: ChatMessage['settings'] = {
                    provider: settingsData.provider,
                    model: settingsData.model,
                    temperature: Number(settingsData.temperature),
                    flare: settingsData.flare,
                    isReasoningModel: settingsData.isReasoningModel,
                    reasoningHeader: settingsData.reasoningHeader,
                    maxTokens: settingsData.maxTokens,
                    contextWindow: settingsData.contextWindow,
                    handoffContext: settingsData.handoffContext,
                };
                
                // Add the message
                messages.push({
                    role,
                    content: messageContent,
                    timestamp,
                    settings
                });
            }
            
            return messages;
        } catch (error) {
            console.error('Failed to parse message blocks:', error);
            return [];
        }
    }

    private sanitizeFileName(name: string): string {
        return name
            .toLowerCase()
            .replace(/[^a-z0-9]+/g, '-')
            .replace(/(^-|-$)/g, '');
    }

    private async ensureFolderExists(path: string): Promise<void> {
        const normalizedPath = normalizePath(path);
        const exists = await this.plugin.app.vault.adapter.exists(normalizedPath);
        if (!exists) {
            await this.plugin.app.vault.createFolder(normalizedPath);
        }
    }

    getCurrentHistory(): ChatHistory | null {
        return this.currentHistory;
    }

    getCurrentFile(): TFile | null {
        return this.currentFile;
    }

    hasUnsavedChanges(): boolean {
        return this.unsavedChanges;
    }

    async cleanup(): Promise<void> {
        if (this.unsavedChanges) {
            await this.saveCurrentHistory(false, false);
        }
    }

    async generateTitle(): Promise<string> {
        if (!this.currentHistory || !this.currentFile) {
            throw new Error('No active chat to retitle');
        }

        try {
            // Get title settings
            const settings = this.plugin.settings.titleSettings;
            const provider = await this.plugin.getProviderInstance(settings.provider);
            if (!provider) {
                throw new Error('Title generation provider not found');
            }

            // Format chat history for the prompt
            const historyText = this.currentHistory.messages
                .filter(msg => msg.role !== 'system') // Exclude system messages from title generation
                .map(msg => `${msg.role}: ${msg.content.substring(0, 150)}...`) // Limit message length
                .join('\n\n');

            // Generate title with retry logic
            let response = '';
            let attempts = 0;
            const maxAttempts = 3;

            while (!response && attempts < maxAttempts) {
                try {
                    response = await provider.sendMessage(
                        settings.prompt + '\n\nChat History:\n' + historyText,
                        {
                            model: settings.model,
                            temperature: settings.temperature,
                            maxTokens: settings.maxTokens
                        }
                    );
                } catch (error) {
                    console.error(`Title generation attempt ${attempts + 1} failed:`, error);
                    attempts++;
                    if (attempts === maxAttempts) {
                        throw new Error('Failed to generate title after multiple attempts');
                    }
                    // Wait before retrying
                    await new Promise(resolve => setTimeout(resolve, 1000));
                }
            }

            // Clean up the response
            const newTitle = response.trim()
                .replace(/^["']|["']$/g, '') // Remove quotes
                .replace(/[<>:"\\\/|?*]/g, '-') // Replace invalid filename characters
                .substring(0, 50); // Enforce length limit

            // Ensure title starts with chat- prefix
            const finalTitle = newTitle.startsWith('chat-') ? newTitle : `chat-${newTitle}`;

            // Update both the history object title and file name
            const oldTitle = this.currentHistory.title;
            this.currentHistory.title = finalTitle;
            
            // Save changes to current file first (this will update the frontmatter)
            this.unsavedChanges = true;  // Force a save by marking as unsaved
            await this.saveCurrentHistory(true, false);  // Force immediate save but don't show notice

            // Now rename the file
            const oldPath = this.currentFile.path;
            const newPath = oldPath.replace(oldTitle, finalTitle);
            
            try {
                await this.plugin.app.fileManager.renameFile(this.currentFile, newPath);
                const newFile = this.plugin.app.vault.getAbstractFileByPath(newPath);
                
                if (!(newFile instanceof TFile)) {
                    throw new Error('Failed to get new file reference after rename');
                }
                
                this.currentFile = newFile;
            } catch (error) {
                // Revert title in memory if rename fails
                this.currentHistory.title = oldTitle;
                this.unsavedChanges = true;  // Mark as unsaved to ensure reversion is saved
                await this.saveCurrentHistory(true, false);  // Force save of the reversion but don't show notice
                console.error('Failed to rename file:', error);
                throw new Error('Failed to rename chat file');
            }
            
            return finalTitle;
        } catch (error: unknown) {
            const errorMessage = 'Failed to generate title: ' + getErrorMessage(error);
            new Notice(errorMessage);
            throw new Error(errorMessage);
        }
    }

    async clearHistory(): Promise<void> {
        if (this.currentHistory) {
            // Clear messages but keep metadata
            this.currentHistory.messages = [];
            this.currentHistory.lastModified = Date.now();
            this.unsavedChanges = true;
        }
    }

    /**
     * Exports the current chat history to a file in the export folder
     * @returns Promise<TFile> The exported file
     * @throws Error if export fails
     */
    async exportHistory(): Promise<TFile> {
        if (!this.currentHistory || this.currentHistory.messages.length === 0) {
            throw new Error("No chat history to export");
        }

        try {
            // Ensure export folder exists
            const exportFolder = this.plugin.settings.exportSettings?.exportFolder || 'FLAREai/exports';
            await this.ensureFolderExists(exportFolder);

            // Generate export filename
            const now = new Date();
            const dateStr = this.formatDate(now, this.plugin.settings.dateFormat || 'MM-DD-YYYY');
            const title = this.currentHistory.title || 'Chat';
            const sanitizedTitle = this.sanitizeFileName(title);
            
            let fileName = `${sanitizedTitle}-${dateStr}.md`;
            let filePath = normalizePath(`${exportFolder}/${fileName}`);
            
            // Check if file exists and generate unique name if needed
            let counter = 1;
            while (await this.plugin.app.vault.adapter.exists(filePath)) {
                fileName = `${sanitizedTitle}-${dateStr}-${counter}.md`;
                filePath = normalizePath(`${exportFolder}/${fileName}`);
                counter++;
            }

            // Generate content using templates
            const content = await this.generateExportContent();
            
            // Create file
            const file = await this.plugin.app.vault.create(filePath, content);
            
            return file;
        } catch (error) {
            const errorMessage = `Failed to export chat history: ${getErrorMessage(error)}`;
            console.error("Failed to export chat history:", error);
            new Notice(errorMessage);
            throw new Error(errorMessage);
        }
    }

    /**
     * Generates the content for an exported chat history
     * @returns Promise<string> The formatted content
     */
    private async generateExportContent(): Promise<string> {
        if (!this.currentHistory) {
            throw new Error("No chat history to export");
        }

        try {
            // Get templates from settings
            const exportSettings = this.plugin.settings.exportSettings || {
                frontmatterTemplate: `---
title: {{title}}
date: {{date}}
---`,
                metadataTemplate: "",
                includeSystemMessages: true,
                includeReasoningBlocks: true
            };

            // Prepare frontmatter context
            const frontmatterContext = {
                title: this.currentHistory.title || 'Chat Export',
                date: new Date().toISOString().split('T')[0],
                flare: this.currentHistory.flare || '',
                model: this.currentHistory.model || '',
                provider: this.currentHistory.provider || '',
                temperature: this.currentHistory.temperature || 0.7
            };

            // Apply frontmatter template
            const frontmatter = this.applyTemplate(
                exportSettings.frontmatterTemplate, 
                frontmatterContext
            );

            // Format messages
            const messagesPromises = this.currentHistory.messages
                .filter(msg => 
                    exportSettings.includeSystemMessages || msg.role !== 'system'
                )
                .map(async msg => {
                    // Format message header
                    const header = `## ${msg.role.charAt(0).toUpperCase() + msg.role.slice(1)}`;
                    
                    // Only add metadata for assistant messages if template is specified
                    let metadata = '';
                    if (msg.role === 'assistant' && exportSettings.metadataTemplate) {
                        const metadataContext = {
                            flare: msg.settings?.flare || this.currentHistory?.flare || '',
                            provider: msg.settings?.provider || this.currentHistory?.provider || '',
                            model: msg.settings?.model || this.currentHistory?.model || '',
                            temperature: msg.settings?.temperature || this.currentHistory?.temperature || 0.7,
                            maxTokens: msg.settings?.maxTokens || '',
                            date: new Date(msg.timestamp).toISOString().split('T')[0],
                            time: new Date(msg.timestamp).toTimeString().split(' ')[0]
                        };
                        
                        metadata = this.applyTemplate(
                            exportSettings.metadataTemplate,
                            metadataContext
                        );
                        
                        if (metadata) {
                            metadata = `> ${metadata}\n\n`;
                        }
                    }
                    
                    // Get message content
                    let content = msg.content;
                    
                    // Process reasoning blocks if needed
                    if (msg.role === 'assistant') {
                        if (!exportSettings.includeReasoningBlocks && 
                            msg.settings?.isReasoningModel && msg.settings?.reasoningHeader) {
                            // Extract reasoning and response parts
                            const { responsePart } = this.extractReasoningContent(
                                content, 
                                msg.settings.reasoningHeader
                            );
                            
                            // Use only the response part
                            content = responsePart;
                        } else if (exportSettings.includeReasoningBlocks && 
                                   msg.settings?.isReasoningModel && msg.settings?.reasoningHeader) {
                            // Replace reasoning tags with parentheses
                            const reasoningHeader = msg.settings.reasoningHeader;
                            const reasoningEndTag = reasoningHeader.replace('<', '</');
                            
                            // First, normalize all newlines to ensure consistent handling
                            content = content.replace(/\r\n/g, '\n');
                            
                            // Use a more direct approach for handling the replacement
                            // Split the content into chunks based on reasoning tags
                            const chunks: string[] = [];
                            let insideReasoning = false;
                            let currentChunk = '';
                            
                            // Handle the opening and closing tags
                            const openTag = new RegExp(this.escapeRegexSpecials(reasoningHeader), 'g');
                            const closeTag = new RegExp(this.escapeRegexSpecials(reasoningEndTag), 'g');
                            
                            // First do a simple replacement of tags
                            let processedContent = content;
                            processedContent = processedContent.replace(openTag, '(');
                            processedContent = processedContent.replace(closeTag, ')');
                            
                            // Now split by parentheses to process chunks
                            const parts = processedContent.split(/(\(|\))/);
                            let newContent = '';
                            let inReasoning = false;
                            
                            for (let i = 0; i < parts.length; i++) {
                                if (parts[i] === '(') {
                                    // Start of reasoning
                                    inReasoning = true;
                                    newContent += '(';
                                } else if (parts[i] === ')') {
                                    // End of reasoning - add a single newline
                                    inReasoning = false;
                                    newContent += ')\n';
                                } else if (parts[i].trim()) {
                                    // Regular content
                                    if (inReasoning) {
                                        // Inside reasoning - just add content
                                        newContent += parts[i];
                                    } else {
                                        // Outside reasoning - ensure it starts with a clean line if after a reasoning block
                                        if (i > 0 && parts[i-1] === ')') {
                                            // Already has a newline added after the closing parenthesis
                                            newContent += parts[i].trim();
                                        } else {
                                            newContent += parts[i];
                                        }
                                    }
                                }
                            }
                            
                            // Final cleanup - ensure no double newlines
                            content = newContent.replace(/\n\n+/g, '\n\n');
                        }
                    }
                    
                    return `${header}\n\n${metadata}${content}\n\n`;
                });

            // Wait for all message formatting to complete
            const messages = await Promise.all(messagesPromises);

            // Combine everything
            return `${frontmatter}\n\n${messages.join('')}`;
        } catch (error) {
            console.error("Failed to generate export content:", error);
            throw new Error(`Failed to generate export content: ${getErrorMessage(error)}`);
        }
    }

    /**
     * Applies a template using handlebar-like syntax
     * @param template The template string with {{variable}} placeholders
     * @param context The context object with values for the placeholders
     * @returns The rendered template
     */
    private applyTemplate(template: string, context: Record<string, string | number | undefined>): string {
        if (!template) return '';
        
        return template.replace(/\{\{([^}]+)\}\}/g, (match, key) => {
            const trimmedKey = key.trim();
            const value = context[trimmedKey];
            return value !== undefined ? String(value) : '';
        });
    }

    /**
     * Extracts reasoning content and response part from a message
     * @param content Message content
     * @param reasoningHeader Reasoning header marker
     * @returns Object with reasoning blocks and response part
     */
    private extractReasoningContent(content: string, reasoningHeader: string): {
        reasoningBlocks: string[];
        responsePart: string;
    } {
        const reasoningEndTag = reasoningHeader.replace('<', '</');
        const escapedHeader = this.escapeRegexSpecials(reasoningHeader);
        const escapedEndTag = this.escapeRegexSpecials(reasoningEndTag);
        const allReasoningRegex = new RegExp(`${escapedHeader}([\\s\\S]*?)${escapedEndTag}`, 'g');
        
        const reasoningBlocks: string[] = [];
        let responsePart = content;
        let match: RegExpExecArray | null;

        // Extract all reasoning blocks
        while ((match = allReasoningRegex.exec(content)) !== null) {
            if (match[1]) {
                reasoningBlocks.push(match[1].trim());
            }
            // Remove this reasoning block from response
            responsePart = responsePart.replace(match[0], '').trim();
        }

        // Clean up any extra newlines in response
        responsePart = responsePart.replace(/^\n+|\n+$/g, '');

        return { reasoningBlocks, responsePart };
    }

    /**
     * Escapes special regex characters in a string
     * @param str The string to escape
     * @returns The escaped string
     */
    private escapeRegexSpecials(str: string): string {
        return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    }
} 