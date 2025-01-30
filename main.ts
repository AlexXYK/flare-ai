import { App, Plugin, WorkspaceLeaf, Notice, TFile } from 'obsidian';
import { GeneralSettingTab } from './src/settings/GeneralSettingTab';
import { AIChatView, VIEW_TYPE_AI_CHAT } from './src/views/aiChatView';
import { 
    AIProvider, 
    OllamaManager,
    OpenAIManager,
    ProviderSettings
} from './src/providers/aiProviders';
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

export default class FlarePlugin extends Plugin {
    settings: PluginSettings;
    providers: Map<string, ProviderManager> = new Map();
    providerManager: ProviderManager;
    activeProvider: AIProvider | null = null;
    flareManager: FlareManager;
    chatHistoryManager: ChatHistoryManager;
    private flareWatcher: NodeJS.Timer | null = null;
    flares: Array<{ name: string; path: string }> = [];
    isFlareSwitchActive: boolean = false;
    lastUsedFlare: string | null = null;

    async onload() {
        try {
            // Load settings first
            this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
            
            // Initialize managers
            this.providerManager = new ProviderManager(this);
            this.flareManager = new FlareManager(this);
            this.chatHistoryManager = new ChatHistoryManager(this);
            
            // Ensure Flares folder exists BEFORE initializing manager
            await this.ensureFlaresFolderExists();
            
            // Load initial flares
            await this.flareManager.loadFlares();
            
            // Register providers with error handling
            const providers = [
                new OllamaManager(this),
                new OpenAIManager(this),
                new OpenRouterManager(this)
            ];

            for (const provider of providers) {
                try {
                    this.registerProvider(provider);
                } catch (error) {
                    console.error(`Failed to register provider: ${provider.constructor.name}`, error);
                }
            }
            
            // Only initialize default provider if explicitly set and valid
            if (this.settings?.defaultProvider && this.providers.has(this.settings.defaultProvider)) {
                await this.initializeProvider();
            }

            // Register view
            this.registerView(
                VIEW_TYPE_AI_CHAT,
                (leaf) => new AIChatView(leaf, this)
            );

            // Add ribbon icon
            this.addRibbonIcon('flame', 'Open Flares Chat', () => {
                this.activateView();
            });

            // Add settings tab
            this.addSettingTab(new GeneralSettingTab(this.app, this));

            // Add commands
            this.addCommands();

            // Start watching Flares folder
            this.startFlareWatcher();
        } catch (error) {
            console.error('Failed to initialize plugin:', error);
            new Notice('Failed to initialize Flare plugin. Please check the console for details.');
        }
    }

