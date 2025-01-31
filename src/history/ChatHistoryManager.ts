import { TFile, TFolder } from 'obsidian';
import type FlarePlugin from '../../main';

interface ChatMessage {
    role: 'user' | 'assistant' | 'system';
    content: string;
    timestamp: number;
    settings: {
        provider: string;
        model: string;
        temperature: number;
        flare?: string;
        timestamp?: number;
    };
}

interface ChatHistory {
    created: number;
    lastModified: number;
    title: string;
    flare?: string;
    provider: string;
    model: string;
    temperature: number;
    messages: ChatMessage[];
}

interface FrontMatter {
    created?: number;
    lastModified?: number;
    title?: string;
    flare?: string;
    [key: string]: string | number | undefined;  // Allow for additional string/number properties
}

export class ChatHistoryManager {
    private autoSaveTimer: NodeJS.Timer | null = null;
    private currentHistory: ChatHistory | null = null;
    private currentFile: TFile | null = null;
    private unsavedChanges: boolean = false;

    constructor(private plugin: FlarePlugin) {
        this.startAutoSave();
    }

    private startAutoSave() {
        if (this.autoSaveTimer) {
            clearInterval(this.autoSaveTimer);
        }

        if (!this.plugin.settings.autoSaveEnabled) {
            return;
        }

        const intervalSeconds = Math.max(this.plugin.settings.autoSaveInterval, 10);

        this.autoSaveTimer = setInterval(() => {
            if (this.unsavedChanges) {
                this.saveCurrentHistory();
            }
        }, intervalSeconds * 1000);
    }

    public updateAutoSave() {
        this.startAutoSave();
    }

    async createNewHistory(title?: string) {
        try {
            // Generate title if not provided
            if (!title) {
                title = 'New Chat';
            }

            // Create new history object with default values
            this.currentHistory = {
                created: Date.now(),
                lastModified: Date.now(),
                title,
                messages: [],
                provider: this.plugin.settings.defaultProvider || 'default',
                model: this.plugin.settings.providers[this.plugin.settings.defaultProvider || 'default']?.defaultModel || 'default',
                temperature: 0.7
            };

            // Create file path
            const basePath = this.plugin.settings.historyFolder;
            
            // Ensure folder exists
            await this.ensureFolderExists(basePath);

            // Create initial filename with timestamp for uniqueness
            const timestamp = new Date().toISOString().replace(/[-:]/g, '').slice(0, 12);
            let fileName = `chat-${timestamp}.md`;
            let filePath = `${basePath}/${fileName}`;

            // Check if file already exists and generate new unique ID if needed
            let counter = 1;
            while (await this.plugin.app.vault.adapter.exists(filePath)) {
                fileName = `chat-${timestamp}-${counter}.md`;
                filePath = `${basePath}/${fileName}`;
                counter++;
            }

            // Create file with initial content
            const content = this.formatHistoryForSave(this.currentHistory);
            this.currentFile = await this.plugin.app.vault.create(filePath, content);
            
            if (!this.currentFile) {
                throw new Error('Failed to create history file');
            }

            this.unsavedChanges = false;
            return this.currentHistory;
        } catch (error) {
            console.error('Error creating new history:', error);
            throw new Error(`Failed to create new history: ${error.message}`);
        }
    }

    async loadHistory(file: TFile): Promise<void> {
        try {
            // Save current history if exists
            if (this.unsavedChanges) {
                await this.saveCurrentHistory();
            }

            // Reset current history first
            this.currentHistory = null;
            this.currentFile = null;

            // Read file content using cached read for better performance
            const content = await this.plugin.app.vault.cachedRead(file);
            const { frontmatter, messages } = this.parseHistoryFile(content);

            // Create new history object with default values
            this.currentHistory = {
                created: frontmatter.created || Date.now(),
                lastModified: frontmatter.lastModified || Date.now(),
                title: frontmatter.title || file.basename.split('-').slice(1).join('-'), // Remove timestamp prefix
                flare: frontmatter.flare,
                provider: this.plugin.settings.defaultProvider || 'default',
                model: (this.plugin.settings.providers[this.plugin.settings.defaultProvider || 'default'] || {}).defaultModel || 'default',
                temperature: 0.7,
                messages: messages || []
            };

            this.currentFile = file;
            this.unsavedChanges = false;
        } catch (error) {
            console.error('Error loading history:', error);
            // Reset state on error
            this.currentHistory = null;
            this.currentFile = null;
            throw error;
        }
    }

    async addMessage(message: Omit<ChatMessage, 'timestamp'>): Promise<void> {
        if (!this.currentHistory) {
            await this.createNewHistory();
        }

        if (this.currentHistory) {
            const fullMessage: ChatMessage = {
                ...message,
                timestamp: Date.now(),
                settings: {
                    // Preserve ALL settings from the original message
                    ...(message.settings ?? {}),
                    // Add timestamp for uniqueness in deduplication
                    timestamp: Date.now()
                }
            };

            this.currentHistory.messages.push(fullMessage);
            this.currentHistory.lastModified = Date.now();
            this.unsavedChanges = true;

            // Save history after each message
            await this.saveCurrentHistory();
        }
    }

