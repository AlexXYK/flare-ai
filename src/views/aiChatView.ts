import { ItemView, MarkdownRenderer, TFile, setIcon, Notice, App, WorkspaceLeaf, Menu, Platform, Modal, SuggestModal, debounce, sanitizeHTMLToDom, setTooltip } from 'obsidian';
import { TempDialog } from './components/TempDialog';

// @ts-ignore
import FlarePlugin from '../main';
import { FlareConfig } from '../flares/FlareConfig';
import { HistorySidebar } from './components/HistorySidebar';
import type { Moment } from 'moment';
// @ts-ignore
import moment from 'moment';
import { getErrorMessage } from '../utils/errors';

/**
 * Settings for message processing and display
 */
interface MessageSettings {
    /** The flare configuration name */
    flare?: string;
    /** The AI provider ID */
    provider: string;
    /** The provider name (for cross-device compatibility) */
    providerName?: string;
    /** The provider type (for cross-device compatibility) */
    providerType?: string;
    /** The model ID */
    model: string;
    /** Temperature setting for generation */
    temperature: number;
    /** Maximum tokens for generation */
    maxTokens?: number;
    /** Whether to stream the response */
    stream?: boolean;
    /** Whether this is a flare switch message */
    isFlareSwitch?: boolean;
    /** Number of messages to include in context */
    contextWindow?: number;
    /** Number of messages before handoff */
    handoffContext?: number;
    /** Whether the message was truncated */
    truncated?: boolean;
    /** Tag for reasoning model thoughts */
    reasoningHeader?: string;
    /** Whether this is a reasoning-capable model */
    isReasoningModel?: boolean;
    /** Original message content with wikilinks */
    originalContent?: string;
    /** Processed message content with expanded wikilinks */
    processedContent?: string;
}

/**
 * Interface for flare configuration objects
 */
interface Flare {
    name: string;
    providerName: string;
    providerType: string;
    provider?: string;
    model?: string;
    temperature?: number;
    maxTokens?: number;
    stream?: boolean;
    historyWindow?: number;
    handoffContext?: number;
    reasoningHeader?: string;
    isReasoningModel?: boolean;
    [key: string]: any;
}

/**
 * Represents a chat message in the history
 */
interface ChatMessage {
    /** The role of the message sender */
    role: 'user' | 'assistant' | 'system';
    /** The message content */
    content: string;
    /** Unix timestamp of the message */
    timestamp: number;
    /** Message settings */
    settings?: MessageSettings;
}

/**
 * Content structure for system messages
 */
interface SystemMessageContent {
    /** Main message text */
    main: string;
    /** Optional metadata */
    metadata?: {
        /** Type of system message */
        type?: 'model' | 'temperature' | 'export';
        /** Whether reasoning is enabled */
        isReasoningModel?: boolean;
        /** Reasoning header tag */
        reasoningHeader?: string;
        /** Additional metadata fields */
        [key: string]: any;
        /** Path to the exported file */
        path?: string;
    };
}

/**
 * Partial message settings type
 */
interface PartialMessageSettings extends Partial<MessageSettings> {
    [key: string]: any;
}

/** View type identifier for the AI chat */
export const VIEW_TYPE_AI_CHAT = 'ai-chat-view';

// Constants
const CONSTANTS = {
    DEFAULT_TEMPERATURE: 0.7,
    RENDER_DEBOUNCE_MS: 25,
    DEFAULT_REASONING_HEADER: '<think>',
    MAX_TITLE_LENGTH: 100,
    SCROLL_THRESHOLD: 100,
    MOBILE_BREAKPOINT: 768,
    MAX_INPUT_HEIGHT: 144,
    SUGGESTIONS_MIN_SPACE: 200,
    SUGGESTIONS_OFFSET: 8,
    SUGGESTIONS_MAX_HEIGHT: 300,
    SUGGESTIONS_PADDING: 16,
    TRANSITION_DURATION: 300
} as const;

class WikiLinkSuggestModal extends SuggestModal<TFile> {
    constructor(
        app: App,
        private textArea: HTMLTextAreaElement,
        private onChoose: (file: TFile) => void
    ) {
        super(app);
    }

    getSuggestions(query: string): TFile[] {
        const files = this.app.vault.getMarkdownFiles();
        return files.filter(file => 
            file.basename.toLowerCase().includes(query.toLowerCase())
        );
    }

    renderSuggestion(file: TFile, el: HTMLElement) {
        el.createEl("div", { text: file.basename });
    }

    onChooseSuggestion(file: TFile, evt: MouseEvent | KeyboardEvent) {
        this.onChoose(file);
    }
}

class NoteLinkSuggestModal extends SuggestModal<TFile> {
    constructor(
        app: App,
        private textArea: HTMLTextAreaElement,
        private onChoose: (file: TFile) => void
    ) {
        super(app);
        this.setPlaceholder("Type to find a note...");
        this.limit = 10;
    }

    getSuggestions(query: string): TFile[] {
        const files = this.app.vault.getMarkdownFiles();
        if (!query) return files.slice(0, this.limit);
        
        const lowerQuery = query.toLowerCase();
        return files
            .filter(file => file.basename.toLowerCase().includes(lowerQuery))
            .sort((a, b) => {
                // Exact matches first
                const aExact = a.basename.toLowerCase() === lowerQuery;
                const bExact = b.basename.toLowerCase() === lowerQuery;
                if (aExact && !bExact) return -1;
                if (!aExact && bExact) return 1;
                
                // Then starts-with matches
                const aStarts = a.basename.toLowerCase().startsWith(lowerQuery);
                const bStarts = b.basename.toLowerCase().startsWith(lowerQuery);
                if (aStarts && !bStarts) return -1;
                if (!aStarts && bStarts) return 1;
                
                // Then alphabetical
                return a.basename.localeCompare(b.basename);
            })
            .slice(0, this.limit);
    }

    renderSuggestion(file: TFile, el: HTMLElement) {
        // Use Obsidian's native suggestion rendering
        el.addClass('suggestion-item', 'mod-complex');
        
        const content = el.createDiv('suggestion-content');
        const title = content.createDiv('suggestion-title');
        title.setText(file.basename);

        if (file.parent && file.parent.path !== '/') {
            const note = content.createDiv('suggestion-note');
            note.setText(file.parent.path);
        }
    }

    onChooseSuggestion(file: TFile) {
        this.onChoose(file);
    }
}

/**
 * Error types for FLARE.ai
 */
class FlareError extends Error {
    constructor(message: string, public code: string) {
        super(message);
        this.name = 'FlareError';
    }
}

/** Error for message handling */
class MessageError extends FlareError {
    constructor(message: string) {
        super(message, 'MESSAGE_ERROR');
    }
}

/** Error for flare handling */
class FlareConfigError extends FlareError {
    constructor(message: string) {
        super(message, 'FLARE_CONFIG_ERROR');
    }
}

/** Error for provider handling */
class ProviderError extends FlareError {
    constructor(message: string) {
        super(message, 'PROVIDER_ERROR');
    }
}

/** Interface for message state tracking */
interface MessageState {
    isStreaming: boolean;
    isProcessing: boolean;
    hasError: boolean;
    errorMessage: string;
}

/** Interface for view state */
interface ViewState {
    isStreaming: boolean;
    isProcessing: boolean;
    hasError: boolean;
    errorMessage: string;
    expandedMessages: Set<string>;
    currentTemp?: number;
    lastSavedTimestamp?: number;
}

/** Interface for operation options */
interface OperationOptions {
    timeout?: number;
    retries?: number;
    backoff?: boolean;
}

/**
 * Main view for the AI chat interface
 * Handles message display, user input, and interaction with AI providers
 */
export class AIChatView extends ItemView {
    /** Container for chat messages */
    public messagesEl!: HTMLElement;
    /** Text input for user messages */
    public inputEl!: HTMLTextAreaElement;
    /** Display element for model name */
    public modelNameEl!: HTMLElement;
    /** Sidebar for chat history */
    public historySidebar!: HistorySidebar;
    /** Current flare configuration */
    public currentFlare: FlareConfig | undefined;
    /** Current temperature setting */
    public currentTemp: number | undefined;
    /** Array of message history */
    public messageHistory: Array<{role: string; content: string; timestamp?: number; settings?: any}> = [];
    /** Reference to the Obsidian app */
    public app: App;
    /** Display element for temperature */
    private tempDisplayEl!: HTMLElement;
    /** Display element for model selection */
    private modelDisplayEl!: HTMLElement;
    /** Whether a response is currently streaming */
    private isStreaming: boolean = false;
    /** Original event handler for send button */
    private originalSendHandler: ((event: MouseEvent) => Promise<void>) | null = null;
    /** Set of message IDs with expanded reasoning */
    private expandedReasoningMessages: Set<string> = new Set();
    /** Container for suggestions */
    private suggestionsEl!: HTMLElement;
    /** Whether current streaming is aborted */
    private isAborted: boolean = false;
    /** Track title generation state */
    private isTitleGenerationInProgress: boolean = false;
    private selectedSuggestionIndex: number = -1;
    /** Set of cleanup functions for event listeners */
    private eventRefs: Set<() => void>;
    /** Set of cleanup functions for debounced handlers */
    private debouncedHandlers: Set<() => void>;
    /** Array of active request controllers */
    private activeRequests: AbortController[];
    /** Current message state */
    private messageState: MessageState = {
        isStreaming: false,
        isProcessing: false,
        hasError: false,
        errorMessage: ''
    };

    /** View state */
    private viewState: ViewState = {
        isStreaming: false,
        isProcessing: false,
        hasError: false,
        errorMessage: '',
        expandedMessages: new Set()
    };

    /** ResizeObserver for layout updates */
    private resizeObserver: ResizeObserver;

    private debouncedHeightUpdate: {
        (): void;
        cancel?: () => void;
    };
    private hasAutoGeneratedTitle: boolean = false;  // Add this new property

    constructor(leaf: WorkspaceLeaf, private plugin: FlarePlugin) {
        super(leaf);
        this.app = plugin.app;
        this.eventRefs = new Set();
        this.debouncedHandlers = new Set();
        this.activeRequests = [];

        // Initialize ResizeObserver
        const resizeHandler = debounce(
            () => this.updateLayout(),
            100,
            false
        ) as { 
            (): void; 
            cancel?: () => void 
        };
        
        this.resizeObserver = new ResizeObserver(resizeHandler);
        
        // Track the debounced resize handler for cleanup
        this.debouncedHandlers.add(() => {
            if (resizeHandler.cancel) {
                resizeHandler.cancel();
            }
        });

        // Initialize debounced height update
        this.debouncedHeightUpdate = debounce(
            () => this.updateInputHeight(),
            50,  // Back to 50ms for smoother resizing behavior
            true
        ) as {
            (): void;
            cancel?: () => void;
        };
        
        // Track debounced handler for cleanup
        this.debouncedHandlers.add(() => {
            // This cancels any pending calls to debouncedHeightUpdate
            if (this.debouncedHeightUpdate.cancel) {
                this.debouncedHeightUpdate.cancel();
            }
        });

        // Register all cleanup in one place
        this.register(() => {
            // Clean up event listeners
            this.eventRefs.forEach((cleanup: () => void) => cleanup());
            this.eventRefs.clear();

            // Clean up debounced handlers
            this.debouncedHandlers.forEach((cleanup: () => void) => cleanup());
            this.debouncedHandlers.clear();

            // Abort any active requests
            this.activeRequests.forEach(controller => controller.abort());
            this.activeRequests = [];

            // Clean up ResizeObserver
            if (this.resizeObserver) {
                this.resizeObserver.disconnect();
            }

            // Clean up suggestions
            this.hideSuggestions();

            // Clean up history sidebar
            if (this.historySidebar) {
                this.historySidebar.hide();
            }

            // Clean up markdown renderers
            this.containerEl.querySelectorAll('.markdown-rendered').forEach(el => {
                if (el instanceof HTMLElement) el.empty();
            });

            // Reset state
            this.messageHistory = [];
            this.currentFlare = undefined;
            this.isStreaming = false;
            this.isAborted = false;

            // Clear DOM
            if (this.messagesEl) this.messagesEl.empty();
            if (this.inputEl) this.inputEl.value = '';
            this.containerEl.empty();
        });
    }

    /**
     * Gets the view type identifier
     * @returns The view type string
     */
    getViewType(): string {
        return VIEW_TYPE_AI_CHAT;
    }

    /**
     * Gets the display text for the view
     * @returns The display text
     */
    getDisplayText(): string {
        return 'FLARE.ai';
    }

    /**
     * Gets the icon for the view
     * @returns The icon name
     */
    getIcon(): string {
        return 'flame';
    }

    /**
     * Handles loading and initialization of the view
     */
    async onload() {
        super.onload();

        try {
            // Create UI components
            await this.createUI();
            
            // Initialize observers
            this.initializeObservers();
            
            // Register for chat history changes - custom event
            // Use a direct approach since the event is custom and not in Obsidian typings
            const historyChangeHandler = this.updateChatTitle.bind(this);
            // @ts-ignore - Using custom event name
            this.app.workspace.on('chat-history-changed', historyChangeHandler);
            // Make sure to unregister the event on view unload
            this.register(() => {
                // @ts-ignore - Using custom event name
                this.app.workspace.off('chat-history-changed', historyChangeHandler);
            });
            
            // Listen for provider changes from other devices
            const providerChangeHandler = this.refreshProviderSettings.bind(this);
            // @ts-ignore - Using custom event name
            this.app.workspace.on('flare:providers-changed', providerChangeHandler);
            // Make sure to unregister the event on view unload
            this.register(() => {
                // @ts-ignore - Using custom event name
                this.app.workspace.off('flare:providers-changed', providerChangeHandler);
            });
            
            // Load saved state
            await this.loadViewState();
            
            console.debug('FLARE.ai: View loaded successfully');
        } catch (error) {
            console.error('FLARE.ai: Failed to load view:', error);
            new Notice('Failed to load FLARE.ai chat view');
        }
    }

    /**
     * Updates the chat title in the toolbar based on the current history file
     */
    private updateChatTitle(): void {
        const currentFile = this.plugin.chatHistoryManager.getCurrentFile();
        const titleEl = this.containerEl.querySelector('.flare-toolbar-center h2');
        
        if (titleEl && currentFile) {
            titleEl.textContent = currentFile.basename;
        }
    }