    async onunload() {
        if (this.flareWatcher) {
            clearInterval(this.flareWatcher);
        }
        if (this.chatHistoryManager) {
            await this.chatHistoryManager.cleanup();
        }
        if (this.flareManager) {
            await this.flareManager.cleanup();
        }

        // Deregister the view
        this.app.workspace.detachLeavesOfType(VIEW_TYPE_AI_CHAT);

        await this.saveData(this.settings);
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
                console.debug('No providers configured');
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
            console.debug(`Successfully initialized provider: ${config.type}`);
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
        historyWindow?: number;
        stream?: boolean;
        onToken?: (token: string) => void;
        isResend?: boolean;
    }): Promise<string> {
        try {
            const lastFlare = this.lastUsedFlare || null;
            const newFlareName = options?.flare || this.settings.defaultFlare || 'default';
            
            // Validate flare exists
            const flareExists = await this.app.vault.adapter.exists(
                `${this.settings.flaresFolder}/${newFlareName}.md`
            );
            if (!flareExists) {
                new Notice(`Flare "${newFlareName}" does not exist. Please create it first.`);
                return '';
            }
            
            // Load flare config
            const flareConfig = await this.flareManager.debouncedLoadFlare(newFlareName);
            if (!flareConfig) {
                throw new Error(`Failed to load flare: ${newFlareName}`);
            }

            // Determine if this is a flare switch
            let isFlareSwitch = false;
            if (options?.messageHistory?.length) {
                // Check if any of the last N messages used a different flare
                const lastMessages = options.messageHistory.slice(-3); // Look at last few messages
                const lastFlares = new Set(lastMessages.map(msg => msg.settings?.flare).filter(Boolean));
                isFlareSwitch = lastFlares.size > 1 || !lastFlares.has(newFlareName);
            } else {
                isFlareSwitch = true; // First message is always a flare switch
            }

            if (this.settings.debugLoggingEnabled) {
                console.debug('Flare switch detection:', {
                    newFlareName,
                    lastMessages: options?.messageHistory?.slice(-3).map(m => ({
                        flare: m.settings?.flare,
                        role: m.role,
                        content: m.content.substring(0, 30) + '...'
                    })),
                    isFlareSwitch
                });
            }

            // Start with complete message history
            let finalMessageHistory = [...(options?.messageHistory || [])];

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

            // Determine what history to send to the provider
            let historyToSend = [...finalMessageHistory];

            // Handle history windows for flare switches differently
            if (isFlareSwitch) {
                // Keep system message separate
                const systemMessages = historyToSend.filter(m => m.role === 'system');
                const nonSystemMessages = historyToSend.filter(m => m.role !== 'system');

                // For flare switches, first apply handoff window
                const handoffSize = flareConfig.handoffWindow ?? -1;
                if (handoffSize === -1) {
                    // If handoff is -1, use all messages
                    historyToSend = [...systemMessages, ...nonSystemMessages];
                } else {
                    // Group into pairs for handoff
                    const pairs: Array<Array<{role: string; content: string; settings?: any}>> = [];
                    let currentPair: Array<{role: string; content: string; settings?: any}> = [];
                    
                    for (const msg of nonSystemMessages) {
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

                    // Get the last N complete pairs based on handoff window
                    const handoffPairs = pairs.slice(-handoffSize);
                    const handoffMessages = handoffPairs.flat();

                    // Now check if history window is smaller than handoff
                    const historySize = flareConfig.historyWindow ?? -1;
                    if (historySize === -1) {
                        // If history is -1, use all handoff messages
                        historyToSend = [...systemMessages, ...handoffMessages];
                    } else if (historySize < handoffSize) {
                        // If history window is smaller, get the last N pairs from handoff
                        const historyPairs = handoffPairs.slice(-historySize);
                        historyToSend = [...systemMessages, ...historyPairs.flat()];
                    } else {
                        // If history window is larger or equal, use all handoff messages
                        // The history window will build up from the handoff size as more messages come in
                        historyToSend = [...systemMessages, ...handoffMessages];
                    }
                }
            } else if (!isFlareSwitch) {
                // For regular messages, apply history window if set
                const historySize = flareConfig.historyWindow ?? -1;
                if (historySize !== -1) {
                    const systemMessages = historyToSend.filter(m => m.role === 'system');
                    const nonSystemMessages = historyToSend.filter(m => m.role !== 'system');
                    const windowedNonSystem = this.applyHistoryWindow(nonSystemMessages, historySize);
                    historyToSend = [...systemMessages, ...windowedNonSystem];
                }
            }

            // Strip reasoning content from messages when switching flares or if current flare is not a reasoning model
            if (isFlareSwitch || !flareConfig.isReasoningModel) {
                historyToSend = this.stripReasoningContent(historyToSend, flareConfig.reasoningHeader);
            }

            if (this.settings.debugLoggingEnabled) {
                console.log('Sending to provider:', {
                    messageCount: historyToSend.length + 1, // +1 for current message
                    hasSystem: historyToSend.some(m => m.role === 'system'),
                    isFlareSwitch,
                    handoffWindow: isFlareSwitch ? flareConfig.handoffWindow : 'n/a',
                    historyWindow: flareConfig.historyWindow,
                    messages: [...historyToSend, currentMessage].map(m => ({
                        role: m.role,
                        content: m.content.substring(0, 50) + '...'
                    }))
                });
            }

            // Get provider and send message
            const provider = await this.getProviderInstance(flareConfig.provider);
            if (!provider) {
                throw new Error('No active provider available');
            }

            const response = await provider.sendMessage(processedMessage, {
                ...options,
                messageHistory: historyToSend,
                flare: newFlareName,
                model: flareConfig.model,
                temperature: options?.temperature ?? flareConfig.temperature ?? 0.7,
                maxTokens: options?.maxTokens ?? flareConfig.maxTokens
            });

            // After getting response, update the full history with both messages
            finalMessageHistory.push(currentMessage);
            finalMessageHistory.push({
                role: 'assistant',
                content: response,
                settings: {
                    flare: newFlareName,
                    provider: flareConfig.provider,
                    model: flareConfig.model
                }
            });

            this.lastUsedFlare = newFlareName;
            return response;
        } catch (error) {
            console.error('Error in handleMessage:', error);
            throw error;
        }
    }

    parseMessageForFlare(message: string): { flare: string; content: string } {
        const match = message.match(/(?:^|\s)@(\w+)\s*(.*)/);
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

            if (!flareFile) {
                return {
                    name: flareName,
                    provider: defaultProvider,
                    model: model,
                    enabled: true,
                    description: '',
                    temperature: 0.7,
                    maxTokens: 2048,
                    historyWindow: -1,
                    handoffWindow: -1,
                    systemPrompt: 'You are a helpful AI assistant.',
                    stream: false,
                    isReasoningModel: false,
                    reasoningHeader: '<think>'
                };
            }

            // Get frontmatter and content
            const frontmatter = this.app.metadataCache.getFileCache(flareFile)?.frontmatter;
            const content = await this.app.vault.cachedRead(flareFile);
            const systemPrompt = content.replace(/^---[\s\S]*?---/, '').trim();

            const provider = frontmatter?.provider || defaultProvider;
            const providerSettings2 = this.settings.providers[provider];
            
            // Ensure we have a valid model from frontmatter or provider
            let finalModel = frontmatter?.model;
            if (!finalModel && providerSettings2) {
                if (providerSettings2.defaultModel) {
                    finalModel = providerSettings2.defaultModel;
                } else {
                    // Try to get first available model
                    try {
                        const models = await this.getModelsForProvider(providerSettings2.type);
                        if (models.length > 0) {
                            finalModel = models[0];
                        }
                    } catch (error) {
                        console.error('Failed to get models for provider:', error);
                    }
                }
            }

            return {
                name: flareName,
                provider: provider,
                model: finalModel || model || '',  // Fallback to initial model if needed
                enabled: frontmatter?.enabled ?? true,
                description: frontmatter?.description || '',
                temperature: frontmatter?.temperature ?? 0.7,
                maxTokens: frontmatter?.maxTokens ?? 2048,
                historyWindow: frontmatter?.historyWindow ?? -1,
                handoffWindow: frontmatter?.handoffWindow ?? -1,
                systemPrompt: systemPrompt || 'You are a helpful AI assistant.',
                stream: frontmatter?.stream ?? false,
                isReasoningModel: frontmatter?.isReasoningModel ?? false,
                reasoningHeader: frontmatter?.reasoningHeader || '<think>'
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
        if (this.settings.debugLoggingEnabled) {
            const providerName = this.settings.providers[manager.id]?.name || manager.id;
            console.debug(`Registered provider: ${providerName}`);
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
            if (error.message === 'Request timed out') {
                throw new Error('Failed to load models: Request timed out. Please check your connection and try again.');
            }
            throw error;
        }
    }

    async getProviderInstance(providerId: string): Promise<AIProvider | null> {
        try {
            const providerSettings = this.settings.providers[providerId];
            if (!providerSettings || !providerSettings.type) {
                console.error(`No settings found for provider: ${providerId}`);
                return null;
            }

            const manager = this.providers.get(providerSettings.type);
            if (!manager) {
                console.error(`No manager found for provider type: ${providerSettings.type}`);
                return null;
            }

            // Create a new provider instance
            const provider = manager.createProvider(providerSettings);
            if (!provider) {
                console.error(`Failed to create provider instance for ${providerId}`);
                return null;
            }

            return provider;
        } catch (error) {
            console.error('Error getting provider instance:', error);
            return null;
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
                        historyWindow: newFlare.historyWindow
                    });
                }
            }
        });
    }

    public applyHistoryWindow(messages: Array<{role: string; content: string; settings?: any}>, window: number): Array<{role: string; content: string; settings?: any}> {
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
        
        // Add system messages first
        result.push(...systemMessages);
        
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

    private applyHandoffSlicing(messages: Array<{role: string; content: string; settings?: any}>, window: number): Array<{role: string; content: string; settings?: any}> {
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
        
        for (const link of wikilinks) {
            try {
                // Handle potential aliases in wikilinks
                const [fileName, alias] = link.split('|').map(s => s.trim());
                
                // Get the file from the vault
                const file = this.app.metadataCache.getFirstLinkpathDest(fileName, '');
                if (!file) continue;

                // Get file content
                const content = await this.app.vault.cachedRead(file);
                
                // Process Dataview queries if the plugin is available
                let processedContent = content;
                const plugins = (this.app as any as { plugins: ObsidianPlugins }).plugins;
                const dataviewPlugin = plugins.plugins.dataview;
                
                if (dataviewPlugin?.api) {
                    // Find all dataview codeblocks
                    const dataviewBlocks = content.match(/```dataview\n([\s\S]*?)\n```/g) || [];
                    const dataviewJSBlocks = content.match(/```dataviewjs\n([\s\S]*?)\n```/g) || [];
                    
                    // Process each dataview block
                    for (const block of dataviewBlocks) {
                        try {
                            const query = block.replace(/```dataview\n/, '').replace(/\n```$/, '');
                            // Execute the query and get results
                            const queryResult = await dataviewPlugin.api.query(query, file.path);
                            
                            if (queryResult && queryResult.successful) {
                                let resultText = '';
                                const result = queryResult.value;
                                if (result.type === 'table') {
                                    // Format table results
                                    const headers = result.headers || [];
                                    const values = result.values;
                                    resultText = '| ' + headers.join(' | ') + ' |\n';
                                    resultText += '| ' + headers.map(() => '---').join(' | ') + ' |\n';
                                    values.forEach((row: any[]) => {
                                        resultText += '| ' + row.map(cell => String(cell)).join(' | ') + ' |\n';
                                    });
                                } else if (result.type === 'list') {
                                    // Format list results
                                    resultText = result.values.map((item: any) => `- ${item}`).join('\n');
                                } else if (result.type === 'task') {
                                    // Format task results
                                    resultText = result.values.map((task: any) => `- [ ] ${task}`).join('\n');
                                }
                                
                                // Replace the codeblock with the formatted results
                                processedContent = processedContent.replace(block, resultText);
                                
                                if (this.settings.debugLoggingEnabled) {
                                    console.log('FLARE.ai: Dataview query result:', {
                                        query,
                                        type: result.type,
                                        result: resultText.substring(0, 100) + '...'
                                    });
                                }
                            }
                        } catch (err) {
                            console.warn('Failed to evaluate dataview query:', err);
                            // Keep the original block if evaluation fails
                        }
                    }

                    // Process each dataviewjs block
                    for (const block of dataviewJSBlocks) {
                        try {
                            const code = block.replace(/```dataviewjs\n/, '').replace(/\n```$/, '');
                            // Execute the JS code and get results
                            const component = await dataviewPlugin.api.executeJs(code, file.path);
                            if (component?.container?.innerHTML) {
                                const jsResult = component.container.innerHTML;
                                // Replace the codeblock with the results
                                processedContent = processedContent.replace(block, jsResult);
                                
                                if (this.settings.debugLoggingEnabled) {
                                    console.log('FLARE.ai: DataviewJS result:', {
                                        code: code.substring(0, 100) + '...',
                                        result: jsResult.substring(0, 100) + '...'
                                    });
                                }
                            }
                        } catch (err) {
                            console.warn('Failed to evaluate dataviewjs block:', err);
                            // Keep the original block if evaluation fails
                        }
                    }
                }

                if (this.settings.debugLoggingEnabled) {
                    console.log('FLARE.ai: Expanded wikilink content:', {
                        link,
                        originalContent: content.substring(0, 100) + '...',
                        processedContent: processedContent.substring(0, 100) + '...',
                        hasDataview: dataviewPlugin?.api ? 'yes' : 'no'
                    });
                }

                result[fileName] = processedContent;
            } catch (err) {
                console.warn(`Failed to load note for [[${link}]]:`, err);
            }
        }
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
} 