    async saveCurrentHistory(): Promise<void> {
        if (!this.currentHistory || !this.currentFile || !this.unsavedChanges) {
            return;
        }

        // Deduplicate messages before saving, keeping only the latest version of each message
        const uniqueMessages = new Map<string, ChatMessage>();
        
        for (const msg of this.currentHistory.messages) {
            const key = `${msg.role}-${msg.timestamp}`;
            uniqueMessages.set(key, msg);
        }

        this.currentHistory.messages = Array.from(uniqueMessages.values());
        this.currentHistory.lastModified = Date.now();

        const content = this.formatHistoryForSave(this.currentHistory);
        await this.plugin.app.vault.modify(this.currentFile, content);
        this.unsavedChanges = false;
    }

    private formatHistoryForSave(history: ChatHistory): string {
        const frontmatter = [
            '---',
            `created: ${history.created}`,
            `lastModified: ${history.lastModified}`,
            `title: "${history.title}"`,
            history.flare ? `flare: ${history.flare}` : null,
            '---\n'
        ].filter(Boolean).join('\n');

        // Format messages, ensuring valid roles and content
        const messages = history.messages
            .filter(msg => msg && msg.role && ['system', 'user', 'assistant'].includes(msg.role))
            .map(msg => {
                const header = `## ${msg.role.charAt(0).toUpperCase() + msg.role.slice(1)}`;
                const content = msg.content || '';
                const settings = msg.settings ? 
                    `\n<!-- settings: ${JSON.stringify({
                        ...msg.settings,
                        timestamp: msg.timestamp,
                        temperature: Number(msg.settings.temperature) // Ensure temperature is a number
                    })} -->` : '';
                
                return `${header}\n${content}${settings}\n`;
            }).join('\n');

        return `${frontmatter}\n${messages}`;
    }

    private parseHistoryFile(content: string): { frontmatter: FrontMatter, messages: ChatMessage[] } {
        const frontmatterMatch = content.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
        if (!frontmatterMatch) {
            throw new Error('Invalid history file format');
        }

        const [, frontmatterContent, messagesContent] = frontmatterMatch;
        const frontmatter = this.parseFrontmatter(frontmatterContent);
        const messages = this.parseMessages(messagesContent);

        return { frontmatter, messages };
    }

    private parseFrontmatter(content: string): FrontMatter {
        const frontmatter: FrontMatter = {};
        const lines = content.split('\n');
        
        lines.forEach(line => {
            const match = line.match(/^(\w+):\s*(.+)$/);
            if (match) {
                const [, key, value] = match;
                // Try to convert to number if possible
                const numValue = Number(value.replace(/^"(.*)"$/, '$1'));
                frontmatter[key] = isNaN(numValue) ? value.replace(/^"(.*)"$/, '$1') : numValue;
            }
        });

        return frontmatter;
    }

    private parseMessages(content: string): ChatMessage[] {
        const messages: ChatMessage[] = [];
        const messageBlocks = content.split(/^## /m).filter(Boolean);

        messageBlocks.forEach(block => {
            try {
                const lines = block.trim().split('\n');
                const roleStr = lines[0].toLowerCase();
                
                // Only process valid roles
                if (!['system', 'user', 'assistant'].includes(roleStr)) {
                    return;
                }

                // Cast to valid role type
                const role = roleStr as 'system' | 'user' | 'assistant';
                
                // Extract settings if present
                const settingsMatch = block.match(/<!-- settings: (.*?) -->/);
                const settings = settingsMatch ? JSON.parse(settingsMatch[1]) : undefined;
                
                // Get timestamp from settings or default to now
                const timestamp = settings?.timestamp || Date.now();
                delete settings?.timestamp; // Remove timestamp from settings after extraction
                
                // Get content (everything between role and settings/end)
                const contentStart = lines.slice(1).join('\n');
                const content = settingsMatch ? 
                    contentStart.replace(/<!-- settings: .*? -->/, '').trim() :
                    contentStart.trim();

                messages.push({
                    role,
                    content,
                    timestamp,
                    settings
                });
            } catch (error) {
                console.warn('Failed to parse message block:', error);
                // Skip invalid message blocks
            }
        });

        return messages;
    }

    private sanitizeFileName(name: string): string {
        return name
            .toLowerCase()
            .replace(/[^a-z0-9]+/g, '-')
            .replace(/(^-|-$)/g, '');
    }

    private async ensureFolderExists(path: string): Promise<void> {
        const adapter = this.plugin.app.vault.adapter;
        const exists = await adapter.exists(path);
        if (!exists) {
            await this.plugin.app.vault.createFolder(path);
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
        if (this.autoSaveTimer) {
            clearInterval(this.autoSaveTimer);
        }
        if (this.unsavedChanges) {
            await this.saveCurrentHistory();
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

            // Update history object
            const oldTitle = this.currentHistory.title;
            this.currentHistory.title = finalTitle;
            
            // Save changes to current file first
            await this.saveCurrentHistory();

            // Rename the file
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
                console.error('Failed to rename file:', error);
                throw new Error('Failed to rename chat file');
            }
            
            return finalTitle;
        } catch (error) {
            console.error('Error generating title:', error);
            throw new Error('Failed to generate title: ' + error.message);
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
} 