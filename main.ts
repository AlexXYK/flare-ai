import { App, Plugin, WorkspaceLeaf, Notice, TFile, sanitizeHTMLToDom, setTooltip, setIcon, Platform } from 'obsidian';
import { GeneralSettingTab } from './src/settings/GeneralSettingTab';
import { AIChatView, VIEW_TYPE_AI_CHAT } from './src/views/aiChatView';
import { 
    AIProvider, 
    OllamaManager,
    OpenAIManager,
    ProviderSettings,
    OpenRouterManager,
    AnthropicManager,
    GeminiManager
} from './src/providers/aiProviders';
import { MainProviderManager } from './src/providers/MainProviderManager';
import { ProviderManager } from './src/providers/ProviderManager';
import { FlareConfig } from './src/flares/FlareConfig';
import { FlareManager } from './src/flares/FlareManager';
import { PluginSettings } from './src/types/PluginSettings';
import { 
    PLUGIN_NAME, 
    PLUGIN_VERSION, 
    PLUGIN_DESC,
    DEFAULT_SETTINGS 
} from './src/utils/constants';
import { ChatHistoryManager } from './src/history/ChatHistoryManager';
import { MarkdownRenderer } from 'obsidian';
import { MarkdownPostProcessorContext } from 'obsidian';
import { MarkdownView } from 'obsidian';
import { MarkdownRenderChild } from 'obsidian';
import { debounce } from 'obsidian';

/** Custom cleanup class for flare codeblocks */
class FlareCodeBlockCleanup extends MarkdownRenderChild {
    private plugin: FlarePlugin;
    private codeBlockId: string;

    constructor(containerEl: HTMLElement, plugin: FlarePlugin, codeBlockId: string) {
        super(containerEl);
        this.plugin = plugin;
        this.codeBlockId = codeBlockId;
    }

    onunload(): void {
        const cleanups = this.plugin.getCodeBlockCleanupFunctions(this.codeBlockId);
        if (cleanups) {
            cleanups.forEach((cleanup: () => void) => cleanup());
            this.plugin.removeCodeBlockCleanupFunctions(this.codeBlockId);
        }
    }
}

/** Custom error class for FLARE.ai specific errors */
class FlareError extends Error {
    constructor(message: string, public code: string) {
        super(message);
        this.name = 'FlareError';
        // Maintains proper stack trace for where error was thrown
        Error.captureStackTrace(this, FlareError);
    }
}

interface DataviewApi {
    queryMarkdown(query: string, sourcePath: string): Promise<string>;
    executeJs(code: string, sourcePath: string): Promise<{ container: { innerHTML: string } }>;
    query(source: string, originFile?: string, settings?: any): Promise<{
        successful: boolean;
        value: {
            type: 'table' | 'list' | 'task';
            headers?: string[];
            values: any[];
        };
    }>;
}

interface DataviewPlugin {
    api: DataviewApi;
}

interface ObsidianPlugins {
    plugins: {
        dataview?: DataviewPlugin;
    };
}

interface ObsidianApp extends App {
    plugins: {
        plugins: {
            dataview?: DataviewPlugin;
        };
    };
}

export default class FlarePlugin extends Plugin {
    settings!: PluginSettings;
    providers: Map<string, ProviderManager> = new Map();
    providerManager!: MainProviderManager;
    activeProvider: AIProvider | null = null;
    flareManager!: FlareManager;
    chatHistoryManager!: ChatHistoryManager;
    private flareWatcher: NodeJS.Timer | null = null;
    flares: Array<{ name: string; path: string }> = [];
    isFlareSwitchActive: boolean = false;
    lastUsedFlare: string | null = null;
    settingTab: GeneralSettingTab | null = null;
    private codeBlockCleanupFunctions: Map<string, Array<() => void>> = new Map();

    async onload() {
        console.log(`Loading ${PLUGIN_NAME} v${PLUGIN_VERSION}`);
        
        try {
            await this.loadSettings();
            
            // Initialize export settings if not present
            if (!this.settings.exportSettings) {
                this.settings.exportSettings = {
                    exportFolder: 'FLAREai/exports',
                    frontmatterTemplate: `---
title: {{title}}
date: {{date}}
---`,
                    metadataTemplate: 'Provider: {{provider}} | Model: {{model}} | Temp: {{temperature}}',
                    includeSystemMessages: true,
                    includeReasoningBlocks: true
                };
                await this.saveSettings();
            }
            
            // Add this: Set up a listener for external settings changes
            this.registerInterval(
                window.setInterval(() => this.checkForExternalSettingsChanges(), 30000) // Check every 30 seconds
            );
            
            // Remove CSS styles for codeblock header color variations
            
            await this.initializePlugin();
            this.addCommands();
            
            // Ensure folders exist
            await this.ensureFlaresFolderExists();
            await this.ensureHistoryFolderExists();
            await this.ensureExportFolderExists();
            
            // Watch for changes to flare files
            this.startFlareWatcher();
            
            // Register flare codeblock processors - both lowercase and uppercase
            this.registerMarkdownCodeBlockProcessor('flare', this.handleFlareCodeBlock.bind(this));
            this.registerMarkdownCodeBlockProcessor('FLARE', this.handleFlareCodeBlock.bind(this));
            
            console.log(`${PLUGIN_NAME} loaded successfully`);
        } catch (error) {
            console.error('Error initializing FLARE.ai plugin:', error);
            new Notice('Error initializing FLARE.ai plugin: ' + error);
        }
    }

    private async initializePlugin() {
        try {
            // Initialize managers
            this.providerManager = new MainProviderManager(this);
            this.flareManager = new FlareManager(this);
            this.chatHistoryManager = new ChatHistoryManager(this);
            
            // Ensure folders exist
            await this.ensureFlaresFolderExists();
            
            // Load initial flares
            await this.flareManager.loadFlares();
            
            // Register providers
            await this.registerProviders();
            
            // Initialize default provider if set
            if (this.settings?.defaultProvider) {
                await this.initializeProvider();
            }

            // Register view
            this.registerView(
                VIEW_TYPE_AI_CHAT,
                (leaf) => new AIChatView(leaf, this)
            );

            // Add settings tab
            const settingTab = new GeneralSettingTab(this.app, this);
            this.addSettingTab(settingTab);
            this.settingTab = settingTab;
        } catch (error) {
            console.error('FLARE.ai: Plugin initialization failed:', error);
            throw new Error(
                'Failed to initialize FLARE.ai plugin. ' + 
                'Please check your settings and try reloading Obsidian.'
            );
        }
    }

    private async registerProviders() {
        // Create manager instances for each provider type
        const providerManagerTypes: Record<string, ProviderManager> = {
            'ollama': new OllamaManager(this),
            'openai': new OpenAIManager(this),
            'openrouter': new OpenRouterManager(this),
            'anthropic': new AnthropicManager(this),
            'gemini': new GeminiManager(this)
        };

        // Register all manager types
        for (const [type, manager] of Object.entries(providerManagerTypes)) {
            this.providers.set(type, manager);
        }

        // Now make sure all providers in settings are properly registered
        // This ensures providers created on other devices are available
        for (const [providerId, providerSettings] of Object.entries(this.settings.providers)) {
            const type = providerSettings.type;
            
            // Make sure the provider has a valid type that matches one of our managers
            if (!type || !providerManagerTypes[type]) {
                console.warn(`Provider ${providerId} has invalid type: ${type}`);
                continue;
            }
            
            // Make sure the provider has a name
            if (!providerSettings.name) {
                providerSettings.name = this.getDefaultNameForProviderType(type);
                // Save settings to update this provider
                await this.saveSettings();
            }
            
            // Ensure availableModels and visibleModels are initialized properly
            if (!Array.isArray(providerSettings.availableModels)) {
                providerSettings.availableModels = [];
            }
            
            if (!Array.isArray(providerSettings.visibleModels)) {
                providerSettings.visibleModels = [];
            }
        }
    }

    private setupUI() {
        try {
            // Add ribbon icon with proper aria label and tooltip
            const ribbonIconEl = this.addRibbonIcon('flame', PLUGIN_NAME, (evt: MouseEvent) => {
                this.activateView();
            });
            setTooltip(ribbonIconEl, 'Open FLARE.ai Chat');
        } catch (error) {
            console.error('FLARE.ai: Failed to setup UI:', error);
            new Notice('Failed to setup FLARE.ai UI components');
        }
    }

    async onunload() {
        console.log(`Unloading ${PLUGIN_NAME}`);
        
        const cleanupTasks: Array<Promise<void>> = [];
        
        try {
            // Remove custom header styles reference
            
            // Clean up watchers and timers
            if (this.flareWatcher) {
                clearInterval(this.flareWatcher);
                this.flareWatcher = null;
            }

            // Clean up any registered event listeners from codeblocks
            this.codeBlockCleanupFunctions.forEach(cleanupFunctions => {
                cleanupFunctions.forEach(cleanup => cleanup());
            });
            this.codeBlockCleanupFunctions.clear();

            // Clean up managers with proper error handling for each
            if (this.chatHistoryManager) {
                try {
                    const historyCleanup = this.chatHistoryManager.cleanup().catch(error => {
                        console.error('Error during chat history cleanup:', error);
                        // Return resolved promise to not block other cleanup operations
                        return Promise.resolve();
                    });
                    cleanupTasks.push(historyCleanup);
                } catch (error) {
                    console.error('Error initializing chat history cleanup:', error);
                }
            }
            
            if (this.flareManager) {
                try {
                    const flareCleanup = this.flareManager.cleanup().catch(error => {
                        console.error('Error during flare manager cleanup:', error);
                        return Promise.resolve();
                    });
                    cleanupTasks.push(flareCleanup);
                } catch (error) {
                    console.error('Error initializing flare manager cleanup:', error);
                }
            }
            
            if (this.providerManager) {
                try {
                    if (this.providerManager.cleanup && typeof this.providerManager.cleanup === 'function') {
                        const providerManagerCleanup = this.providerManager.cleanup().catch(error => {
                            console.error('Error during provider manager cleanup:', error);
                            return Promise.resolve();
                        });
                        cleanupTasks.push(providerManagerCleanup);
                    }
                } catch (error) {
                    console.error('Error initializing provider manager cleanup:', error);
                }
            }
            
            // Clean up individual providers if they have cleanup methods
            const providerCleanupPromises = Array.from(this.providers.entries()).map(async ([id, provider]) => {
                try {
                    if (provider.cleanup && typeof provider.cleanup === 'function') {
                        return provider.cleanup().catch(error => {
                            console.error(`Error during cleanup for provider ${id}:`, error);
                            return Promise.resolve();
                        });
                    }
                    return Promise.resolve();
                } catch (error) {
                    console.error(`Error initializing cleanup for provider ${id}:`, error);
                    return Promise.resolve();
                }
            });
            cleanupTasks.push(...providerCleanupPromises);
            
            // Detach all views created by this plugin
            this.app.workspace.detachLeavesOfType(VIEW_TYPE_AI_CHAT);
            
            // Cancel any in-progress operations if needed
            if (this.activeProvider && this.activeProvider.cancelRequest) {
                try {
                    this.activeProvider.cancelRequest();
                } catch (error) {
                    console.error('Error canceling active provider request:', error);
                }
            }

            // Wait for all cleanup tasks to complete
            await Promise.allSettled(cleanupTasks);

            // Save final state
            await this.saveData(this.settings);
            
            // Remove any remaining event listeners from the plugin's ribbon icon
            // This is typically handled by Obsidian, but adding it for completeness
            
            console.log(`${PLUGIN_NAME} unloaded successfully`);
        } catch (error) {
            console.error(`FLARE.ai: Error during cleanup:`, error);
            // Don't show notice during unload as it may not be visible
        }
    }

