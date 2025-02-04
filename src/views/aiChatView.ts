import { ItemView, MarkdownRenderer, TFile, setIcon, Notice, App, WorkspaceLeaf, Menu, Platform, Modal, SuggestModal } from 'obsidian';
import { TempDialog } from './components/TempDialog';

// @ts-ignore
import FlarePlugin from '../main';
import { FlareConfig } from '../flares/FlareConfig';
import { HistorySidebar } from './components/HistorySidebar';
import type { Moment } from 'moment';
// @ts-ignore
import moment from 'moment';

interface MessageSettings {
    flare?: string;
    provider: string;
    model: string;
    temperature: number;
    maxTokens?: number;
    stream?: boolean;
    isFlareSwitch?: boolean;
    historyWindow?: number;
    handoffWindow?: number;
    truncated?: boolean;
    reasoningHeader?: string;
    isReasoningModel?: boolean;
}

interface ChatMessage {
    role: 'user' | 'assistant' | 'system';
    content: string;
    timestamp: number;
    settings?: MessageSettings;
}

export const VIEW_TYPE_AI_CHAT = 'ai-chat-view';

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

export class AIChatView extends ItemView {
    public messagesEl: HTMLElement;
    public inputEl: HTMLTextAreaElement;
    public modelNameEl: HTMLElement;
    public historySidebar: HistorySidebar;
    public currentFlare: FlareConfig | undefined;
    public currentTemp: number = 0.7;
    public messageHistory: Array<{role: string; content: string; settings?: any}> = [];
    public app: App;
    private tempDisplayEl: HTMLElement;
    private modelDisplayEl: HTMLElement;
    private isStreaming: boolean = false;
    private originalSendHandler: ((this: GlobalEventHandlers, ev: MouseEvent) => any) | null = null;
    private expandedReasoningMessages: Set<string> = new Set();
    private suggestionsEl: HTMLElement;

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
            this.originalSendHandler = async () => {
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
                            this.inputEl.style.height = '';  // Reset to default height instead of forcing 24px
                        }
                        const success = await this.handleTitleGeneration();
                        if (!success) {
                            new Notice('Failed to generate title');
                        }
                        return;
                    }
                    
                    // Set streaming state before sending
                    this.isStreaming = true;
                    setIcon(sendBtn, 'square');
                    sendBtn.classList.add('is-streaming');
                    sendBtn.setAttribute('aria-label', 'Stop streaming');
                    
                    try {
                        // Try to send the message
                        const success = await this.handleMessage(content);
                        // Only clear input if message was sent successfully
                        if (success) {
                            this.inputEl.value = '';
                            this.inputEl.style.height = '';  // Reset to default height instead of forcing 24px
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
            flareChooser.addEventListener('click', async (event: MouseEvent) => {
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
                                    } catch (error) {
                                        console.error('Failed to load flare config:', error);
                                        new Notice('Failed to load flare configuration');
                                    }
                                });
                        });
                    }
                    
                    // Show menu at click position
                    menu.showAtPosition({
                        x: event.clientX,
                        y: event.clientY
                    });
                } catch (error) {
                    console.error('Failed to load flares:', error);
                    new Notice('Failed to load flares');
                }
            });
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
                            await this.originalSendHandler.call(this);
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
            new Notice('Error loading chat history: ' + error.message);
            
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
                new Notice('Failed to create new chat: ' + error.message);
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
                new Notice(`Error generating title: ${error.message}`);
            }, 100);
            return false;
        }
    }

    async handleMessage(content: string): Promise<boolean> {
        // Check for title command
        if (content === '/title') {
            // Clear input field immediately
            if (this.inputEl) {
                this.inputEl.value = '';
                this.inputEl.style.height = '';  // Reset to default height instead of forcing 24px
            }
            const success = await this.handleTitleGeneration();
            if (!success) {
                new Notice('Failed to generate title');
            }
            return true;
        }

        // First check if message starts with a flare switch
        // Match both @flarename message and @flarename formats
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
            } catch (error) {
                console.error('Failed to load flare config:', error);
                new Notice(error.message);
                return false;
            }
        }

        // Verify we have a current flare
        if (!this.currentFlare) {
            new Notice('Please select a flare first');
            return false;
        }

        // Verify the current flare still exists
        const currentFlareExists = await this.plugin.app.vault.adapter.exists(
            `${this.plugin.settings.flaresFolder}/${this.currentFlare.name}.md`
        );
        if (!currentFlareExists) {
            new Notice(`Current flare "${this.currentFlare.name}" no longer exists. Please select another flare.`);
            this.currentFlare = undefined;
            return false;
        }

        // Process message normally
        try {
            await this.processMessage(content, { 
                stream: this.currentFlare?.stream ?? false,
                isFlareSwitch: false 
            });
            return true;
        } catch (error) {
            console.error('Error processing message:', error);
            new Notice('Error: ' + error.message);
            return false;
        }
    }

    // Split out the actual message processing logic
    private async processMessage(
        content: string, 
        options?: { stream?: boolean; isFlareSwitch?: boolean }
    ) {
        try {
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

            // Add user message to UI and history
            const userMessage = {
                role: 'user',
                content: content,
                settings
            };
            
            // Add to local history
            this.messageHistory.push(userMessage);
            
            // Add to ChatHistoryManager
            await this.plugin.chatHistoryManager.addMessage(userMessage);

            // Add user message to UI
            await this.addMessage('user', content, settings);

            // Create loading message
            const loadingMsg = await this.addMessage('assistant', '', settings);
            if (loadingMsg) {
                loadingMsg.addClass('is-loading');
            }

            let accumulatedContent = '';
            let isInReasoning = false;
            let displayedContent = '';
            const reasoningHeader = settings.reasoningHeader;
            const reasoningEndTag = reasoningHeader.replace('<', '</');

            // Add an escaped version for partial parsing:
            const escapedHeader = this.escapeRegexSpecials(reasoningHeader);
            const escapedEndTag = this.escapeRegexSpecials(reasoningEndTag);

            try {
                // Send message to provider
                const response = await this.plugin.handleMessage(content, {
                    flare: settings.flare,
                    provider: settings.provider,
                    model: settings.model,
                    temperature: settings.temperature,
                    maxTokens: settings.maxTokens,
                    messageHistory: this.messageHistory,
                    historyWindow: settings.historyWindow,
                    stream: settings.stream,
                    onToken: (token: string) => {
                        if (loadingMsg) {
                            accumulatedContent += token;
                            const contentEl = loadingMsg.querySelector('.flare-message-content');
                            if (contentEl) {
                                let markdownContainer = contentEl.querySelector('.flare-markdown-content') as HTMLElement;
                                if (!markdownContainer) {
                                    // First token, set up the full structure
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

                                    markdownContainer = contentWrapper.createDiv('flare-markdown-content');
                                }
                                
                                if (settings.isReasoningModel) {
                                    // Extract all reasoning blocks
                                    const reasoningRegex = new RegExp(`${escapedHeader}([\\s\\S]*?)${escapedEndTag}`, 'g');
                                    const reasoningBlocks: string[] = [];
                                    let responsePart = accumulatedContent;
                                    let match;

                                    while ((match = reasoningRegex.exec(accumulatedContent)) !== null) {
                                        const [fullMatch, reasoningContent] = match;
                                        if (reasoningContent.trim()) {
                                            reasoningBlocks.push(reasoningContent.trim());
                                        }
                                        // Remove this reasoning block from the response part
                                        responsePart = responsePart.replace(fullMatch, '');
                                    }

                                    // Only show the response part during streaming
                                    markdownContainer.empty();
                                    if (responsePart.trim()) {
                                        MarkdownRenderer.renderMarkdown(
                                            responsePart.trim(),
                                            markdownContainer,
                                            '',
                                            this.plugin
                                        );
                                    }
                                } else {
                                    // Not a reasoning model, show everything
                                    markdownContainer.empty();
                                    MarkdownRenderer.renderMarkdown(
                                        accumulatedContent,
                                        markdownContainer,
                                        '',
                                        this.plugin
                                    );
                                }
                            }
                        }
                    }
                });

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

                // Update loading message with final response
                if (loadingMsg) {
                    loadingMsg.removeClass('is-loading');
                    await this.addMessage('assistant', settings.stream ? accumulatedContent : response, settings, false);
                    loadingMsg.remove();
                }

                // Save history after each message exchange
                await this.plugin.chatHistoryManager.saveCurrentHistory();
                
                // Check if we should auto-generate title
                const titleEl = this.containerEl.querySelector('.flare-toolbar-center h2');
                const currentFile = await this.plugin.chatHistoryManager.getCurrentFile();
                if (titleEl && currentFile && titleEl.textContent === 'New Chat') {
                    const titleSettings = this.plugin.settings.titleSettings;
                    // Only proceed if auto-generate is enabled
                    if (titleSettings.autoGenerate) {
                        // Calculate number of complete message pairs (user + assistant)
                        const messagePairs = Math.floor(this.messageHistory.filter(m => m.role !== 'system').length / 2);
                        if (messagePairs >= (titleSettings.autoGenerateAfterPairs || 2)) {
                            // Generate title in the background
                            this.handleTitleGeneration().catch(error => {
                                console.error('Auto title generation failed:', error);
                            });
                        }
                    }
                }

                // Refresh history sidebar if it exists
                if (this.plugin.historySidebar) {
                    await this.plugin.historySidebar.refresh();
                }

            } catch (error) {
                // If we have accumulated content and this was a streaming request that was stopped
                if (accumulatedContent && settings.stream && error.name === 'AbortError') {
                    // Create assistant message with the truncated response
                    const assistantMessage = {
                        role: 'assistant',
                        content: accumulatedContent,
                        settings: {
                            ...settings,
                            truncated: true // Mark this response as truncated
                        }
                    };
                    
                    // Add to local history
                    this.messageHistory.push(assistantMessage);
                    
                    // Add to ChatHistoryManager and save immediately
                    await this.plugin.chatHistoryManager.addMessage(assistantMessage);
                    await this.plugin.chatHistoryManager.saveCurrentHistory();

                    // Update loading message with truncated response
                    if (loadingMsg) {
                        loadingMsg.removeClass('is-loading');
                        await this.addMessage('assistant', accumulatedContent, settings, false);
                        loadingMsg.remove();
                    }

                    // Don't show error notice for intentional stops
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
                    new Notice('Error: ' + error.message);
                }
            }
        } catch (error) {
            console.error('Error processing message:', error);
            new Notice('Error: ' + error.message);
        }
    }

    // Add a helper method for getting flare metadata
    private getFlareMetadata(settings?: MessageSettings): Record<string, string> {
        const metadata: Record<string, string> = {};
        
        // Add provider and model info
        const provider = settings?.provider ? this.plugin.settings.providers[settings.provider] : undefined;
        metadata.provider = provider?.name || settings?.provider || 'default';
        metadata.model = settings?.model ? this.truncateModelName(settings.model) : 'default';
        
        // Only show history window info if explicitly set
        if (settings?.historyWindow !== undefined) {
            if (settings.historyWindow === -1) {
                metadata['chat history'] = 'all';
            } else if (settings.historyWindow === 0) {
                metadata['chat history'] = 'none';
            } else {
                metadata['chat history'] = `${settings.historyWindow} messages`;
            }
        }

        // Only show handoff window info if explicitly set
        if (settings?.handoffWindow !== undefined) {
            if (settings.handoffWindow === -1) {
                metadata['handoff history'] = 'all';
            } else if (settings.handoffWindow === 0) {
                metadata['handoff history'] = 'none';
            } else {
                metadata['handoff history'] = `${settings.handoffWindow} messages`;
            }
        }

        // Add temperature
        metadata.temperature = settings?.temperature?.toFixed(2) || '0.70';

        // Add streaming info - default to true if undefined
        metadata.stream = settings?.stream !== false ? 'yes' : 'no';

        // Add reasoning model info - only if explicitly set
        if (settings?.isReasoningModel !== undefined) {
            metadata.reasoning = settings.isReasoningModel ? 'yes' : 'no';
            if (settings.isReasoningModel && settings.reasoningHeader) {
                metadata['reasoning header'] = settings.reasoningHeader;
            }
        }

        if (this.plugin.settings.debugLoggingEnabled) {
            console.log('Metadata Generation:', {
                input: settings,
                output: metadata
            });
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
                    expandBtn.onclick = () => {
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

    private async updateSystemMessage(messageEl: HTMLElement, content: any) {
        const contentEl = messageEl.querySelector('.flare-message-content');
        if (contentEl) {
            contentEl.empty();
            
            // Create a container for the flare name and content
            const contentWrapper = contentEl.createDiv('flare-content-wrapper');
            
            // Add flare info for assistant messages
            const mainText = contentWrapper.createDiv('flare-system-main');
            
            // Handle different types of system messages
            if (content.metadata?.type === 'model') {
                // For model changes, use circuit icon
                const modelText = mainText.createSpan('flare-name');
                const circuitIcon = modelText.createSpan();
                setIcon(circuitIcon, 'circuit-board');
                modelText.createSpan().setText(content.main.replace('Model: ', ''));

                // Add metadata for model changes too
                const metadataEl = modelText.createDiv('flare-metadata');
                const metadata = this.getFlareMetadata({
                    ...content.metadata,
                    model: content.main,
                    isReasoningModel: this.currentFlare?.isReasoningModel,
                    reasoningHeader: this.currentFlare?.reasoningHeader
                });
                Object.entries(metadata).forEach(([key, value]) => {
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
                
                // Get metadata directly from the content
                const metadata = this.getFlareMetadata({
                    ...content.metadata,
                    flare: content.main.replace('@', ''),
                    isReasoningModel: content.metadata.isReasoningModel,
                    reasoningHeader: content.metadata.reasoningHeader
                });
                
                Object.entries(metadata).forEach(([key, value]) => {
                    const item = metadataEl.createDiv('flare-metadata-item');
                    item.createSpan('metadata-key').setText(key + ':');
                    item.createSpan('metadata-value').setText(' ' + value);
                });
            } else {
                // For temperature changes and others, show the text with metadata
                const tempText = mainText.createSpan('flare-name');
                const tempIcon = tempText.createSpan();
                setIcon(tempIcon, 'thermometer');
                tempText.createSpan().setText(content.main);

                // Add metadata for temperature changes too
                const metadataEl = tempText.createDiv('flare-metadata');
                const metadata = this.getFlareMetadata({
                    ...content.metadata,
                    temperature: parseFloat(content.main),
                    isReasoningModel: this.currentFlare?.isReasoningModel,
                    reasoningHeader: this.currentFlare?.reasoningHeader
                });
                Object.entries(metadata).forEach(([key, value]) => {
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
} 