    private async createUI() {
        const container = this.containerEl.children[1] as HTMLElement;
        container.empty();
        container.setAttribute('role', 'main');

        // Create main chat container
        const chatContainer = container.createDiv('flare-chat-container');
        chatContainer.setAttribute('role', 'region');
        
        // Create main content area
        const mainContent = chatContainer.createDiv('flare-main-content');
        mainContent.setAttribute('role', 'region');

        // Create toolbar
        const toolbar = mainContent.createDiv('flare-toolbar');
        toolbar.setAttribute('role', 'toolbar');
        const toolbarLeft = toolbar.createDiv('flare-toolbar-left');
        const toolbarCenter = toolbar.createDiv('flare-toolbar-center');
        const toolbarRight = toolbar.createDiv('flare-toolbar-right');

        // Add history toggle button
        const historyBtn = toolbarLeft.createEl('button', {
            cls: 'flare-toolbar-button history-toggle'
        });
        setIcon(historyBtn, 'history');
        setTooltip(historyBtn, 'Toggle chat history');
        
        // Add new chat button
        const newChatBtn = toolbarLeft.createEl('button', {
            cls: 'flare-toolbar-button new-chat'
        });
        setIcon(newChatBtn, 'plus');
        setTooltip(newChatBtn, 'New chat');
        
        // Add chat title
        toolbarCenter.createEl('h2', { text: 'New Chat' });
        
        // Add export button
        const exportBtn = toolbarRight.createEl('button', {
            cls: 'flare-toolbar-button export-chat'
        });
        setIcon(exportBtn, 'download');
        setTooltip(exportBtn, 'Export chat');
        
        // Add save button
        const saveBtn = toolbarRight.createEl('button', {
            cls: 'flare-toolbar-button save-chat'
        });
        setIcon(saveBtn, 'save');
        setTooltip(saveBtn, 'Save chat');
        
        // Add clear button
        const clearBtn = toolbarRight.createEl('button', {
            cls: 'flare-toolbar-button clear-chat'
        });
        setIcon(clearBtn, 'trash');
        setTooltip(clearBtn, 'Clear chat');
        
        // Create messages area
        this.messagesEl = mainContent.createDiv('flare-messages');

        // Instead, create a bottom container that will hold both composer and footer
        const bottomContainer = mainContent.createDiv('flare-bottom-container');
        const composer = bottomContainer.createDiv('flare-composer');

        // Create input wrapper
        const inputWrapper = composer.createDiv('flare-input-wrapper');
        
        // Create controls container with horizontal layout
        const controlsContainer = inputWrapper.createDiv('flare-controls-container');
        
        // Add flare chooser to the left
        const flareChooser = controlsContainer.createEl('button', {
            cls: 'flare-chooser'
        });
        setIcon(flareChooser, 'flame');
        setTooltip(flareChooser, 'Choose flare');
        
        // Create textarea container in the middle
        const textareaContainer = controlsContainer.createDiv('flare-textarea-container');
        
        // Create input inside the textarea container
        this.inputEl = textareaContainer.createEl('textarea', {
            cls: 'flare-input',
            attr: { 
                rows: '1',
                placeholder: '@flarename or select a Flare'
            }
        });
        
        // Add auto-resize handler for input using Obsidian's registerDomEvent for proper cleanup
        this.registerDomEvent(this.inputEl, 'input', (e) => {
            // Process suggestions and other input handling
            this.handleInput(e);
            // The debouncedHeightUpdate is already called within handleInput
        });
        
        // Also listen for keyup events to catch operations like undo that might not trigger input events
        this.registerDomEvent(this.inputEl, 'keyup', (e) => {
            // Use debounced update for smoother experience
            this.debouncedHeightUpdate();
        });
        
        // Create send button on the right
        const sendBtn = controlsContainer.createEl('button', {
            cls: 'flare-send-button',
            attr: { type: 'button' }
        }) as HTMLButtonElement;
        setIcon(sendBtn, 'send');
        setTooltip(sendBtn, 'Send message');

        // Now create footer as a child of bottomContainer, right after the composer
        const footer = bottomContainer.createDiv('flare-footer');
        const footerLeft = footer.createDiv('flare-footer-left');
        const footerRight = footer.createDiv('flare-footer-right');

        // Add model selector
        const modelControl = footerLeft.createDiv('flare-model-control');
        modelControl.addClass('is-disabled');
        
        // Add circuit icon
        const modelIcon = modelControl.createSpan('flare-model-icon');
        setIcon(modelIcon, 'circuit-board');
        
        // Add model display
        this.modelDisplayEl = modelControl.createSpan('flare-model-value');
        this.modelDisplayEl.setText('--');
        
        // Add click handler for model selection
        modelControl.onclick = async () => {
            if (!this.currentFlare) return;
            await this.showModelSelector();
        };
        
        // Add temperature display
        const tempControl = footerRight.createDiv('flare-temp-control');
        tempControl.addClass('is-disabled'); // Start disabled
        tempControl.onclick = () => {
            if (!this.currentFlare || this.currentTemp === undefined) return; // Don't allow temp changes without a flare and temp
            new TempDialog(
                this.plugin,
                this.currentTemp,
                (temp: number) => {
                    this.currentTemp = temp;
                    this.updateTempDisplay();
                }
            ).open();
        };
        
        const tempIcon = tempControl.createSpan('flare-temp-icon');
        setIcon(tempIcon, 'thermometer');
        
        this.tempDisplayEl = tempControl.createSpan('flare-temp-value');
        this.tempDisplayEl.setText('--');  // Initialize with -- instead of the default temperature
        
        // Initialize history sidebar
        this.historySidebar = new HistorySidebar(this.plugin, async (file: TFile) => {
            await this.plugin.chatHistoryManager.loadHistory(file);
            await this.loadCurrentHistory();
        });
        this.historySidebar.attachTo(chatContainer);
        
        // Setup event handlers
        this.setupEventHandlers();

        // Add ResizeObserver
        this.resizeObserver.observe(this.containerEl);

        // Setup accessibility
        this.setupAccessibility();

        // Load saved state
        await this.loadViewState();
    }
    
    private setupEventHandlers() {
        if (!this.inputEl) return;

        // Register all DOM events using Obsidian's registerDomEvent
        // No longer need to register input handler here as it's handled in createUI
        this.registerDomEvent(this.inputEl, 'keydown', this.handleKeyDown.bind(this), { capture: true });
        this.registerDomEvent(document, 'click', this.handleGlobalClick.bind(this));

        // Handle send button
        const sendBtn = this.containerEl.querySelector('.flare-send-button') as HTMLButtonElement | null;
        if (sendBtn) {
            // Store original handler
            this.originalSendHandler = async (event: MouseEvent) => {
                if (this.isStreaming) {
                    // If streaming, stop the current request
                    if (this.currentFlare) {
                        const provider = await this.plugin.getProviderInstance(this.currentFlare.provider);
                        if (provider) {
                            provider.stopRequest();
                            this.isStreaming = false;
                            this.resetSendButton(sendBtn, this.originalSendHandler);
                        }
                    }
                    return;
                }

                const content = this.inputEl.value.trim();
                if (content) {
                    // Check for temperature command
                    if (content.startsWith('/t ')) {
                        try {
                            const tempStr = content.substring(3).trim();
                            const newTemp = parseFloat(tempStr);
                            
                            // Clear input field immediately
                            if (this.inputEl instanceof HTMLTextAreaElement) {
                                this.inputEl.value = '';
                                this.inputEl.classList.remove('has-content', 'has-custom-height');
                                this.inputEl.removeAttribute('data-content-height');
                                this.inputEl.style.height = 'auto';
                                const wrapper = this.inputEl.closest('.flare-input-wrapper');
                                if (wrapper instanceof HTMLElement) {
                                    wrapper.style.height = '40px';
                                }
                            }

                            // Validate temperature value
                            if (isNaN(newTemp)) {
                                throw new Error('Please provide a valid number');
                            }
                            
                            if (newTemp < 0 || newTemp > 2) {
                                throw new Error('Temperature must be between 0 and 2');
                            }

                            // Update temperature and UI
                            this.currentTemp = newTemp;
                            this.updateTempDisplay();
                            new Notice(`Temperature set to ${newTemp.toFixed(2)}`);
                        } catch (error) {
                            new Notice(`Invalid temperature: ${error instanceof Error ? error.message : 'Unknown error'}`);
                        }
                        return;
                    }
                    
                    // Check for title command
                    if (content === '/title') {
                        // Clear input field immediately
                        if (this.inputEl) {
                            this.inputEl.value = '';
                            this.inputEl.classList.remove('has-content', 'has-custom-height');
                            this.inputEl.removeAttribute('data-content-height');
                            this.inputEl.style.height = 'auto';
                            const wrapper = this.inputEl.closest('.flare-input-wrapper');
                            if (wrapper instanceof HTMLElement) {
                                wrapper.style.height = '40px';
                            }
                        }
                        // Run title generation in the background
                        this.handleTitleGeneration().catch(error => {
                            console.error('Failed to generate title:', error);
                            new Notice('Failed to generate title');
                        });
                        return;
                    }
                    
                    // Check for export command
                    if (content === '/export') {
                        // Clear input field immediately
                        if (this.inputEl) {
                            this.inputEl.value = '';
                            this.inputEl.classList.remove('has-content', 'has-custom-height');
                            this.inputEl.removeAttribute('data-content-height');
                            this.inputEl.style.height = 'auto';
                            const wrapper = this.inputEl.closest('.flare-input-wrapper');
                            if (wrapper instanceof HTMLElement) {
                                wrapper.style.height = '40px';
                            }
                        }
                        // Export chat history
                        this.handleExportCommand().catch((error: unknown) => {
                            console.error('Failed to export chat history:', error);
                            new Notice('Failed to export chat history');
                        });
                        return;
                    }
                    
                    // Set streaming state before sending
                    this.isStreaming = true;
                    setIcon(sendBtn, 'square');
                    sendBtn.classList.add('is-streaming');
                    setTooltip(sendBtn, 'Stop streaming');
                    
                    try {
                        // Store input value and clear input immediately with proper height reset
                        const inputValue = this.inputEl.value;
                        this.resetInputField();
                        
                        // Try to send the message
                        const success = await this.handleMessage(content);
                        // If message failed to send, restore the input
                        if (!success) {
                            this.inputEl.value = inputValue;
                            this.updateInputHeight();
                        }
                    } finally {
                        // Reset streaming state
                        this.isStreaming = false;
                        this.resetSendButton(sendBtn, this.originalSendHandler);
                    }
                }
            };

            this.registerDomEvent(sendBtn, 'click', (e: MouseEvent) => {
                if (this.originalSendHandler) {
                    this.originalSendHandler(e);
                }
            });
        }
        
        // Handle flare chooser
        const flareChooser = this.containerEl.querySelector('.flare-chooser');
        if (flareChooser instanceof HTMLElement) {
            this.registerDomEvent(flareChooser, 'click', async (e: MouseEvent) => {
                const menu = new Menu();
                
                try {
                    // Load available flares
                    const flares = await this.plugin.flareManager.loadFlares();
                    
                    // Add menu items for each flare
                    for (const flare of flares) {
                        menu.addItem((item) => {
                            item.setTitle(flare.name)
                                .setIcon('flame')
                                .onClick(async () => {
                                    try {
                                        // When clicking from the menu, we want to actually switch flares
                                        this.currentFlare = await this.plugin.flareManager.debouncedLoadFlare(flare.name);
                                        if (this.currentFlare) {
                                            await this.handleFlareSwitch(this.currentFlare);
                                        }
                                    } catch (error: unknown) {
                                        console.error('Failed to load flare config:', error);
                                        new Notice(getErrorMessage(error));
                                    }
                                });
                        });
                    }
                    
                    // Show menu at click position
                    menu.showAtPosition({
                        x: e.clientX,
                        y: e.clientY
                    });
                } catch (error: unknown) {
                    console.error('Failed to load flares:', error);
                    new Notice('Failed to load flares: ' + getErrorMessage(error));
                }
            });
        }

        // Global click handler for closing suggestions
        this.registerDomEvent(document, 'click', ((e: Event) => {
            if (!(e instanceof MouseEvent)) return;
            const suggestionContainer = this.containerEl.querySelector('.flare-suggestions');
            if (suggestionContainer && 
                !suggestionContainer.contains(e.target as Node) && 
                !this.inputEl.contains(e.target as Node)) {
                this.hideSuggestions();
            }
        }) as EventListener);

        // Window resize handler for suggestion positioning
        const debouncedUpdatePosition = debounce(
            () => {
                const suggestionContainer = this.containerEl.querySelector('.flare-suggestions');
                if (suggestionContainer) {
                    this.updateSuggestionsPosition();
                }
            },
            100,
            false
        );
        this.registerDomEvent(window, 'resize', debouncedUpdatePosition as EventListener);

        // Setup toolbar buttons
        this.setupToolbarHandlers();
    }

    private resetSendButton(
        button: HTMLButtonElement, 
        originalHandler: ((this: GlobalEventHandlers, ev: MouseEvent) => any) | null
    ): void {
        this.isAborted = true;  // Set abort state when stopping
        setIcon(button, 'send');
        setTooltip(button, 'Send message');
        button.classList.remove('is-streaming');
        this.isStreaming = false;
    }

    private updateFlareSuggestions(searchTerm: string) {
        const createSuggestionContainer = () => {
            const container = createDiv('flare-suggestions');
            // Append to input wrapper for proper positioning
            const inputWrapper = this.inputEl?.closest('.flare-input-wrapper');
            if (inputWrapper) {
                inputWrapper.appendChild(container);
            }
            return container;
        };

        const removeSuggestions = () => {
            const container = this.containerEl.querySelector('.flare-suggestions');
            if (container) {
                container.remove();
            }
            this.selectedSuggestionIndex = -1;
        };

        const renderSuggestions = async (container: HTMLElement, searchTerm: string) => {
            try {
                const flares = await this.plugin.flareManager.loadFlares();
                const filtered = flares.filter((f: { name: string }) => 
                    f.name.toLowerCase().includes(searchTerm.toLowerCase())
                );

                if (filtered.length === 0) {
                    removeSuggestions();
                    return;
                }

                container.empty();
                const suggestionsInner = container.createDiv('flare-suggestions-container');

                // Add suggestions
                filtered.forEach((flare: { name: string }, index: number) => {
                    const item = suggestionsInner.createDiv('flare-suggestion-item');
                    if (index === this.selectedSuggestionIndex) {
                        item.classList.add('is-selected');
                    }
                    
                    const icon = item.createDiv('suggestion-icon');
                    setIcon(icon, 'flame');
                    
                    item.createDiv('suggestion-name').setText(flare.name);
                    
                    if (index === 0) {
                        item.createDiv('suggestion-hint').setText('↵ to select');
                    }
                    
                    // Add mouse event handlers
                    if (item instanceof HTMLElement) {
                        this.registerDomEvent(item, 'mouseenter', () => {
                            // Remove selection from previously selected item
                            suggestionsInner.querySelectorAll('.is-selected').forEach(el => 
                                el.classList.remove('is-selected')
                            );
                            item.classList.add('is-selected');
                            this.selectedSuggestionIndex = index;
                        });
                        
                        this.registerDomEvent(item, 'click', () => {
                            this.insertFlareSuggestion(index);
                        });
                    }
                });

                // Position the suggestions based on available space
                const inputWrapper = this.inputEl?.closest('.flare-input-wrapper');
                if (inputWrapper) {
                    const rect = inputWrapper.getBoundingClientRect();
                    const viewportHeight = window.innerHeight;
                    const spaceBelow = viewportHeight - rect.bottom;
                    const spaceAbove = rect.top;

                    if (spaceBelow >= 200 || spaceBelow > spaceAbove) {
                        container.classList.remove('position-top');
                        container.classList.add('position-bottom');
                    } else {
                        container.classList.add('position-top');
                        container.classList.remove('position-bottom');
                    }
                }

                container.classList.add('is-visible');

                // Set initial selection
                if (this.selectedSuggestionIndex === -1) {
                    this.selectedSuggestionIndex = 0;
                    const firstItem = suggestionsInner.querySelector('.flare-suggestion-item');
                    if (firstItem instanceof HTMLElement) {
                        firstItem.classList.add('is-selected');
                    }
                }

                // Add mouse leave handler to container
                if (container instanceof HTMLElement) {
                    this.registerDomEvent(container, 'mouseleave', () => {
                        // Restore keyboard selection when mouse leaves
                        suggestionsInner.querySelectorAll('.is-selected').forEach(el => 
                            el.classList.remove('is-selected')
                        );
                        const currentItem = suggestionsInner.children[this.selectedSuggestionIndex];
                        if (currentItem instanceof HTMLElement) {
                            currentItem.classList.add('is-selected');
                        }
                    });
                }
            } catch (error) {
                console.error('Error updating suggestions:', error);
                removeSuggestions();
            }
        };

        // Remove existing suggestions
        removeSuggestions();

        // Create new suggestions container
        const container = createSuggestionContainer();
        renderSuggestions(container, searchTerm);
    }