    private addCommands() {
        // Main window command
        this.addCommand({
            id: 'open-flare-ai-main',
            name: 'Open chat in main window',
            callback: () => this.activateView('tab')
        });

        // Sidebar command
        this.addCommand({
            id: 'open-flare-ai-sidebar',
            name: 'Open chat in sidebar',
            callback: () => this.activateView('right')
        });
    }

    async activateView(location: 'tab' | 'right' | 'left' = 'tab') {
        const { workspace } = this.app;
        let leaf = workspace.getLeavesOfType(VIEW_TYPE_AI_CHAT)[0];
        
        if (!leaf) {
            if (location === 'tab') {
                // For main window/tab, use 'tab' to open in main area without splitting
                leaf = workspace.getLeaf('tab');
            } else {
                // For sidebars, use the proper sidebar creation method
                const sideLeaf = location === 'right' 
                    ? workspace.getRightLeaf(false)
                    : workspace.getLeftLeaf(false);
                    
                if (!sideLeaf) {
                    throw new Error(`Failed to create ${location} sidebar leaf`);
                }
                
                leaf = sideLeaf;
            }
            
            await leaf.setViewState({
                type: VIEW_TYPE_AI_CHAT,
                active: true,
            });
        } else {
            // If the view exists but we want it in a different location
            const isInSidebar = leaf.getRoot() !== workspace.rootSplit;
            
            if (location === 'tab' && isInSidebar) {
                // Move to main area if it's currently in a sidebar
                const newLeaf = workspace.getLeaf('tab');
                await newLeaf.setViewState({
                    type: VIEW_TYPE_AI_CHAT,
                    active: true
                });
                await leaf.detach();
                leaf = newLeaf;
            } else if (location !== 'tab' && !isInSidebar) {
                // Move to sidebar if it's currently in main area
                const targetLeaf = location === 'right' 
                    ? workspace.getRightLeaf(false)
                    : workspace.getLeftLeaf(false);
                    
                if (targetLeaf) {
                    await targetLeaf.setViewState({
                        type: VIEW_TYPE_AI_CHAT,
                        active: true
                    });
                    await leaf.detach();
                    leaf = targetLeaf;
                }
            }
        }

        // Ensure the leaf is revealed and focused
        workspace.revealLeaf(leaf);
        await workspace.setActiveLeaf(leaf, { focus: true });
    }

    async initializeProvider() {
        try {
            // Get all provider entries
            const providers = Object.entries(this.settings.providers);
            
            if (providers.length === 0) {
                return;
            }

            // Try to initialize the default provider first
            if (this.settings.defaultProvider) {
                const defaultProvider = providers.find(([id]) => id === this.settings.defaultProvider);
                if (defaultProvider) {
                    await this.initializeSingleProvider(defaultProvider[0], defaultProvider[1]);
                    return;
                }
            }

            // If no default provider or it failed, try the first available provider
            const [firstId, firstConfig] = providers[0];
            await this.initializeSingleProvider(firstId, firstConfig);
        } catch (error) {
            console.error('Failed to initialize provider:', error);
            new Notice('Failed to initialize AI provider. Please check your settings.');
        }
    }

    async initializeSingleProvider(id: string, config: ProviderSettings) {
        try {
            // Validate provider configuration
            if (!config.type) {
                throw new Error(`Invalid provider configuration for ${id}: missing type`);
            }

            // Get the provider manager
            const manager = this.providers.get(config.type);
            if (!manager) {
                throw new Error(`No provider manager found for type: ${config.type}`);
            }

            // Create and validate the provider
            const provider = manager.createProvider(config);
            if (!provider) {
                throw new Error(`Failed to create provider instance for ${config.type}`);
            }

            // Test the provider by fetching models
            await provider.getAvailableModels();

            // If all validation passes, set as active provider
            this.activeProvider = provider;
        } catch (error) {
            console.error(`Failed to initialize provider ${id}:`, error);
            throw error;
        }
    }

    // Add helper method to strip reasoning content from messages
    private stripReasoningContent(messages: Array<{role: string; content: string; settings?: any}>, defaultReasoningHeader: string = '<think>'): Array<{role: string; content: string; settings?: any}> {
        return messages.map(msg => {
            if (msg.role === 'assistant') {
                // Use message-specific reasoning header if available, otherwise use default
                const reasoningHeader = msg.settings?.reasoningHeader || defaultReasoningHeader;
                const reasoningEndTag = reasoningHeader.replace('<', '</');
                const escapedHeader = this.escapeRegexSpecials(reasoningHeader);
                const escapedEndTag = this.escapeRegexSpecials(reasoningEndTag);
                const reasoningRegex = new RegExp(`${escapedHeader}[\\s\\S]*?${escapedEndTag}`, 'g');
                
                return {
                    ...msg,
                    content: msg.content.replace(reasoningRegex, '').trim()
                };
            }
            return msg;
        });
    }

    private escapeRegexSpecials(str: string): string {
        return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    }

    public async handleMessage(message: string, options?: {
        flare?: string;
        provider?: string;
        providerName?: string;
        providerType?: string;
        model?: string;
        temperature?: number;
        maxTokens?: number;
        messageHistory?: Array<{role: string; content: string; settings?: any}>;
        contextWindow?: number;
        stream?: boolean;
        onToken?: (token: string) => void;
        isFlareSwitch?: boolean;
        signal?: AbortSignal;
    }): Promise<string> {
        try {
            // Use selected flare from options, or the last used flare, or the default flare
            let newFlareName = options?.flare || this.lastUsedFlare || this.settings.defaultFlare || '';
            if (!newFlareName) {
                // If no flare is available, look for a flare with matching provider
                if (options?.provider || options?.providerName || options?.providerType) {
                    // Try to find a matching flare
                    const flares = await this.flareManager.loadFlares();
                    const matchingFlare = flares.find(flare => 
                        (options?.provider && flare.provider === options.provider) ||
                        (options?.providerName && flare.providerName === options.providerName) ||
                        (options?.providerType && flare.providerType === options.providerType)
                    );
                    
                    if (matchingFlare) {
                        newFlareName = matchingFlare.name;
                    } else {
                        // If no matching flare, use default flare
                        newFlareName = this.settings.defaultFlare || '';
                    }
                }
                
                // If still no flare, use the first available flare
                if (!newFlareName) {
                    const flares = await this.flareManager.loadFlares();
                    if (flares.length > 0) {
                        newFlareName = flares[0].name;
                    }
                }
                
                // If still no flare, create a new one
                if (!newFlareName) {
                    throw new Error('No flares available. Please create a flare first.');
                }
            }
            
            // Save the last used flare
            this.lastUsedFlare = newFlareName;
            
            // Validate flare exists
            const flareExists = await this.app.vault.adapter.exists(
                `${this.settings.flaresFolder}/${newFlareName}.md`
            );
            if (!flareExists) {
                throw new Error(`Flare "${newFlareName}" does not exist. Please create it first.`);
            }
            
            // Load flare config
            const flareConfig = await this.flareManager.debouncedLoadFlare(newFlareName);
            if (!flareConfig) {
                throw new Error(`Failed to load flare: ${newFlareName}`);
            }

            // Handle context windows for flare switches differently
            let isFlareSwitch = options?.isFlareSwitch;
            if (isFlareSwitch === undefined) {
                // If not explicitly set, determine based on history and flare name
                if (options?.messageHistory && options.messageHistory.length > 0) {
                    // Consider only non-system (user/assistant) messages
                    const nonSystemMessages = options.messageHistory.filter(msg => msg.role !== 'system');
                    if (nonSystemMessages.length === 0) {
                        isFlareSwitch = true; // No previous messages, treat as switch
                    } else {
                        // Check if we're switching from a different flare
                        const lastMessage = nonSystemMessages[nonSystemMessages.length - 1];
                        isFlareSwitch = lastMessage.settings?.flare !== newFlareName;
                    }
                } else {
                    isFlareSwitch = true; // First message is considered a flare switch
                }
            }

            // Start with complete message history
            let finalMessageHistory = [...(options?.messageHistory || [])];

            // Apply handoff context if this is a flare switch
            if (isFlareSwitch && flareConfig.handoffContext !== undefined) {
                if (flareConfig.handoffContext === -1) {
                    // For -1, keep all messages (no need to modify finalMessageHistory)
                } else {
                    // For specific window size, apply the handoff context
                    finalMessageHistory = this.applyHandoffContext(finalMessageHistory, flareConfig.handoffContext);
                }
            }
            // Apply context window only for non-flare switch messages
            else if (!isFlareSwitch && flareConfig.contextWindow !== undefined) {
                finalMessageHistory = this.applyContextWindow(finalMessageHistory, flareConfig.contextWindow);
            }

            // Handle system message
            if (flareConfig.systemPrompt) {
                // Process system prompt wikilinks
                let processedSystemPrompt = flareConfig.systemPrompt;
                const systemWikilinks = await this.expandWikiLinks(flareConfig.systemPrompt);
                for (const [fileName, content] of Object.entries(systemWikilinks)) {
                    if (typeof content === 'string') {
                        const wikiLinkPattern = new RegExp(`\\[\\[${this.escapeRegexSpecials(fileName)}(?:\\|[^\\]]*)?\\]\\]`, 'g');
                        processedSystemPrompt = processedSystemPrompt.replace(wikiLinkPattern, content);
                    }
                }

                // Add system message if:
                // 1. This is the first message, or
                // 2. This is a flare switch, or
                // 3. There's no system message yet
                const hasSystemMessage = finalMessageHistory.some(m => m.role === 'system');
                if (isFlareSwitch || !hasSystemMessage) {
                    // Remove any existing system messages
                    finalMessageHistory = finalMessageHistory.filter(m => m.role !== 'system');
                    // Add new system message at the start
                    finalMessageHistory.unshift({
                        role: 'system',
                        content: processedSystemPrompt,
                        settings: {
                            flare: newFlareName,
                            provider: flareConfig.provider,
                            providerName: flareConfig.providerName,
                            providerType: flareConfig.providerType,
                            model: flareConfig.model
                        }
                    });
                }
            }

            // Process current message
            let processedMessage = message;
            let displayMessage = message;  // Keep original message for display
            const messageWikilinks = await this.expandWikiLinks(message);
            
            // Create a map of wikilink patterns to their expanded content
            const wikilinksMap = new Map<string, string>();
            for (const [fileName, content] of Object.entries(messageWikilinks)) {
                if (typeof content === 'string') {
                    const wikiLinkPattern = new RegExp(`\\[\\[${this.escapeRegexSpecials(fileName)}(?:\\|[^\\]]*)?\\]\\]`, 'g');
                    wikilinksMap.set(wikiLinkPattern.source, content);
                    processedMessage = processedMessage.replace(wikiLinkPattern, content);
                }
            }

            // Create message object for current message
            const currentMessage = {
                role: 'user',
                content: displayMessage,  // Use original message with wikilinks for display
                settings: {
                    flare: newFlareName,
                    providerName: flareConfig.providerName,
                    providerType: flareConfig.providerType,
                    provider: flareConfig.provider, // Keep for backward compatibility
                    model: flareConfig.model,
                    temperature: options?.temperature ?? flareConfig.temperature ?? 0.7,
                    maxTokens: options?.maxTokens ?? flareConfig.maxTokens,
                    originalContent: displayMessage,  // Store original content with wikilinks
                    processedContent: processedMessage,  // Store processed content for AI
                    wikilinks: Object.fromEntries(wikilinksMap)  // Store wikilinks map for reference
                }
            };

            // Get provider using name and type (more reliable across devices)
            let provider: AIProvider;
            try {
                provider = await this.getProviderByNameAndType(
                    flareConfig.providerName,
                    flareConfig.providerType
                );
            } catch (error) {
                // Fallback to using provider ID
                console.warn(`Failed to get provider by name and type, falling back to ID: ${error}`);
                // Attempt to get provider from ID, defaultProvider, or throw an error
                if (flareConfig.provider) {
                    provider = await this.getProviderInstance(flareConfig.provider);
                } else if (this.settings.defaultProvider) {
                    provider = await this.getProviderInstance(this.settings.defaultProvider);
                } else {
                    throw new Error('No provider available');
                }
            }
            
            if (!provider) {
                throw new Error('No active provider available');
            }

            // Send message to provider
            const response = await provider.sendMessage(processedMessage, {
                model: flareConfig.model,
                systemPrompt: flareConfig.systemPrompt,
                messageHistory: finalMessageHistory.map(msg => {
                    // Replace display content with processed content for AI
                    const settings = msg.settings || {};
                    const sanitizedContent = settings.processedContent || msg.content;
                    return {
                        role: msg.role,
                        content: sanitizedContent
                    };
                }),
                flare: newFlareName,
                // Don't duplicate model, temperature and maxTokens are set below
                temperature: options?.temperature ?? flareConfig.temperature ?? 0.7,
                maxTokens: options?.maxTokens ?? flareConfig.maxTokens,
                stream: options?.stream ?? flareConfig.stream ?? false,
                onToken: options?.onToken,
                signal: options?.signal
            });

            // After getting response, update the full history with both messages
            finalMessageHistory.push(currentMessage);
            
            // Create assistant message with proper settings
            const assistantMessage = {
                role: 'assistant',
                content: response,
                settings: {
                    flare: newFlareName,
                    providerName: flareConfig.providerName,
                    providerType: flareConfig.providerType,
                    provider: flareConfig.provider, // Keep for backward compatibility
                    model: flareConfig.model,
                    temperature: options?.temperature ?? flareConfig.temperature ?? 0.7,
                    isReasoningModel: flareConfig.isReasoningModel,
                    reasoningHeader: flareConfig.reasoningHeader
                }
            };
            finalMessageHistory.push(assistantMessage);

            // Return just the response part (without reasoning) if this is a reasoning model
            if (flareConfig.isReasoningModel) {
                const stripped = this.stripReasoningContent([{
                    role: 'assistant',
                    content: response
                }], flareConfig.reasoningHeader)[0].content;
                
                return stripped;
            }

            return response;
        } catch (error) {
            console.error('Error handling message:', error);
            if (error instanceof Error) {
                return `Error: ${error.message}`;
            }
            return 'An unknown error occurred while processing your message.';
        }
    }

