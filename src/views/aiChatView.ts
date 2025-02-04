import { ItemView, MarkdownRenderer, TFile, setIcon, Notice, App, WorkspaceLeaf, Menu, Platform, Modal, SuggestModal } from 'obsidian';
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
    /** Number of messages to include in history */
    historyWindow?: number;
    /** Number of messages before handoff */
    handoffWindow?: number;
    /** Whether the message was truncated */
    truncated?: boolean;
    /** Tag for reasoning model thoughts */
    reasoningHeader?: string;
    /** Whether this is a reasoning-capable model */
    isReasoningModel?: boolean;
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
        type?: 'model' | 'temperature';
        /** Whether reasoning is enabled */
        isReasoningModel?: boolean;
        /** Reasoning header tag */
        reasoningHeader?: string;
        /** Additional metadata fields */
        [key: string]: any;
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
    MOBILE_BREAKPOINT: 768
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
    public currentTemp: number = CONSTANTS.DEFAULT_TEMPERATURE;
    /** Array of message history */
    public messageHistory: Array<{role: string; content: string; settings?: any}> = [];
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
    // Add a new property to track title generation state
    private isTitleGenerationInProgress: boolean = false;

    constructor(leaf: WorkspaceLeaf, private plugin: FlarePlugin) {
        super(leaf);
        this.app = plugin.app;
    }

    getViewType(): string {
        return VIEW_TYPE_AI_CHAT;
    }

    getDisplayText(): string {
        return 'FLARE.ai';
    }

    getIcon(): string {
        return 'flame';
    }

    async onload() {
        const container = this.containerEl.children[1];
        container.empty();

        // Create main chat container
        const chatContainer = container.createDiv('flare-chat-container');
        
        // Create main content area
        const mainContent = chatContainer.createDiv('flare-main-content');

        // Create toolbar
        const toolbar = mainContent.createDiv('flare-toolbar');
        const toolbarLeft = toolbar.createDiv('flare-toolbar-left');
        const toolbarCenter = toolbar.createDiv('flare-toolbar-center');
        const toolbarRight = toolbar.createDiv('flare-toolbar-right');
        
        // Add history toggle button
        const historyBtn = toolbarLeft.createEl('button', {
            cls: 'flare-toolbar-button',
            attr: { 'aria-label': 'Toggle chat history' }
        });
        setIcon(historyBtn, 'history');
        
        // Add new chat button
        const newChatBtn = toolbarLeft.createEl('button', {
            cls: 'flare-toolbar-button',
            attr: { 'aria-label': 'New chat' }
        });
        setIcon(newChatBtn, 'plus');
        
        // Add chat title
        toolbarCenter.createEl('h2', { text: 'New Chat' });
        
        // Set window title to FLARE.ai
        document.title = 'FLARE.ai';
        
        // Add save button
        const saveBtn = toolbarRight.createEl('button', {
            cls: 'flare-toolbar-button',
            attr: { 'aria-label': 'Save chat' }
        });
        setIcon(saveBtn, 'save');
        
        // Add clear button
        const clearBtn = toolbarRight.createEl('button', {
            cls: 'flare-toolbar-button',
            attr: { 'aria-label': 'Clear chat' }
        });
        setIcon(clearBtn, 'trash-2');
        
        // Create messages area
        this.messagesEl = mainContent.createDiv('flare-messages');
        
        // Instead, create a bottom container that will hold both composer and footer
        const bottomContainer = mainContent.createDiv('flare-bottom-container');
        const composer = bottomContainer.createDiv('flare-composer');
        
        const inputWrapper = composer.createDiv('flare-input-wrapper');

        // Add flare chooser
        const flareChooser = inputWrapper.createEl('button', {
            cls: 'flare-chooser',
            attr: { 'aria-label': 'Choose flare' }
        });
        setIcon(flareChooser, 'flame');
        
        // Create input
        this.inputEl = inputWrapper.createEl('textarea', {
            cls: 'flare-input',
            attr: { 
                rows: '1',
                placeholder: 'Select a flare using the flame button, or type @flarename to start...'
            }
        });
        
        // Create send button
        const sendBtn = inputWrapper.createEl('button', {
            cls: 'flare-send-button',
            attr: { 'aria-label': 'Send message', type: 'button' }
        }) as HTMLButtonElement;
        setIcon(sendBtn, 'send');
        
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
        
        // Add click handler for model selection
        modelControl.onclick = async () => {
            if (!this.currentFlare) return;
            await this.showModelSelector();
        };
        
        // Add temperature display
        const tempControl = footerRight.createDiv('flare-temp-control');
        tempControl.addClass('is-disabled'); // Start disabled
        tempControl.onclick = () => {
            if (!this.currentFlare) return; // Don't allow temp changes without a flare
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
        this.updateTempDisplay();
        
        // Initialize history sidebar
        this.historySidebar = new HistorySidebar(this.plugin, async (file: TFile) => {
            await this.plugin.chatHistoryManager.loadHistory(file);
            await this.loadCurrentHistory();
        });
        this.historySidebar.attachTo(chatContainer);
        
        // Setup event handlers
        this.setupEventHandlers();
    }
    
    private setupEventHandlers() {
        // Handle history toggle
        const historyBtn = this.containerEl.querySelector('.flare-toolbar-button[aria-label="Toggle chat history"]');
        if (historyBtn) {
            historyBtn.addEventListener('click', () => {
                if (this.historySidebar.isVisible) {
                    this.historySidebar.hide();
                } else {
                    this.historySidebar.show();
                }
            }, { passive: true });
        }
        
        // Handle new chat
        const newChatBtn = this.containerEl.querySelector('.flare-toolbar-button[aria-label="New chat"]');
        if (newChatBtn) {
            newChatBtn.addEventListener('click', () => {
                this.startNewChat();
            }, { passive: true });
        }
        
        // Handle save chat
        const saveBtn = this.containerEl.querySelector('.flare-toolbar-button[aria-label="Save chat"]');
        if (saveBtn) {
            saveBtn.addEventListener('click', async () => {
                try {
                    await this.plugin.chatHistoryManager.saveCurrentHistory();
                    new Notice('Chat saved successfully');
                    const currentFile = await this.plugin.chatHistoryManager.getCurrentFile();
                    if (currentFile) {
                        const titleEl = this.containerEl.querySelector('.flare-toolbar-center h2');
                        if (titleEl) {
                            titleEl.setText(currentFile.basename);
                        }
                    }
                } catch (error) {
                    console.error('Error saving chat:', error);
                    new Notice('Failed to save chat');
                }
            }, { passive: true });
        }
        
        // Handle clear chat
        const clearBtn = this.containerEl.querySelector('.flare-toolbar-button[aria-label="Clear chat"]');
        if (clearBtn) {
            clearBtn.addEventListener('click', () => {
                this.clearChat();
            }, { passive: true });
        }

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
                    // Check for title command
                    if (content === '/title') {
                        // Clear input field immediately
                        if (this.inputEl) {
                            this.inputEl.value = '';
                            this.inputEl.style.height = '';  // Reset to default height
                        }
                        // Run title generation in the background without affecting send button state
                        this.handleTitleGeneration().catch(error => {
                            console.error('Failed to generate title:', error);
                            new Notice('Failed to generate title');
                        });
                        return;
                    }
                    
                    // Set streaming state before sending
                    this.isStreaming = true;
                    setIcon(sendBtn, 'square');
                    sendBtn.classList.add('is-streaming');
                    sendBtn.setAttribute('aria-label', 'Stop streaming');
                    
                    try {
                        // Clear input before sending - this is the only place we should clear it
                        const inputValue = this.inputEl.value;
                        this.inputEl.value = '';
                        this.inputEl.style.height = '';  // Reset to default height
                        
                        // Try to send the message
                        const success = await this.handleMessage(content);
                        // If message failed to send, restore the input
                        if (!success) {
                            this.inputEl.value = inputValue;
                        }
                    } finally {
                        // Reset streaming state
                        this.isStreaming = false;
                        this.resetSendButton(sendBtn, this.originalSendHandler);
                    }
                }
            };

            // Set initial handler
            sendBtn.addEventListener('click', this.originalSendHandler, { passive: true });
        }
        
        // Handle flare chooser
        const flareChooser = this.containerEl.querySelector('.flare-chooser');
        if (flareChooser) {
            flareChooser.addEventListener('click', (async function(this: AIChatView, event: Event) {
                const mouseEvent = event as MouseEvent;
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
                                        // Load the flare config
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
                        x: mouseEvent.clientX,
                        y: mouseEvent.clientY
                    });
                } catch (error: unknown) {
                    console.error('Failed to load flares:', error);
                    new Notice('Failed to load flares: ' + getErrorMessage(error));
                }
            }).bind(this));
        }
        
        // Setup input handlers for flare suggestions
        if (this.inputEl) {
            let suggestionContainer: HTMLElement | null = null;
            let selectedIndex = -1;
            let flares: Array<{name: string}> = [];
            
            const removeSuggestions = () => {
                if (suggestionContainer) {
                    suggestionContainer.remove();
                    suggestionContainer = null;
                }
                this.containerEl.removeClass('has-suggestions');
                selectedIndex = -1;
                flares = [];
            };

            const selectSuggestion = async (index: number) => {
                if (!suggestionContainer || index < 0 || index >= flares.length) return;
                
                const flare = flares[index];
                const input = this.inputEl.value;
                const cursorPosition = this.inputEl.selectionStart || 0;
                
                // Only process @ at the start of input
                if (input.trimStart().startsWith('@')) {
                    const newValue = '@' + flare.name + ' ' + input.slice(cursorPosition);
                    this.inputEl.value = newValue;
                    
                    // Set cursor position after the inserted flare name
                    const newPosition = flare.name.length + 2; // +2 for @ and space
                    this.inputEl.setSelectionRange(newPosition, newPosition);
                }
                
                // Remove suggestions
                removeSuggestions();
            };

            const updateSuggestions = async (searchTerm: string) => {
                try {
                    // Load available flares
                    flares = await this.plugin.flareManager.loadFlares();
                    
                    // Filter flares based on search term
                    const filtered = flares.filter(f => 
                        f.name.toLowerCase().includes(searchTerm.toLowerCase())
                    );

                    if (filtered.length === 0) {
                        removeSuggestions();
                        return;
                    }

                    // Update flares array to only contain filtered results
                    flares = filtered;

                    // Create or update suggestion container
                    if (!suggestionContainer) {
                        suggestionContainer = createDiv('flare-suggestions');
                        document.body.appendChild(suggestionContainer);
                    }
                    suggestionContainer.empty();

                    // Create inner container for suggestions
                    const suggestionsInner = suggestionContainer.createDiv('flare-suggestions-container');

                    // Add suggestions
                    filtered.forEach((flare, index) => {
                        const item = suggestionsInner.createDiv('flare-suggestion-item');
                        if (index === selectedIndex) {
                            item.addClass('is-selected');
                        }
                        
                        const icon = item.createDiv('suggestion-icon');
                        setIcon(icon, 'flame');
                        
                        item.createDiv('suggestion-name').setText(flare.name);
                        
                        if (index === 0) {
                            item.createDiv('suggestion-hint').setText('↵ to select');
                        }
                        
                        // Handle click
                        item.addEventListener('click', async () => {
                            await selectSuggestion(index);
                        });
                    });

                    // Position the suggestions
                    const inputWrapper = this.inputEl.closest('.flare-input-wrapper') as HTMLElement;
                    if (!inputWrapper) return;

                    const wrapperRect = inputWrapper.getBoundingClientRect();
                    const viewportHeight = window.innerHeight;
                    const viewportWidth = window.innerWidth;
                    
                    // Calculate available space
                    const spaceBelow = viewportHeight - wrapperRect.bottom;
                    const spaceAbove = wrapperRect.top;
                    
                    // Calculate dimensions
                    const containerWidth = Math.min(viewportWidth * 0.9, 400);
                    const leftOffset = Math.max(8, wrapperRect.left);
                    
                    // Set position and dimensions
                    suggestionContainer.style.position = 'fixed';
                    suggestionContainer.style.width = `${containerWidth}px`;
                    suggestionContainer.style.left = `${leftOffset}px`;
                    
                    // Set max height for suggestions container
                    const maxHeight = Math.min(300, Math.max(spaceAbove, spaceBelow) - 16);
                    suggestionsInner.style.maxHeight = `${maxHeight}px`;
                    
                    if (spaceBelow >= 200 || spaceBelow > spaceAbove) {
                        // Position below input
                        suggestionContainer.style.top = `${wrapperRect.bottom + 8}px`;
                        suggestionContainer.style.bottom = 'auto';
                        suggestionContainer.removeClass('position-top');
                        suggestionContainer.addClass('position-bottom');
                    } else {
                        // Position above input
                        suggestionContainer.style.bottom = `${viewportHeight - wrapperRect.top + 8}px`;
                        suggestionContainer.style.top = 'auto';
                        suggestionContainer.addClass('position-top');
                        suggestionContainer.removeClass('position-bottom');
                    }

                    // Show suggestions
                    suggestionContainer.addClass('is-visible');
                    
                    // Set initial selection
                    if (selectedIndex === -1) {
                        selectedIndex = 0;
                    }

                } catch (error) {
                    console.error('Error updating suggestions:', error);
                    removeSuggestions();
                }
            };

            // Add input handlers
            this.inputEl.addEventListener('input', async () => {
                const input = this.inputEl.value;
                const cursorPosition = this.inputEl.selectionStart || 0;
                
                // Check if we're at the start of the input or after whitespace
                const beforeCursor = input.slice(0, cursorPosition);
                const isAtStart = beforeCursor.trim() === beforeCursor && beforeCursor.startsWith('@');
                
                if (isAtStart) {
                    const searchTerm = beforeCursor.slice(1); // Remove the @ symbol
                    await updateSuggestions(searchTerm);
                } else {
                    removeSuggestions();
                }
            });

            // Also trigger suggestions on @ being typed
            this.inputEl.addEventListener('keyup', async (e: KeyboardEvent) => {
                if (e.key === '@') {
                    const input = this.inputEl.value;
                    const cursorPosition = this.inputEl.selectionStart || 0;
                    const beforeCursor = input.slice(0, cursorPosition);
                    
                    // Only show suggestions if @ is at the start or after whitespace
                    if (beforeCursor.trim() === '@') {
                        await updateSuggestions('');
                    }
                }
            });

            // Handle keyboard navigation
            this.inputEl.addEventListener('keydown', async (e: KeyboardEvent) => {
                // Handle suggestions navigation if suggestions are visible
                if (suggestionContainer) {
                    switch (e.key) {
                        case 'ArrowUp':
                            e.preventDefault();
                            selectedIndex = Math.max(0, selectedIndex - 1);
                            const upSearchTerm = this.inputEl.value.slice(1, this.inputEl.selectionStart).trim();
                            await updateSuggestions(upSearchTerm);
                            break;
                            
                        case 'ArrowDown':
                            e.preventDefault();
                            selectedIndex = Math.min(flares.length - 1, selectedIndex + 1);
                            const downSearchTerm = this.inputEl.value.slice(1, this.inputEl.selectionStart).trim();
                            await updateSuggestions(downSearchTerm);
                            break;
                            
                        case 'Enter':
                            if (selectedIndex >= 0) {
                                e.preventDefault();
                                await selectSuggestion(selectedIndex);
                            }
                            break;
                            
                        case 'Escape':
                            removeSuggestions();
                            break;
                    }
                    return;
                }

                // Handle Enter key behavior when no suggestions are shown
                if (e.key === 'Enter') {
                    // On mobile, allow normal Enter behavior
                    if (Platform.isMobile) {
                        return;
                    }
                    
                    // On desktop:
                    // - Shift+Enter creates a line break
                    // - Plain Enter sends the message
                    if (!e.shiftKey) {
                        e.preventDefault();
                        const sendBtn = this.containerEl.querySelector('.flare-send-button') as HTMLButtonElement;
                        if (sendBtn && this.originalSendHandler && !this.isStreaming) {
                            const boundHandler = this.originalSendHandler.bind(this);
                            await boundHandler(new MouseEvent('click'));
                        }
                    }
                }
            });

            // Remove suggestions when clicking outside
            document.addEventListener('click', (e: MouseEvent) => {
                if (suggestionContainer && !suggestionContainer.contains(e.target as Node) && !this.inputEl.contains(e.target as Node)) {
                    removeSuggestions();
                }
            });
        }

        // If you want the default placeholder to read "@flarename ..." on startup,
        // add something like this:
        if (this.inputEl) {
            this.inputEl.setAttribute('placeholder', '@flarename ...');
        }
    }

    async loadCurrentHistory() {
        if (!this.messagesEl) return;

        try {
            // Clear UI first
            this.messagesEl.empty();
            this.messageHistory = [];

            // Add loading indicator
            const loadingEl = this.messagesEl.createDiv('flare-loading-message');
            loadingEl.setText('Loading chat history...');

            const history = await this.plugin.chatHistoryManager.getCurrentHistory();
            const currentFile = await this.plugin.chatHistoryManager.getCurrentFile();
            
            // Update chat title based on current history
            const titleEl = this.containerEl.querySelector('.flare-toolbar-center h2');
            if (titleEl) {
                if (currentFile) {
                    titleEl.setText(currentFile.basename);
                } else {
                    titleEl.setText('New Chat');
                }
            }
            
            // Remove loading indicator
            loadingEl.remove();
            
            if (history?.messages && Array.isArray(history.messages)) {
                // Store complete history first
                this.messageHistory = history.messages.map((message: ChatMessage) => ({
                    role: message.role,
                    content: message.content,
                    settings: message.settings
                }));

                // Determine what to show in UI based on history window
                let messagesToShow = [...history.messages];
                if (this.currentFlare?.historyWindow !== undefined && this.currentFlare.historyWindow !== -1) {
                    const windowSize = this.currentFlare.historyWindow;
                    if (windowSize === 0) {
                        messagesToShow = [];
                    } else {
                        const systemMessages = messagesToShow.filter(m => m.role === 'system');
                        const nonSystemMessages = messagesToShow.filter(m => m.role !== 'system');
                        const windowedNonSystem = this.plugin.applyHistoryWindow(nonSystemMessages, windowSize);
                        messagesToShow = windowedNonSystem.length > 0 ? 
                            systemMessages.concat(windowedNonSystem) : 
                            windowedNonSystem;
                    }
                }

                // Display messages in UI
                for (const message of messagesToShow) {
                    await this.addMessage(
                        message.role,
                        message.content,
                        message.settings,
                        false // Don't add to history manager since we're loading from it
                    );
                }

                // Scroll to bottom
                this.messagesEl.scrollTop = this.messagesEl.scrollHeight;
            }

        } catch (error) {
            console.error('Error loading chat history:', error);
            const errorMessage = error instanceof Error ? error.message : String(error);
            new Notice('Error loading chat history: ' + errorMessage);
            
            // Clear messages on error
            this.messagesEl.empty();
            this.messageHistory = [];
            
            // Reset title
            const titleEl = this.containerEl.querySelector('.flare-toolbar-center h2');
            if (titleEl) {
                titleEl.setText('New Chat');
            }
        }
    }

    private async clearChat() {
        if (this.messagesEl) {
            // Clear UI messages
            this.messagesEl.empty();
            
            // Clear message history
            this.messageHistory = [];

            // Clear history in the history manager and save empty state
            const currentFile = await this.plugin.chatHistoryManager.getCurrentFile();
            if (currentFile) {
                // Clear the history manager's state
                await this.plugin.chatHistoryManager.clearHistory();
                // Ensure we have a clean history object
                const history = await this.plugin.chatHistoryManager.getCurrentHistory();
                if (history) {
                    history.messages = [];
                    history.lastModified = Date.now();
                }
                // Save the empty state
                await this.plugin.chatHistoryManager.saveCurrentHistory();
            } else {
                // If no current file, create a new empty history
                await this.plugin.chatHistoryManager.createNewHistory();
            }

            // Reset chat title to "New Chat"
            const titleEl = this.containerEl.querySelector('.flare-toolbar-center h2');
            if (titleEl) {
                titleEl.setText('New Chat');
            }
        }
    }

    // Add a new method for starting a new chat
    private async startNewChat() {
        if (this.messagesEl) {
            // Clear UI messages and history
            this.messagesEl.empty();
            this.messageHistory = [];
            
            try {
                // Create new chat history and wait for it to complete
                const newHistory = await this.plugin.chatHistoryManager.createNewHistory();
                if (!newHistory) {
                    throw new Error('Failed to create new chat history');
                }

                // Save the new history immediately
                await this.plugin.chatHistoryManager.saveCurrentHistory();
                
                // Always set title to "New Chat" initially
                const titleEl = this.containerEl.querySelector('.flare-toolbar-center h2');
                if (titleEl) {
                    titleEl.setText('New Chat');
                }

                // Reset current flare
                this.currentFlare = undefined;
                
                // Reset input placeholder
                if (this.inputEl) {
                    this.inputEl.setAttribute('placeholder', '@flarename ...');
                }

                // Reset model display
                if (this.modelDisplayEl) {
                    this.modelDisplayEl.setText('--');
                    const modelControl = this.containerEl.querySelector('.flare-model-control');
                    if (modelControl) {
                        modelControl.addClass('is-disabled');
                    }
                }

                // Reset temperature
                this.currentTemp = 0.7; // Reset to default temperature
                if (this.tempDisplayEl) {
                    this.tempDisplayEl.setText('--');
                    const tempControl = this.containerEl.querySelector('.flare-temp-control');
                    if (tempControl) {
                        tempControl.addClass('is-disabled');
                    }
                }

                // Reset streaming state
                this.isStreaming = false;
                const sendBtn = this.containerEl.querySelector('.flare-send-button') as HTMLButtonElement;
                if (sendBtn) {
                    this.resetSendButton(sendBtn, this.originalSendHandler);
                }

                // Update history sidebar if it exists
                if (this.plugin.historySidebar) {
                    await this.plugin.historySidebar.refresh();
                }

                new Notice('New chat created');
            } catch (error) {
                console.error('Failed to create new chat:', error);
                const errorMessage = error instanceof Error ? error.message : String(error);
                new Notice('Failed to create new chat: ' + errorMessage);
            }
        }
    }

    async handleTitleGeneration(): Promise<boolean> {
        let progressNotice: any = null;
        try {
            // Verify we have messages to generate a title from
            if (!this.messageHistory.length) {
                throw new Error('No messages to generate title from');
            }

            const titleSettings = this.plugin.settings.titleSettings;

            // Validate title generation settings
            if (!titleSettings.provider || !titleSettings.model) {
                throw new Error('Title generation provider and model must be configured in settings');
            }

            // Verify provider exists and is enabled
            const provider = this.plugin.settings.providers[titleSettings.provider];
            if (!provider || !provider.enabled) {
                throw new Error(`Provider ${provider?.name || titleSettings.provider} is not configured or enabled`);
            }

            progressNotice = new Notice('Title generation in progress...', 0);

            // Build the conversation's text, filtering out system messages and cleaning content
            const historyText = this.messageHistory
                .filter(msg => msg.role !== 'system')
                .map(msg => {
                    let content = msg.content;
                    try {
                        // Try to parse JSON content (for system messages)
                        const parsed = JSON.parse(content);
                        if (parsed.main) {
                            content = parsed.main;
                        }
                    } catch (e) {
                        // Not JSON, use as is
                    }
                    // Clean up the content - remove markdown and limit length
                    content = content
                        .replace(/```[\s\S]*?```/g, '') // Remove code blocks
                        .replace(/`[^`]*`/g, '') // Remove inline code
                        .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1') // Convert links to text
                        .replace(/[#*_~]/g, '') // Remove markdown formatting
                        .substring(0, 150); // Limit length
                    return `${msg.role}: ${content}`;
                })
                .join('\n\n');

            // Create a direct request to the provider's API
            const prompt = titleSettings.prompt + '\n\nChat History:\n' + historyText;
            
            // Create messages array for the API request
            const messages = [
                { role: 'user', content: prompt }
            ];

            // Make direct API call based on provider type
            let response: string;
            
            if (titleSettings.provider === 'openai') {
                const result = await this.plugin.openai.createChatCompletion({
                    model: titleSettings.model,
                    messages: messages,
                    temperature: titleSettings.temperature || 0.7,
                    max_tokens: titleSettings.maxTokens || 50,
                    stream: false // Never use streaming for title generation
                });
                response = result.choices[0]?.message?.content || '';
            } else if (titleSettings.provider === 'anthropic') {
                const result = await this.plugin.anthropic.messages.create({
                    model: titleSettings.model,
                    messages: messages,
                    temperature: titleSettings.temperature || 0.7,
                    max_tokens: titleSettings.maxTokens || 50,
                    stream: false // Never use streaming for title generation
                });
                response = result.content[0]?.text || '';
            } else if (provider.type === 'ollama') {
                const result = await fetch(`${provider.baseUrl}/api/chat`, {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json'
                    },
                    body: JSON.stringify({
                        model: titleSettings.model,
                        messages: messages,
                        stream: false, // Never use streaming for title generation
                        options: {
                            temperature: titleSettings.temperature || 0.7
                        }
                    })
                });

                if (!result.ok) {
                    const error = await result.text();
                    throw new Error(`Ollama API error: ${error}`);
                }

                const data = await result.json();
                response = data.message?.content || '';
            } else {
                throw new Error(`Unsupported provider: ${titleSettings.provider}`);
            }

            // If we don't get a valid response, throw an error
            if (!response || response.trim().length === 0) {
                throw new Error('Failed to generate title - no response from model');
            }

            // Update the title
            const currentFile = await this.plugin.chatHistoryManager.getCurrentFile();
            if (currentFile) {
                let sanitizedTitle = this.sanitizeTitle(response.trim());
                const currentPath = currentFile.parent.path;

                // Handle potential file name conflicts by adding a number suffix
                let counter = 1;
                let targetPath = `${currentPath}/${sanitizedTitle}.md`;
                while (await this.plugin.app.vault.adapter.exists(targetPath)) {
                    sanitizedTitle = `${this.sanitizeTitle(response.trim())} ${counter}`;
                    targetPath = `${currentPath}/${sanitizedTitle}.md`;
                    counter++;
                }
                
                // Get current history and update its title
                const history = await this.plugin.chatHistoryManager.getCurrentHistory();
                if (history) {
                    history.title = sanitizedTitle;
                    // Save the updated history
                    await this.plugin.chatHistoryManager.saveCurrentHistory();
                }
                
                // Update the file
                await this.plugin.app.fileManager.renameFile(
                    currentFile,
                    targetPath
                );
                
                // Update the title in the UI
                const titleEl = this.containerEl.querySelector('.flare-toolbar-center h2');
                if (titleEl) {
                    titleEl.setText(sanitizedTitle);
                }
                
                // Hide the progress notice before showing success
                if (progressNotice) progressNotice.hide();
                
                // Show success notice after a small delay
                setTimeout(() => {
                    new Notice('Title updated successfully');
                }, 100);
            } else {
                throw new Error('No active chat file found');
            }

            return true;
        } catch (error) {
            console.error('Error generating title:', error);
            // Hide the progress notice before showing error
            if (progressNotice) progressNotice.hide();
            
            // Show error notice after a small delay
            setTimeout(() => {
                const errorMessage = error instanceof Error ? error.message : String(error);
                new Notice(`Error generating title: ${errorMessage}`);
            }, 100);
            return false;
        }
    }

    async handleMessage(content: string): Promise<boolean> {
        try {
            // Check for title command
            if (content === '/title') {
                // Run title generation in the background without affecting send button state
                this.handleTitleGeneration().catch(error => {
                    console.error('Failed to generate title:', error);
                    new Notice('Failed to generate title');
                });
                return true;
            }

            // First check if message starts with a flare switch
            const flareSwitchMatch = content.match(/^@(\w+)(?:\s+([\s\S]+))?$/);
            if (flareSwitchMatch) {
                const [_, flareName, actualMessage] = flareSwitchMatch;
                
                try {
                    // Check if flare exists before proceeding
                    const flareExists = await this.plugin.app.vault.adapter.exists(
                        `${this.plugin.settings.flaresFolder}/${flareName}.md`
                    );
                    if (!flareExists) {
                        new Notice(`Flare "${flareName}" does not exist. Please create it first.`);
                        return false;
                    }

                    // Load and switch to the new flare
                    const newFlare = await this.plugin.flareManager.debouncedLoadFlare(flareName);
                    if (!newFlare) {
                        throw new Error(`Failed to load flare configuration for ${flareName}`);
                    }

                    // Check provider configuration before switching
                    const provider = this.plugin.settings.providers[newFlare.provider];
                    if (!provider || !provider.enabled) {
                        const providerName = provider?.name || newFlare.provider;
                        throw new Error(`Provider ${providerName} is not configured or enabled. Please check settings.`);
                    }

                    if (!newFlare.model) {
                        throw new Error(`No model selected for flare ${newFlare.name}. Please configure the flare.`);
                    }

                    // Wait for the flare switch to complete before processing message
                    await this.handleFlareSwitch(newFlare);

                    // Only process message if there is one
                    if (actualMessage?.trim()) {
                        await this.processMessage(actualMessage.trim(), { 
                            stream: newFlare.stream ?? true, 
                            isFlareSwitch: true 
                        });
                    }
                    return true;
                } catch (error: unknown) {
                    console.error('Failed to load flare config:', error);
                    new Notice(getErrorMessage(error));
                    return false;
                }
            }

            // Verify we have a current flare
            if (!this.currentFlare) {
                new Notice('Please select a flare first');
                return false;
            }

            // Process message normally
            try {
                await this.processMessage(content, { 
                    stream: this.currentFlare?.stream ?? false,
                    isFlareSwitch: false 
                });
                return true;
            } catch (error: unknown) {
                console.error('Error processing message:', error);
                new Notice('Error: ' + getErrorMessage(error));
                return false;
            }
        } catch (error: unknown) {
            await this.handleError(error, 'Error sending message');
            return false;
        }
    }

    // Split out the actual message processing logic
    private async processMessage(
        content: string, 
        options?: { stream?: boolean; isFlareSwitch?: boolean }
    ) {
        try {
            // Reset abort state at the start of each message
            this.isAborted = false;

            // Clear input field immediately and reset its height
            if (this.inputEl) {
                this.inputEl.value = '';
                this.inputEl.classList.add('is-empty');
                // Force a reflow to ensure height is updated
                void this.inputEl.offsetHeight;
                this.inputEl.classList.remove('is-empty');
            }

            // Get current flare settings
            const settings = {
                flare: this.currentFlare?.name || 'default',
                provider: this.currentFlare?.provider || this.plugin.settings.defaultProvider,
                model: this.currentFlare?.model || 'default',
                temperature: this.currentTemp,
                maxTokens: this.currentFlare?.maxTokens,
                historyWindow: this.currentFlare?.historyWindow ?? -1,
                handoffWindow: this.currentFlare?.handoffWindow,
                stream: options?.stream ?? this.currentFlare?.stream ?? true,
                isFlareSwitch: options?.isFlareSwitch ?? false,
                reasoningHeader: this.currentFlare?.reasoningHeader || '<think>',
                isReasoningModel: this.currentFlare?.isReasoningModel ?? false
            };

            // Create user message object (but don't add to history yet)
            const userMessage = {
                role: 'user',
                content: content,
                settings
            };

            // Add user message to UI only
            await this.addMessage('user', content, settings, false);

            // Create loading message
            const loadingMsg = await this.addMessage('assistant', '', settings, false);
            if (loadingMsg) {
                loadingMsg.addClass('is-loading');
                const contentEl = loadingMsg.querySelector('.flare-message-content');
                if (contentEl) {
                    contentEl.empty();
                    const contentWrapper = contentEl.createDiv('flare-content-wrapper');
                    const mainText = contentWrapper.createDiv('flare-system-main');
                    const flareName = mainText.createSpan('flare-name');
                    const flameIcon = flareName.createSpan();
                    setIcon(flameIcon, 'flame');
                    flareName.createSpan().setText(`@${settings.flare}`);
                    
                    const metadataEl = flareName.createDiv('flare-metadata');
                    const metadata = this.getFlareMetadata(settings);
                    Object.entries(metadata).forEach(([key, value]) => {
                        const item = metadataEl.createDiv('flare-metadata-item');
                        item.createSpan('metadata-key').setText(key + ':');
                        item.createSpan('metadata-value').setText(' ' + value);
                    });

                    // Create markdown container with proper structure
                    const markdownContent = contentWrapper.createDiv('flare-markdown-content is-empty');
                    if (settings.isReasoningModel) {
                        // Create containers for reasoning and response content
                        const reasoningContainer = markdownContent.createDiv('flare-reasoning-content');
                        reasoningContainer.setAttribute('data-reasoning-blocks', '[]');
                        reasoningContainer.setAttribute('data-partial-block', '');
                        reasoningContainer.style.display = 'none';
                        
                        const responseContainer = markdownContent.createDiv('flare-response-content');
                        responseContainer.createDiv('markdown-rendered');
                    } else {
                        // For non-reasoning models, just create the markdown container
                        markdownContent.createDiv('markdown-rendered');
                    }
                }
            }

            let accumulatedContent = '';
            let lastRenderedLength = 0;
            const renderDebounceMs = 25;
            let lastRenderTime = 0;
            let pendingRender: number | null = null;
            let renderBuffer = '';
            let response = '';

            // Add header/tag variables for reasoning model
            const reasoningHeader = settings.reasoningHeader || '<think>';
            const reasoningEndTag = reasoningHeader.replace('<', '</');
            const escapedHeader = this.escapeRegexSpecials(reasoningHeader);
            const escapedEndTag = this.escapeRegexSpecials(reasoningEndTag);

            try {
                // Send message to provider
                response = await this.plugin.handleMessage(content, {
                    flare: settings.flare,
                    provider: settings.provider,
                    model: settings.model,
                    temperature: settings.temperature,
                    maxTokens: settings.maxTokens,
                    messageHistory: this.messageHistory,
                    historyWindow: settings.historyWindow,
                    stream: settings.stream,
                    onToken: (token: string) => {
                        if (loadingMsg && !this.isAborted) {
                            accumulatedContent += token;
                            renderBuffer += token;
                            
                            // Cancel any pending render
                            if (pendingRender !== null) {
                                window.clearTimeout(pendingRender);
                            }
                            
                            const now = Date.now();
                            const timeSinceLastRender = now - lastRenderTime;
                            const hasSignificantContent = renderBuffer.length >= 10;
                            
                            // Render immediately if we have significant content and enough time has passed
                            if (hasSignificantContent && timeSinceLastRender >= renderDebounceMs) {
                                this.renderStreamingContent(loadingMsg, accumulatedContent, renderBuffer, settings);
                                renderBuffer = '';
                                lastRenderedLength = accumulatedContent.length;
                                lastRenderTime = now;
                            } else {
                                // Schedule a new render
                                pendingRender = window.setTimeout(() => {
                                    if (!this.isAborted && renderBuffer.length > 0) {
                                        this.renderStreamingContent(loadingMsg, accumulatedContent, renderBuffer, settings);
                                        renderBuffer = '';
                                        lastRenderedLength = accumulatedContent.length;
                                        lastRenderTime = Date.now();
                                    }
                                    pendingRender = null;
                                }, renderDebounceMs);
                            }
                        }
                    }
                });

                // Now that we have a successful response, add both messages to history
                // Add user message to histories
                this.messageHistory.push(userMessage);
                await this.plugin.chatHistoryManager.addMessage(userMessage);

                // Add assistant response to histories
                const assistantMessage = {
                    role: 'assistant',
                    content: settings.stream ? accumulatedContent : response,
                    settings: {
                        ...settings,
                        truncated: false
                    }
                };
                
                // Add to local history
                this.messageHistory.push(assistantMessage);
                
                // Add to ChatHistoryManager
                await this.plugin.chatHistoryManager.addMessage(assistantMessage);

                // Cancel any pending renders before final render
                if (pendingRender !== null) {
                    window.clearTimeout(pendingRender);
                    pendingRender = null;
                }

                // Update loading message with final response
                if (loadingMsg) {
                    await this.finalizeMessageRender(
                        loadingMsg,
                        settings.stream ? accumulatedContent : response,
                        settings
                    );
                }
            } catch (error: unknown) {
                // If we have accumulated content and this was a streaming request that was stopped
                if (accumulatedContent && settings.stream && error instanceof Error && error.name === 'AbortError') {
                    this.isAborted = true;
                    
                    // Cancel any pending render
                    if (pendingRender !== null) {
                        window.clearTimeout(pendingRender);
                        pendingRender = null;
                    }

                    // Create assistant message with the truncated response
                    const assistantMessage = {
                        role: 'assistant',
                        content: accumulatedContent,
                        settings: {
                            ...settings,
                            truncated: true
                        }
                    };
                    
                    // Add to local history
                    this.messageHistory.push(assistantMessage);
                    
                    // Add to ChatHistoryManager and save immediately
                    await this.plugin.chatHistoryManager.addMessage(assistantMessage);
                    await this.plugin.chatHistoryManager.saveCurrentHistory();

                    // Update loading message with final content
                    if (loadingMsg) {
                        loadingMsg.removeClass('is-loading');
                        const contentEl = loadingMsg.querySelector('.flare-message-content');
                        if (contentEl) {
                            const markdownContainer = contentEl.querySelector('.flare-markdown-content') as HTMLElement;
                            if (markdownContainer) {
                                markdownContainer.empty();
                                await MarkdownRenderer.renderMarkdown(
                                    accumulatedContent,
                                    markdownContainer,
                                    '',
                                    this.plugin
                                );
                            }
                        }
                    }

                    return;
                }

                // Remove loading message if no content was received
                if (loadingMsg) {
                    loadingMsg.removeClass('is-loading');
                    loadingMsg.remove();
                }

                // Show a user-friendly message for connection issues
                if (error instanceof TypeError && error.message === 'Failed to fetch') {
                    new Notice(`Unable to connect to ${settings.provider}. Please check your connection and provider settings.`);
                } else {
                    console.error('Error processing message:', error);
                    new Notice('Error: ' + getErrorMessage(error));
                }
            }

            // After streaming completes:
            if (loadingMsg) {
                await this.finalizeMessageRender(
                    loadingMsg,
                    settings.stream ? accumulatedContent : response,
                    settings
                );
            }
        } catch (error: unknown) {
            const err: unknown = error;
            console.error('Error processing message:', err);
            if (err instanceof Error && err.name === 'AbortError') {
                return;
            }
            new Notice('Error: ' + getErrorMessage(err));
        }
    }

    // Add this new method to handle content rendering
    private renderStreamingContent(
        loadingMsg: HTMLElement,
        fullContent: string,
        newContent: string,
        settings: MessageSettings
    ): void {
        // Helper function to smooth out line breaks and handle sentence boundaries
        const smoothContent = (text: string, existingText: string = ''): string => {
            // Normalize all newlines
            let normalized = text.replace(/\r\n/g, '\n');
            
            // If this is the start of streaming, trim any leading newlines
            if (!existingText) {
                normalized = normalized.trimStart();
            }
            
            // Split into lines and process each one
            const lines = normalized.split('\n');
            const processedLines = lines.map((line, i) => {
                // Trim the line
                line = line.trimStart();
                
                // Skip empty lines between list items
                if (!line && i > 0 && i < lines.length - 1) {
                    const prevIsListItem = lines[i-1].match(/^[-*]\s|^\d+\.\s/);
                    const nextIsListItem = lines[i+1].match(/^[-*]\s|^\d+\.\s/);
                    if (prevIsListItem && nextIsListItem) return '';
                }
                
                // Handle list items and headings
                if (line.match(/^[-*]\s/)) {
                    // Ensure single space after list marker
                    return line.replace(/^([-*])\s+/, '$1 ');
                }
                if (line.match(/^\d+\.\s/)) {
                    // Ensure single space after number
                    return line.replace(/^(\d+\.)\s+/, '$1 ');
                }
                if (line.match(/^#{1,6}\s/)) {
                    // Ensure proper spacing around headings
                    return (!existingText ? '\n' : '') + line;
                }
                
                // Handle list item continuation
                if (i > 0) {
                    const prevLine = lines[i-1];
                    if (prevLine.match(/^[-*]\s|^\d+\.\s/)) {
                        // This is a continuation of a list item
                        return '  ' + line;
                    }
                }
                
                return line;
            });
            
            // Join lines and handle sentence continuation
            let result = processedLines.filter(line => line !== undefined).join('\n');
            
            // If we're continuing a sentence, handle the spacing
            if (existingText && 
                !existingText.trim().endsWith('.') && 
                !existingText.trim().endsWith('!') && 
                !existingText.trim().endsWith('?') && 
                !existingText.trim().endsWith(':') && 
                !result.match(/^[-*]\s|^\d+\.\s|^#{1,6}\s/)) {
                // If the existing text ends with a newline and we're not starting a list item or heading,
                // preserve the newline
                if (existingText.endsWith('\n')) {
                    result = result.trimStart();
                } else {
                    // Otherwise add a space between sentences
                    result = ' ' + result.trimStart();
                }
            }
            
            // Clean up multiple newlines
            result = result
                .replace(/\n{3,}/g, '\n\n')
                .replace(/\n\n(#{1,6}\s)/g, '\n$1')
                .replace(/(#{1,6}[^\n]+)\n\n/g, '$1\n');
            
            return result;
        };

        // 1. Grab the main message content area from the loading message
        const contentEl = loadingMsg.querySelector('.flare-message-content');
        if (!contentEl) return;

        // 2. Grab the "flare-markdown-content" container (for normal streaming text)
        const markdownContainer = contentEl.querySelector('.flare-markdown-content');
        if (!(markdownContainer instanceof HTMLElement)) return;

        // 3. If this is a reasoning-capable model, we need to split reasoning vs. normal text.
        if (settings.isReasoningModel) {
            // a) Find or create the separate containers for reasoning and normal/response content.
            let reasoningContainer = contentEl.querySelector('.flare-reasoning-content') as HTMLElement | null;
            let responseContainer = contentEl.querySelector('.flare-response-content') as HTMLElement | null;

            // Create them once if needed
            if (!reasoningContainer) {
                reasoningContainer = markdownContainer.createDiv({ cls: 'flare-reasoning-content' });
                reasoningContainer.setAttribute('data-reasoning-blocks', '[]');
                reasoningContainer.setAttribute('data-partial-block', '');
                reasoningContainer.style.display = 'none'; // hidden until user expands
            }
            if (!responseContainer) {
                responseContainer = markdownContainer.createDiv({ cls: 'flare-response-content' });
                // Create markdown container for response if it doesn't exist
                if (!responseContainer.querySelector('.markdown-rendered')) {
                    responseContainer.createDiv('markdown-rendered');
                }
            }

            // b) Retrieve the partial-block state, previously-detected reasoning blocks, etc.
            const existingBlocksStr = reasoningContainer.getAttribute('data-reasoning-blocks') || '[]';
            const existingBlocks = JSON.parse(existingBlocksStr) as string[];
            const partialBlock = reasoningContainer.getAttribute('data-partial-block') || '';

            // Combine the old partial plus the new tokens
            let currentContent = partialBlock + newContent;

            // c) Regex set for reasoning start/end
            const reasoningHeader = settings.reasoningHeader || '<think>';
            const reasoningEndTag = reasoningHeader.replace('<', '</');
            const escapedHeader = this.escapeRegexSpecials(reasoningHeader);
            const escapedEndTag = this.escapeRegexSpecials(reasoningEndTag);
            const allReasoningRegex = new RegExp(`${escapedHeader}([\\s\\S]*?)${escapedEndTag}`, 'g');

            let lastIndex = 0;
            let match: RegExpExecArray | null;
            let remainingContent = '';
            let newPartialBlock = '';

            // d) Loop through all reasoning blocks within currentContent
            while ((match = allReasoningRegex.exec(currentContent)) !== null) {
                // Everything before this block is normal text
                if (match.index > lastIndex) {
                    remainingContent += currentContent.slice(lastIndex, match.index);
                }
                // The reasoning content (match[1]) is fully complete, so store it
                if (match[1]) {
                    // Clean up the reasoning block content
                    const cleanedBlock = match[1].trim().replace(/\n{3,}/g, '\n\n');
                    existingBlocks.push(cleanedBlock);
                }
                lastIndex = match.index + match[0].length;
            }

            // e) Add leftover text after the final block
            if (lastIndex < currentContent.length) {
                const tail = currentContent.slice(lastIndex);
                // If we see a new reasoning-header but no matching end tag, store that as partial
                const headerPos = tail.indexOf(reasoningHeader);
                if (headerPos >= 0 && !tail.includes(reasoningEndTag)) {
                    // means we started a reasoning block but didn't finish
                    newPartialBlock = tail.slice(headerPos);
                    remainingContent += tail.slice(0, headerPos);
                } else {
                    // it's normal text
                    remainingContent += tail;
                }
            }

            // f) Update the stored states
            reasoningContainer.setAttribute('data-reasoning-blocks', JSON.stringify(existingBlocks));
            reasoningContainer.setAttribute('data-partial-block', newPartialBlock);

            // g) Only show response content if we have any
            if (remainingContent.trim()) {
                markdownContainer.removeClass('is-empty');
                const currentResponseDiv = responseContainer.querySelector('.markdown-rendered') as HTMLElement;
                if (currentResponseDiv) {
                    // Get existing text and smooth out the new content
                    const existingText = currentResponseDiv.textContent || '';
                    const smoothedContent = smoothContent(remainingContent, existingText);
                    currentResponseDiv.textContent = existingText + smoothedContent;
                }
            }

            // h) If we have at least one complete reasoning block, ensure we show the plus toggle
            if (existingBlocks.length > 0) {
                const actions = loadingMsg.querySelector('.flare-message-actions');
                if (actions && !actions.querySelector('[aria-label="Toggle reasoning"]')) {
                    // Add toggle button
                    const messageId = loadingMsg.getAttribute('data-message-id') || `message-${Date.now()}`;
                    loadingMsg.setAttribute('data-message-id', messageId);

                    const expandBtn = actions.createEl('button', {
                        cls: 'flare-action-button',
                        attr: { 'aria-label': 'Toggle reasoning' }
                    });
                    setIcon(expandBtn, 'plus-circle');
                    
                    expandBtn.onclick = async () => {
                        const isExpanded = this.expandedReasoningMessages.has(messageId);
                        if (isExpanded) {
                            // Hide reasoning
                            this.expandedReasoningMessages.delete(messageId);
                            reasoningContainer?.classList.remove('is-expanded');
                            expandBtn.classList.remove('is-active');
                            setIcon(expandBtn, 'plus-circle');
                            // Wait a moment before visually hiding
                            setTimeout(() => {
                                if (!this.expandedReasoningMessages.has(messageId)) {
                                    reasoningContainer!.style.display = 'none';
                                }
                            }, 300);
                        } else {
                            // Expand
                            reasoningContainer!.style.display = 'block';
                            // Force reflow
                            void reasoningContainer!.offsetHeight;
                            // Render the reasoning blocks if not already done
                            if (!reasoningContainer?.querySelector('.markdown-rendered')) {
                                const joinedReasoning = existingBlocks.join('\n\n---\n\n');
                                if (reasoningContainer) {  // Add null check
                                    await MarkdownRenderer.renderMarkdown(joinedReasoning, reasoningContainer, '', this.plugin);
                                }
                            }
                            this.expandedReasoningMessages.add(messageId);
                            reasoningContainer!.classList.add('is-expanded');
                            expandBtn.classList.add('is-active');
                            setIcon(expandBtn, 'minus-circle');
                        }
                    };
                }
            }
        } else {
            // For non-reasoning models, just append text while preserving appropriate newlines
            markdownContainer.removeClass('is-empty');
            let currentContent = markdownContainer.querySelector('.markdown-rendered');
            if (!currentContent) {
                currentContent = markdownContainer.createDiv('markdown-rendered');
            }
            if (!(currentContent instanceof HTMLElement)) return;

            // Get existing text and smooth out the new content
            const existingText = currentContent.textContent || '';
            const smoothedContent = smoothContent(newContent, existingText);
            currentContent.textContent = existingText + smoothedContent;
        }

        // 4. Scroll to bottom if user is near bottom
        requestAnimationFrame(() => {
            if (this.messagesEl instanceof HTMLElement) {
                const shouldScroll = this.messagesEl.scrollHeight - this.messagesEl.scrollTop <= CONSTANTS.SCROLL_THRESHOLD;
                if (shouldScroll) {
                    this.messagesEl.scrollTop = this.messagesEl.scrollHeight;
                }
            }
        });
    }

    // Add a helper method for getting flare metadata
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

        // Update history window to context window in metadata
        if (typeof settings.historyWindow === 'number') {
            metadata['Context Window'] = settings.historyWindow.toString();
        }

        // Update handoff window to handoff context in metadata
        if (typeof settings.handoffWindow === 'number') {
            metadata['Handoff Context'] = settings.handoffWindow.toString();
        }

        return metadata;
    }

    // Add a helper method for formatting metadata
    private formatMetadata(metadata: Record<string, string>): string {
        return Object.entries(metadata)
            .map(([key, value]) => `${key}: ${value}`)
            .join('\n');
    }

    private async addMessage(
        role: 'user' | 'assistant' | 'system', 
        content: string, 
        settings?: MessageSettings,
        addToHistoryManager: boolean = true
    ) {
        if (!this.messagesEl) return;

        // Create message container
        const messageEl = this.messagesEl.createDiv({
            cls: `flare-message ${role}`
        });

        // Store original content for comparison
        messageEl.setAttribute('data-content', content);

        // Create message content
        const contentEl = messageEl.createDiv('flare-message-content');

        // Add metadata (timestamp, etc) and actions early
        const metaEl = messageEl.createDiv('flare-message-meta');
        // Only add a timestamp if it's not a system message
        if (role !== 'system') {
            const timestamp = moment().format('h:mm A');
            metaEl.createSpan('flare-message-time').setText(timestamp);
        }

        // Add action buttons container early
        const actions = metaEl.createDiv('flare-message-actions');

        // Handle system messages differently
        if (role === 'system') {
            messageEl.removeClass('flare-message');
            messageEl.addClass('flare-system-message');
            
            try {
                const switchContent = JSON.parse(content);
                const mainText = contentEl.createDiv('flare-system-main');
                
                // If it's a temperature message
                if (switchContent.metadata?.type === 'temperature') {
                    const tempDisplay = mainText.createSpan('flare-name');
                    const tempIcon = tempDisplay.createSpan();
                    setIcon(tempIcon, 'thermometer');
                    tempDisplay.createSpan().setText(switchContent.main);
                } else {
                    // Otherwise it's a flare switch message
                    const flareName = mainText.createSpan('flare-name');
                    const flameIcon = flareName.createSpan();
                    setIcon(flameIcon, 'flame');
                    flareName.createSpan().setText(switchContent.main);
                    
                    // Create metadata container with complete metadata
                    const metadataEl = flareName.createDiv('flare-metadata');
                    
                    // Get metadata directly from the content
                    const metadata = this.getFlareMetadata({
                        ...switchContent.metadata,
                        flare: switchContent.main.replace('@', ''),
                        isReasoningModel: switchContent.metadata.isReasoningModel,
                        reasoningHeader: switchContent.metadata.reasoningHeader
                    });
                    
                    Object.entries(metadata).forEach(([key, value]) => {
                        const item = metadataEl.createDiv('flare-metadata-item');
                        item.createSpan('metadata-key').setText(key + ':');
                        item.createSpan('metadata-value').setText(' ' + value);
                    });
                }
            } catch (error) {
                console.error('Error parsing system message:', error);
                contentEl.setText(content);
            }
        } else {
            // For user/assistant messages, render markdown
            if (role === 'assistant' && settings) {
                // Create a container for the flare name and content
                const contentWrapper = contentEl.createDiv('flare-content-wrapper');
                
                // Add flare info for assistant messages
                const mainText = contentWrapper.createDiv('flare-system-main');
                
                // Create flare name with info button
                const flareName = mainText.createSpan('flare-name');
                const flameIcon = flareName.createSpan();
                setIcon(flameIcon, 'flame');
                flareName.createSpan().setText(`@${settings.flare || 'default'}`);
                
                // Create metadata container
                const metadataEl = flareName.createDiv('flare-metadata');
                const metadata = this.getFlareMetadata(settings);
                Object.entries(metadata).forEach(([key, value]) => {
                    const item = metadataEl.createDiv('flare-metadata-item');
                    item.createSpan('metadata-key').setText(key + ':');
                    item.createSpan('metadata-value').setText(' ' + value);
                });

                // Create a container for the markdown content
                const markdownContainer = contentWrapper.createDiv('flare-markdown-content');

                // Check if this is a reasoning model response
                const reasoningHeader = settings.reasoningHeader || '<think>';
                const reasoningEndTag = reasoningHeader.replace('<', '</');
                
                // Get unique ID for this message
                const messageId = `message-${Date.now()}`;
                messageEl.setAttribute('data-message-id', messageId);

                // Escape special characters for the final extraction
                const escapedHeader = this.escapeRegexSpecials(reasoningHeader);
                const escapedEndTag = this.escapeRegexSpecials(reasoningEndTag);

                // Extract all reasoning blocks
                const reasoningRegex = new RegExp(`${escapedHeader}([\\s\\S]*?)${escapedEndTag}`, 'g');
                const reasoningBlocks: string[] = [];
                let responsePart = content;
                let match;

                while ((match = reasoningRegex.exec(content)) !== null) {
                    const [fullMatch, reasoningContent] = match;
                    if (reasoningContent.trim()) {
                        reasoningBlocks.push(reasoningContent.trim());
                    }
                    // Remove this reasoning block from the response part
                    responsePart = responsePart.replace(fullMatch, '');
                }

                const hasReasoning = reasoningBlocks.length > 0;
                
                if (hasReasoning && settings.isReasoningModel) {
                    // Create reasoning container (initially hidden)
                    const reasoningContainer = markdownContainer.createDiv('flare-reasoning-content');
                    reasoningContainer.style.display = 'block';
                    reasoningContainer.style.opacity = '0';
                    reasoningContainer.style.height = '0';
                    reasoningContainer.style.overflow = 'hidden';
                    reasoningContainer.style.transition = 'opacity 0.2s ease, height 0.2s ease';
                    
                    if (this.expandedReasoningMessages.has(messageId)) {
                        reasoningContainer.style.opacity = '1';
                        reasoningContainer.style.height = 'auto';
                    }
                    
                    // Render all reasoning blocks
                    if (reasoningBlocks.length > 0) {
                        // Join reasoning blocks with dividers
                        const reasoningContent = reasoningBlocks.join('\n\n---\n\n');
                        await MarkdownRenderer.renderMarkdown(reasoningContent, reasoningContainer, '', this.plugin);
                    } else {
                        reasoningContainer.setText('No reasoning content found.');
                    }

                    // Create response container
                    const responseContainer = markdownContainer.createDiv('flare-response-content');
                    if (responsePart.trim()) {
                        await MarkdownRenderer.renderMarkdown(responsePart.trim(), responseContainer, '', this.plugin);
                    }

                    // Add expand/collapse button to actions
                    const expandBtn = actions.createEl('button', {
                        cls: 'flare-action-button',
                        attr: { 'aria-label': 'Toggle reasoning' }
                    });
                    setIcon(expandBtn, this.expandedReasoningMessages.has(messageId) ? 'minus-circle' : 'plus-circle');
                    expandBtn.onclick = async () => {
                        const isExpanded = this.expandedReasoningMessages.has(messageId);
                        if (isExpanded) {
                            this.expandedReasoningMessages.delete(messageId);
                            reasoningContainer.style.opacity = '0';
                            reasoningContainer.style.height = '0';
                            setIcon(expandBtn, 'plus-circle');
                            // Wait for animation to complete before hiding
                            setTimeout(() => {
                                if (!this.expandedReasoningMessages.has(messageId)) {
                                    reasoningContainer.style.display = 'none';
                                }
                            }, 200);
                        } else {
                            this.expandedReasoningMessages.add(messageId);
                            reasoningContainer.style.display = 'block';
                            // Force a reflow
                            void reasoningContainer.offsetHeight;
                            reasoningContainer.style.opacity = '1';
                            reasoningContainer.style.height = 'auto';
                            setIcon(expandBtn, 'minus-circle');
                        }
                    };
                } else {
                    // No reasoning found, just render the content normally
                    await MarkdownRenderer.renderMarkdown(content, markdownContainer, '', this.plugin);
                }
            } else {
                // For user messages, render markdown directly in the content element
                await MarkdownRenderer.renderMarkdown(content, contentEl, '', this.plugin);
            }
            
            // Add standard action buttons
            const copyBtn = actions.createEl('button', {
                cls: 'flare-action-button',
                attr: { 'aria-label': 'Copy message' }
            });
            setIcon(copyBtn, 'copy');
            copyBtn.onclick = () => {
                navigator.clipboard.writeText(content);
                new Notice('Message copied to clipboard');
            };

            // Delete button for both user and assistant messages
            const deleteBtn = actions.createEl('button', {
                cls: 'flare-action-button delete',
                attr: { 'aria-label': 'Delete message' }
            });
            setIcon(deleteBtn, 'trash-2');
            deleteBtn.onclick = async () => {
                // Get the current content from the data-content attribute or fallback to original
                const currentContent = messageEl.getAttribute('data-content') || content;
                
                // Remove from UI
                messageEl.remove();

                // Find message index
                const index = this.messageHistory.findIndex(m => 
                    m.role === role && m.content === currentContent
                );
                
                if (index !== -1) {
                    // Reset lastUsedFlare only if we're deleting the message that established the current flare
                    const messageSettings = this.messageHistory[index]?.settings;
                    if (messageSettings?.flare === this.plugin.lastUsedFlare) {
                        // Check if any later messages use this flare
                        const laterFlareMessage = this.messageHistory.slice(index + 1)
                            .some(m => m.settings?.flare === this.plugin.lastUsedFlare);
                        if (!laterFlareMessage) {
                            this.plugin.lastUsedFlare = null;
                        }
                    }

                    // Remove from local messageHistory
                    this.messageHistory.splice(index, 1);

                    // Also remove from ChatHistoryManager
                    const history = await this.plugin.chatHistoryManager.getCurrentHistory();
                    if (history) {
                        history.messages = history.messages.filter(
                            (m: { role: string; content: string }) => 
                                !(m.role === role && m.content === currentContent)
                        );
                        history.lastModified = Date.now();
                        await this.plugin.chatHistoryManager.saveCurrentHistory();
                    }
                }
            };

            // Add buttons to actions container
            actions.appendChild(copyBtn);
            actions.appendChild(deleteBtn);
        }

        // Scroll to bottom
        this.messagesEl.scrollTop = this.messagesEl.scrollHeight;

        return messageEl;
    }

    private truncateModelName(model: string, maxLength: number = 20): string {
        if (model.length <= maxLength) return model;
        return '...' + model.slice(-maxLength);
    }

    private setupInfoPanelToggle(infoButton: HTMLElement, infoPanel: HTMLElement, container: HTMLElement) {
            const toggleInfo = (e: Event) => {
                e.preventDefault();
                e.stopPropagation();
                
                // Close any other open panels first
                document.querySelectorAll('.flare-info-panel.is-visible').forEach(panel => {
                    if (panel !== infoPanel) {
                        panel.removeClass('is-visible');
                    }
                });
                
                // Toggle classes with proper boolean value
                const isVisible = !infoPanel.hasClass('is-visible');
                infoPanel.toggleClass('is-visible', isVisible);
                infoButton.toggleClass('is-active', isVisible);
                
                // Add click outside listener to close panel
                if (isVisible) {
                    setTimeout(() => {
                        document.addEventListener('click', function closePanel(e) {
                        if (!container.contains(e.target as Node)) {
                                infoPanel.removeClass('is-visible');
                                infoButton.removeClass('is-active');
                                document.removeEventListener('click', closePanel);
                            }
                        });
                    }, 0);
                }
            };
            
            infoButton.onclick = toggleInfo;
    }

    private sanitizeTitle(title: string): string {
        // Remove invalid filename characters
        let sanitized = title.replace(/[\\/:*?"<>|]/g, '');
        
        // Trim whitespace and dots from ends (dots at end can cause issues on some filesystems)
        sanitized = sanitized.trim().replace(/\.+$/, '');
        
        // Limit length (most filesystems have a 255 char limit, but we'll be more conservative)
        const MAX_LENGTH = 100;
        if (sanitized.length > MAX_LENGTH) {
            sanitized = sanitized.slice(0, MAX_LENGTH).trim();
        }
        
        // Ensure we have a valid title
        if (!sanitized) {
            sanitized = 'Untitled Chat';
        }
        
        return sanitized;
    }

    private async handleFlareSwitch(flare: FlareConfig | undefined) {
        // Enable/disable interactions based on flare presence
        const modelControl = this.containerEl.querySelector('.flare-model-control');
        const tempControl = this.containerEl.querySelector('.flare-temp-control');
        
        if (modelControl) {
            if (flare) {
                modelControl.removeClass('is-disabled');
                // Update model display
                if (this.modelDisplayEl) {
                    this.modelDisplayEl.setText(flare.model ? this.truncateModelName(flare.model, 30) : '--');
                }
            } else {
                modelControl.addClass('is-disabled');
                if (this.modelDisplayEl) {
                    this.modelDisplayEl.setText('--');
                }
            }
        }
        
        if (tempControl) {
            if (flare) {
                tempControl.removeClass('is-disabled');
            } else {
                tempControl.addClass('is-disabled');
            }
        }
        
        if (this.inputEl) {
            // Keep input enabled always to allow @flarename commands
            this.inputEl.value = '';
            // Update placeholder based on current flare
            this.inputEl.setAttribute('placeholder', flare ? `@${flare.name}` : '@flarename or select a flare');
        }

        if (flare) {
            // Always update temperature to flare's default
            this.currentTemp = flare.temperature ?? 0.7;
            if (this.tempDisplayEl) {
                this.tempDisplayEl.setText(this.currentTemp.toFixed(2));
            }

            if (this.plugin.settings.debugLoggingEnabled) {
                console.log('Flare Config:', {
                    name: flare.name,
                    isReasoningModel: flare.isReasoningModel,
                    reasoningHeader: flare.reasoningHeader
                });
            }

            // Add a "system" message to note that we switched flares
            const switchContent = {
                main: `@${flare.name}`,
                metadata: {
                    flare: flare.name,
                    provider: flare.provider,
                    model: flare.model,
                    temperature: flare.temperature ?? 0.7,
                    maxTokens: flare.maxTokens,
                    historyWindow: flare.historyWindow ?? -1,
                    handoffWindow: flare.handoffWindow ?? -1,
                    stream: flare.stream ?? true,
                    isReasoningModel: flare.isReasoningModel,
                    reasoningHeader: flare.reasoningHeader
                }
            };

            if (this.plugin.settings.debugLoggingEnabled) {
                console.log('Switch Content Metadata:', switchContent.metadata);
            }

            // Only add the system message to UI, not to history
            await this.addMessage('system', JSON.stringify(switchContent), switchContent.metadata, false);

            // Set the current flare and activate flare switch mode
            this.currentFlare = flare;
            this.plugin.isFlareSwitchActive = true;

            // Reload flares to ensure list is up to date
            await this.plugin.flareManager.loadFlares();
        } else {
            // Clear current flare and deactivate flare switch mode
            this.currentFlare = undefined;
            this.plugin.isFlareSwitchActive = false;
        }
    }

    private async updateModelSelector(flare: FlareConfig) {
        const modelSelect = this.containerEl.querySelector('.flare-model-select') as HTMLSelectElement;
        if (!modelSelect) return;

        // Clear existing options except the placeholder
        while (modelSelect.options.length > 1) {
            modelSelect.remove(1);
        }

        try {
            // Get available models for the provider
            const providerSettings = this.plugin.settings.providers[flare.provider];
            console.debug('Provider settings:', providerSettings);
            console.debug('Current flare:', this.currentFlare);
            
            // Check if we have visible models
            if (!providerSettings?.visibleModels?.length) {
                // Try getting enabled models instead
                if (providerSettings?.enabledModels?.length) {
                    console.debug('Using enabled models:', providerSettings.enabledModels);
                    const menu = new Menu();
                    
                    providerSettings.enabledModels.forEach((model: string) => {
                        menu.addItem(item => {
                            const displayName = this.truncateModelName(model, 30);
                            item
                                .setTitle(displayName)
                                .onClick(async () => {
                                    if (model === this.currentFlare?.model) return;
                                    
                                    // Update display
                                    if (this.modelDisplayEl) {
                                        this.modelDisplayEl.setText(displayName);
                                    }

                                    // Add system message for model change
                                    await this.addMessage('system', JSON.stringify({
                                        main: displayName,
                                        metadata: {
                                            type: 'model',
                                            from: this.currentFlare?.model,
                                            to: model
                                        }
                                    }), undefined, false);

                                    // Update current flare's model (in memory only)
                                    if (this.currentFlare) {
                                        this.currentFlare.model = model;
                                    }
                                });
                        });
                    });

                    // Show menu at model control
                    const modelControl = this.containerEl.querySelector('.flare-model-control');
                    if (modelControl) {
                        const rect = modelControl.getBoundingClientRect();
                        menu.showAtPosition({ x: rect.left, y: rect.bottom });
                    }
                    return;
                }
                
                console.debug('No models found in provider settings');
                new Notice('No models available for this provider');
                return;
            }

            console.debug('Using visible models:', providerSettings.visibleModels);
            const menu = new Menu();
            
            providerSettings.visibleModels.forEach((model: string) => {
                menu.addItem(item => {
                    const displayName = this.truncateModelName(model, 30);
                    item
                        .setTitle(displayName)
                        .onClick(async () => {
                            if (model === this.currentFlare?.model) return;
                            
                            // Update display
                            if (this.modelDisplayEl) {
                                this.modelDisplayEl.setText(displayName);
                            }

                            // Add system message for model change
                            await this.addMessage('system', JSON.stringify({
                                main: displayName,
                                metadata: {
                                    type: 'model',
                                    from: this.currentFlare?.model,
                                    to: model
                                }
                            }), undefined, false);

                            // Update current flare's model (in memory only)
                            if (this.currentFlare) {
                                this.currentFlare.model = model;
                            }
                        });
                });
            });

            // Show menu at model control
            const modelControl = this.containerEl.querySelector('.flare-model-control');
            if (modelControl) {
                const rect = modelControl.getBoundingClientRect();
                menu.showAtPosition({ x: rect.left, y: rect.bottom });
            }
        } catch (error) {
            console.error('Error showing model selector:', error);
            new Notice('Failed to show model selector');
        }
    }

    private async updateSystemMessage(messageEl: HTMLElement, content: SystemMessageContent) {
        const contentEl = messageEl.querySelector('.flare-message-content');
        if (contentEl) {
            contentEl.empty();
            
            // Create a container for the flare name and content
            const contentWrapper = contentEl.createDiv('flare-content-wrapper');
            
            // Add flare info for assistant messages
            const mainText = contentWrapper.createDiv('flare-system-main');
            
            // Handle different types of system messages
            const metadata = content.metadata || {};
            if (metadata.type === 'model') {
                // For model changes, use circuit icon
                const modelText = mainText.createSpan('flare-name');
                const circuitIcon = modelText.createSpan();
                setIcon(circuitIcon, 'circuit-board');
                modelText.createSpan().setText(content.main.replace('Model: ', ''));

                // Add metadata for model changes too
                const metadataEl = modelText.createDiv('flare-metadata');
                const flareMetadata = this.getFlareMetadata({
                    ...metadata,
                    model: content.main,
                    isReasoningModel: this.currentFlare?.isReasoningModel,
                    reasoningHeader: this.currentFlare?.reasoningHeader
                });
                Object.entries(flareMetadata).forEach(([key, value]) => {
                    const item = metadataEl.createDiv('flare-metadata-item');
                    item.createSpan('metadata-key').setText(key + ':');
                    item.createSpan('metadata-value').setText(' ' + value);
                });
            } else if (content.main.startsWith('@')) {
                // For flare switches
                const flareName = mainText.createSpan('flare-name');
                const flameIcon = flareName.createSpan();
                setIcon(flameIcon, 'flame');
                flareName.createSpan().setText(content.main);
                
                // Create metadata container with complete metadata
                const metadataEl = flareName.createDiv('flare-metadata');
                const flareMetadata = this.getFlareMetadata({
                    ...metadata,
                    flare: content.main.replace('@', ''),
                    isReasoningModel: this.currentFlare?.isReasoningModel,
                    reasoningHeader: this.currentFlare?.reasoningHeader
                });
                Object.entries(flareMetadata).forEach(([key, value]) => {
                    const item = metadataEl.createDiv('flare-metadata-item');
                    item.createSpan('metadata-key').setText(key + ':');
                    item.createSpan('metadata-value').setText(' ' + value);
                });
            } else {
                // For temperature changes
                const tempDisplay = mainText.createSpan('flare-name');
                const tempIcon = tempDisplay.createSpan();
                setIcon(tempIcon, 'thermometer');
                tempDisplay.createSpan().setText(content.main);
                
                // Add metadata for temperature changes too
                const metadataEl = tempDisplay.createDiv('flare-metadata');
                const flareMetadata = this.getFlareMetadata({
                    ...metadata,
                    temperature: parseFloat(content.main),
                    isReasoningModel: this.currentFlare?.isReasoningModel,
                    reasoningHeader: this.currentFlare?.reasoningHeader
                });
                Object.entries(flareMetadata).forEach(([key, value]) => {
                    const item = metadataEl.createDiv('flare-metadata-item');
                    item.createSpan('metadata-key').setText(key + ':');
                    item.createSpan('metadata-value').setText(' ' + value);
                });
            }
        }
    }

    private async showModelSelector() {
        if (!this.currentFlare) return;

        try {
            // Get available models for the provider
            const providerSettings = this.plugin.settings.providers[this.currentFlare.provider];
            console.debug('Provider settings:', providerSettings);
            console.debug('Current flare:', this.currentFlare);
            
            // Check if we have visible models
            if (!providerSettings?.visibleModels?.length) {
                // Try getting enabled models instead
                if (providerSettings?.enabledModels?.length) {
                    console.debug('Using enabled models:', providerSettings.enabledModels);
                    const menu = new Menu();
                    
                    providerSettings.enabledModels.forEach((model: string) => {
                        menu.addItem(item => {
                            const displayName = this.truncateModelName(model, 30);
                            item
                                .setTitle(displayName)
                                .onClick(async () => {
                                    if (model === this.currentFlare?.model) return;
                                    
                                    // Update display
                                    if (this.modelDisplayEl) {
                                        this.modelDisplayEl.setText(displayName);
                                    }

                                    // Add system message for model change
                                    await this.addMessage('system', JSON.stringify({
                                        main: displayName,
                                        metadata: {
                                            type: 'model',
                                            from: this.currentFlare?.model,
                                            to: model
                                        }
                                    }), undefined, false);

                                    // Update current flare's model (in memory only)
                                    if (this.currentFlare) {
                                        this.currentFlare.model = model;
                                    }
                                });
                        });
                    });

                    // Show menu at model control
                    const modelControl = this.containerEl.querySelector('.flare-model-control');
                    if (modelControl) {
                        const rect = modelControl.getBoundingClientRect();
                        menu.showAtPosition({ x: rect.left, y: rect.bottom });
                    }
                    return;
                }
                
                console.debug('No models found in provider settings');
                new Notice('No models available for this provider');
                return;
            }

            console.debug('Using visible models:', providerSettings.visibleModels);
            const menu = new Menu();
            
            providerSettings.visibleModels.forEach((model: string) => {
                menu.addItem(item => {
                    const displayName = this.truncateModelName(model, 30);
                    item
                        .setTitle(displayName)
                        .onClick(async () => {
                            if (model === this.currentFlare?.model) return;
                            
                            // Update display
                            if (this.modelDisplayEl) {
                                this.modelDisplayEl.setText(displayName);
                            }

                            // Add system message for model change
                            await this.addMessage('system', JSON.stringify({
                                main: displayName,
                                metadata: {
                                    type: 'model',
                                    from: this.currentFlare?.model,
                                    to: model
                                }
                            }), undefined, false);

                            // Update current flare's model (in memory only)
                            if (this.currentFlare) {
                                this.currentFlare.model = model;
                            }
                        });
                });
            });

            // Show menu at model control
            const modelControl = this.containerEl.querySelector('.flare-model-control');
            if (modelControl) {
                const rect = modelControl.getBoundingClientRect();
                menu.showAtPosition({ x: rect.left, y: rect.bottom });
            }
        } catch (error) {
            console.error('Error showing model selector:', error);
            new Notice('Failed to show model selector');
        }
    }

    async onOpen() {
        await super.onOpen();

        // Clear model selector and disable controls initially
        if (this.modelDisplayEl) {
            this.modelDisplayEl.setText('--');
        }
        if (this.tempDisplayEl) {
            this.tempDisplayEl.setText('--');
        }
        // Set initial input placeholder
        if (this.inputEl) {
            this.inputEl.setAttribute('placeholder', this.currentFlare ? `@${this.currentFlare.name}` : '@flarename or select a flare');
        }
        // Input should always be enabled to allow @flarename commands
        // ... rest of the onOpen method ...
    }

    private resetSendButton(
        button: HTMLButtonElement, 
        originalHandler?: ((this: GlobalEventHandlers, ev: MouseEvent) => any) | null
    ): void {
        this.isAborted = true;  // Set abort state when stopping
        setIcon(button, 'send');
        button.setAttribute('aria-label', 'Send message');
        button.onclick = originalHandler || null;
        this.isStreaming = false;
    }

    private async updateTempDisplay() {
        if (this.tempDisplayEl) {
            if (!this.currentFlare) {
                this.tempDisplayEl.setText('--');
                return;
            }

            this.tempDisplayEl.setText(this.currentTemp.toFixed(2));
            
            // Only show temp change message if it differs from flare default
            const flareDefaultTemp = this.currentFlare?.temperature ?? 0.7;
            if (this.currentTemp !== flareDefaultTemp) {
                // Always append new temperature message
                await this.addMessage('system', JSON.stringify({
                    main: `${this.currentTemp.toFixed(2)}`,
                    metadata: {
                        type: 'temperature'
                    }
                }), undefined, false);
            }
        }
    }

    private escapeRegexSpecials(str: string): string {
        return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    }

    private updateInputHeight() {
        if (!this.inputEl) return;

        // Reset height to auto to get scrollHeight
        this.inputEl.classList.add('is-empty');
        
        // Set height to 0 to measure content
        this.inputEl.classList.add('is-measuring');
        
        // Get content height and set CSS variable
        const contentHeight = this.inputEl.scrollHeight;
        this.inputEl.style.setProperty('--content-height', `${contentHeight}px`);
        
        // Apply content height
        this.inputEl.classList.remove('is-measuring', 'is-empty');
        this.inputEl.classList.add('has-content');
    }

    private updateSuggestionsPosition() {
        const suggestionContainer = this.containerEl.querySelector('.flare-suggestions') as HTMLElement;
        if (!suggestionContainer) return;

        // Get input wrapper for positioning reference
        const inputWrapper = this.inputEl.closest('.flare-input-wrapper') as HTMLElement;
        if (!inputWrapper) return;

        const wrapperRect = inputWrapper.getBoundingClientRect();
        const viewportHeight = window.innerHeight;
        const viewportWidth = window.innerWidth;
        
        // Calculate available space above and below input
        const spaceAbove = wrapperRect.top;
        const spaceBelow = viewportHeight - wrapperRect.bottom;

        // Calculate dimensions
        const containerWidth = Math.min(viewportWidth * 0.9, 400);
        const leftOffset = (viewportWidth - containerWidth) / 2;
        
        // Set CSS custom properties for positioning
        suggestionContainer.addClass('position-fixed');
        suggestionContainer.style.setProperty('--container-width', `${containerWidth}px`);
        suggestionContainer.style.setProperty('--left-offset', `${leftOffset}px`);
        
        // Get suggestions inner container
        const suggestionsInner = suggestionContainer.querySelector('.flare-suggestions-container') as HTMLElement;
        if (suggestionsInner) {
            // Set max height based on available space
            const maxHeight = Math.max(spaceAbove, spaceBelow) - 20;
            suggestionsInner.style.setProperty('--max-height', `${maxHeight}px`);
        }
        
        // Position above or below based on available space
        if (spaceBelow >= spaceAbove) {
            suggestionContainer.addClass('position-bottom');
            suggestionContainer.removeClass('position-top');
            suggestionContainer.style.setProperty('--bottom-offset', `${wrapperRect.bottom + 8}px`);
        } else {
            suggestionContainer.addClass('position-top');
            suggestionContainer.removeClass('position-bottom');
            suggestionContainer.style.setProperty('--top-offset', `${viewportHeight - wrapperRect.top + 8}px`);
        }
    }

    private toggleReasoningVisibility(messageEl: HTMLElement) {
        const reasoningContent = messageEl.querySelector('.flare-reasoning-content');
        if (reasoningContent) {
            reasoningContent.classList.toggle('is-expanded');
        }
    }

    async saveChat(error?: Error) {
        try {
            // ... existing code ...
        } catch (error) {
            console.error('Error saving chat:', error);
        }
    }

    private async handleError(error: unknown, message: string) {
        console.error(message, error);
        new Notice(message + ': ' + getErrorMessage(error));
    }

    private async finalizeMessageRender(
        loadingMsg: HTMLElement,
        content: string,
        settings: MessageSettings
    ) {
        loadingMsg.removeClass('is-loading');
        const contentEl = loadingMsg.querySelector('.flare-message-content');
        if (!contentEl) return;

        const markdownContainer = contentEl.querySelector('.flare-markdown-content');
        if (!(markdownContainer instanceof HTMLElement)) return;

        // Helper function to clean up content before rendering
        const cleanContent = (text: string): string => {
            // Normalize line endings
            let cleaned = text.replace(/\r\n/g, '\n');
            
            // Fix list item spacing and remove extra newlines between list items
            cleaned = cleaned.replace(/^([-*])\s+/gm, '$1 ');  // Unordered lists
            cleaned = cleaned.replace(/^(\d+\.)\s+/gm, '$1 '); // Ordered lists
            
            // Handle headings - ensure exactly one newline before and after
            cleaned = cleaned.replace(/\n{2,}(#{1,6}\s)/g, '\n$1');  // Before headings
            cleaned = cleaned.replace(/(#{1,6}[^\n]+)\n{2,}/g, '$1\n'); // After headings
            
            // Split into lines for more complex processing
            const lines = cleaned.split('\n');
            const result = lines.map((line, i): string => {
                // Trim each line
                line = line.trimStart();
                
                // Skip empty lines between list items
                if (!line && i > 0 && i < lines.length - 1) {
                    const prevIsListItem = lines[i-1].match(/^[-*]\s|^\d+\.\s/);
                    const nextIsListItem = lines[i+1].match(/^[-*]\s|^\d+\.\s/);
                    if (prevIsListItem && nextIsListItem) return '';
                }
                
                // Handle list item continuations
                if (i > 0 && !line.match(/^[-*]\s|^\d+\.\s|^#{1,6}\s/) && 
                    lines[i-1].match(/^[-*]\s|^\d+\.\s/)) {
                    return '  ' + line;
                }
                
                return line;
            });
            
            // Join lines and clean up multiple newlines
            cleaned = result.filter(line => line !== undefined).join('\n');
            
            // Final cleanup of multiple newlines, preserving at most double newlines
            cleaned = cleaned.replace(/\n{3,}/g, '\n\n');
            
            // Ensure single newline after list items unless it's the end of a list
            cleaned = cleaned.replace(/^([-*]|\d+\.)\s[^\n]+\n{2,}(?=[-*]|\d+\.)/gm, '$&\n');
            
            return cleaned.trim();
        };

        if (settings.isReasoningModel) {
            // Get reasoning container and response container
            const reasoningContainer = markdownContainer.querySelector('.flare-reasoning-content') as HTMLElement;
            const responseContainer = markdownContainer.querySelector('.flare-response-content') as HTMLElement;
            
            if (reasoningContainer && responseContainer) {
                // Extract reasoning blocks and response content
                const reasoningHeader = settings.reasoningHeader || '<think>';
                const reasoningEndTag = reasoningHeader.replace('<', '</');
                const escapedHeader = this.escapeRegexSpecials(reasoningHeader);
                const escapedEndTag = this.escapeRegexSpecials(reasoningEndTag);
                const allReasoningRegex = new RegExp(`${escapedHeader}([\\s\\S]*?)${escapedEndTag}`, 'g');
                
                const reasoningBlocks: string[] = [];
                let responsePart = content;
                let match;

                // First collect all reasoning blocks
                while ((match = allReasoningRegex.exec(content)) !== null) {
                    if (match[1]) {
                        reasoningBlocks.push(match[1].trim());
                    }
                }

                // Then remove all reasoning blocks from response
                responsePart = content.replace(allReasoningRegex, '').trim();

                // Store reasoning blocks for later rendering
                reasoningContainer.setAttribute('data-reasoning-blocks', JSON.stringify(reasoningBlocks));
                reasoningContainer.style.display = 'none';
                reasoningContainer.classList.remove('is-expanded');

                // Only render the response part
                const responseDiv = responseContainer.querySelector('.markdown-rendered') as HTMLElement;
                if (responseDiv) {
                    responseDiv.empty();
                    // Clean up the response content before rendering
                    const cleanedResponse = cleanContent(responsePart);
                    await MarkdownRenderer.renderMarkdown(
                        cleanedResponse,
                        responseDiv,
                        '',
                        this.plugin
                    );
                }

                // Add toggle button if we have reasoning blocks
                if (reasoningBlocks.length > 0) {
                    const actions = loadingMsg.querySelector('.flare-message-actions');
                    if (actions && !actions.querySelector('[aria-label="Toggle reasoning"]')) {
                        const messageId = loadingMsg.getAttribute('data-message-id') || `message-${Date.now()}`;
                        loadingMsg.setAttribute('data-message-id', messageId);

                        const expandBtn = actions.createEl('button', {
                            cls: 'flare-action-button',
                            attr: { 'aria-label': 'Toggle reasoning' }
                        });
                        setIcon(expandBtn, 'plus-circle');
                        
                        expandBtn.onclick = () => {
                            const isExpanded = this.expandedReasoningMessages.has(messageId);
                            if (isExpanded) {
                                // Hide reasoning
                                this.expandedReasoningMessages.delete(messageId);
                                reasoningContainer.classList.remove('is-expanded');
                                expandBtn.classList.remove('is-active');
                                setIcon(expandBtn, 'plus-circle');
                                // Wait a moment before visually hiding
                                setTimeout(() => {
                                    if (!this.expandedReasoningMessages.has(messageId)) {
                                        reasoningContainer.style.display = 'none';
                                    }
                                }, 300);
                            } else {
                                // Expand
                                reasoningContainer.style.display = 'block';
                                // Force reflow
                                void reasoningContainer.offsetHeight;
                                // Render the reasoning blocks if not already done
                                if (!reasoningContainer.querySelector('.markdown-rendered')) {
                                    const joinedReasoning = reasoningBlocks.join('\n\n---\n\n');
                                    // Clean up the reasoning content before rendering
                                    const cleanedReasoning = cleanContent(joinedReasoning);
                                    MarkdownRenderer.renderMarkdown(cleanedReasoning, reasoningContainer, '', this.plugin);
                                }
                                this.expandedReasoningMessages.add(messageId);
                                reasoningContainer.classList.add('is-expanded');
                                expandBtn.classList.add('is-active');
                                setIcon(expandBtn, 'minus-circle');
                            }
                        };
                    }
                }
            }
        } else {
            // For non-reasoning models, just render the full content
            markdownContainer.empty();
            // Clean up the content before rendering
            const cleanedContent = cleanContent(content);
            await MarkdownRenderer.renderMarkdown(
                cleanedContent,
                markdownContainer,
                '',
                this.plugin
            );
        }

        // Save history after each message exchange
        await this.plugin.chatHistoryManager.saveCurrentHistory();
        
        // Check if we should auto-generate title
        const titleEl = this.containerEl.querySelector('.flare-toolbar-center h2');
        const currentFile = await this.plugin.chatHistoryManager.getCurrentFile();
        if (titleEl && 
            currentFile && 
            titleEl.textContent === 'New Chat' && 
            !this.isTitleGenerationInProgress) {
            const titleSettings = this.plugin.settings.titleSettings;
            // Only proceed if auto-generate is enabled
            if (titleSettings.autoGenerate) {
                // Calculate number of complete message pairs (user + assistant)
                const messagePairs = Math.floor(this.messageHistory.filter(m => 
                    m.role !== 'system' && !m.settings?.truncated
                ).length / 2);
                
                if (messagePairs >= (titleSettings.autoGenerateAfterPairs || 2)) {
                    // Set flag before starting generation
                    this.isTitleGenerationInProgress = true;
                    // Run title generation in the background
                    this.handleTitleGeneration()
                        .catch(error => {
                            console.error('Auto title generation failed:', error);
                        })
                        .finally(() => {
                            this.isTitleGenerationInProgress = false;
                        });
                }
            }
        }

        // Refresh history sidebar if it exists
        if (this.plugin.historySidebar) {
            await this.plugin.historySidebar.refresh();
        }
    }
} 