    private hideSuggestions() {
        const container = this.containerEl.querySelector('.flare-suggestions');
        if (container instanceof HTMLElement) {
            // First remove the visible class to trigger transition
            container.removeClass('is-visible');
            
            // Wait for transition to complete before removing
            setTimeout(() => {
                container.remove();
            }, CONSTANTS.TRANSITION_DURATION);
        }
        this.selectedSuggestionIndex = -1;
    }

    private async selectFlare(flareName: string) {
        try {
            const flare = await this.plugin.flareManager.debouncedLoadFlare(flareName);
            if (flare) {
                this.currentFlare = flare;
                await this.handleFlareSwitch(flare);
            }
        } catch (error) {
            console.error('Error loading flare:', error);
            new Notice(`Failed to load flare: ${error}`);
        }
    }

    private navigateSuggestions(direction: 'up' | 'down') {
        const suggestions = this.containerEl.querySelectorAll('.flare-suggestion-item');
        const total = suggestions.length;
        if (!total) return;

        // Update index with wrapping, one item at a time
        if (direction === 'up') {
            this.selectedSuggestionIndex = (this.selectedSuggestionIndex <= 0) ? total - 1 : this.selectedSuggestionIndex - 1;
        } else {
            this.selectedSuggestionIndex = (this.selectedSuggestionIndex >= total - 1) ? 0 : this.selectedSuggestionIndex + 1;
        }

        // Update UI
        suggestions.forEach((item, index) => {
            if (index === this.selectedSuggestionIndex) {
                item.classList.add('is-selected');
                // Use scrollIntoView with smooth behavior
                item.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
            } else {
                item.classList.remove('is-selected');
            }
        });
    }

    private handleKeyDown(e: KeyboardEvent) {
        const suggestionContainer = this.containerEl.querySelector('.flare-suggestions');
        
        // Handle suggestions navigation if suggestions are visible
        if (suggestionContainer) {
            switch (e.key) {
                case 'ArrowUp':
                    e.preventDefault();
                    e.stopImmediatePropagation();
                    this.navigateSuggestions('up');
                    break;
                    
                case 'ArrowDown':
                    e.preventDefault();
                    e.stopImmediatePropagation();
                    this.navigateSuggestions('down');
                    break;
                    
                case 'Tab':
                    if (this.selectedSuggestionIndex >= 0) {
                        e.preventDefault();
                        e.stopImmediatePropagation();
                        this.insertFlareSuggestion(this.selectedSuggestionIndex);
                    }
                    break;
                    
                case 'Enter':
                    if (this.selectedSuggestionIndex >= 0) {
                        e.preventDefault();
                        e.stopImmediatePropagation();
                        this.insertFlareSuggestion(this.selectedSuggestionIndex);
                    }
                    break;
                    
                case 'Escape':
                    this.hideSuggestions();
                    break;
            }
            return;
        }

        // Handle undo operation (Ctrl+Z or Cmd+Z)
        if (e.key === 'z' && (e.ctrlKey || e.metaKey)) {
            // Use requestAnimationFrame with debounced update for smoother experience
            requestAnimationFrame(() => {
                this.debouncedHeightUpdate();
            });
        }

        // If suggestions are not visible, let the Enter key (and others) be handled normally:
        if (e.key === 'Enter' && !Platform.isMobile && !e.shiftKey) {
            e.preventDefault();
            const sendBtn = this.containerEl.querySelector('.flare-send-button') as HTMLButtonElement;
            if (sendBtn && this.originalSendHandler && !this.isStreaming) {
                this.originalSendHandler(new MouseEvent('click'));
            }
        }
    }

    private setupToolbarHandlers() {
        // History toggle
        const historyBtn = this.containerEl.querySelector('.flare-toolbar-button.history-toggle');
        if (historyBtn instanceof HTMLElement) {
            this.registerDomEvent(historyBtn, 'click', () => {
                if (this.historySidebar.isVisible) {
                    this.historySidebar.hide();
                } else {
                    this.historySidebar.show();
                }
            });
        }

        // New chat
        const newChatBtn = this.containerEl.querySelector('.flare-toolbar-button.new-chat');
        if (newChatBtn instanceof HTMLElement) {
            this.registerDomEvent(newChatBtn, 'click', () => {
                this.startNewChat();
            });
        }

        // Export chat
        const exportBtn = this.containerEl.querySelector('.flare-toolbar-button.export-chat');
        if (exportBtn instanceof HTMLElement && !exportBtn.hasAttribute('data-handler-registered')) {
            exportBtn.setAttribute('data-handler-registered', 'true');
            this.registerDomEvent(exportBtn, 'click', async () => {
                try {
                    await this.handleExportCommand();
                } catch (error: unknown) {
                    console.error('Failed to export chat:', error);
                    new Notice('Failed to export chat');
                }
            });
        }

        // Save chat
        const saveBtn = this.containerEl.querySelector('.flare-toolbar-button.save-chat');
        if (saveBtn instanceof HTMLElement && !saveBtn.hasAttribute('data-handler-registered')) {
            saveBtn.setAttribute('data-handler-registered', 'true');
            this.registerDomEvent(saveBtn, 'click', async () => {
                try {
                    // Temporarily disable auto-title generation
                    const autoTitleEnabled = this.plugin.settings.titleSettings.autoGenerate;
                    this.plugin.settings.titleSettings.autoGenerate = false;
                    
                    await this.plugin.chatHistoryManager.saveCurrentHistory(true, false);  // Force save but don't show notice
                    const currentFile = this.plugin.chatHistoryManager.getCurrentFile();
                    if (currentFile) {
                        const titleEl = this.containerEl.querySelector('.flare-toolbar-center h2');
                        if (titleEl) {
                            titleEl.textContent = currentFile.basename;
                        }
                        new Notice('Chat saved successfully');  // Single notice for successful save
                    }
                    
                    // Restore auto-title generation setting
                    this.plugin.settings.titleSettings.autoGenerate = autoTitleEnabled;
                } catch (error) {
                    console.error('Error saving chat:', error);
                    new Notice('Failed to save chat');
                }
            });
        }

        // Clear chat
        const clearBtn = this.containerEl.querySelector('.flare-toolbar-button.clear-chat');
        if (clearBtn instanceof HTMLElement) {
            this.registerDomEvent(clearBtn, 'click', () => {
                this.clearChat();
            });
        }
    }

    private async startNewChat() {
        try {
            // Clear existing messages
            if (this.messagesEl) {
                this.messagesEl.empty();
            }

            // Reset message history
            this.messageHistory = [];
            this.hasAutoGeneratedTitle = false;  // Reset the flag when starting a new chat

            // Reset title
            const titleEl = this.containerEl.querySelector('.flare-toolbar-center h2');
            if (titleEl) {
                titleEl.textContent = 'New Chat';
            }

            // Create new history in the manager
            await this.plugin.chatHistoryManager.createNewHistory();

            // Clear input
            if (this.inputEl) {
                this.inputEl.value = '';
                this.inputEl.classList.remove('has-content', 'has-custom-height');
                // Reset input placeholder to default
                this.inputEl.setAttribute('placeholder', '@flarename or select a Flare');
            }

            // Reset flare and related UI elements
            this.currentFlare = undefined;
            
            // Reset model display
            if (this.modelDisplayEl) {
                this.modelDisplayEl.textContent = '--';
                const modelControl = this.modelDisplayEl.closest('.flare-model-control');
                if (modelControl instanceof HTMLElement) {
                    modelControl.classList.add('is-disabled');
                }
            }

            // Reset temperature to undefined and update display
            this.currentTemp = undefined;
            this.updateTempDisplay();
            const tempControl = this.containerEl.querySelector('.flare-temp-control');
            if (tempControl instanceof HTMLElement) {
                tempControl.classList.add('is-disabled');
            }

            // Reset plugin state
            this.plugin.isFlareSwitchActive = false;
            this.plugin.lastUsedFlare = null;

            // Update view state
            this.updateViewState({
                isStreaming: false,
                isProcessing: false,
                hasError: false,
                errorMessage: ''
            });
        } catch (error) {
            console.error('Error starting new chat:', error);
            new Notice('Failed to start new chat');
        }
    }

    private async clearChat() {
        try {
            // Clear UI
            if (this.messagesEl) {
                this.messagesEl.empty();
            }

            // Clear history arrays
            this.messageHistory = [];
            await this.plugin.chatHistoryManager.clearHistory();

            // Reset input field
            this.resetInputField();

            new Notice('Chat cleared');
        } catch (error) {
            console.error('Error clearing chat:', error);
            new Notice('Failed to clear chat');
        }
    }

    private updateInputHeight() {
        if (!this.inputEl) return;

        const inputEl = this.inputEl;
        const hasContent = inputEl.value.trim().length > 0;
        
        // First reset height to auto to get accurate scrollHeight measurement
        inputEl.style.height = 'auto';
        
        // Always calculate appropriate height based on content
        const scrollHeight = Math.max(36, inputEl.scrollHeight);
        const newHeight = hasContent ? Math.min(scrollHeight, CONSTANTS.MAX_INPUT_HEIGHT) : 36;
        inputEl.style.height = `${newHeight}px`;
        
        // Update classes for styling
        inputEl.classList.toggle('has-content', hasContent);
        
        // Update container classes to match
        const textareaContainer = inputEl.closest('.flare-textarea-container');
        if (textareaContainer instanceof HTMLElement) {
            textareaContainer.classList.toggle('has-content', hasContent);
        }
        
        const controlsContainer = inputEl.closest('.flare-controls-container');
        if (controlsContainer instanceof HTMLElement) {
            controlsContainer.classList.toggle('has-content', hasContent);
        }
        
        const wrapper = inputEl.closest('.flare-input-wrapper');
        if (wrapper instanceof HTMLElement) {
            wrapper.classList.toggle('has-content', hasContent);
        }
    }

    private updateTempDisplay() {
        if (!this.tempDisplayEl) return;

        // Show -- if no flare is selected or no temperature set
        const tempText = !this.currentFlare || this.currentTemp === undefined ? '--' : this.currentTemp.toFixed(2);
        this.tempDisplayEl.textContent = tempText;

        // Update temperature control state
        const tempControl = this.tempDisplayEl.closest('.flare-temp-control');
        if (tempControl instanceof HTMLElement) {
            tempControl.classList.toggle('is-disabled', !this.currentFlare);
        }
    }

    private async showModelSelector() {
        if (!this.currentFlare) return;

        try {
            const provider = await this.plugin.getProviderInstance(this.currentFlare.provider);
            if (!provider) {
                throw new Error('Provider not found');
            }

            const allModels = await provider.getAvailableModels();
            if (!allModels || allModels.length === 0) {
                new Notice('No models available for this provider');
                return;
            }

            // Get provider settings to check visible models
            const providerSettings = this.plugin.settings.providers[this.currentFlare.provider];
            if (!providerSettings) {
                throw new Error('Provider settings not found');
            }

            // Filter models based on visibility settings
            const visibleModels: string[] = providerSettings.visibleModels && providerSettings.visibleModels.length > 0
                ? allModels.filter((model: string) => providerSettings.visibleModels?.includes(model))
                : allModels;

            if (visibleModels.length === 0) {
                new Notice('No visible models available for this provider');
                return;
            }

            const menu = new Menu();
            visibleModels.forEach((model: string) => {
                menu.addItem(item => {
                    item.setTitle(model)
                        .setIcon(model === this.currentFlare?.model ? 'check' : 'circuit-board')
                        .onClick(async () => {
                            if (this.currentFlare) {
                                this.currentFlare.model = model;
                                if (this.modelDisplayEl) {
                                    this.modelDisplayEl.textContent = this.truncateModelName(model);
                                }
                                await this.plugin.saveSettings();
                            }
                        });
                });
            });

            // Position menu near the model selector
            const modelControl = this.containerEl.querySelector('.flare-model-control');
            if (modelControl instanceof HTMLElement) {
                const rect = modelControl.getBoundingClientRect();
                menu.showAtPosition({ x: rect.left, y: rect.bottom });
            }
        } catch (error) {
            console.error('Error showing model selector:', error);
            new Notice('Failed to load available models');
        }
    }