    parseMessageForFlare(message: string): { flare: string; content: string } {
        const match = message.match(/(?:^|\s)@([^\s]+)(?:\s+(.*))?/i);
        if (match) {
            // If there's no content after the flare name, treat it as a flare switch
            if (!match[2] || !match[2].trim()) {
                return { 
                    flare: match[1], 
                    content: '' // Empty content triggers the flare switch format
                };
            }
            return { 
                flare: match[1], 
                content: match[2].trim() 
            };
        }
        return { 
            flare: this.settings.defaultFlare || 'default', // Provide default value
            content: message 
        };
    }

    async loadFlareConfig(flareName: string): Promise<FlareConfig> {
        try {
            const files = this.app.vault.getMarkdownFiles();
            const flareFile = files.find(file => 
                file.path.startsWith(this.settings.flaresFolder + '/') && 
                file.basename === flareName
            );

            const defaultProvider = Object.keys(this.settings.providers)[0];
            const providerSettings = this.settings.providers[defaultProvider];
            
            // Ensure we have a valid model
            let model = '';
            if (providerSettings) {
                if (providerSettings.defaultModel) {
                    model = providerSettings.defaultModel;
                } else {
                    // Try to get first available model
                    try {
                        const models = await this.getModelsForProvider(providerSettings.type);
                        if (models.length > 0) {
                            model = models[0];
                        }
                    } catch (error) {
                        console.error('Failed to get models for provider:', error);
                    }
                }
            }

            // If no file exists, return default config
            if (!flareFile) {
                console.debug(`No flare file found for ${flareName}`);
                return {
                    name: flareName,
                    providerName: 'Default Provider',
                    providerType: '',
                    provider: defaultProvider,
                    model: model,
                    enabled: true,
                    description: '',
                    contextWindow: -1,
                    handoffContext: -1,
                    stream: false,
                    systemPrompt: "You are a helpful AI assistant.",
                    isReasoningModel: false
                };
            }

            // Get file metadata from cache
            const fileCache = this.app.metadataCache.getFileCache(flareFile);
            if (!fileCache || !fileCache.frontmatter) {
                throw new Error('Invalid flare file format: missing frontmatter');
            }

            // Read file content for system prompt
            const content = await this.app.vault.read(flareFile);
            const frontmatterMatch = content.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
            if (!frontmatterMatch) {
                throw new Error('Invalid flare file format: missing frontmatter');
            }
            const systemPrompt = frontmatterMatch[2].trim();

            // Get provider information
            const providerName = fileCache.frontmatter.providerName || 'Default Provider';
            const providerType = fileCache.frontmatter.providerType || '';
            const providerId = fileCache.frontmatter.provider || defaultProvider;

            return {
                name: flareName,
                providerName: providerName,
                providerType: providerType,
                provider: providerId,
                model: fileCache.frontmatter.model || model,
                enabled: fileCache.frontmatter.enabled ?? true,
                description: fileCache.frontmatter.description || '',
                temperature: fileCache.frontmatter.temperature !== undefined ? fileCache.frontmatter.temperature : 0.7,
                maxTokens: fileCache.frontmatter.maxTokens,
                contextWindow: fileCache.frontmatter.contextWindow ?? -1,
                handoffContext: fileCache.frontmatter.handoffContext ?? -1,
                systemPrompt: systemPrompt,
                stream: fileCache.frontmatter.stream ?? false,
                isReasoningModel: fileCache.frontmatter.isReasoningModel ?? false,
                reasoningHeader: fileCache.frontmatter.reasoningHeader || '<think>'
            };
        } catch (error) {
            console.error('Failed to load flare config:', error);
            throw error;
        }
    }

    private async loadSettings() {
        this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
    }

    private async saveSettings() {
        await this.saveData(this.settings);
        // Ensure folders exist after settings change
        await this.ensureFlaresFolderExists();
        // Reload flares after settings change
        if (this.flareManager) {
            await this.flareManager.loadFlares();
        }
    }

    public async ensureFlaresFolderExists() {
        // Use consistent API pattern for folder existence check and creation
        try {
            const flaresExists = await this.app.vault.adapter.exists(this.settings.flaresFolder);
            if (!flaresExists) {
                await this.app.vault.createFolder(this.settings.flaresFolder);
            }
        } catch (error) {
            console.error('Failed to create Flares folder:', error);
            new Notice('Failed to create Flares folder');
        }

        // Use consistent API pattern for history folder too
        try {
            const historyExists = await this.app.vault.adapter.exists(this.settings.historyFolder);
            if (!historyExists) {
                await this.app.vault.createFolder(this.settings.historyFolder);
            }
        } catch (error) {
            console.error('Failed to create History folder:', error);
            new Notice('Failed to create History folder');
        }
    }

    private registerProvider(manager: ProviderManager) {
        if (!manager) {
            console.error('Invalid provider manager:', manager);
            return;
        }
        
        // Get the provider type name
        const providerType = manager.id;
        
        // First look for existing providers with this type
        const existingProviders = Object.entries(this.settings.providers)
            .filter(([_, settings]) => settings.type === providerType)
            .map(([id, settings]) => ({ id, settings }));
            
        if (existingProviders.length > 0) {
            // Register existing providers
            for (const { id, settings } of existingProviders) {
                // Set the ID to the saved ID
                manager.setId(id);
                console.log(`Found existing provider with ID: ${id} (${settings.name})`);
                
                // Track the provider in our map - we add each provider separately
                // so multiple can exist of the same type
                this.providers.set(id, manager);
            }
        } else {
            // No existing provider of this type, create a default one
            const defaultName = this.getDefaultNameForProviderType(providerType);
            const newProviderId = this.generateProviderID(providerType, defaultName);
            
            manager.setId(newProviderId);
            
            // Initialize default settings for this provider
            if (!this.settings.providers[newProviderId]) {
                this.settings.providers[newProviderId] = {
                    type: providerType,
                    name: defaultName,
                    enabled: true
                };
                // Save the settings to persist the new provider
                this.saveSettings();
            }
            
            console.log(`Registered new provider: ${newProviderId} (${defaultName})`);
            
            // Register the provider in our map
            this.providers.set(newProviderId, manager);
        }
    }
    
    /**
     * Generate a provider ID that will be consistent across devices
     * This uses the provider type and name to create a unique but consistent ID
     */
    private generateProviderID(type: string, name: string): string {
        // Create a stable ID by combining type and sanitized name
        // This ensures the same ID will be generated on different devices for the same provider
        const sanitizedName = name.toLowerCase().replace(/[^a-z0-9]/g, '_');
        return `${type}_${sanitizedName}`;
    }
    
    private getDefaultNameForProviderType(type: string): string {
        // Convert provider type to a user-friendly name
        switch (type) {
            case 'openai':
                return 'OpenAI';
            case 'anthropic':
                return 'Anthropic Claude';
            case 'gemini':
                return 'Google Gemini';
            case 'ollama':
                return 'Ollama';
            case 'openrouter':
                return 'OpenRouter';
            default:
                return type.charAt(0).toUpperCase() + type.slice(1);
        }
    }

    private startFlareWatcher() {
        // Clear any existing watcher
        if (this.flareWatcher) {
            clearInterval(this.flareWatcher);
        }

        // Temporarily disable flare watcher to avoid repeated folder scans
        // If needed, you can re-enable at a safer interval or only when flares actually change.
    }

