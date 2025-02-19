import { App, Plugin, WorkspaceLeaf, Notice, TFile, sanitizeHTMLToDom } from 'obsidian';
import { GeneralSettingTab } from './src/settings/GeneralSettingTab';
import { AIChatView, VIEW_TYPE_AI_CHAT } from './src/views/aiChatView';
import { 
    AIProvider, 
    OllamaManager,
    OpenAIManager,
    ProviderSettings
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
import { OpenRouterManager } from './src/providers/implementations/OpenRouter/OpenRouterManager';
import { ChatHistoryManager } from './src/history/ChatHistoryManager';
import { MarkdownRenderer } from 'obsidian';

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

    async onload() {
        console.log(`Loading ${PLUGIN_NAME} v${PLUGIN_VERSION}`);
        
        try {
            await this.loadSettings();
            await this.initializePlugin();
            this.addCommands();
            this.setupUI();
            
            // Start watching Flares folder
            this.startFlareWatcher();
            
            console.log(`${PLUGIN_NAME} loaded successfully`);
        } catch (error) {
            console.error(`${PLUGIN_NAME} failed to initialize:`, error);
            new Notice(`${PLUGIN_NAME} failed to initialize. Check console for details.`);
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
        const providers = [
            new OllamaManager(this),
            new OpenAIManager(this),
            new OpenRouterManager(this)
        ];

        let registeredCount = 0;
        const errors: string[] = [];

        for (const provider of providers) {
            try {
                this.registerProvider(provider);
                registeredCount++;
            } catch (error) {
                const errorMessage = error instanceof Error ? error.message : String(error);
                errors.push(`${provider.constructor.name}: ${errorMessage}`);
                console.error(
                    `FLARE.ai: Failed to register provider ${provider.constructor.name}:`,
                    error
                );
            }
        }

        if (errors.length > 0) {
            new Notice(
                `Some providers failed to register (${registeredCount}/${providers.length} succeeded). ` +
                'Check settings and console for details.'
            );
        }
    }

    private setupUI() {
        try {
            // Add ribbon icon with proper aria label and tooltip
            this.addRibbonIcon('flame', PLUGIN_NAME, (evt: MouseEvent) => {
                this.activateView();
            }).setAttribute('aria-label', 'Open FLARE.ai Chat');
        } catch (error) {
            console.error('FLARE.ai: Failed to setup UI:', error);
            new Notice('Failed to setup FLARE.ai UI components');
        }
    }

    async onunload() {
        console.log(`Unloading ${PLUGIN_NAME}`);
        
        const cleanupTasks: Array<Promise<void>> = [];
        
        try {
            // Clean up watchers and timers
            if (this.flareWatcher) {
                clearInterval(this.flareWatcher);
                this.flareWatcher = null;
            }

            // Clean up managers
            if (this.chatHistoryManager) {
                cleanupTasks.push(this.chatHistoryManager.cleanup());
            }
            if (this.flareManager) {
                cleanupTasks.push(this.flareManager.cleanup());
            }

            // Wait for all cleanup tasks to complete
            await Promise.all(cleanupTasks);

            // Save final state
            await this.saveData(this.settings);
            
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
    private stripReasoningContent(messages: Array<{role: string; content: string; settings?: any}>, reasoningHeader: string = '<think>'): Array<{role: string; content: string; settings?: any}> {
        const reasoningEndTag = reasoningHeader.replace('<', '</');
        const escapedHeader = this.escapeRegexSpecials(reasoningHeader);
        const escapedEndTag = this.escapeRegexSpecials(reasoningEndTag);
        const reasoningRegex = new RegExp(`${escapedHeader}[\\s\\S]*?${escapedEndTag}`, 'g');

        return messages.map(msg => {
            if (msg.role === 'assistant') {
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
        model?: string;
        temperature?: number;
        maxTokens?: number;
        messageHistory?: Array<{role: string; content: string; settings?: any}>;
        contextWindow?: number;
        stream?: boolean;
        onToken?: (token: string) => void;
        isFlareSwitch?: boolean;
    }): Promise<string> {
        try {
            const lastFlare = this.lastUsedFlare || null;
            const newFlareName = options?.flare || this.settings.defaultFlare || 'default';
            
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
                        const wikiLinkPattern = new RegExp(`\\[\\[${fileName}\\]\\]`, 'g');
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
                            model: flareConfig.model
                        }
                    });
                }
            }

            // Process current message
            let processedMessage = message;
            const messageWikilinks = await this.expandWikiLinks(message);
            for (const [fileName, content] of Object.entries(messageWikilinks)) {
                if (typeof content === 'string') {
                    const wikiLinkPattern = new RegExp(`\\[\\[${fileName}\\]\\]`, 'g');
                    processedMessage = processedMessage.replace(wikiLinkPattern, content);
                }
            }

            // Create message object for current message
            const currentMessage = {
                role: 'user',
                content: processedMessage,
                settings: {
                    flare: newFlareName,
                    provider: flareConfig.provider,
                    model: flareConfig.model,
                    temperature: options?.temperature ?? flareConfig.temperature ?? 0.7,
                    maxTokens: options?.maxTokens ?? flareConfig.maxTokens
                }
            };

            // Get provider and send message
            const provider = await this.getProviderInstance(flareConfig.provider);
            if (!provider) {
                throw new Error('No active provider available');
            }

            // Send message to provider
            const response = await provider.sendMessage(processedMessage, {
                ...options,
                messageHistory: finalMessageHistory,
                flare: newFlareName,
                model: flareConfig.model,
                temperature: options?.temperature ?? flareConfig.temperature ?? 0.7,
                maxTokens: options?.maxTokens ?? flareConfig.maxTokens,
                stream: options?.stream ?? true,
                onToken: options?.onToken
            });

            // After getting response, update the full history with both messages
            finalMessageHistory.push(currentMessage);
            finalMessageHistory.push({
                role: 'assistant',
                content: response,
                settings: {
                    flare: newFlareName,
                    provider: flareConfig.provider,
                    model: flareConfig.model,
                    isReasoningModel: flareConfig.isReasoningModel,
                    reasoningHeader: flareConfig.reasoningHeader
                }
            });

            // Remove the second context window application and just keep track of the last used flare
            this.lastUsedFlare = newFlareName;
            return response;
        } catch (error) {
            console.error('Error in handleMessage:', error);
            throw error;
        }
    }

    parseMessageForFlare(message: string): { flare: string; content: string } {
        const match = message.match(/(?:^|\s)@(\w+)\s*(.*)/i);
        if (match) {
            // If there's no content after the flare name, treat it as a flare switch
            if (!match[2].trim()) {
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
                return {
                    name: flareName,
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

            // Read and parse file content
            const content = await this.app.vault.read(flareFile);
            const frontmatterMatch = content.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
            if (!frontmatterMatch) {
                throw new Error('Invalid flare file format');
            }

            const [_, frontmatterContent, systemPrompt] = frontmatterMatch;
            const frontmatter = this.parseFrontmatter(frontmatterContent);

            return {
                name: flareName,
                provider: frontmatter.provider || defaultProvider,
                model: frontmatter.model || model,
                enabled: frontmatter.enabled ?? true,
                description: frontmatter.description || '',
                temperature: frontmatter.temperature ?? 0.7,
                maxTokens: frontmatter.maxTokens,
                contextWindow: frontmatter.contextWindow ?? -1,
                handoffContext: frontmatter.handoffContext ?? -1,
                systemPrompt: systemPrompt.trim(),
                stream: frontmatter.stream ?? false,
                isReasoningModel: frontmatter.isReasoningModel ?? false,
                reasoningHeader: frontmatter.reasoningHeader || '<think>'
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
        const adapter = this.app.vault.adapter;
        
        // Ensure Flares folder exists
        try {
            const flaresExists = await adapter.exists(this.settings.flaresFolder);
            if (!flaresExists) {
                await this.app.vault.createFolder(this.settings.flaresFolder);
            }
        } catch (error) {
            console.error('Failed to create Flares folder:', error);
            new Notice('Failed to create Flares folder');
        }

        // Ensure History folder exists
        try {
            const historyExists = await adapter.exists(this.settings.historyFolder);
            if (!historyExists) {
                await this.app.vault.createFolder(this.settings.historyFolder);
            }
        } catch (error) {
            console.error('Failed to create History folder:', error);
            new Notice('Failed to create History folder');
        }
    }

    private registerProvider(manager: ProviderManager) {
        if (!manager || !manager.id) {
            console.error('Invalid provider manager:', manager);
            return;
        }
        this.providers.set(manager.id, manager);
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
            // Add timeout protection
            const timeout = new Promise<string[]>((_, reject) => 
                setTimeout(() => reject(new Error('Request timed out')), 10000)
            );

            const modelFetch = (async () => {
                // Get provider settings for this type
                const providerSettings = Object.values(this.settings.providers)
                    .find(p => p.type === type);
                    
                if (!providerSettings) {
                    console.error(`No provider settings found for type: ${type}`);
                    return [];
                }

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
                    const allModels = await provider.getAvailableModels();
                    
                    // First filter by enabledModels if set
                    let filteredModels = allModels;
                    if (providerSettings.enabledModels?.length > 0) {
                        filteredModels = allModels.filter((model: string) => 
                            providerSettings.enabledModels?.includes(model) ?? false
                        );
                    }
                    
                    // Then filter by visibleModels if set
                    if (providerSettings.visibleModels && providerSettings.visibleModels.length > 0) {
                        filteredModels = filteredModels.filter((model: string) => 
                            providerSettings.visibleModels?.includes(model) ?? false
                        );
                    }
                    
                    return filteredModels;
                } catch (error) {
                    console.error(`Failed to get models for provider ${type}:`, error);
                    throw error;
                }
            })();

            // Race between the model fetch and timeout
            return await Promise.race([modelFetch, timeout]);
        } catch (error) {
            console.error('Failed to get models:', error);
            if (error instanceof Error && error.message === 'Request timed out') {
                throw new Error('Failed to load models: Request timed out. Please check your connection and try again.');
            }
            throw error;
        }
    }

    async getProviderInstance(providerId: string): Promise<AIProvider> {
        const providerSettings = this.settings.providers[providerId];
        if (!providerSettings?.type) {
            throw new Error(`No settings found for provider: ${providerId}`);
        }

        const manager = this.providers.get(providerSettings.type);
        if (!manager) {
            throw new Error(`No manager found for provider type: ${providerSettings.type}`);
        }

        const provider = manager.createProvider(providerSettings);
        if (!provider) {
            throw new Error(`Failed to create provider instance for ${providerId}`);
        }

        return provider;
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

    private async expandWikiLinks(text: string): Promise<Record<string, string>> {
        const wikilinks = this.extractWikiLinks(text);
        const result: Record<string, string> = {};
        
        await Promise.all(wikilinks.map(async (link) => {
            try {
                const [fileName, alias] = link.split('|').map(s => s.trim());
                const file = this.app.metadataCache.getFirstLinkpathDest(fileName, '');
                
                if (!file) {
                    console.warn(`File not found for wikilink: ${fileName}`);
                    return;
                }

                const content = await this.app.vault.cachedRead(file);
                let processedContent = content;

                const app = this.app as ObsidianApp;
                const dataviewPlugin = app.plugins.plugins.dataview;

                if (dataviewPlugin?.api) {
                    processedContent = await this.processDataviewContent(content, file, dataviewPlugin.api);
                }

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
        const regex = /\[\[([^\]]+)\]\]/g;
        const links: string[] = [];
        let match;
        
        while ((match = regex.exec(text)) !== null) {
            links.push(match[1].trim());
        }
        
        return links;
    }

    async reloadProviderDependentViews(): Promise<void> {
        const chatLeaves = this.app.workspace.getLeavesOfType(VIEW_TYPE_AI_CHAT);
        return Promise.all(chatLeaves.map(async (leaf) => {
            const view = leaf.view;
            if (view instanceof AIChatView) {
                await view.refreshProviderSettings();
            }
        })).then(() => void 0);
    }

    private async processDataviewContent(
        content: string,
        file: TFile,
        dataviewApi: DataviewApi
    ): Promise<string> {
        let processedContent = content;

        // Process dataview blocks
        const dataviewBlocks = content.match(/```dataview\n([\s\S]*?)\n```/g) || [];
        for (const block of dataviewBlocks) {
            try {
                const query = block.replace(/```dataview\n/, '').replace(/\n```$/, '');
                const result = await dataviewApi.query(query, file.path);
                
                if (result?.successful) {
                    const formattedResult = this.formatDataviewResult(result.value);
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

    private parseFrontmatter(content: string): any {
        const frontmatter: any = {};
        content.split('\n').forEach(line => {
            const match = line.match(/^(\w+):\s*(.*)$/);
            if (match) {
                const [_, key, value] = match;
                // Handle quoted strings
                if (value.startsWith('"') && value.endsWith('"')) {
                    frontmatter[key] = value.slice(1, -1);
                } else if (value === 'true' || value === 'false') {
                    frontmatter[key] = value === 'true';
                } else if (!isNaN(Number(value))) {
                    frontmatter[key] = Number(value);
                } else {
                    frontmatter[key] = value;
                }
            }
        });
        return frontmatter;
    }
} 