    private async loadCurrentHistory() {
        try {
            // Get current history from the history manager
            const history = this.plugin.chatHistoryManager.getCurrentHistory();
            if (!history) return;

            // Clear existing messages
            if (this.messagesEl) {
                this.messagesEl.empty();
            }

            // Reset message history and expanded reasoning messages
            this.messageHistory = [];
            this.expandedReasoningMessages.clear();
            this.hasAutoGeneratedTitle = true;  // Set to true for existing chats to prevent auto title generation

            // Update title from the current file (not history object)
            const currentFile = this.plugin.chatHistoryManager.getCurrentFile();
            const titleEl = this.containerEl.querySelector('.flare-toolbar-center h2');
            if (titleEl && currentFile) {
                titleEl.textContent = currentFile.basename;
            }

            // Update flare and settings if available
            if (history.flare) {
                const flareConfig = await this.plugin.flareManager.debouncedLoadFlare(history.flare);
                if (flareConfig) {
                    this.currentFlare = flareConfig;
                    
                    // Update input placeholder
                    if (this.inputEl) {
                        this.inputEl.setAttribute('placeholder', `@${flareConfig.name}`);
                    }

                    // Update model display
                    if (this.modelDisplayEl) {
                        this.modelDisplayEl.textContent = this.truncateModelName(flareConfig.model);
                    }

                    // Enable model and temperature controls
                    const modelControl = this.containerEl.querySelector('.flare-model-control');
                    const tempControl = this.containerEl.querySelector('.flare-temp-control');
                    
                    if (modelControl instanceof HTMLElement) {
                        modelControl.classList.remove('is-disabled');
                    }
                    if (tempControl instanceof HTMLElement) {
                        tempControl.classList.remove('is-disabled');
                    }
                }
            }

            // Set temperature
            this.currentTemp = history.temperature;
            this.updateTempDisplay();

            // Add each message to the UI
            for (const message of history.messages) {
                const messageSettings = {
                    ...message.settings,
                    flare: message.settings?.flare || history.flare, // Use message's flare name or history's flare name
                    isReasoningModel: message.settings && message.settings.hasOwnProperty('isReasoningModel') ? message.settings.isReasoningModel : this.currentFlare?.isReasoningModel,
                    reasoningHeader: message.settings && message.settings.reasoningHeader ? message.settings.reasoningHeader : this.currentFlare?.reasoningHeader
                };

                // Create message element
                const messageEl = this.messagesEl.createDiv({
                    cls: `flare-message ${message.role}`
                });

                // Add accessibility attributes
                messageEl.setAttribute('role', `${message.role}`);
                setTooltip(messageEl, `${message.role} message`);
                messageEl.setAttribute('aria-live', message.role === 'assistant' ? 'polite' : 'off');

                // Store original content for comparison
                messageEl.setAttrs({
                    'data-content': message.content,
                    'data-role': message.role
                });
                messageEl.setAttribute('data-timestamp', message.timestamp.toString());

                // Create message content with proper structure
                const contentEl = messageEl.createDiv('flare-message-content');

                // Only create meta and actions for non-system messages
                if (message.role !== 'system') {
                    // Add metadata (timestamp, etc) and actions
                    const metaEl = messageEl.createDiv('flare-message-meta');
                    const timestamp = moment(message.timestamp).format('h:mm A');
                    metaEl.createSpan({
                        cls: 'flare-message-time',
                        text: timestamp
                    });

                    // Add action buttons container
                    const actions = metaEl.createDiv('flare-message-actions');
                    this.addMessageActions(actions, messageEl, message.content);
                }

                // Handle system messages differently
                if (message.role === 'system') {
                    this.renderSystemMessage(messageEl, contentEl, message.content);
                } else {
                    await this.renderUserOrAssistantMessage(message.role, contentEl, message.content, messageSettings);
                }

                // Add to message history
                this.messageHistory.push({
                    role: message.role,
                    content: message.content,
                    timestamp: message.timestamp,
                    settings: messageSettings
                });
            }

            // Scroll to bottom after loading
            this.scrollToBottom();

            // Update view state
            this.updateViewState({
                isStreaming: false,
                isProcessing: false,
                hasError: false,
                errorMessage: '',
                currentTemp: history.temperature
            });

        } catch (error) {
            console.error('Error loading chat history:', error);
            new Notice('Failed to load chat history');
            
            // Update view state to show error
            this.updateViewState({
                hasError: true,
                errorMessage: error instanceof Error ? error.message : 'Failed to load chat history'
            });
        }
    }

    private updateSuggestionsPosition() {
        const suggestionContainer = this.containerEl.querySelector('.flare-suggestions');
        if (!(suggestionContainer instanceof HTMLElement)) return;

        const inputWrapper = this.inputEl?.closest('.flare-input-wrapper');
        if (!(inputWrapper instanceof HTMLElement)) return;

        // Batch all DOM reads first
        requestAnimationFrame(() => {
            // Get all measurements in one batch to avoid forced reflows
            const wrapperRect = inputWrapper.getBoundingClientRect();
            const viewportHeight = window.innerHeight;
            
            // Calculate available space above and below
            const spaceBelow = viewportHeight - wrapperRect.bottom;
            const spaceAbove = wrapperRect.top;
            
            // Determine if suggestions should appear below or above input
            const useBottomPosition = spaceBelow >= CONSTANTS.SUGGESTIONS_MIN_SPACE || spaceBelow > spaceAbove;
            
            // Batch all DOM writes in the next frame
            requestAnimationFrame(() => {
                // Toggle position classes instead of setting inline styles
                suggestionContainer.toggleClass('position-top', !useBottomPosition);
                suggestionContainer.toggleClass('position-bottom', useBottomPosition);
                
                // Use data attributes for CSS variables
                if (useBottomPosition) {
                    suggestionContainer.setAttribute('data-top-offset', String(wrapperRect.bottom + CONSTANTS.SUGGESTIONS_OFFSET));
                    suggestionContainer.removeAttribute('data-bottom-offset');
                } else {
                    suggestionContainer.setAttribute('data-bottom-offset', String(viewportHeight - wrapperRect.top + CONSTANTS.SUGGESTIONS_OFFSET));
                    suggestionContainer.removeAttribute('data-top-offset');
                }
                
                // Set max-height based on available space
                suggestionContainer.setAttribute('data-max-height', String(Math.min(CONSTANTS.SUGGESTIONS_MAX_HEIGHT, 
                    Math.max(spaceAbove, spaceBelow) - CONSTANTS.SUGGESTIONS_PADDING)));
            });
        });
    }

    /**
     * Handles generating a title for the current chat
     * @returns Promise<boolean> indicating success
     */
    private async handleTitleGeneration(): Promise<boolean> {
        if (this.isTitleGenerationInProgress) {
            new Notice('Title generation already in progress');
            return false;
        }

        // Check if autosave is disabled and no file exists yet
        if (!this.plugin.settings.autoSaveEnabled && !this.plugin.chatHistoryManager.getCurrentFile()) {
            new Notice('Please save the chat first before generating a title');
            return false;
        }

        this.isTitleGenerationInProgress = true;

        try {
            // Validate settings
            const settings = this.plugin.settings.titleSettings;
            if (!settings) {
                throw new Error('Title generation settings not found');
            }
            if (!settings.provider) {
                throw new Error('Please select a provider for title generation in settings');
            }
            if (!settings.model) {
                throw new Error('Please select a model for title generation in settings');
            }

            // Validate message history
            if (!this.messageHistory || this.messageHistory.length === 0) {
                throw new Error('No messages to generate title from');
            }

            new Notice('Generating title...');
            
            // Generate title
            const newTitle = await this.plugin.chatHistoryManager.generateTitle();
            if (!newTitle || typeof newTitle !== 'string' || newTitle.trim().length === 0) {
                throw new Error('Generated title is empty or invalid');
            }
            
            // Update UI with new title
            const titleEl = this.containerEl.querySelector('.flare-toolbar-center h2');
            if (titleEl) {
                titleEl.textContent = newTitle;
            }
            
            // Get current file
            const currentFile = this.plugin.chatHistoryManager.getCurrentFile();
            if (!currentFile) {
                throw new Error('No active history file');
            }

            // Rename the file to match the new title
            const newPath = `${this.plugin.settings.historyFolder}/${newTitle}.md`;
            await this.plugin.app.fileManager.renameFile(currentFile, newPath);
            
            new Notice('Title generated and updated successfully');
            return true;
        } catch (error: unknown) {
            console.error('Error generating title:', error);
            const errorMessage = error instanceof Error ? error.message : String(error);
            new Notice(`Error generating title: ${errorMessage}`);
            return false;
        } finally {
            this.isTitleGenerationInProgress = false;
        }
    }

    private sanitizeMessageForAPI(message: string, reasoningHeader: string): string {
        if (!message) return message;
        
        // Use existing extractReasoningContent function to get only the response part
        const { responsePart } = this.extractReasoningContent(message, reasoningHeader);
        return responsePart.trim();
    }