    async getModelsForProvider(type: string): Promise<string[]> {
        try {
            // Get provider settings for this type
            const providerSettings = Object.values(this.settings.providers)
                .find(p => p.type === type);
                
            if (!providerSettings) {
                console.error(`No provider settings found for type: ${type}`);
                return [];
            }
            
            // If provider has visibleModels configuration, use that instead of making API calls
            if (providerSettings.visibleModels && providerSettings.visibleModels.length > 0) {
                return providerSettings.visibleModels;
            }
            
            // Add timeout protection
            const timeout = new Promise<string[]>((_, reject) => 
                setTimeout(() => reject(new Error('Request timed out')), 10000)
            );

            const modelFetch = (async () => {
                const manager = this.providers.get(type);
                if (!manager) {
                    console.error(`No provider manager found for type: ${type}`);
                    return [];
                }

                try {
                    const provider = manager.createProvider(providerSettings);
                    if (!provider) {
                        console.error(`Failed to create provider instance for ${type}`);
                        return [];
                    }
                    
                    // Only try to fetch models if we have valid credentials
                    // For certain provider types, don't fetch if no API key is provided
                    const requiresApiKey = ['openai', 'anthropic', 'openrouter', 'gemini'].includes(type);
                    if (requiresApiKey && (!providerSettings.apiKey || providerSettings.apiKey.trim() === '')) {
                        console.log(`Skipping model fetch for ${type} - no API key provided`);
                        return providerSettings.visibleModels || [];
                    }
                    
                    const allModels = await provider.getAvailableModels();
                    
                    // First filter by enabledModels if set
                    let filteredModels = allModels;
                    if (providerSettings.enabledModels?.length > 0) {
                        filteredModels = allModels.filter(model => 
                            providerSettings.enabledModels?.includes(model)
                        );
                    }
                    
                    return filteredModels;
                } catch (error) {
                    console.error(`Failed to get models for provider ${type}:`, error);
                    // Return existing visible models as fallback
                    return providerSettings.visibleModels || [];
                }
            })();

            // Race between the fetch and the timeout
            return await Promise.race([modelFetch, timeout]);
        } catch (error) {
            console.error('Failed to get models:', error);
            return [];
        }
    }

    async getProviderInstance(providerId: string): Promise<AIProvider> {
        // First, try to get provider settings directly by ID
        let providerSettings = this.settings.providers[providerId];
        
        // If not found, it might be a provider name - try to look it up by name
        if (!providerSettings) {
            // Find a provider with matching name
            const matchByName = Object.entries(this.settings.providers)
                .find(([_, settings]) => settings.name === providerId);
                
            if (matchByName) {
                providerSettings = matchByName[1];
                providerId = matchByName[0]; // Update the ID to match what we found
                // Remove excessive logging
            } else {
                throw new Error(`No provider found with ID or name: ${providerId}`);
            }
        }
        
        // Get the provider type
        const type = providerSettings.type;
        if (!type) {
            throw new Error(`Provider ${providerId} has no type defined`);
        }
        
        // Get the manager for this provider type
        const manager = this.providers.get(type);
        if (!manager) {
            throw new Error(`No manager found for provider type: ${type}`);
        }
        
        // Create the provider instance
        try {
            const provider = manager.createProvider(providerSettings);
            if (!provider) {
                throw new Error(`Failed to create provider instance for ${providerId}`);
            }
            return provider;
        } catch (error) {
            console.error(`Error creating provider ${providerId} (${providerSettings.name}):`, error);
            throw new Error(`Failed to create provider: ${error instanceof Error ? error.message : String(error)}`);
        }
    }

    // Add method to notify views of flare changes
    notifyFlareChanged(flareName: string) {
        // Get all chat views
        const chatViews = this.app.workspace.getLeavesOfType(VIEW_TYPE_AI_CHAT)
            .map(leaf => leaf.view as AIChatView);
        
        // Notify each view
        chatViews.forEach(async (view) => {
            if (view.currentFlare?.name === flareName) {
                // Reload the flare config
                const newFlare = await this.flareManager.debouncedLoadFlare(flareName);
                if (!newFlare) {
                    console.error(`Failed to load flare config for ${flareName}`);
                    return;
                }
                
                view.currentFlare = newFlare;
                
                // Simplified placeholder once flare is selected
                view.inputEl.setAttribute('placeholder', `@${newFlare.name}`);

                // Initialize provider with current history if there is any
                if (view.messageHistory.length > 0) {
                    await this.handleMessage('', {
                        flare: newFlare.name,
                        provider: newFlare.provider,
                        model: newFlare.model,
                        temperature: view.currentTemp,
                        maxTokens: newFlare.maxTokens,
                        messageHistory: view.messageHistory,
                        contextWindow: newFlare.contextWindow
                    });
                }
            }
        });
    }

    public applyContextWindow(messages: Array<{role: string; content: string; settings?: any}>, window: number): Array<{role: string; content: string; settings?: any}> {
        // If window is -1 or no messages, return as is
        if (window === -1 || !messages.length) return messages;
        
        // Keep system message if it exists
        const systemMessages = messages.filter(msg => msg.role === 'system');
        const nonSystemMessages = messages.filter(msg => msg.role !== 'system');
        
        // Group messages into user-assistant pairs, excluding the current message
        const pairs: Array<Array<{role: string; content: string; settings?: any}>> = [];
        let currentPair: Array<{role: string; content: string; settings?: any}> = [];
        
        // Get the current message (last message) if it exists
        const currentMessage = nonSystemMessages.length > 0 ? 
            nonSystemMessages[nonSystemMessages.length - 1] : null;
        
        // Process all messages except the current one
        const messagesToProcess = currentMessage ? 
            nonSystemMessages.slice(0, -1) : nonSystemMessages;
        
        for (const msg of messagesToProcess) {
            if (msg.role === 'user') {
                if (currentPair.length > 0) {
                    pairs.push([...currentPair]);
                }
                currentPair = [msg];
            } else if (msg.role === 'assistant' && currentPair.length === 1) {
                currentPair.push(msg);
                pairs.push([...currentPair]);
                currentPair = [];
            }
        }
        
        // Get the last N complete pairs
        const result: Array<{role: string; content: string; settings?: any}> = [];
        
        // Add only the last system message, if any, to the result
        if (systemMessages.length) {
            result.push(systemMessages[systemMessages.length - 1]);
        }
        
        // Add the last N pairs
        const targetPairs = pairs.slice(-window);
        targetPairs.forEach(pair => {
            result.push(...pair);
        });
        
        // Add the current message if it exists
        if (currentMessage) {
            result.push(currentMessage);
        }
        
        return result;
    }

    private applyHandoffContext(messages: Array<{role: string; content: string; settings?: any}>, window: number): Array<{role: string; content: string; settings?: any}> {
        // Keep system message if it exists
        const systemMessage = messages.find(msg => msg.role === 'system');
        const nonSystemMessages = messages.filter(msg => msg.role !== 'system');
        
        // Group messages into user-assistant pairs
        const pairs: Array<Array<{role: string; content: string; settings?: any}>> = [];
        let currentPair: Array<{role: string; content: string; settings?: any}> = [];
        
        // Skip the last message (current message) when forming pairs
        const messagesToProcess = nonSystemMessages.slice(0, -1);
        
        for (let i = 0; i < messagesToProcess.length; i++) {
            const msg = messagesToProcess[i];
            
            if (msg.role === 'user') {
                if (currentPair.length > 0) {
                    pairs.push([...currentPair]);
                }
                currentPair = [msg];
                
                // Look ahead for assistant response
                if (i + 1 < messagesToProcess.length && messagesToProcess[i + 1].role === 'assistant') {
                    currentPair.push(messagesToProcess[i + 1]);
                    pairs.push([...currentPair]);
                    currentPair = [];
                    i++; // Skip the assistant message we just added
                }
            }
        }
        
        // Get the last N pairs
        const targetPairs = pairs.slice(-window);
        const result: Array<{role: string; content: string; settings?: any}> = [];
        
        // Always add system message first if it exists
        if (systemMessage) {
            result.push(systemMessage);
        }
        
        // Add all messages from the selected pairs
        targetPairs.forEach(pair => {
            result.push(...pair);
        });
        
        // Add the current message back
        if (nonSystemMessages.length > 0) {
            result.push(nonSystemMessages[nonSystemMessages.length - 1]);
        }
        
        return result;
    }

    private async expandWikiLinks(text: string, processedLinks: Set<string> = new Set()): Promise<Record<string, string>> {
        const wikilinks = this.extractWikiLinks(text);
        const result: Record<string, string> = {};
        
        await Promise.all(wikilinks.map(async (link) => {
            try {
                const [fileName, alias] = link.split('|').map(s => s.trim());
                
                // Prevent infinite recursion
                if (processedLinks.has(fileName)) {
                    return;
                }
                processedLinks.add(fileName);

                const file = this.app.metadataCache.getFirstLinkpathDest(fileName, '');
                
                if (!file) {
                    console.warn(`File not found for wikilink: ${fileName}`);
                    return;
                }

                // Use read instead of cachedRead to ensure we get the latest content
                const content = await this.app.vault.read(file);
                let processedContent = content;

                const app = this.app as ObsidianApp;
                const dataviewPlugin = app.plugins.plugins.dataview;

                // Process any nested wikilinks first
                const nestedWikilinks = await this.expandWikiLinks(content, processedLinks);
                for (const [nestedFileName, nestedContent] of Object.entries(nestedWikilinks)) {
                    const nestedWikiLinkPattern = new RegExp(`\\[\\[${this.escapeRegexSpecials(nestedFileName)}(?:\\|[^\\]]*)?\\]\\]`, 'g');
                    processedContent = processedContent.replace(nestedWikiLinkPattern, nestedContent);
                }

                // Process dataview content after handling nested wikilinks
                if (dataviewPlugin?.api) {
                    processedContent = await this.processDataviewContent(processedContent, file, dataviewPlugin.api);
                }

                // Store with original filename for proper replacement later
                result[fileName] = processedContent;
            } catch (error) {
                console.error(`Error processing wikilink ${link}:`, error);
                throw new FlareError(`Failed to process wikilink ${link}`, 'WIKILINK_ERROR');
            }
        }));

        return result;
    }