    /**
     * Handles sending a message to the AI provider and rendering the response
     * @param content - The message content to send
     * @param options - Optional settings for message handling
     * @returns Promise<boolean> - Success status
     * @throws {MessageError} When message handling fails
     */
    private async sendMessage(content: string, options?: { stream?: boolean; isFlareSwitch?: boolean }): Promise<boolean> {
        // Declare loadingMsg outside try/catch so it can be used in catch blocks
        let loadingMsg: HTMLElement | null = null;
        
        try {
            this.messageState = {
                isStreaming: false,
                isProcessing: true,
                hasError: false,
                errorMessage: ''
            };

            // Add user message to UI first
            const userMessage = await this.addMessage('user', content, {
                flare: this.currentFlare?.name || 'default',
                provider: this.currentFlare?.provider || 'default',
                model: this.currentFlare?.model || 'default',
                temperature: this.currentTemp ?? 0.7,
                maxTokens: this.currentFlare?.maxTokens,
                contextWindow: this.currentFlare?.contextWindow,
                handoffContext: this.currentFlare?.handoffContext
            });

            if (userMessage) {
                userMessage.setAttribute('role', 'user');
                setTooltip(userMessage, 'User message');
                if (!userMessage.getAttribute('data-timestamp')) {
                    userMessage.setAttribute('data-timestamp', Date.now().toString());
                }
            }

            // Create loading message for assistant
            loadingMsg = await this.addMessage('assistant', '', {
                flare: this.currentFlare?.name || 'default',
                provider: this.currentFlare?.provider || 'default',
                model: this.currentFlare?.model || 'default',
                temperature: this.currentTemp ?? 0.7,
                maxTokens: this.currentFlare?.maxTokens,
                contextWindow: this.currentFlare?.contextWindow,
                handoffContext: this.currentFlare?.handoffContext
            }, false);

            if (!loadingMsg) {
                throw new Error('Failed to create loading message');
            }

            loadingMsg.setAttribute('role', 'assistant');
            setTooltip(loadingMsg, 'Assistant message');
            loadingMsg.setAttribute('data-timestamp', Date.now().toString());
            loadingMsg.addClass('is-loading');

            // Set up streaming containers
            const contentEl = loadingMsg.querySelector('.flare-message-content');
            if (!(contentEl instanceof HTMLElement)) {
                throw new Error('Failed to find message content element');
            }

            const contentWrapper = contentEl.querySelector('.flare-content-wrapper');
            if (!(contentWrapper instanceof HTMLElement)) {
                throw new Error('Failed to find content wrapper');
            }

            // For non-reasoning models, ensure we have a markdown container
            if (!this.currentFlare?.isReasoningModel) {
                const markdownContainer = contentWrapper.querySelector('.flare-markdown-content');
                if (markdownContainer instanceof HTMLElement) {
                    if (!markdownContainer.querySelector('.markdown-rendered')) {
                        const rendered = markdownContainer.createDiv('markdown-rendered');
                        rendered.setAttribute('role', 'presentation');
                    }
                }
            }
            // For reasoning models, ensure we have both reasoning and response containers
            else {
                const responseContainer = contentWrapper.querySelector('.flare-response-content');
                if (!responseContainer) {
                    contentWrapper.createDiv('flare-response-content');
                }
            }

            let accumulatedResponse = '';
            let accumulatedReasoningBlocks: string[] = [];
            let currentReasoningBlock = '';
            let isInReasoningBlock = false;
            const reasoningHeader = this.currentFlare?.reasoningHeader || '<think>';
            const reasoningEndTag = reasoningHeader.replace('<', '</');

            // Create sanitized message history for API
            const sanitizedHistory = this.messageHistory.map(msg => ({
                ...msg,
                content: this.sanitizeMessageForAPI(
                    msg.content, 
                    // Use message's original reasoning header if available, otherwise use current
                    msg.settings?.reasoningHeader || reasoningHeader
                )
            }));

            try {
                // Update the isStreaming state in the view and button
                this.isStreaming = true;
                const sendBtn = this.containerEl.querySelector('.flare-send-button') as HTMLButtonElement;
                if (sendBtn) {
                    setIcon(sendBtn, 'square');
                    sendBtn.classList.add('is-streaming');
                    setTooltip(sendBtn, 'Stop streaming');
                }

                const response = await this.plugin.handleMessage(content, {
                    ...options,
                    messageHistory: sanitizedHistory,
                    flare: this.currentFlare?.name,
                    provider: this.currentFlare?.provider,
                    model: this.currentFlare?.model,
                    temperature: this.currentTemp,
                    maxTokens: this.currentFlare?.maxTokens,
                    stream: options?.stream ?? true,
                    onToken: async (token: string) => {
                        if (this.currentFlare?.isReasoningModel) {
                            // Handle reasoning blocks during streaming
                            if (token.includes(reasoningHeader)) {
                                // If we were in a reasoning block, save it before starting new one
                                if (isInReasoningBlock && currentReasoningBlock.trim()) {
                                    accumulatedReasoningBlocks.push(currentReasoningBlock.trim());
                                }
                                isInReasoningBlock = true;
                                currentReasoningBlock = '';
                                token = token.replace(reasoningHeader, '');
                            }
                            if (token.includes(reasoningEndTag)) {
                                isInReasoningBlock = false;
                                if (currentReasoningBlock.trim()) {
                                    accumulatedReasoningBlocks.push(currentReasoningBlock.trim());
                                }
                                currentReasoningBlock = '';
                                token = token.replace(reasoningEndTag, '');
                            }

                            if (isInReasoningBlock) {
                                currentReasoningBlock += token;
                            } else {
                                accumulatedResponse += token;
                                const responseContainer = contentWrapper.querySelector('.flare-response-content');
                                if (responseContainer instanceof HTMLElement) {
                                    // Just update text content during streaming
                                    responseContainer.textContent = accumulatedResponse;
                                }
                            }
                        } else {
                            // For non-reasoning models, stream directly to markdown container
                            accumulatedResponse += token;
                            const markdownContainer = contentWrapper.querySelector('.flare-markdown-content');
                            if (markdownContainer instanceof HTMLElement) {
                                const rendered = markdownContainer.querySelector('.markdown-rendered');
                                if (rendered instanceof HTMLElement) {
                                    // Just update text content during streaming
                                    rendered.textContent = accumulatedResponse;
                                }
                            }
                        }

                        // Scroll to bottom during streaming
                        this.scrollToBottom();
                    }
                });

                // For non-streaming responses, we need to process the response differently
                let finalResponse = '';
                if (options?.stream) {
                    finalResponse = accumulatedResponse;
                } else {
                    // For non-streaming, we need to process the response
                    if (this.currentFlare?.isReasoningModel) {
                        // Extract reasoning blocks from the complete response
                        const extraction = this.extractReasoningContent(response, reasoningHeader);
                        accumulatedReasoningBlocks = extraction.reasoningBlocks;
                        finalResponse = extraction.responsePart;
                    } else {
                        finalResponse = response;
                    }
                }
                
                // For reasoning models, reconstruct the full content with reasoning blocks
                let fullContent = finalResponse;
                if (this.currentFlare?.isReasoningModel) {
                    // Save any in-progress reasoning block if stream was aborted
                    if (this.isAborted && isInReasoningBlock && currentReasoningBlock.trim()) {
                        accumulatedReasoningBlocks.push(currentReasoningBlock.trim());
                    }
                    
                    // Reconstruct content with reasoning blocks
                    const reasoningParts = accumulatedReasoningBlocks.map(block => 
                        `${reasoningHeader}${block}${reasoningEndTag}`
                    );
                    fullContent = [...reasoningParts, finalResponse].join('\n\n');
                }

                // Update loading message with final response
                if (loadingMsg) {
                    loadingMsg.removeClass('is-loading');
                    const contentEl = loadingMsg.querySelector('.flare-message-content') as HTMLElement | null;
                    if (contentEl) {
                        contentEl.empty();
                        
                        await this.renderUserOrAssistantMessage('assistant', contentEl, fullContent, {
                            flare: this.currentFlare?.name || 'default',
                            provider: this.currentFlare?.provider || 'default',
                            model: this.currentFlare?.model || 'default',
                            temperature: this.currentTemp ?? 0.7,
                            maxTokens: this.currentFlare?.maxTokens,
                            contextWindow: this.currentFlare?.contextWindow,
                            handoffContext: this.currentFlare?.handoffContext,
                            isReasoningModel: this.currentFlare?.isReasoningModel,
                            reasoningHeader: this.currentFlare?.reasoningHeader
                        });
                        
                        loadingMsg.setAttribute('data-content', fullContent.trim());
                        loadingMsg.setAttribute('data-role', 'assistant');
                    }
                }

                // Add the assistant message to history manager
                const providerId = this.currentFlare?.provider || 'default';
                const providerSettings = this.plugin.settings.providers[providerId];
                const providerName = providerSettings?.name || providerId;

                const messageData = {
                    role: 'assistant',
                    content: fullContent,
                    settings: {
                        flare: this.currentFlare?.name || 'default',
                        provider: providerName,
                        model: this.currentFlare?.model || 'default',
                        temperature: this.currentTemp ?? 0.7,
                        maxTokens: this.currentFlare?.maxTokens,
                        contextWindow: this.currentFlare?.contextWindow,
                        handoffContext: this.currentFlare?.handoffContext,
                        isReasoningModel: this.currentFlare?.isReasoningModel,
                        reasoningHeader: this.currentFlare?.reasoningHeader,
                        timestamp: parseInt(loadingMsg.getAttribute('data-timestamp') || Date.now().toString())
                    },
                    timestamp: parseInt(loadingMsg.getAttribute('data-timestamp') || Date.now().toString())
                };

                // Add to message history and save
                this.messageHistory.push(messageData);
                await this.plugin.chatHistoryManager.addMessage(messageData);
                loadingMsg.setAttribute('data-timestamp', messageData.timestamp.toString());

                this.messageState.isProcessing = false;
                
                // Reset the isStreaming state and button after response is complete
                this.isStreaming = false;
                if (sendBtn) {
                    this.resetSendButton(sendBtn, this.originalSendHandler);
                }
                
                return true;
            } catch (error: unknown) {
                // Handle AbortError as a successful completion with partial content
                if (error instanceof Error && error.name === 'AbortError') {
                    // Save any in-progress reasoning block
                    if (this.currentFlare?.isReasoningModel && isInReasoningBlock && currentReasoningBlock.trim()) {
                        accumulatedReasoningBlocks.push(currentReasoningBlock.trim());
                    }

                    // Reconstruct content with any accumulated content
                    let fullContent = accumulatedResponse;
                    if (this.currentFlare?.isReasoningModel && (accumulatedReasoningBlocks.length > 0 || accumulatedResponse)) {
                        const reasoningParts = accumulatedReasoningBlocks.map(block => 
                            `${reasoningHeader}${block}${reasoningEndTag}`
                        );
                        fullContent = [...reasoningParts, accumulatedResponse].join('\n\n');
                    }

                    // Only proceed if we have some content
                    if (fullContent.trim()) {
                        if (loadingMsg) {
                            loadingMsg.removeClass('is-loading');
                            const contentEl = loadingMsg.querySelector('.flare-message-content') as HTMLElement | null;
                            if (contentEl) {
                                contentEl.empty();
                                await this.renderUserOrAssistantMessage('assistant', contentEl, fullContent, {
                                    flare: this.currentFlare?.name || 'default',
                                    provider: this.currentFlare?.provider || 'default',
                                    model: this.currentFlare?.model || 'default',
                                    temperature: this.currentTemp ?? 0.7,
                                    maxTokens: this.currentFlare?.maxTokens,
                                    contextWindow: this.currentFlare?.contextWindow,
                                    handoffContext: this.currentFlare?.handoffContext,
                                    isReasoningModel: this.currentFlare?.isReasoningModel,
                                    reasoningHeader: this.currentFlare?.reasoningHeader
                                });
                                
                                loadingMsg.setAttribute('data-content', fullContent.trim());
                                loadingMsg.setAttribute('data-role', 'assistant');
                            }
                        }

                        // Add to history even if aborted
                        const providerId = this.currentFlare?.provider || 'default';
                        const providerSettings = this.plugin.settings.providers[providerId];
                        const providerName = providerSettings?.name || providerId;

                        const messageData = {
                            role: 'assistant',
                            content: fullContent,
                            settings: {
                                flare: this.currentFlare?.name || 'default',
                                provider: providerName,
                                model: this.currentFlare?.model || 'default',
                                temperature: this.currentTemp ?? 0.7,
                                maxTokens: this.currentFlare?.maxTokens,
                                contextWindow: this.currentFlare?.contextWindow,
                                handoffContext: this.currentFlare?.handoffContext,
                                isReasoningModel: this.currentFlare?.isReasoningModel,
                                reasoningHeader: this.currentFlare?.reasoningHeader,
                                timestamp: parseInt(loadingMsg.getAttribute('data-timestamp') || Date.now().toString())
                            },
                            timestamp: parseInt(loadingMsg.getAttribute('data-timestamp') || Date.now().toString())
                        };

                        this.messageHistory.push(messageData);
                        await this.plugin.chatHistoryManager.addMessage(messageData);
                        loadingMsg.setAttribute('data-timestamp', messageData.timestamp.toString());
                    }

                    this.messageState.isProcessing = false;
                    
                    // Reset streaming state and button on abort
                    const sendBtn = this.containerEl.querySelector('.flare-send-button') as HTMLButtonElement;
                    if (sendBtn) {
                        this.resetSendButton(sendBtn, this.originalSendHandler);
                    }
                    
                    return true;
                }

                // Handle other errors normally
                this.messageState = {
                    isStreaming: false,
                    isProcessing: false,
                    hasError: true,
                    errorMessage: error instanceof Error ? error.message : String(error)
                };
                
                // Reset streaming state and button on error
                const sendBtn = this.containerEl.querySelector('.flare-send-button') as HTMLButtonElement;
                if (sendBtn) {
                    this.resetSendButton(sendBtn, this.originalSendHandler);
                }

                if (error instanceof Error) {
                    throw new MessageError(error.message);
                }
                throw new MessageError('Unknown error occurred while sending message');
            }
        } catch (error: unknown) {
            // Don't show error notice for AbortError
            if (error instanceof Error && error.name === 'AbortError') {
                return true;
            }
            
            this.messageState = {
                isStreaming: false,
                isProcessing: false,
                hasError: true,
                errorMessage: error instanceof Error ? error.message : String(error)
            };

            // Update the loading message to remove the loading state
            if (loadingMsg) {
                loadingMsg.removeClass('is-loading');
                const contentEl = loadingMsg.querySelector('.flare-message-content') as HTMLElement | null;
                if (contentEl) {
                    contentEl.empty();
                    // Render a simple message so actions can be accessed
                    const errorMessage = error instanceof Error ? error.message : String(error);
                    await this.renderUserOrAssistantMessage('assistant', contentEl, 
                        `Failed to generate response: ${errorMessage}`, 
                        {
                            flare: this.currentFlare?.name || 'default',
                            provider: this.currentFlare?.provider || 'default',
                            model: this.currentFlare?.model || 'default',
                            temperature: this.currentTemp ?? 0.7
                        }
                    );
                    
                    loadingMsg.setAttribute('data-content', `Failed to generate response: ${errorMessage}`);
                    loadingMsg.setAttribute('data-role', 'assistant');
                }
            }

            // Always reset streaming state and button on error
            const sendBtn = this.containerEl.querySelector('.flare-send-button') as HTMLButtonElement;
            if (sendBtn) {
                this.resetSendButton(sendBtn, this.originalSendHandler);
            }

            console.error('Error in sendMessage:', error);
            new Notice('Error: ' + getErrorMessage(error));
            return false;
        } finally {
            // Reset abort state
            this.isAborted = false;
            
            // Ensure streaming state is reset in all cases
            this.isStreaming = false;
            const sendBtn = this.containerEl.querySelector('.flare-send-button') as HTMLButtonElement;
            if (sendBtn) {
                this.resetSendButton(sendBtn, this.originalSendHandler);
            }
        }
    }

    /**
     * Handles switching between different flares
     * @param flare - The flare configuration to switch to
     * @throws {FlareConfigError} When flare switching fails
     */
    private async handleFlareSwitch(flare: FlareConfig): Promise<void> {
        // Track state for cleanup in case of error
        const originalFlare = this.currentFlare;
        const originalTemp = this.currentTemp;
        const originalPlaceholder = this.inputEl?.getAttribute('placeholder');

        try {
            // Clean up any existing event listeners
            this.eventRefs.forEach(cleanup => cleanup());
            this.eventRefs.clear();

            // Enable/disable interactions based on flare presence
            const modelControl = this.containerEl.querySelector('.flare-model-control');
            const tempControl = this.containerEl.querySelector('.flare-temp-control');
            
            if (modelControl) {
                if (flare) {
                    modelControl.classList.remove('is-disabled');
                    // Update model display
                    if (this.modelDisplayEl) {
                        this.modelDisplayEl.textContent = this.truncateModelName(flare.model);
                    }
                } else {
                    modelControl.classList.add('is-disabled');
                    if (this.modelDisplayEl) {
                        this.modelDisplayEl.textContent = '--';
                    }
                }
            }
            
            if (tempControl) {
                if (flare) {
                    tempControl.classList.remove('is-disabled');
                } else {
                    tempControl.classList.add('is-disabled');
                }
            }
            
            if (this.inputEl) {
                // Keep input enabled always to allow @flarename commands
                this.inputEl.value = '';
                // Update placeholder based on current flare
                this.inputEl.setAttribute('placeholder', flare ? `@${flare.name}` : '');
            }

            // Always update temperature to flare's default if available
            this.currentTemp = flare.temperature;
            if (this.tempDisplayEl && this.currentTemp !== undefined) {
                this.tempDisplayEl.textContent = this.currentTemp.toFixed(2);
            }

            // Add a "system" message to note that we switched flares
            const switchContent = {
                main: `@${flare.name}`,
                metadata: {
                    flare: flare.name,
                    provider: flare.provider || '', // Ensure it's not undefined
                    providerName: flare.providerName,
                    providerType: flare.providerType,
                    model: flare.model,
                    temperature: flare.temperature ?? 0.7,
                    maxTokens: flare.maxTokens,
                    contextWindow: flare.contextWindow ?? -1,
                    handoffContext: flare.handoffContext ?? -1,
                    stream: flare.stream ?? true,
                    isReasoningModel: flare.isReasoningModel,
                    reasoningHeader: flare.reasoningHeader
                }
            };

            // Only add the system message to UI, not to history
            await this.addMessage('system', JSON.stringify(switchContent), switchContent.metadata, false);

            // Set the current flare and activate flare switch mode
            this.currentFlare = flare;
            this.plugin.isFlareSwitchActive = true;

            // Reload flares to ensure list is up to date
            await this.plugin.flareManager.loadFlares();

            // Re-setup event handlers with new flare context
            this.setupEventHandlers();
        } catch (error: unknown) {
            console.error('Error handling flare switch:', error);
            const errorMessage = error instanceof Error ? error.message : String(error);
            
            // Attempt to restore previous state
            try {
                this.currentFlare = originalFlare;
                this.currentTemp = originalTemp;
                if (this.inputEl && originalPlaceholder) {
                    this.inputEl.setAttribute('placeholder', originalPlaceholder);
                }
                
                // Re-setup event handlers with original context
                this.setupEventHandlers();
                
                new Notice(`Failed to switch flare: ${errorMessage}. Restored previous state.`);
            } catch (restoreError) {
                console.error('Failed to restore previous state:', restoreError);
                new Notice(`Critical error during flare switch. Please reload the plugin.`);
            }
        }
    }

    private truncateModelName(model: string, maxLength: number = 20): string {
        if (model.length <= maxLength) return model;
        return '...' + model.slice(-maxLength);
    }

    private async addMessage(
        role: 'user' | 'assistant' | 'system', 
        content: string, 
        settings?: MessageSettings,
        addToHistoryManager: boolean = true
    ): Promise<HTMLElement | null> {
        if (!this.messagesEl) return null;

        // Create message container using Obsidian's createDiv
        const messageEl = this.messagesEl.createDiv({
            cls: `flare-message ${role}`
        });

        // Generate a single timestamp to use consistently
        const timestamp = Date.now();

        // Add accessibility attributes
        messageEl.setAttribute('role', `${role}`);
        setTooltip(messageEl, `${role} message`);
        messageEl.setAttribute('aria-live', role === 'assistant' ? 'polite' : 'off');

        // Store content and role for deletion
        messageEl.setAttribute('data-content', content.trim());
        messageEl.setAttribute('data-role', role);
        messageEl.setAttribute('data-timestamp', timestamp.toString());

        // Create message content with proper structure
        const contentEl = messageEl.createDiv('flare-message-content');

        // Only create meta and actions for non-system messages
        if (role !== 'system') {
            // Add metadata (timestamp, etc) and actions
            const metaEl = messageEl.createDiv('flare-message-meta');
            const displayTime = moment(timestamp).format('h:mm A');
            metaEl.createSpan({
                cls: 'flare-message-time',
                text: displayTime
            });

            // Add action buttons container
            const actions = metaEl.createDiv('flare-message-actions');
            this.addMessageActions(actions, messageEl, content);
        }

        // Handle system messages differently
        if (role === 'system') {
            this.renderSystemMessage(messageEl, contentEl, content);
        } else {
            // For user and assistant messages, ensure all settings are passed
            const fullSettings = {
                ...settings,
                flare: settings?.flare || this.currentFlare?.name || 'default',
                provider: settings?.provider || this.currentFlare?.provider || 'default',
                model: settings?.model || this.currentFlare?.model || 'default',
                temperature: settings?.temperature ?? this.currentTemp ?? 0.7,
                maxTokens: settings?.maxTokens || this.currentFlare?.maxTokens,
                stream: settings?.stream ?? this.currentFlare?.stream ?? true,
                contextWindow: settings?.contextWindow ?? this.currentFlare?.contextWindow ?? -1,
                handoffContext: settings?.handoffContext ?? this.currentFlare?.handoffContext ?? -1,
                isReasoningModel: settings?.isReasoningModel ?? this.currentFlare?.isReasoningModel ?? false,
                reasoningHeader: settings?.reasoningHeader ?? this.currentFlare?.reasoningHeader
            };
            await this.renderUserOrAssistantMessage(role, contentEl, content, fullSettings);
        }

        // Add to history manager if needed
        if (addToHistoryManager) {
            // Get provider's common name if available
            const providerId = settings?.provider || 'default';
            const providerSettings = this.plugin.settings.providers[providerId];
            const providerName = providerSettings?.name || providerId;

            const messageData = {
                role,
                content,
                settings: {
                    ...settings,
                    provider: providerName,  // Use common name instead of ID
                    timestamp  // Include timestamp in settings
                },
                timestamp     // Use same timestamp as main timestamp
            };
            this.messageHistory.push(messageData);
            await this.plugin.chatHistoryManager.addMessage(messageData);
        }

        // Force scroll to bottom for new messages
        this.scrollToBottom(true);

        return messageEl;
    }

    private addMessageActions(actions: HTMLElement, messageEl: HTMLElement, content: string) {
        // Add copy button
        const copyBtn = this.createActionButton(actions, 'Copy message', 'copy');
        this.registerDomEvent(copyBtn, 'click', async () => {
            try {
                // Get the message container and data
                const container = messageEl.querySelector('.flare-message-content') as HTMLElement | null;
                if (!container) {
                    throw new Error('Message content container not found');
                }

                // Get the message settings that might contain original content
                const messageId = messageEl.getAttribute('data-message-id');
                const timestamp = messageEl.getAttribute('data-timestamp');
                
                // Find the message in history to get its original markdown content
                let textToCopy = '';
                
                // Try to get the raw markdown content from message attributes or history
                if (timestamp) {
                    // Look for the message in the history using timestamp
                    const messageIndex = this.messageHistory.findIndex(
                        msg => msg.timestamp?.toString() === timestamp
                    );
                    
                    if (messageIndex !== -1) {
                        const historyMsg = this.messageHistory[messageIndex];
                        
                        // Use original content if available (with wikilinks), otherwise use stored content
                        if (historyMsg.settings?.originalContent) {
                            textToCopy = historyMsg.settings.originalContent;
                        } else {
                            textToCopy = historyMsg.content;
                        }
                        
                        // Handle reasoning blocks appropriately if reasoning is collapsed
                        if (historyMsg.settings?.isReasoningModel && historyMsg.role === 'assistant') {
                            const reasoningHeader = historyMsg.settings.reasoningHeader || '<think>';
                            const reasoningContainer = container.querySelector('.flare-reasoning-content') as HTMLElement | null;
                            
                            // Only exclude reasoning if it's collapsed
                            if (reasoningContainer && !reasoningContainer.classList.contains('is-expanded')) {
                                // Self-contained reasoning extraction without using class method
                                const header = this.escapeRegexSpecials(reasoningHeader);
                                const pattern = new RegExp(`${header}\\s*([\\s\\S]*?)${header}`, 'g');
                                const matches = [...textToCopy.matchAll(pattern)];
                                
                                if (matches.length) {
                                    // Remove all reasoning blocks, leaving only the response
                                    textToCopy = textToCopy.replace(pattern, '').trim();
                                }
                            }
                        }
                    }
                }
                
                // If we couldn't find message in history, fallback to the content passed to this method
                if (!textToCopy && content) {
                    textToCopy = content;
                }
                
                // If still no content, use the displayed text as last resort
                if (!textToCopy) {
                    console.warn('Could not find original markdown, falling back to rendered content');
                    
                    // Initialize text to copy
                    let fallbackText = '';
                    
                    // Check if this is an assistant message with reasoning
                    const reasoningContainer = container.querySelector('.flare-reasoning-content') as HTMLElement | null;
                    const responseContainer = container.querySelector('.flare-response-content') as HTMLElement | null;
                    
                    // If we have reasoning content and it's expanded, include it
                    if (reasoningContainer && reasoningContainer.classList.contains('is-expanded')) {
                        fallbackText += reasoningContainer.innerText.trim() + '\n\n';
                    }
                    
                    // Add response content if it exists
                    if (responseContainer) {
                        fallbackText += responseContainer.innerText.trim();
                    } else {
                        // For regular messages without reasoning/response split
                        const markdownContainer = container.querySelector('.flare-markdown-content') as HTMLElement | null;
                        if (markdownContainer) {
                            fallbackText = markdownContainer.innerText.trim();
                        }
                    }
                    
                    // If we still don't have text, fall back to the entire container
                    if (!fallbackText) {
                        fallbackText = container.innerText.trim();
                    }
                    
                    textToCopy = fallbackText;
                }
                
                // Normalize line breaks (ensure we don't have excessive empty lines)
                textToCopy = textToCopy
                    .replace(/\n{3,}/g, '\n\n')  // Replace 3+ line breaks with 2
                    .trim();

                // Check if we have a secure context (https or localhost)
                if (navigator.clipboard && window.isSecureContext) {
                    await navigator.clipboard.writeText(textToCopy);
                    new Notice('Message copied to clipboard');
                } else {
                    // Fallback for non-secure contexts
                    const textarea = document.createElement('textarea');
                    textarea.value = textToCopy;
                    textarea.style.position = 'absolute';
                    textarea.style.left = '-9999px';
                    textarea.style.top = '0';
                    textarea.style.whiteSpace = 'pre';
                    textarea.setAttribute('readonly', '');
                    document.body.appendChild(textarea);
                    try {
                        textarea.select();
                        textarea.setSelectionRange(0, textarea.value.length);
                        const success = document.execCommand('copy');
                        if (success) {
                            new Notice('Message copied to clipboard');
                        } else {
                            throw new Error('Copy command failed');
                        }
                    } finally {
                        document.body.removeChild(textarea);
                    }
                }
            } catch (error) {
                console.error('Failed to copy message:', error);
                new Notice('Failed to copy message to clipboard');
            }
        });
        
        // Add delete button
        const deleteBtn = this.createActionButton(actions, 'Delete message', 'trash-2', 'delete');
        this.registerDomEvent(deleteBtn, 'click', async () => {
            await this.deleteMessage(messageEl);
        });
    }

    private createActionButton(
        parent: HTMLElement,
        tooltip: string,
        iconName: string,
        additionalClass?: string
    ): HTMLElement {
        const btn = parent.createEl('button', {
            cls: `flare-action-button${additionalClass ? ' ' + additionalClass : ''}`,
            attr: { 
                'role': 'button',
                'tabindex': '0'
            }
        });
        setIcon(btn, iconName);
        setTooltip(btn, tooltip);
        return btn;
    }

    private async deleteMessage(messageEl: HTMLElement) {
        // Traverse upward to find the container with the data-timestamp attribute
        let container: HTMLElement | null = messageEl;
        while (container && !container.hasAttribute('data-timestamp')) {
            container = container.parentElement;
        }
        if (!container) {
            console.debug('No container with data-timestamp found');
            return;
        }

        const timestampAttr = container.getAttribute('data-timestamp');
        const role = container.getAttribute('data-role');
        const content = container.getAttribute('data-content');
        
        if (!timestampAttr) {
            console.debug('No timestamp attribute found');
            return;
        }

        console.debug('Deleting message:', { 
            timestamp: timestampAttr,
            role,
            content: content?.substring(0, 50) + '...'
        });

        // Remove from UI with animation
        container.classList.add('deleting');
        await new Promise(resolve => setTimeout(resolve, 300));
        container.remove();

        // Convert timestamp to number for exact matching
        const timestamp = parseInt(timestampAttr, 10);
        
        // Remove from in-memory history
        const beforeMemoryCount = this.messageHistory.length;
        this.messageHistory = this.messageHistory.filter((m: { 
            timestamp?: number; 
            settings?: { timestamp?: number } 
        }) => {
            const mainMatch = m.timestamp !== timestamp;
            const settingsMatch = m.settings?.timestamp !== timestamp;
            return mainMatch && settingsMatch;
        });
        console.debug('Memory history update:', {
            beforeCount: beforeMemoryCount,
            afterCount: this.messageHistory.length,
            removed: beforeMemoryCount - this.messageHistory.length
        });

        // Update the history note
        const history = this.plugin.chatHistoryManager.getCurrentHistory();
        if (history) {
            const beforeHistoryCount = history.messages.length;
            history.messages = history.messages.filter((m: { 
                timestamp?: number; 
                settings?: { timestamp?: number } 
            }) => {
                const mainMatch = m.timestamp !== timestamp;
                const settingsMatch = m.settings?.timestamp !== timestamp;
                return mainMatch && settingsMatch;
            });
            
            console.debug('History note update:', {
                beforeCount: beforeHistoryCount,
                afterCount: history.messages.length,
                removed: beforeHistoryCount - history.messages.length
            });

            if (beforeHistoryCount !== history.messages.length) {
                history.lastModified = Date.now();
                // Force an immediate save of the history note
                try {
                    await this.plugin.chatHistoryManager.saveCurrentHistory(true, false);  // Force save but don't show notice
                    console.debug('History note saved immediately after deletion');
                } catch (error) {
                    console.error('Failed to save history note:', error);
                    new Notice('Failed to save changes to history');
                }
            } else {
                console.debug('No messages removed from history note');
            }
        } else {
            console.debug('No current history found');
        }
    }

    private renderSystemMessage(messageEl: HTMLElement, contentEl: HTMLElement, content: string) {
        messageEl.classList.remove('flare-message');
        messageEl.classList.add('flare-system-message');
        
        try {
            const switchContent = JSON.parse(content);
            const mainText = contentEl.createDiv('flare-system-main');
            
            // If it's a temperature message
            if (switchContent.metadata?.type === 'temperature') {
                const tempDisplay = mainText.createSpan('flare-name');
                const tempIcon = tempDisplay.createSpan();
                setIcon(tempIcon, 'thermometer');
                tempDisplay.createSpan().textContent = switchContent.main;
            } 
            // If it's an export message
            else if (switchContent.metadata?.type === 'export') {
                const exportInfo = mainText.createSpan('flare-name');
                exportInfo.classList.add('flare-export-link');
                const exportIcon = exportInfo.createSpan();
                setIcon(exportIcon, 'download');
                exportInfo.createSpan().textContent = switchContent.main;
                
                // Make the message clickable to open the exported file
                if (switchContent.metadata?.path) {
                    setTooltip(exportInfo, 'Click to open exported file');
                    
                    this.registerDomEvent(exportInfo, 'click', () => {
                        const file = this.app.vault.getAbstractFileByPath(switchContent.metadata.path);
                        if (file && file instanceof TFile) {
                            this.app.workspace.getLeaf(true).openFile(file);
                        } else {
                            new Notice('Could not find exported file');
                        }
                    });
                    
                    // Add cursor style via CSS class instead of inline style
                    exportInfo.classList.add('clickable');
                }
            }
            // Otherwise it's a flare switch message
            else {
                const flareName = mainText.createSpan('flare-name');
                const flameIcon = flareName.createSpan();
                setIcon(flameIcon, 'flame');
                flareName.createSpan().textContent = switchContent.main;
                
                // Get metadata directly from the content
                const metadata = this.getFlareMetadata(switchContent.metadata);
                
                // Setup click handler for metadata display
                this.setupTooltipHandlers(flareName, metadata);
            }
        } catch (error) {
            console.error('Error parsing system message:', error);
            contentEl.textContent = content;
        }
    }