    private extractWikiLinks(text: string): string[] {
        // Improved regex to handle aliases and more complex wikilinks
        const regex = /\[\[([^\]|]+)(?:\|[^\]]+)?\]\]/g;
        const links: string[] = [];
        let match;
        
        while ((match = regex.exec(text)) !== null) {
            links.push(match[1].trim());
        }
        
        return links;
    }

    public async reloadProviderDependentViews(): Promise<void> {
        const chatLeaves = this.app.workspace.getLeavesOfType(VIEW_TYPE_AI_CHAT);
        
        const refreshPromises = chatLeaves.map(async (leaf) => {
            const view = leaf.view;
            if (view instanceof AIChatView) {
                await view.refreshProviderSettings();
            }
        });
        
        await Promise.all(refreshPromises);
    }

    private async processDataviewContent(
        content: string,
        file: TFile,
        dataviewApi: DataviewApi
    ): Promise<string> {
        let processedContent = content;

        // Cache for storing processed queries to avoid duplicate work
        const queryCache: Record<string, string> = {};

        // Process dataview blocks
        const dataviewBlocks = content.match(/```dataview\n([\s\S]*?)\n```/g) || [];
        for (const block of dataviewBlocks) {
            try {
                const query = block.replace(/```dataview\n/, '').replace(/\n```$/, '');
                
                // Check if we've already processed this exact query
                if (queryCache[query]) {
                    processedContent = processedContent.replace(block, queryCache[query]);
                    continue;
                }
                
                const result = await dataviewApi.query(query, file.path);
                
                if (result?.successful) {
                    const formattedResult = this.formatDataviewResult(result.value);
                    // Cache the result
                    queryCache[query] = formattedResult;
                    // Replace in the content
                    processedContent = processedContent.replace(block, formattedResult);
                }
            } catch (error) {
                console.error('Dataview query failed:', error);
                throw new FlareError('Dataview query failed', 'DATAVIEW_ERROR');
            }
        }

        return processedContent;
    }

    private formatDataviewResult(result: {
        type: 'table' | 'list' | 'task';
        headers?: string[];
        values: any[];
    }): string {
        switch (result.type) {
            case 'table':
                return this.formatTableResult(result.headers || [], result.values);
            case 'list':
                return this.formatListResult(result.values);
            case 'task':
                return this.formatTaskResult(result.values);
            default:
                throw new FlareError(`Unknown result type: ${result.type}`, 'FORMAT_ERROR');
        }
    }

    private formatTableResult(headers: string[], values: any[]): string {
        let resultText = '| ' + headers.join(' | ') + ' |\n';
        resultText += '| ' + headers.map(() => '---').join(' | ') + ' |\n';
        values.forEach((row: any[]) => {
            resultText += '| ' + row.map(cell => String(cell)).join(' | ') + ' |\n';
        });
        return resultText;
    }

    private formatListResult(values: any[]): string {
        return values.map((item: any) => `- ${item}`).join('\n');
    }

    private formatTaskResult(values: any[]): string {
        return values.map((task: any) => `- [ ] ${task}`).join('\n');
    }

    private async handleFlareCodeBlock(source: string, el: HTMLElement, ctx: MarkdownPostProcessorContext) {
        // Create a unique ID for this codeblock instance to track event listeners
        const codeBlockId = this.createUniqueCodeBlockId();
        const cleanupFunctions: Array<() => void> = [];
        
        // Create UI elements
        const elements = this.createFlareCodeBlockUI(el, source, cleanupFunctions);
        
        // Set up resize handling
        this.setupFlareCodeBlockResize(elements, cleanupFunctions);
        
        // Set up event handlers for buttons
        this.setupFlareCodeBlockEventHandlers(elements, source, ctx, cleanupFunctions);
        
        // Render existing response if present
        this.renderExistingFlareResponse(elements, source, ctx);
        
        // Register cleanup
        this.registerFlareCodeBlockCleanup(el, codeBlockId, cleanupFunctions, ctx);
    }
    
    private createUniqueCodeBlockId(): string {
        return `flare-codeblock-${Date.now()}-${Math.random().toString(36).substring(2, 15)}`;
    }
    
    private createFlareCodeBlockUI(el: HTMLElement, source: string, cleanupFunctions: Array<() => void>): {
        contentContainer: HTMLDivElement;
        querySection: HTMLTextAreaElement;
        resizeHandle: HTMLDivElement;
        responseSection: HTMLDivElement;
        buttonContainer: HTMLDivElement;
        sendButton: HTMLButtonElement;
        finalizeButton: HTMLButtonElement;
    } {
        // Create container for the codeblock content
        const contentContainer = el.createDiv({ cls: 'flare-codeblock-container' });
        
        // Add a data attribute with a hash of the source content to help identify this block
        const sourceHash = this.hashString(source.trim());
        contentContainer.setAttribute('data-flare-id', sourceHash);
        
        // Create header with flame icon
        const header = contentContainer.createDiv({ cls: 'flare-codeblock-header' });
        
        // Simply use a standard header style without color variations
        setIcon(header.createSpan(), 'flame');
        header.createSpan({ text: 'FLARE.ai' });
        
        // Create the query section as a textarea
        const querySection = contentContainer.createEl('textarea', { 
            cls: 'flare-codeblock-query',
            attr: { rows: '1' }
        });
        querySection.value = source;
        
        // Add a dedicated resize handle for mobile/touch devices
        const resizeHandle = contentContainer.createDiv({ cls: 'flare-codeblock-resize-handle' });
        
        // Create response section
        const responseSection = contentContainer.createDiv({ cls: 'flare-codeblock-response' });
        responseSection.addClass('is-hidden');

        // Create button container
        const buttonContainer = contentContainer.createEl('div', {
            cls: 'flare-codeblock-buttons'
        });

        // Add send button
        const sendButton = buttonContainer.createEl('button', {
            text: 'Send',
            cls: 'flare-codeblock-button'
        });

        // Add finalize button (hidden by default)
        const finalizeButton = buttonContainer.createEl('button', {
            text: 'Finalize',
            cls: 'flare-codeblock-button is-hidden'
        });
        
        return {
            contentContainer,
            querySection,
            resizeHandle,
            responseSection,
            buttonContainer,
            sendButton,
            finalizeButton
        };
    }
    
    private setupFlareCodeBlockResize(
        elements: {
            querySection: HTMLTextAreaElement;
            resizeHandle: HTMLDivElement;
        },
        cleanupFunctions: Array<() => void>
    ) {
        const { querySection, resizeHandle } = elements;
        
        // Auto-resize textarea as content changes
        const resizeQuerySection = () => {
            // Only auto-resize if the user hasn't manually resized
            if (!querySection.hasClass('user-resized')) {
                // Batch DOM operations for better performance
                requestAnimationFrame(() => {
                    // Reset height to auto to measure actual content height
                    querySection.addClass('is-measuring');
                    
                    // Read measurements in a single frame
                    const scrollHeight = querySection.scrollHeight;
                    const minHeight = parseFloat(getComputedStyle(querySection).minHeight);
                    const newHeight = Math.max(scrollHeight, minHeight);
                    
                    // Write to DOM in a single frame
                    querySection.removeClass('is-measuring');
                    querySection.style.height = `${newHeight}px`;
                });
            }
        };

        // Track interaction state for resizing
        let touchStartY = 0;
        let initialHeight = 0;
        let isResizing = false;

        // Touch event handlers for custom resize on mobile
        const touchStartHandler = (e: TouchEvent) => {
            touchStartY = e.touches[0].clientY;
            initialHeight = querySection.offsetHeight;
            isResizing = true;
            querySection.addClass('user-resized');
            
            // Prevent default to avoid scrolling while resizing
            e.preventDefault();
        };
        resizeHandle.addEventListener('touchstart', touchStartHandler, { passive: false });
        cleanupFunctions.push(() => resizeHandle.removeEventListener('touchstart', touchStartHandler));

        const touchMoveHandler = (e: TouchEvent) => {
            if (!isResizing) return;
            
            // Calculate new height
            const touchDeltaY = e.touches[0].clientY - touchStartY;
            const newHeight = Math.max(initialHeight + touchDeltaY, 50); // Minimum height of 50px
            
            // Batch style updates in the next animation frame
            requestAnimationFrame(() => {
                if (querySection) {
                    querySection.style.height = `${newHeight}px`;
                }
            });
            
            // Prevent default to avoid scrolling while resizing
            e.preventDefault();
        };
        document.addEventListener('touchmove', touchMoveHandler, { passive: false });
        cleanupFunctions.push(() => document.removeEventListener('touchmove', touchMoveHandler));

        const touchEndHandler = () => {
            isResizing = false;
        };
        document.addEventListener('touchend', touchEndHandler);
        cleanupFunctions.push(() => document.removeEventListener('touchend', touchEndHandler));

        // Mouse event handlers for resize handle
        const mouseDownHandler = (e: MouseEvent) => {
            // Only handle left mouse button
            if (e.button !== 0) return;
            
            initialHeight = querySection.offsetHeight;
            touchStartY = e.clientY;
            isResizing = true;
            querySection.addClass('user-resized');
            
            // Prevent text selection during resize
            e.preventDefault();
            
            // Add event listeners to document for better drag tracking
            document.addEventListener('mousemove', mouseMoveHandler);
            document.addEventListener('mouseup', mouseUpHandler);
        };
        
        const mouseMoveHandler = (e: MouseEvent) => {
            if (!isResizing) return;
            
            const deltaY = e.clientY - touchStartY;
            const newHeight = Math.max(initialHeight + deltaY, 50); // Minimum height of 50px
            
            // Batch style updates in requestAnimationFrame
            requestAnimationFrame(() => {
                querySection.style.height = `${newHeight}px`;
            });
            
            e.preventDefault();
        };
        
        const mouseUpHandler = () => {
            isResizing = false;
            document.removeEventListener('mousemove', mouseMoveHandler);
            document.removeEventListener('mouseup', mouseUpHandler);
        };
        
        // Add mouse event listeners to resize handle
        resizeHandle.addEventListener('mousedown', mouseDownHandler);
        cleanupFunctions.push(() => resizeHandle.removeEventListener('mousedown', mouseDownHandler));
        cleanupFunctions.push(() => {
            document.removeEventListener('mousemove', mouseMoveHandler);
            document.removeEventListener('mouseup', mouseUpHandler);
        });

        // Add mousedown handler to track manual resizing of textarea itself
        const textareaMousedownHandler = () => {
            // Mark as manually resized
            querySection.addClass('user-resized');
        };
        querySection.addEventListener('mousedown', textareaMousedownHandler);
        cleanupFunctions.push(() => querySection.removeEventListener('mousedown', textareaMousedownHandler));

        // Add mouseup handler to restore auto-resize after manual resize
        const textareaMouseupHandler = () => {
            // Nothing to do here - we keep the user-resized state
        };
        querySection.addEventListener('mouseup', textareaMouseupHandler);
        cleanupFunctions.push(() => querySection.removeEventListener('mouseup', textareaMouseupHandler));
        
        // Add input event listener for auto-resize
        querySection.addEventListener('input', resizeQuerySection);
        cleanupFunctions.push(() => querySection.removeEventListener('input', resizeQuerySection));
        
        // Initial resize using requestAnimationFrame for better performance
        const initialResizeTimeout = setTimeout(() => {
            resizeQuerySection();
        }, 0);
        
        // Fix initialResizeTimeout reference
        if (initialResizeTimeout) {
            cleanupFunctions.push(() => clearTimeout(initialResizeTimeout));
        }
    }
    
    private setupFlareCodeBlockEventHandlers(
        elements: {
            querySection: HTMLTextAreaElement;
            responseSection: HTMLDivElement;
            buttonContainer: HTMLDivElement;
            sendButton: HTMLButtonElement;
            finalizeButton: HTMLButtonElement;
        },
        source: string,
        ctx: MarkdownPostProcessorContext,
        cleanupFunctions: Array<() => void>
    ) {
        const { querySection, responseSection, buttonContainer, sendButton, finalizeButton } = elements;
        
        // Function to update the file content
        const updateFileContent = async (query: string, response: string | null, blockId: string | null) => {
            const file = this.app.vault.getAbstractFileByPath(ctx.sourcePath);
            if (!file || !(file instanceof TFile)) {
                return;
            }

            // Get all editors for this file
            const editorLeaves = this.app.workspace.getLeavesOfType('markdown')
                .filter(leaf => {
                    const view = leaf.view;
                    return view instanceof MarkdownView && view.file?.path === ctx.sourcePath;
                });
                
            const editors = editorLeaves.map(leaf => {
                const view = leaf.view as MarkdownView;
                return view.editor;
            });

            const content = editors.length > 0 ? 
                editors[0].getValue() : 
                await this.app.vault.read(file);

            const lines = content.split('\n');
            
            // Find all flare codeblocks in the file
            const codeblocks: Array<{ start: number; end: number; content: string; hash?: string }> = [];
            let insideCodeblock = false;
            let currentStart = -1;
            let currentContent = '';
            
            for (let i = 0; i < lines.length; i++) {
                const line = lines[i].trim();
                
                // Check for both lowercase and uppercase variants
                if ((line === '```flare' || line === '```FLARE') && !insideCodeblock) {
                    insideCodeblock = true;
                    currentStart = i;
                    currentContent = '';
                } else if (line === '```' && insideCodeblock) {
                    insideCodeblock = false;
                    // Calculate a hash for this content to compare with blockId
                    const contentHash = this.hashString(currentContent.trim());
                    codeblocks.push({
                        start: currentStart,
                        end: i,
                        content: currentContent.trim(),
                        hash: contentHash
                    });
                } else if (insideCodeblock) {
                    currentContent += line + '\n';
                }
            }
            
            // Find the specific codeblock that matches our query
            // First try to match by blockId if available
            let targetCodeblock = null;
            
            if (blockId) {
                // Try to find by hash ID first (most precise)
                targetCodeblock = codeblocks.find(block => block.hash === blockId);
            }
            
            // If we couldn't find by ID, fall back to content matching
            if (!targetCodeblock) {
                for (const block of codeblocks) {
                    // Check for exact match or if the block content starts with our query
                    if (block.content === query ||
                        block.content.startsWith(query) ||
                        // Normalize both by removing whitespace and compare
                        block.content.replace(/\s+/g, '') === query.replace(/\s+/g, '') ||
                        // Handle case where there's already a separator with response
                        block.content.split(/\n\s*---\s*\n/)[0].trim() === query.trim()) {
                        targetCodeblock = block;
                        break;
                    }
                }
            }
            
            // If we found a matching codeblock, update it
            if (targetCodeblock) {
                const startLine = targetCodeblock.start;
                const endLine = targetCodeblock.end;
                
                // Create the new content
                const sourceHash = blockId || this.hashString(query.trim());
                const newContent = response ? 
                    `\`\`\`flare\n${query}\n\n---\n${response}\n\`\`\`` :
                    `\`\`\`flare\n${query}\n\`\`\``;

                // Check if content has actually changed to avoid unnecessary updates
                let contentChanged = false;
                const existingContent = lines.slice(startLine, endLine + 1).join('\n');
                const expectedContent = response ? 
                    `\`\`\`flare\n${targetCodeblock.content}\n\`\`\`` :
                    `\`\`\`flare\n${targetCodeblock.content.split(/\n\s*---\s*\n/)[0].trim()}\n\`\`\``;
                
                // If content is different, update it
                if (existingContent.trim() !== expectedContent.trim() || 
                    existingContent.trim() !== newContent.trim()) {
                    contentChanged = true;
                }
                
                if (!contentChanged) {
                    console.log('No content change detected, skipping update');
                    return; // Skip update if no change
                }

                if (editors.length > 0) {
                    // If editor is open, use editor transaction
                    const editor = editors[0];
                    
                    // Check if there's content on the line after the codeblock
                    const nextLineContent = endLine + 1 < lines.length ? lines[endLine + 1] : '';
                    const endsWithNewline = nextLineContent === '';
                    
                    // Add a newline to the end of newContent if the line after codeblock was empty
                    // This preserves empty lines after the codeblock
                    const finalContent = endsWithNewline ? newContent + '\n' : newContent;
                    
                    editor.transaction({
                        changes: [{
                            from: editor.offsetToPos(editor.posToOffset({ line: startLine, ch: 0 })),
                            to: editor.offsetToPos(editor.posToOffset({ line: endLine + 1, ch: 0 })),
                            text: finalContent
                        }]
                    });
                } else {
                    // If no editor, modify file directly
                    
                    // Check if there's content on the line after the codeblock
                    const nextLineContent = endLine + 1 < lines.length ? lines[endLine + 1] : '';
                    const endsWithNewline = nextLineContent === '';
                    
                    // Preserve empty line after codeblock if it existed
                    if (endsWithNewline) {
                        // Replace with the new content and add an empty line
                        lines.splice(startLine, endLine - startLine + 1, newContent, '');
                    } else {
                        // Just replace with the new content
                        lines.splice(startLine, endLine - startLine + 1, newContent);
                    }
                    
                    await this.app.vault.modify(file, lines.join('\n'));
                }
            } else {
                // Fallback to the first codeblock if no match found
                let startLine = -1;
                let endLine = -1;
                
                for (let i = 0; i < lines.length; i++) {
                    if (lines[i].trim() === '```flare' && startLine === -1) {
                        startLine = i;
                    } else if (lines[i].trim() === '```' && startLine !== -1 && endLine === -1) {
                        endLine = i;
                        break;
                    }
                }
                
                if (startLine !== -1 && endLine !== -1) {
                    // Create the new content
                    const newContent = response ? 
                        `\`\`\`flare\n${query}\n\n---\n${response}\n\`\`\`` :
                        `\`\`\`flare\n${query}\n\`\`\``;

                    if (editors.length > 0) {
                        // If editor is open, use editor transaction
                        const editor = editors[0];
                        
                        // Check if there's content on the line after the codeblock
                        const nextLineContent = endLine + 1 < lines.length ? lines[endLine + 1] : '';
                        const endsWithNewline = nextLineContent === '';
                        
                        // Add a newline to the end of newContent if the line after codeblock was empty
                        // This preserves empty lines after the codeblock
                        const finalContent = endsWithNewline ? newContent + '\n' : newContent;
                        
                        editor.transaction({
                            changes: [{
                                from: editor.offsetToPos(editor.posToOffset({ line: startLine, ch: 0 })),
                                to: editor.offsetToPos(editor.posToOffset({ line: endLine + 1, ch: 0 })),
                                text: finalContent
                            }]
                        });
                    } else {
                        // If no editor, modify file directly
                        
                        // Check if there's content on the line after the codeblock
                        const nextLineContent = endLine + 1 < lines.length ? lines[endLine + 1] : '';
                        const endsWithNewline = nextLineContent === '';
                        
                        // Preserve empty line after codeblock if it existed
                        if (endsWithNewline) {
                            // Replace with the new content and add an empty line
                            lines.splice(startLine, endLine - startLine + 1, newContent, '');
                        } else {
                            // Just replace with the new content
                            lines.splice(startLine, endLine - startLine + 1, newContent);
                        }
                        
                        await this.app.vault.modify(file, lines.join('\n'));
                    }
                }
            }
        };

        // Function to update file content on input with debouncing using Obsidian's debounce function
        const debouncedUpdateQuery = debounce(
            async (query: string) => {
                try {
                    // Add updating state to prevent visual flashing during update
                    const codeblockContainer = querySection.closest('.flare-codeblock-container');
                    codeblockContainer?.addClass('is-updating');
                    
                    const blockId = codeblockContainer ? codeblockContainer.getAttribute('data-flare-id') : null;
                    
                    // If there's already a response, preserve it
                    const hasResponse = !responseSection.hasClass('is-hidden');
                    let response = null;
                    
                    if (hasResponse) {
                        // Get the response content by extracting from the rendered content
                        response = responseSection.textContent;
                    }
                    
                    await updateFileContent(query, response, blockId);
                    
                    // Remove updating state after a slight delay to ensure smooth transition
                    setTimeout(() => {
                        codeblockContainer?.removeClass('is-updating');
                    }, 50);
                } catch (error) {
                    console.error('Error updating codeblock content:', error);
                    // Remove updating state on error too
                    const codeblockContainer = querySection.closest('.flare-codeblock-container');
                    codeblockContainer?.removeClass('is-updating');
                }
            },
            300, // Reduced from 400ms for more responsiveness while still preventing flashing
            false  // Changed to false to not run immediately for first call - wait for the debounce
        );
        
        // Make sure to add a cleanup for the debounced function
        cleanupFunctions.push(() => {
            // Cast the debouncer to access the cancel method
            const debouncerWithCancel = debouncedUpdateQuery as unknown as { 
                cancel: () => void 
            };
            if (debouncerWithCancel.cancel) {
                debouncerWithCancel.cancel();
            }
        });

        // Add input event listener to synchronize textarea with file content
        const inputChangeHandler = () => {
            // NO-OP: We've removed auto-syncing during typing to prevent cursor jumps
            // Previously this would trigger debouncedUpdateQuery on every keystroke
        };
        
        // Create a debounced version specifically for mobile
        const debouncedMobileUpdate = debounce(
            async (query: string, responseText: string | null, blockId: string | null) => {
                try {
                    // Add updating state to prevent visual flashing
                    const codeblockContainer = querySection.closest('.flare-codeblock-container');
                    codeblockContainer?.addClass('is-updating');
                    
                    await updateFileContent(query, responseText, blockId);
                    
                    // Remove updating state after a slight delay
                    setTimeout(() => {
                        codeblockContainer?.removeClass('is-updating');
                    }, 50);
                } catch (error) {
                    console.error('Error updating codeblock content on mobile:', error);
                    // Remove updating state on error
                    const codeblockContainer = querySection.closest('.flare-codeblock-container');
                    codeblockContainer?.removeClass('is-updating');
                }
            },
            200, // Slightly faster for mobile for better responsiveness
            false // Don't run immediately
        );
        
        // Add cleanup for mobile debouncer too
        cleanupFunctions.push(() => {
            const mobileDebouncerWithCancel = debouncedMobileUpdate as unknown as {
                cancel: () => void
            };
            if (mobileDebouncerWithCancel.cancel) {
                mobileDebouncerWithCancel.cancel();
            }
        });
        
        // Use blur event to ensure update happens when focus leaves the textarea
        // For mobile, this is the ONLY time we update the content
        const blurHandler = () => {
            const currentQuery = querySection.value;
            
            // Store the active element before the blur
            const activeElement = document.activeElement;
            
            // Only proceed with content update if we're truly losing focus to something outside this component
            // or if we're on mobile (where the behavior is different)
            if (Platform.isMobile || 
                (activeElement && 
                 !querySection.contains(activeElement) && 
                 !querySection.closest('.flare-codeblock-container')?.contains(activeElement))) {
                
                // Get current content for comparison to detect changes
                const blockId = querySection.closest('.flare-codeblock-container')?.getAttribute('data-flare-id') || null;
                const responseText = responseSection.textContent;
                
                if (Platform.isMobile) {
                    // On mobile, use the mobile-optimized debouncer
                    debouncedMobileUpdate(currentQuery, responseText, blockId);
                } else {
                    // For desktop, trigger the debounced update
                    debouncedUpdateQuery(currentQuery);
                }
            }
        };
        
        // Register event listeners
        querySection.addEventListener('input', inputChangeHandler);
        querySection.addEventListener('blur', blurHandler);
        
        // Clean up event listeners
        cleanupFunctions.push(() => {
            querySection.removeEventListener('input', inputChangeHandler);
            querySection.removeEventListener('blur', blurHandler);
        });

        // Variable to track request state
        let isProcessing = false;
        // Create an AbortController to handle request cancellation
        let abortController: AbortController | null = null;

        // Function to toggle send button state
        const toggleSendButton = (isProcessingState: boolean) => {
            isProcessing = isProcessingState;
            sendButton.textContent = isProcessing ? 'Stop' : 'Send';
            sendButton.disabled = false; // Always ensure button is enabled
        };
        
        // Function to safely reset state in case of errors
        const safeResetState = () => {
            isProcessing = false;
            abortController = null;
            sendButton.textContent = 'Send';
            sendButton.disabled = false;
        };

        // Handle send button click
        const sendButtonClickHandler = async () => {
            // If already processing, treat as stop request
            if (isProcessing) {
                // Give immediate UI feedback
                responseSection.textContent = 'Stopping request...';
                
                // Make sure abort controller exists and isn't already aborted
                if (abortController && !abortController.signal.aborted) {
                    abortController.abort();
                }
                
                // Clean up the controller reference
                abortController = null;
                
                // Also try to cancel via the provider directly
                try {
                    const flare = this.parseMessageForFlare(querySection.value).flare;
                    const provider = await this.getProviderInstance(flare);
                    if (provider && typeof provider.cancelRequest === 'function') {
                        provider.cancelRequest();
                    }
                } catch (error) {
                    console.error('Error stopping request:', error);
                }
                
                // Reset button state immediately so user sees response
                toggleSendButton(false);
                
                // Update response section after a brief delay to ensure the abort had time to take effect
                setTimeout(() => {
                    responseSection.textContent = 'Request stopped by user.';
                }, 50);
                
                return;
            }

            const currentQuery = querySection.value;
            
            // Get the hash ID of this codeblock to help identify it when updating
            const codeblockContainer = querySection.closest('.flare-codeblock-container');
            const blockId = codeblockContainer ? codeblockContainer.getAttribute('data-flare-id') : null;
            
            // Save cursor position for later restoration
            const cursorPos = querySection.selectionStart;
            
            // Parse the message for flare
            const { flare, content } = this.parseMessageForFlare(currentQuery);
            
            // Show loading state
            toggleSendButton(true);
            responseSection.removeClass('is-hidden');
            responseSection.textContent = 'Loading...';
            
            // Record start time for minimum display duration
            const startTime = Date.now();
            // Minimum time (milliseconds) to show the Stop button
            const MIN_PROCESSING_TIME = 1000;

            try {
                // Create a new AbortController for this request
                abortController = new AbortController();
                const signal = abortController.signal;

                // Send message to the flare with the abort signal
                const response = await this.handleMessage(currentQuery, {
                    flare: flare,
                    stream: false, // Don't stream for codeblocks
                    signal: signal // Pass the abort signal
                });

                // Only continue if not aborted
                if (!signal.aborted) {
                    // Update the file with the new query and response
                    await updateFileContent(currentQuery, response, blockId);

                    // Clear existing content and render markdown response
                    responseSection.empty();
                    await MarkdownRenderer.render(
                        this.app,
                        response,
                        responseSection,
                        ctx.sourcePath,
                        this
                    );
                    
                    // Show finalize button if not already visible
                    finalizeButton.removeClass('is-hidden');
                    
                    // Restore focus immediately after rendering response
                    setTimeout(() => {
                        querySection.focus();
                        querySection.setSelectionRange(cursorPos, cursorPos);
                    }, 10);
                }
            } catch (error) {
                // If aborted, show appropriate message
                if (error instanceof Error && (error.name === 'AbortError' || error.message.includes('aborted'))) {
                    responseSection.textContent = 'Request stopped by user.';
                } else {
                    responseSection.textContent = `Error: ${error instanceof Error ? error.message : 'An unknown error occurred'}`;
                    console.error('Error in codeblock:', error);
                }
                
                // Restore focus after error
                setTimeout(() => {
                    querySection.focus();
                    querySection.setSelectionRange(cursorPos, cursorPos);
                }, 10);
            } finally {
                // Always clean up the abort controller
                abortController = null;
                
                // Calculate time elapsed since starting the request
                const elapsedTime = Date.now() - startTime;
                const remainingTime = Math.max(0, MIN_PROCESSING_TIME - elapsedTime);
                
                // Add a delay before resetting button state to ensure minimum visibility time
                // This ensures users have time to see and interact with the Stop button
                setTimeout(() => {
                    // Only reset the button if we're still processing (hasn't been clicked again)
                    if (isProcessing) {
                        toggleSendButton(false);
                    }
                }, remainingTime); // Ensure button stays visible for at least MIN_PROCESSING_TIME
                
                // Add a safety timeout to ensure button eventually resets
                // This prevents the button from getting stuck in a "Stop" state
                setTimeout(() => {
                    if (isProcessing) {
                        console.log('Safety reset triggered for Stop button');
                        safeResetState();
                    }
                }, MIN_PROCESSING_TIME + 5000); // Extra 5 seconds as safety measure
            }
        };
        sendButton.addEventListener('click', sendButtonClickHandler);
        cleanupFunctions.push(() => {
            sendButton.removeEventListener('click', sendButtonClickHandler);
            
            // Make sure to abort any pending requests on cleanup
            if (abortController) {
                abortController.abort();
                abortController = null;
            }
            
            // Reset processing state 
            isProcessing = false;
        });

        // Handle finalize button click
        const finalizeButtonClickHandler = () => {
            this.finalizeFlareCodeBlock(ctx, buttonContainer);
        };
        finalizeButton.addEventListener('click', finalizeButtonClickHandler);
        cleanupFunctions.push(() => finalizeButton.removeEventListener('click', finalizeButtonClickHandler));
    }
    
    private finalizeFlareCodeBlock(ctx: MarkdownPostProcessorContext, buttonContainer: HTMLDivElement) {
        // Get the markdown file that contains this codeblock
        const file = this.app.vault.getAbstractFileByPath(ctx.sourcePath);
        if (!file || !(file instanceof TFile)) {
            return;
        }

        // Get current codeblock content to use for matching
        // This will be in the parent element of the buttonContainer
        const codeblockContainer = buttonContainer.closest('.flare-codeblock-container');
        if (!codeblockContainer) {
            return; // Can't find the container
        }
        
        // Get the hash ID of this codeblock
        const blockId = codeblockContainer.getAttribute('data-flare-id');
        
        // Get the query text from the textarea 
        const querySection = codeblockContainer.querySelector('.flare-codeblock-query') as HTMLTextAreaElement;
        if (!querySection) {
            return; // Can't find the query section
        }
        
        const currentQuery = querySection.value.trim();

        // Get all editors for this file
        const editorLeaves = this.app.workspace.getLeavesOfType('markdown')
            .filter(leaf => {
                const view = leaf.view;
                return view instanceof MarkdownView && view.file?.path === ctx.sourcePath;
            });
            
        const editors = editorLeaves.map(leaf => {
            const view = leaf.view as MarkdownView;
            return view.editor;
        });

        if (editors.length === 0) {
            // If no editor is open, modify the file directly
            this.app.vault.read(file).then(content => {
                const lines = content.split('\n');
                
                // Find all flare codeblocks
                const codeblocks: Array<{ start: number; end: number; content: string; hash?: string; codeBlockType: string }> = [];
                let insideCodeblock = false;
                let currentStart = -1;
                let currentContent = '';
                let currentCodeBlockType = '';
                
                for (let i = 0; i < lines.length; i++) {
                    const line = lines[i].trim();
                    
                    // Check for both cases of flare
                    if (line === '```flare' || line === '```FLARE') {
                        insideCodeblock = true;
                        currentStart = i;
                        currentContent = '';
                        currentCodeBlockType = line === '```flare' ? 'flare' : 'FLARE';
                    } else if (line === '```' && insideCodeblock) {
                        insideCodeblock = false;
                        // Calculate hash for this content
                        const contentHash = this.hashString(currentContent.trim());
                        codeblocks.push({
                            start: currentStart,
                            end: i,
                            content: currentContent.trim(),
                            hash: contentHash,
                            codeBlockType: currentCodeBlockType
                        });
                    } else if (insideCodeblock) {
                        currentContent += line + '\n';
                    }
                }
                
                // Find the codeblock matching our current query or hash
                let targetCodeblock = null;
                
                // First try to match by hash ID (most precise)
                if (blockId) {
                    targetCodeblock = codeblocks.find(block => block.hash === blockId);
                }
                
                // If no match by hash, try matching by content
                if (!targetCodeblock) {
                    for (const block of codeblocks) {
                        // Check for matches with the current query
                        if (block.content === currentQuery || 
                            block.content.startsWith(currentQuery) ||
                            block.content.split(/\n\s*---\s*\n/)[0].trim() === currentQuery.trim()) {
                            targetCodeblock = block;
                            break;
                        }
                    }
                }
                
                // If we found a match, update just that codeblock
                if (targetCodeblock) {
                    // Always use uppercase FLARE-ai regardless of original case
                    lines[targetCodeblock.start] = "```FLARE-ai";
                    
                    // Write back to file
                    this.app.vault.modify(file, lines.join('\n'));
                    
                    // Hide the buttons
                    buttonContainer.remove();
                } else {
                    // Fallback to old behavior if no match found
                    let startLine = -1;
                    let endLine = -1;
                    
                    for (let i = 0; i < lines.length; i++) {
                        const line = lines[i].trim();
                        if ((line === '```flare' || line === '```FLARE') && startLine === -1) {
                            startLine = i;
                        } else if (line === '```' && startLine !== -1 && endLine === -1) {
                            endLine = i;
                            break;
                        }
                    }

                    if (startLine !== -1 && endLine !== -1) {
                        // Always use uppercase FLARE-ai
                        lines[startLine] = "```FLARE-ai";
                        
                        // Write back to file
                        this.app.vault.modify(file, lines.join('\n'));
                        
                        // Hide the buttons
                        buttonContainer.remove();
                    }
                }
            });
        } else {
            // If editor is open, use the editor API
            const editor = editors[0];
            const content = editor.getValue();
            const lines = content.split('\n');
            
            // Find all flare codeblocks
            const codeblocks: Array<{ start: number; end: number; content: string; hash?: string; codeBlockType: string }> = [];
            let insideCodeblock = false;
            let currentStart = -1;
            let currentContent = '';
            let currentCodeBlockType = '';
            
            for (let i = 0; i < lines.length; i++) {
                const line = lines[i].trim();
                
                if (line === '```flare' || line === '```FLARE') {
                    insideCodeblock = true;
                    currentStart = i;
                    currentContent = '';
                    currentCodeBlockType = line === '```flare' ? 'flare' : 'FLARE';
                } else if (line === '```' && insideCodeblock) {
                    insideCodeblock = false;
                    // Calculate hash for matching
                    const contentHash = this.hashString(currentContent.trim());
                    codeblocks.push({
                        start: currentStart,
                        end: i,
                        content: currentContent.trim(),
                        hash: contentHash,
                        codeBlockType: currentCodeBlockType
                    });
                } else if (insideCodeblock) {
                    currentContent += line + '\n';
                }
            }
            
            // Find the codeblock matching our current query or hash
            let targetCodeblock = null;
            
            // First try to match by hash ID (most precise)
            if (blockId) {
                targetCodeblock = codeblocks.find(block => block.hash === blockId);
            }
            
            // If no match by hash, try matching by content
            if (!targetCodeblock) {
                for (const block of codeblocks) {
                    // Check for matches with the current query
                    if (block.content === currentQuery || 
                        block.content.startsWith(currentQuery) ||
                        block.content.split(/\n\s*---\s*\n/)[0].trim() === currentQuery.trim()) {
                        targetCodeblock = block;
                        break;
                    }
                }
            }
            
            // If we found a match, update just that codeblock
            if (targetCodeblock) {
                // Always use uppercase FLARE-ai regardless of original case
                editor.transaction({
                    changes: [{
                        from: editor.offsetToPos(editor.posToOffset({ line: targetCodeblock.start, ch: 0 })),
                        to: editor.offsetToPos(editor.posToOffset({ line: targetCodeblock.start + 1, ch: 0 })),
                        text: "```FLARE-ai\n"
                    }]
                });

                // Hide the buttons
                buttonContainer.remove();
            } else {
                // Fallback to old behavior if no match found
                let startLine = -1;
                let endLine = -1;
                
                for (let i = 0; i < lines.length; i++) {
                    const line = lines[i].trim();
                    if ((line === '```flare' || line === '```FLARE') && startLine === -1) {
                        startLine = i;
                    } else if (line === '```' && startLine !== -1 && endLine === -1) {
                        endLine = i;
                        break;
                    }
                }

                if (startLine !== -1 && endLine !== -1) {
                    // Always use uppercase FLARE-ai
                    editor.transaction({
                        changes: [{
                            from: editor.offsetToPos(editor.posToOffset({ line: startLine, ch: 0 })),
                            to: editor.offsetToPos(editor.posToOffset({ line: startLine + 1, ch: 0 })),
                            text: "```FLARE-ai\n"
                        }]
                    });

                    // Hide the buttons
                    buttonContainer.remove();
                }
            }
        }
    }
    
    private renderExistingFlareResponse(
        elements: {
            querySection: HTMLTextAreaElement;
            responseSection: HTMLDivElement;
            finalizeButton: HTMLButtonElement;
        },
        source: string,
        ctx: MarkdownPostProcessorContext
    ) {
        const { querySection, responseSection, finalizeButton } = elements;
        
        // If there's already a response in the source, render it
        const firstSeparatorIndex = source.indexOf('\n---\n');
        if (firstSeparatorIndex !== -1) {
            const query = source.substring(0, firstSeparatorIndex).trim();
            const response = source.substring(firstSeparatorIndex + 5); // 5 is length of '\n---\n'
            
            querySection.value = query;
            responseSection.removeClass('is-hidden');
            finalizeButton.removeClass('is-hidden');
            
            // Render the existing response
            responseSection.empty();
            MarkdownRenderer.render(
                this.app,
                response,
                responseSection,
                ctx.sourcePath,
                this
            );
        }
    }
    
    private registerFlareCodeBlockCleanup(
        el: HTMLElement, 
        codeBlockId: string, 
        cleanupFunctions: Array<() => void>,
        ctx: MarkdownPostProcessorContext
    ) {
        // Track cleanup functions for this codeblock
        this.codeBlockCleanupFunctions.set(codeBlockId, cleanupFunctions);

        // Register a proper MarkdownRenderChild to clean up when this markdown view is destroyed
        if (ctx) {
            ctx.addChild(new FlareCodeBlockCleanup(el, this, codeBlockId));
        }
    }

    // Helper methods for the FlareCodeBlockCleanup class
    public getCodeBlockCleanupFunctions(id: string): Array<() => void> | undefined {
        return this.codeBlockCleanupFunctions.get(id);
    }

    public removeCodeBlockCleanupFunctions(id: string): void {
        this.codeBlockCleanupFunctions.delete(id);
    }

    async ensureHistoryFolderExists() {
        const folderPath = this.settings.historyFolder || 'FLAREai/history';
        if (!(await this.app.vault.adapter.exists(folderPath))) {
            await this.app.vault.createFolder(folderPath);
        }
    }

    async ensureExportFolderExists() {
        const folderPath = this.settings.exportSettings?.exportFolder || 'FLAREai/exports';
        if (!(await this.app.vault.adapter.exists(folderPath))) {
            await this.app.vault.createFolder(folderPath);
        }
    }

    // Helper method to create a simple hash from a string for identification purposes
    private hashString(input: string): string {
        let hash = 0;
        for (let i = 0; i < input.length; i++) {
            const char = input.charCodeAt(i);
            hash = ((hash << 5) - hash) + char;
            hash = hash & hash; // Convert to 32bit integer
        }
        // Convert to a positive hex string and take first 8 chars for brevity
        return Math.abs(hash).toString(16).substring(0, 8);
    }

    /**
     * Find a provider by name or type - useful for cross-device compatibility
     * @param providerName The name of the provider to look for
     * @param providerType The type of the provider (e.g., 'openai', 'anthropic')
     */
    async getProviderByNameAndType(providerName?: string, providerType?: string): Promise<AIProvider> {
        // If we have a name, try to find by name first (most reliable)
        if (providerName) {
            try {
                return await this.getProviderInstance(providerName);
            } catch (error) {
                // If we couldn't find by name but also have a type, continue to type search
                if (!providerType) {
                    throw error; // Re-throw if we don't have a type to fall back to
                }
                // Otherwise, continue to the type search below
            }
        }
        
        // If we have a type or name search failed, try to find by type
        if (providerType) {
            // Find all providers of this type
            const providersOfType = Object.entries(this.settings.providers)
                .filter(([_, settings]) => settings.type === providerType);
                
            if (providersOfType.length > 0) {
                // Prefer enabled providers
                const enabledProvider = providersOfType.find(([_, settings]) => settings.enabled);
                if (enabledProvider) {
                    return await this.getProviderInstance(enabledProvider[0]);
                }
                
                // Fall back to the first one if none are enabled
                return await this.getProviderInstance(providersOfType[0][0]);
            }
        }
        
        // If we got here, we couldn't find by name or type
        // Try to use the default provider
        if (this.settings.defaultProvider) {
            try {
                return await this.getProviderInstance(this.settings.defaultProvider);
            } catch (error) {
                // Continue to the last resort if default fails
            }
        }
        
        // Last resort: try to use the first available provider
        const firstProviderId = Object.keys(this.settings.providers)[0];
        if (firstProviderId) {
            return await this.getProviderInstance(firstProviderId);
        }
        
        throw new Error(`No provider found matching name: "${providerName}" or type: "${providerType}"`);
    }

    /**
     * Check if settings have been changed externally (by another device)
     * and reload them if necessary
     */
    private async checkForExternalSettingsChanges(): Promise<void> {
        try {
            // Get the current data.json from disk
            const latestData = await this.loadData();
            if (!latestData) return;
            
            // Enable for debugging if needed
            // console.debug('Checking for external settings changes...');
            
            // Check if providers have changed
            const currentProviderKeys = Object.keys(this.settings.providers || {}).sort();
            const newProviderKeys = Object.keys(latestData.providers || {}).sort();
            
            // Simple check - did keys change?
            let providersChanged = false;
            
            // First check if number of providers changed
            if (currentProviderKeys.length !== newProviderKeys.length) {
                providersChanged = true;
            } else {
                // If same number, check if any provider IDs changed
                for (let i = 0; i < currentProviderKeys.length; i++) {
                    if (currentProviderKeys[i] !== newProviderKeys[i]) {
                        providersChanged = true;
                        break;
                    }
                }
                
                // Even if IDs match, only consider a change if there's a significant difference
                // (this prevents infinite refresh cycles from minor setting differences)
                if (!providersChanged) {
                    for (const key of currentProviderKeys) {
                        // Only check if the provider exists in both settings
                        if (!latestData.providers?.[key]) continue;
                        
                        const currentProvider = this.settings.providers[key];
                        const newProvider = latestData.providers[key];
                        
                        // Check for changes that would affect functionality
                        const nameChanged = currentProvider.name !== newProvider.name;
                        const typeChanged = currentProvider.type !== newProvider.type;
                        const apiKeyChanged = currentProvider.apiKey !== newProvider.apiKey;
                        const baseUrlChanged = currentProvider.baseUrl !== newProvider.baseUrl;
                        const enabledChanged = currentProvider.enabled !== newProvider.enabled;
                        
                        // Check for model changes
                        const modelsChanged = this.haveModelsChanged(currentProvider, newProvider);
                        
                        // Only consider it changed if significant properties differ
                        if (nameChanged || typeChanged || apiKeyChanged || baseUrlChanged || enabledChanged || modelsChanged) {
                            providersChanged = true;
                            break;
                        }
                    }
                }
            }
            
            // If providers changed, reload settings and register providers again
            if (providersChanged) {
                console.log('External provider changes detected, reloading settings...');
                this.settings = Object.assign({}, DEFAULT_SETTINGS, latestData);
                
                // Re-register providers with the new settings
                await this.registerProviders();
                
                // Notify views that providers have changed
                this.app.workspace.trigger('flare:providers-changed');
                
                console.log('Settings reloaded successfully');
            }
        } catch (error) {
            console.error('Error checking for external settings changes:', error);
        }
    }
    
    /**
     * Compare model lists between provider versions to detect changes
     */
    private haveModelsChanged(currentProvider: any, newProvider: any): boolean {
        // First check if both have availableModels arrays
        const currentHasModels = Array.isArray(currentProvider.availableModels);
        const newHasModels = Array.isArray(newProvider.availableModels);
        
        // If one has models and the other doesn't, that's a change
        if (currentHasModels !== newHasModels) return true;
        
        // If neither has models, no change
        if (!currentHasModels && !newHasModels) return false;
        
        // Check if array lengths differ
        if (currentProvider.availableModels.length !== newProvider.availableModels.length) return true;
        
        // Check the visible models too
        const currentVisibleModels = Array.isArray(currentProvider.visibleModels) ? 
            new Set(currentProvider.visibleModels) : new Set();
        const newVisibleModels = Array.isArray(newProvider.visibleModels) ? 
            new Set(newProvider.visibleModels) : new Set();
        
        // Compare visible models count
        if (currentVisibleModels.size !== newVisibleModels.size) return true;
        
        // Check if visible models content differs
        if (currentVisibleModels.size > 0) {
            for (const model of currentProvider.visibleModels) {
                if (!newVisibleModels.has(model)) return true;
            }
        }
        
        // For performance reasons, just check a few models rather than the whole array
        // This is a compromise between accuracy and performance
        const samplesToCheck = Math.min(5, currentProvider.availableModels.length);
        for (let i = 0; i < samplesToCheck; i++) {
            const index = Math.floor(Math.random() * currentProvider.availableModels.length);
            if (currentProvider.availableModels[index] !== newProvider.availableModels[index]) {
                return true;
            }
        }
        
        // No significant changes detected
        return false;
    }
} 