    /**
     * Renders user or assistant messages with appropriate styling and content
     * @param role The message role ('user' or 'assistant')
     * @param contentEl The container element to render the message into
     * @param content The message content
     * @param settings Message settings including flare, model, etc.
     */
    private async renderUserOrAssistantMessage(
        role: 'user' | 'assistant',
        contentEl: HTMLElement,
        content: string,
        settings?: MessageSettings
    ): Promise<void> {
        const contentWrapper = contentEl.createDiv({ 
            cls: 'flare-content-wrapper',
            attr: { 'role': 'presentation' }
        });

        // Add flare info for assistant messages
        if (role === 'assistant') {
            const mainText = contentWrapper.createDiv({ 
                cls: 'flare-system-main',
                attr: { 'role': 'presentation' }
            });
            
            const flareName = mainText.createEl('button', {
                cls: 'flare-name',
                attr: {
                    'tabindex': '0'
                }
            });
            
            const flameIcon = flareName.createSpan();
            setIcon(flameIcon, 'flame');
            flareName.createSpan({ text: `@${settings?.flare || 'default'}` });
            setTooltip(flareName, `Flare: ${settings?.flare || 'default'}`);
            
            // Get metadata and setup click handler
            const metadata = this.getFlareMetadata(settings);
            this.setupTooltipHandlers(flareName, metadata);
        }

        // Create markdown container for the actual message content
        const markdownContainer = contentWrapper.createDiv({ 
            cls: 'flare-markdown-content',
            attr: { 'role': 'presentation' }
        });
        
        if (role === 'assistant' && settings?.isReasoningModel) {
            // Always extract reasoning blocks from content
            const extraction = this.extractReasoningContent(
                content,
                settings.reasoningHeader || '<think>'
            );
            const reasoningBlocks = extraction.reasoningBlocks;
            const responsePart = extraction.responsePart;

            // Create reasoning container if we have reasoning blocks
            if (reasoningBlocks.length > 0) {
                const reasoningContainer = markdownContainer.createDiv({ 
                    cls: 'flare-reasoning-content',
                    attr: {
                        'role': 'region',
                        'aria-expanded': 'false'
                    }
                });
                
                setTooltip(reasoningContainer, 'AI reasoning');

                // Create container for rendered content but don't render yet
                reasoningContainer.createDiv('markdown-rendered');

                // Add reasoning toggle button
                const actions = contentEl.closest('.flare-message')?.querySelector('.flare-message-actions');
                if (actions instanceof HTMLElement) {
                    const messageId = contentEl.closest('.flare-message')?.getAttribute('data-message-id') || `message-${Date.now()}`;
                    contentEl.closest('.flare-message')?.setAttribute('data-message-id', messageId);

                    const expandBtn = this.createActionButton(actions, 'Toggle reasoning', 'plus-circle');
                    this.registerDomEvent(expandBtn, 'click', async () => {
                        const timestamp = contentEl.closest('.flare-message')?.getAttribute('data-timestamp');
                        if (!timestamp) return;

                        const isExpanded = this.expandedReasoningMessages.has(timestamp);
                        if (isExpanded) {
                            this.expandedReasoningMessages.delete(timestamp);
                            reasoningContainer.removeClass('is-expanded');
                            expandBtn.removeClass('is-active');
                            setIcon(expandBtn, 'plus-circle');
                            // Clear content when collapsing
                            const rendered = reasoningContainer.querySelector('.markdown-rendered');
                            if (rendered instanceof HTMLElement) rendered.empty();
                        } else {
                            // Render content when expanding
                            const rendered = reasoningContainer.querySelector('.markdown-rendered');
                            if (rendered instanceof HTMLElement) {
                                const joinedReasoning = reasoningBlocks.join('\n\n---\n\n');
                                const currentFile = this.plugin.chatHistoryManager.getCurrentFile();
                                await MarkdownRenderer.render(
                                    this.app,
                                    joinedReasoning,
                                    rendered,
                                    currentFile?.path || '',
                                    this
                                );
                            }
                            this.expandedReasoningMessages.add(timestamp);
                            reasoningContainer.addClass('is-expanded');
                            expandBtn.addClass('is-active');
                            setIcon(expandBtn, 'minus-circle');
                        }
                    });
                }
            }

            // Create and render response container
            const responseContainer = markdownContainer.createDiv('flare-response-content');
            responseContainer.setAttribute('role', 'region');
            if (responsePart.trim()) {
                const currentFile = this.plugin.chatHistoryManager.getCurrentFile();
                await MarkdownRenderer.render(
                    this.app,
                    responsePart.trim(),
                    responseContainer,
                    currentFile?.path || '',
                    this
                );
            }
        } else {
            // For non-reasoning messages, render normally
            const rendered = markdownContainer.createDiv('markdown-rendered');
            rendered.setAttribute('role', 'presentation');
            if (content) {
                // Use original content for display if available
                const displayContent = settings?.originalContent || content;
                
                // Get current file for source path
                const currentFile = this.plugin.chatHistoryManager.getCurrentFile();
                const sourcePath = currentFile?.path || '';

                try {
                    // Render directly using MarkdownRenderer.render
                    await MarkdownRenderer.render(
                        this.app,
                        displayContent,
                        rendered,
                        sourcePath,
                        this
                    );

                    // Add click handlers to any internal links
                    const wikilinks = rendered.querySelectorAll('.internal-link');
                    wikilinks.forEach(link => {
                        if (link instanceof HTMLElement) {
                            this.registerDomEvent(link, 'click', async (e) => {
                                e.preventDefault();
                                const linkText = link.getAttr('data-href');
                                if (linkText) {
                                    await this.app.workspace.openLinkText(
                                        linkText,
                                        sourcePath,  // Pass the source path
                                        true  // Open in new leaf
                                    );
                                }
                            });
                        }
                    });
                } catch (error) {
                    console.error('Error rendering markdown:', error);
                }
            }
        }
    }

    private extractReasoningContent(content: string, reasoningHeader: string): {
        reasoningBlocks: string[];
        responsePart: string;
    } {
        // Ensure we have valid content and header
        if (!content || !reasoningHeader) {
            return { reasoningBlocks: [], responsePart: content || '' };
        }
        
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
                const block = match[1].trim();
                reasoningBlocks.push(block);
            }
            // Remove this reasoning block from response
            responsePart = responsePart.replace(match[0], '').trim();
        }

        // If no reasoning blocks found but content contains ---\n\n, try legacy format
        if (reasoningBlocks.length === 0 && content.includes('---\n\n')) {
            const blocks = content.split(/\n\n---\n\n/);
            // Last block is response, all others are reasoning
            responsePart = blocks.pop() || '';
            reasoningBlocks.push(...blocks.map(block => block.trim()));
        }

        return { reasoningBlocks, responsePart };
    }

    private isNearBottom(): boolean {
        if (!this.messagesEl) return true;
        return this.messagesEl.scrollHeight - this.messagesEl.scrollTop - this.messagesEl.clientHeight <= CONSTANTS.SCROLL_THRESHOLD;
    }

    private scrollToBottom(force: boolean = false) {
        if (!this.messagesEl) return;
        
        // Always scroll if forced, otherwise only scroll if we're near the bottom
        if (force || this.isNearBottom()) {
            // Use smooth scrolling except when forced (for performance)
            this.messagesEl.scrollTo({
                top: this.messagesEl.scrollHeight,
                behavior: force ? 'auto' : 'smooth'
            });
        }
    }

    private getFlareMetadata(settings?: PartialMessageSettings): Record<string, string> {
        const metadata: Record<string, string> = {};
        
        if (!settings) return metadata;

        // Add flare name if present
        if (settings.flare) {
            metadata['Flare'] = settings.flare;
        }

        // Add provider if present, using the common name
        if (settings.provider) {
            const providerSettings = this.plugin.settings.providers[settings.provider];
            metadata['Provider'] = providerSettings?.name || settings.provider;
        }

        // Add model if present
        if (settings.model) {
            metadata['Model'] = this.truncateModelName(settings.model);
        }

        // Add temperature if present
        if (typeof settings.temperature === 'number') {
            metadata['Temperature'] = settings.temperature.toFixed(2);
        }

        // Add max tokens if present
        if (settings.maxTokens) {
            metadata['Max Tokens'] = settings.maxTokens.toString();
        }

        // Add context window with tooltip
        if (typeof settings.contextWindow === 'number') {
            metadata['Context Window'] = `${settings.contextWindow.toString()} pairs${settings.contextWindow === -1 ? ' (all)' : ''}`;
        }

        // Add handoff context with tooltip
        if (typeof settings.handoffContext === 'number') {
            metadata['Handoff Context'] = `${settings.handoffContext.toString()} pairs${settings.handoffContext === -1 ? ' (all)' : ''}`;
        }

        // Add stream setting if present
        if (typeof settings.stream === 'boolean') {
            metadata['Streaming'] = settings.stream ? 'Yes' : 'No';
        }

        // Add reasoning info if present
        if (settings.isReasoningModel) {
            metadata['Reasoning'] = 'Enabled';
            if (settings.reasoningHeader) {
                metadata['Reasoning Tag'] = settings.reasoningHeader;
            }
        }

        return metadata;
    }

    private escapeRegexSpecials(str: string): string {
        return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    }

    private async handleError(error: unknown, context: string): Promise<void> {
        let errorToThrow: Error;
        
        if (error instanceof FlareError) {
            errorToThrow = error;
        } else if (error instanceof Error) {
            switch (context) {
                case 'message':
                    errorToThrow = new MessageError(error.message);
                    break;
                case 'flare':
                    errorToThrow = new FlareConfigError(error.message);
                    break;
                case 'provider':
                    errorToThrow = new ProviderError(error.message);
                    break;
                default:
                    errorToThrow = new FlareError('An unknown error occurred', 'UNKNOWN_ERROR');
            }
        } else {
            errorToThrow = new FlareError('An unknown error occurred', 'UNKNOWN_ERROR');
        }

        console.error(`Error in ${context}:`, error);
        new Notice(`Error: ${errorToThrow.message}`);
        
        this.messageState = {
            isStreaming: false,
            isProcessing: false,
            hasError: true,
            errorMessage: errorToThrow.message
        };

        throw errorToThrow;
    }

    /**
     * Checks if content needs markdown rendering
     * @param content - The content to check
     * @returns boolean - Whether content needs markdown rendering
     */
    private needsMarkdownRendering(content: string): boolean {
        return content.match(/^(\s*)(```|>|\d+\.|[*-]\s|#)/) !== null || content.includes('\n');
    }

    /**
     * Cleans up unnecessary paragraph wrapping from rendered markdown
     * @param rendered - The rendered markdown element
     */
    private cleanupParagraphWrapping(rendered: HTMLElement) {
        const paragraphs = rendered.querySelectorAll('p');
        paragraphs.forEach(p => {
            if (!p.querySelector('pre, blockquote, ul, ol')) {
                const children = Array.from(p.childNodes);
                p.replaceWith(...children);
            }
        });
    }

    /**
     * Updates the layout based on container size
     */
    private updateLayout() {
        const width = this.containerEl.offsetWidth;
        const isMobile = Platform.isMobile;
        this.containerEl.classList.toggle('is-mobile', isMobile);
        this.updateSuggestionsPosition();
    }

    /**
     * Sets up accessibility features
     */
    private setupAccessibility() {
        // Add keyboard navigation
        this.registerDomEvent(this.containerEl, 'keydown', ((e: Event) => {
            if (!(e instanceof KeyboardEvent)) return;
            if (e.key === 'Escape') {
                this.closeAllMenus();
            }
        }) as EventListener);

        // Add touch feedback
        this.containerEl.querySelectorAll('.clickable').forEach(element => {
            if (element instanceof HTMLElement) {
                this.addTouchFeedback(element);
            }
        });
    }

    /**
     * Adds touch feedback to an element
     */
    private addTouchFeedback(element: HTMLElement) {
        this.registerDomEvent(
            element, 
            'touchstart', 
            (() => element.classList.add('is-touching')) as EventListener,
            { passive: true }
        );

        this.registerDomEvent(
            element, 
            'touchend', 
            (() => element.classList.remove('is-touching')) as EventListener,
            { passive: true }
        );
    }

    /**
     * Retries an operation with exponential backoff
     */
    private async retryOperation<T>(
        operation: () => Promise<T>,
        options: OperationOptions = {}
    ): Promise<T> {
        const { timeout = 30000, retries = 3, backoff = true } = options;

        for (let i = 0; i < retries; i++) {
            try {
                return await this.makeRequest(operation(), timeout);
            } catch (error) {
                if (i === retries - 1) throw error;
                if (backoff) {
                    await new Promise(resolve => 
                        setTimeout(resolve, 1000 * Math.pow(2, i))
                    );
                }
            }
        }
        throw new Error('Operation failed after retries');
    }

    /**
     * Makes a request with timeout
     */
    private async makeRequest<T>(
        promise: Promise<T>, 
        timeout: number
    ): Promise<T> {
        const timeoutPromise = new Promise<never>((_, reject) => 
            setTimeout(() => reject(new Error('Request timed out')), timeout)
        );
        return Promise.race([promise, timeoutPromise]);
    }

    /**
     * Updates the view state and triggers UI update
     */
    private updateViewState(state: Partial<ViewState>) {
        this.viewState = { ...this.viewState, ...state };
        this.saveViewState();
        this.updateUI();
    }

    /**
     * Saves view state to plugin data
     */
    private async saveViewState() {
        try {
            const state = {
                ...this.viewState,
                expandedMessages: Array.from(this.viewState.expandedMessages),
                lastSavedTimestamp: Date.now()
            };
            await this.plugin.saveData(state);
        } catch (error) {
            console.error('Error saving view state:', error);
        }
    }

    /**
     * Loads view state from plugin data
     */
    private async loadViewState() {
        try {
            const saved = await this.plugin.loadData();
            if (saved) {
                this.viewState = {
                    ...this.viewState,
                    ...saved,
                    expandedMessages: new Set(saved.expandedMessages)
                };
                this.updateUI();
            }
        } catch (error) {
            console.error('Error loading view state:', error);
        }
    }

    /**
     * Updates UI based on current state
     */
    private updateUI() {
        // Update streaming state
        this.containerEl.classList.toggle('is-streaming', this.viewState.isStreaming);
        this.containerEl.classList.toggle('is-processing', this.viewState.isProcessing);
        this.containerEl.classList.toggle('has-error', this.viewState.hasError);

        // Update expanded messages
        this.viewState.expandedMessages.forEach(timestamp => {
            const messageEl = this.containerEl.querySelector(`[data-timestamp="${timestamp}"]`);
            if (messageEl) {
                const reasoningContent = messageEl.querySelector('.flare-reasoning-content');
                const toggleBtn = messageEl.querySelector('.flare-message-actions button.toggle-reasoning');
                
                if (reasoningContent instanceof HTMLElement) {
                    reasoningContent.classList.toggle('is-expanded', this.expandedReasoningMessages.has(timestamp));
                }
                
                if (toggleBtn instanceof HTMLElement) {
                    toggleBtn.classList.toggle('is-active', this.expandedReasoningMessages.has(timestamp));
                    setIcon(toggleBtn, this.expandedReasoningMessages.has(timestamp) ? 'minus-circle' : 'plus-circle');
                }
            }
        });

        // Update temperature display
        if (this.tempDisplayEl) {
            const temp = this.viewState.currentTemp;
            this.tempDisplayEl.textContent = temp !== undefined ? temp.toFixed(2) : '--';
        }
    }

    /**
     * Closes all open menus
     */
    private closeAllMenus() {
        this.hideSuggestions();
        this.containerEl.querySelectorAll('.is-active').forEach(el => {
            if (el instanceof HTMLElement) {
                el.removeClass('is-active');
            }
        });
    }

    private handleInput(e: Event) {
        if (!(e.target instanceof HTMLTextAreaElement)) return;
        
        // Use debounced height update for smoother experience
        this.debouncedHeightUpdate();
        
        const input = e.target.value;
        const cursorPosition = e.target.selectionStart || 0;
        
        // Check for wikilink trigger
        const beforeCursor = input.slice(0, cursorPosition);
        const lastTwoChars = beforeCursor.slice(-2);
        if (lastTwoChars === '[[') {
            // Open note suggestion modal
            const modal = new NoteLinkSuggestModal(
                this.app,
                this.inputEl,
                (file: TFile) => {
                    // Insert the selected file as a wikilink
                    const afterCursor = input.slice(cursorPosition);
                    const newValue = beforeCursor + file.basename + ']]' + afterCursor;
                    this.inputEl.value = newValue;
                    // Set cursor position after the inserted wikilink
                    const newCursorPosition = cursorPosition + file.basename.length + 2;
                    this.inputEl.setSelectionRange(newCursorPosition, newCursorPosition);
                    // Update height for the new content
                    this.debouncedHeightUpdate();
                }
            );
            modal.open();
        }
        
        // Check for flare suggestions
        const isAtStart = beforeCursor.trim() === beforeCursor && beforeCursor.startsWith('@');
        if (isAtStart) {
            const searchTerm = beforeCursor.slice(1); // Remove the @ symbol
            this.updateFlareSuggestions(searchTerm);
        } else {
            this.hideSuggestions();
        }
    }

    private handleGlobalClick(e: MouseEvent) {
        const suggestionContainer = this.containerEl.querySelector('.flare-suggestions');
        if (suggestionContainer && 
            !suggestionContainer.contains(e.target as Node) && 
            !this.inputEl.contains(e.target as Node)) {
            this.hideSuggestions();
        }
    }

    private initializeObservers() {
        // Add ResizeObserver
        if (this.resizeObserver) {
            this.resizeObserver.observe(this.containerEl);
        }
    }

    private async insertFlareSuggestion(index: number) {
        const suggestions = this.containerEl.querySelectorAll('.flare-suggestion-item');
        if (index < 0 || index >= suggestions.length) return;

        const selectedItem = suggestions[index] as HTMLElement;
        const flareName = selectedItem.querySelector('.suggestion-name')?.textContent;
        if (!flareName || !this.inputEl) return;

        // Get cursor position and input value
        const cursorPosition = this.inputEl.selectionStart || 0;
        const input = this.inputEl.value;
        
        // Find the @ symbol before the cursor
        const beforeCursor = input.slice(0, cursorPosition);
        const atIndex = beforeCursor.lastIndexOf('@');
        
        if (atIndex !== -1) {
            // Replace the text from @ to cursor with the flare name and add a space
            const newValue = input.slice(0, atIndex) + '@' + flareName + ' ' + input.slice(cursorPosition);
            this.inputEl.value = newValue;
            
            // Set cursor position after the flare name and space
            const newCursorPosition = atIndex + flareName.length + 2; // +2 for @ and space
            this.inputEl.setSelectionRange(newCursorPosition, newCursorPosition);
            
            // Update input height if needed
            this.debouncedHeightUpdate();
        }
        
        // Hide suggestions after inserting
        this.hideSuggestions();
    }

    /**
     * Refreshes provider settings in the view
     * Called when provider settings change to update the UI and state
     */
    async refreshProviderSettings(): Promise<void> {
        try {
            // If we have a current flare, reload it to ensure it has the latest provider info
            if (this.currentFlare) {
                const flareName = this.currentFlare.name;
                console.log(`Refreshing flare ${flareName} due to provider changes`);
                
                // Reload the flare config
                const updatedFlare = await this.plugin.flareManager.debouncedLoadFlare(flareName);
                
                if (updatedFlare) {
                    // Update the current flare with the refreshed settings
                    this.currentFlare = updatedFlare;
                    
                    try {
                        // Try to get the provider using the new provider info
                        const provider = await this.plugin.getProviderByNameAndType(
                            updatedFlare.providerName,
                            updatedFlare.providerType
                        );
                        
                        if (provider) {
                            // Update model display
                            if (this.modelDisplayEl) {
                                this.modelDisplayEl.textContent = this.truncateModelName(updatedFlare.model);
                            }
                            
                            // Update model control state
                            const modelControl = this.containerEl.querySelector('.flare-model-control');
                            if (modelControl instanceof HTMLElement) {
                                modelControl.classList.remove('is-disabled');
                                
                                // Reload the models dropdown if it exists and is open
                                const modelSelector = this.containerEl.querySelector('.flare-model-selector');
                                if (modelSelector && modelSelector.classList.contains('is-open')) {
                                    // Close and reopen to refresh the models list
                                    modelSelector.classList.remove('is-open');
                                    
                                    // Add a small delay before reopening to ensure all data is loaded
                                    setTimeout(() => {
                                        if (modelSelector) {
                                            modelSelector.classList.add('is-open');
                                        }
                                    }, 500);
                                }
                            }
                            
                            // Show a success notification
                            new Notice(`Provider settings updated for flare "${flareName}"`);
                        }
                    } catch (error) {
                        console.warn(`Could not find provider for refreshed flare ${flareName}:`, error);
                    }
                } else {
                    console.error(`Failed to reload flare ${flareName}`);
                }
            }

            // Update temperature display
            this.updateTempDisplay();

            // Update view state
            this.updateViewState({
                isStreaming: false,
                isProcessing: false,
                hasError: false,
                errorMessage: ''
            });
        } catch (error) {
            console.error('Failed to refresh provider settings:', error);
            this.updateViewState({
                hasError: true,
                errorMessage: error instanceof Error ? error.message : 'Failed to refresh provider settings'
            });
        }
    }

    private async handleMessage(content: string): Promise<boolean> {
        try {
            // If the message starts with '@', treat it as a possible flare switch command.
            if (content.startsWith('@')) {
                const parsed = this.plugin.parseMessageForFlare(content);
                // If the parsed flare is different from the currently active flare, switch to it case-insensitively.
                const currentFlareName = this.currentFlare ? this.currentFlare.name : (this.plugin.settings.defaultFlare || 'default');
                if (parsed.flare.toLowerCase() !== currentFlareName.toLowerCase()) {
                    // Lookup available flares for proper casing
                    const availableFlares = await this.plugin.flareManager.loadFlares();
                    const matchedFlare = availableFlares.find((f: FlareConfig) => f.name.toLowerCase() === parsed.flare.toLowerCase());
                    if (matchedFlare) {
                        const newFlareConfig = await this.plugin.flareManager.debouncedLoadFlare(matchedFlare.name);
                        if (newFlareConfig) {
                            await this.handleFlareSwitch(newFlareConfig);
                            // If there's no additional message content, we're done.
                            if (!parsed.content.trim()) {
                                return true;
                            }
                            // Otherwise, update content with the remainder of the user's input.
                            content = parsed.content;
                        } else {
                            new Notice(`Flare "${parsed.flare}" does not exist. Please create it first.`);
                            return false;
                        }
                    } else {
                        new Notice(`Flare "${parsed.flare}" does not exist. Please create it first.`);
                        return false;
                    }
                }
            }

            // Check for export command
            if (content.startsWith('/export')) {
                return await this.handleExportCommand();
            }
            
            // Check for temperature command
            if (content.startsWith('/t ')) {
                try {
                    const tempStr = content.substring(3).trim();
                    const newTemp = parseFloat(tempStr);
                    
                    // Clear input field immediately with proper CSS classes
                    if (this.inputEl instanceof HTMLTextAreaElement) {
                        this.inputEl.value = '';
                        this.inputEl.removeClass('has-content', 'has-custom-height');
                        this.inputEl.removeAttribute('data-content-height');
                        
                        // Reset wrapper using CSS classes
                        const wrapper = this.inputEl.closest('.flare-input-wrapper');
                        if (wrapper instanceof HTMLElement) {
                            wrapper.removeClass('has-content');
                        }
                    }

                    // Validate temperature value
                    if (isNaN(newTemp)) {
                        throw new Error('Please provide a valid number');
                    }
                    
                    if (newTemp < 0 || newTemp > 2) {
                        throw new Error('Temperature must be between 0 and 2');
                    }

                    // Update temperature and UI
                    this.currentTemp = newTemp;
                    this.updateTempDisplay();
                    new Notice(`Temperature set to ${newTemp.toFixed(2)}`);
                    return true;
                } catch (error) {
                    new Notice(`Invalid temperature: ${error instanceof Error ? error.message : 'Unknown error'}`);
                    return false;
                }
            }
            
            // Check for title command
            if (content === '/title') {
                // Clear input field immediately with CSS classes
                if (this.inputEl) {
                    this.inputEl.value = '';
                    this.inputEl.removeClass('has-content', 'has-custom-height');
                    this.inputEl.removeAttribute('data-content-height');
                    
                    // Reset wrapper using CSS classes
                    const wrapper = this.inputEl.closest('.flare-input-wrapper');
                    if (wrapper instanceof HTMLElement) {
                        wrapper.removeClass('has-content');
                    }
                }
                // Run title generation in the background
                this.handleTitleGeneration().catch(error => {
                    console.error('Failed to generate title:', error);
                    new Notice('Failed to generate title');
                });
                return true;
            }

            // At this point, this.currentFlare should be set via handleFlareSwitch.
            if (!this.currentFlare) {
                new Notice('Please select a flare first');
                return false;
            }

            // Process message normally
            try {
                // Create new history if this is the first message
                if (!this.plugin.chatHistoryManager.getCurrentHistory()) {
                    const history = await this.plugin.chatHistoryManager.createNewHistory();
                    // Update toolbar title immediately
                    if (history) {
                        const titleEl = this.containerEl.querySelector('.flare-toolbar-center h2');
                        if (titleEl instanceof HTMLElement) {
                            titleEl.textContent = history.title;
                        }
                    }
                }

                const success = await this.sendMessage(content, {
                    stream: this.currentFlare?.stream ?? false,
                    isFlareSwitch: this.plugin.isFlareSwitchActive
                });

                // Check for auto-title generation after successful message
                if (success && !this.hasAutoGeneratedTitle) {
                    const settings = this.plugin.settings.titleSettings;
                    if (settings.autoGenerate) {
                        const pairs = this.countMessagePairs();
                        if (pairs >= settings.autoGenerateAfterPairs) {
                            this.hasAutoGeneratedTitle = true;  // Set flag before generating to prevent multiple attempts
                            await this.handleTitleGeneration().catch(error => {
                                console.error('Failed to auto-generate title:', error);
                            });
                        }
                    }
                }

                // Reset input field with CSS classes after sending
                if (success && this.inputEl) {
                    this.resetInputField();
                }

                // Reset flare switch flag after message is sent
                this.plugin.isFlareSwitchActive = false;

                return success;
            } catch (error: unknown) {
                console.error('Error processing message:', error);
                new Notice('Error: ' + getErrorMessage(error));
                return false;
            }
        } catch (error: unknown) {
            console.error('Error in handleMessage:', error);
            new Notice('Error: ' + getErrorMessage(error));
            return false;
        }
    }

    /**
     * Handles the /export command
     * @returns Promise<boolean> Success status
     */
    private async handleExportCommand(): Promise<boolean> {
        // Clear input field with CSS classes
        if (this.inputEl) {
            this.inputEl.value = '';
            this.inputEl.removeClass('has-content', 'has-custom-height');
            this.inputEl.removeAttribute('data-content-height');
            
            // Reset wrapper using CSS classes
            const wrapper = this.inputEl.closest('.flare-input-wrapper');
            if (wrapper instanceof HTMLElement) {
                wrapper.removeClass('has-content');
            }
        }

        try {
            // Check if we have a current history
            if (!this.plugin.chatHistoryManager.getCurrentHistory() || 
                this.plugin.chatHistoryManager.getCurrentHistory()?.messages.length === 0) {
                new Notice('No chat history to export');
                return false;
            }

            // Make sure current history is saved
            await this.plugin.chatHistoryManager.saveCurrentHistory(true, false);

            // Export history
            const exportedFile = await this.plugin.chatHistoryManager.exportHistory();
            
            // Add success message
            new Notice(`Chat exported to ${exportedFile.path}`);

            // Add system message about export
            const exportMessage = {
                main: `Chat exported to ${exportedFile.path}`,
                metadata: {
                    type: 'export',
                    path: exportedFile.path,
                    // Add required properties for MessageSettings interface
                    provider: this.currentFlare?.provider || 'default',
                    model: this.currentFlare?.model || 'default',
                    temperature: this.currentTemp ?? 0.7
                }
            };

            // Add system message to show export confirmation
            await this.addMessage('system', JSON.stringify(exportMessage), exportMessage.metadata, false);

            return true;
        } catch (error: unknown) {
            console.error('Failed to export chat:', error);
            new Notice('Failed to export chat: ' + getErrorMessage(error));
            return false;
        }
    }

    /**
     * Counts the number of complete user-assistant message pairs in the history
     * @returns number of complete pairs
     */
    private countMessagePairs(): number {
        if (!this.messageHistory || !Array.isArray(this.messageHistory)) {
            return 0;
        }

        let pairs = 0;
        let isUserMessage = false;

        // Filter out system messages and count complete pairs
        const nonSystemMessages = this.messageHistory.filter(msg => msg.role !== 'system');
        
        for (const message of nonSystemMessages) {
            if (!message || typeof message.role !== 'string') continue;

            if (message.role === 'user') {
                isUserMessage = true;
            } else if (message.role === 'assistant' && isUserMessage) {
                pairs++;
                isUserMessage = false;
            }
        }

        return pairs;
    }

    private async renderReasoningContent(
        markdownContainer: HTMLElement,
        content: string,
        settings: MessageSettings
    ) {
        const { reasoningBlocks, responsePart } = this.extractReasoningContent(
            content,
            settings.reasoningHeader || '<think>'
        );

        if (reasoningBlocks.length > 0) {
            const reasoningContainer = markdownContainer.createDiv('flare-reasoning-content');
            reasoningContainer.setAttribute('role', 'region');
            reasoningContainer.setAttribute('aria-expanded', 'false');
            // Remove immediate rendering - this will happen on expand
        }

        const responseContainer = markdownContainer.createDiv('flare-response-content');
        responseContainer.setAttribute('role', 'region');
        if (responsePart.trim()) {
            const currentFile = this.plugin.chatHistoryManager.getCurrentFile();
            await MarkdownRenderer.render(
                this.app,
                responsePart.trim(),
                responseContainer,
                currentFile?.path || '',
                this
            );
        }
    }

    private setupTooltipHandlers(flareName: HTMLElement, metadata: Record<string, string>) {
        // Add click handler for metadata menu
        this.registerDomEvent(flareName, 'click', (e: MouseEvent) => {
            e.preventDefault();
            e.stopPropagation();
            
            const menu = new Menu();
            
            // Add metadata items to menu without disabled state
            Object.entries(metadata).forEach(([key, value]) => {
                menu.addItem((item) => {
                    item.setTitle(`${key}: ${value}`);
                });
            });
            
            // Calculate position to ensure menu stays in view
            const rect = flareName.getBoundingClientRect();
            const viewportHeight = window.innerHeight;
            const viewportWidth = window.innerWidth;
            
            // Calculate optimal position
            let x = rect.left;
            let y = rect.bottom;
            
            // Adjust for viewport edges
            if (x + 200 > viewportWidth) { // 200px is an estimated menu width
                x = viewportWidth - 200;
            }
            
            // Show menu above if not enough space below
            if (rect.bottom + 200 > viewportHeight) { // 200px is an estimated menu height
                y = rect.top;
            }
            
            menu.showAtPosition({ x, y });
        });
    }

    /**
     * Resets the input field to its default state
     */
    private resetInputField() {
        if (!this.inputEl) return;
        
        // First clear the content
        this.inputEl.value = '';
        
        // Explicitly set height to the default minimum
        this.inputEl.style.height = '36px';
        
        // Remove content-related classes
        this.inputEl.classList.remove('has-content');
        
        // Reset all container classes
        const textareaContainer = this.inputEl.closest('.flare-textarea-container');
        if (textareaContainer instanceof HTMLElement) {
            textareaContainer.classList.remove('has-content');
        }
        
        const controlsContainer = this.inputEl.closest('.flare-controls-container');
        if (controlsContainer instanceof HTMLElement) {
            controlsContainer.classList.remove('has-content');
        }
        
        const wrapper = this.inputEl.closest('.flare-input-wrapper');
        if (wrapper instanceof HTMLElement) {
            wrapper.classList.remove('has-content');
        }
    }
} 