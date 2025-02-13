import { Setting, setIcon, Notice, Modal, App, DropdownComponent, TextComponent, TextAreaComponent, TFile, TAbstractFile } from 'obsidian';
import type FlarePlugin from '../../main';
import { FlareConfig } from './FlareConfig';
import { getErrorMessage } from '../utils/errors';

// Add ConfirmModal class
class ConfirmModal extends Modal {
    constructor(
        app: App,
        private title: string,
        private message: string,
        private onConfirm: () => void
    ) {
        super(app);
    }

    onOpen() {
        const { contentEl } = this;
        contentEl.empty();

        contentEl.createEl('h2', { text: this.title });
        contentEl.createEl('p', { text: this.message });

        const buttonContainer = contentEl.createDiv('modal-button-container');

        buttonContainer.createEl('button', {
            text: 'Cancel',
            cls: 'mod-secondary'
        }).onclick = () => this.close();

        buttonContainer.createEl('button', {
            text: 'Confirm',
            cls: 'mod-warning'
        }).onclick = () => {
            this.onConfirm();
            this.close();
        };
    }
}

interface LoadingState {
    operation: string;
    promise: Promise<any>;
    cancel: () => void;
}

export class FlareManager {
    private currentFlare: string | null = null;
    private hasUnsavedChanges: boolean = false;
    private originalSettings: FlareConfig | null = null;
    private currentFlareConfig: FlareConfig | null = null;
    private isLoadingFlares = false;
    private isInitialized = false;
    private pendingOperations: Map<string, LoadingState> = new Map();
    private currentLoadingOperation: string | null = null;
    private flareCache: Map<string, FlareConfig> = new Map();
    private operationQueue: Array<() => Promise<void>> = [];
    private isProcessingQueue = false;
    private actionButtons: HTMLElement | null = null;

    constructor(private plugin: FlarePlugin) {
        this.plugin.flares = [];
    }

    private async processQueue() {
        if (this.isProcessingQueue) return;
        this.isProcessingQueue = true;

        while (this.operationQueue.length > 0) {
            const operation = this.operationQueue.shift();
            if (operation) {
                try {
                    await operation();
                } catch (error) {
                    console.error('Error processing operation:', error);
                }
            }
        }

        this.isProcessingQueue = false;
    }

    private queueOperation(operation: () => Promise<void>) {
        this.operationQueue.push(operation);
        this.processQueue();
    }

    private async loadFlareConfig(flareName: string): Promise<FlareConfig | null> {
        try {
            // Get file reference
            const flareFile = this.plugin.app.vault.getMarkdownFiles()
                .find(file => file.path.startsWith(this.plugin.settings.flaresFolder + '/') && 
                             file.basename.toLowerCase() === flareName.toLowerCase());

            if (!flareFile) {
                console.debug(`No flare file found for ${flareName}`);
                // Get first available provider and its default model
                const defaultProvider = Object.keys(this.plugin.settings.providers)[0] || '';
                const providerSettings = this.plugin.settings.providers[defaultProvider];
                
                // Ensure we have a valid model from provider settings
                let model = '';
                if (providerSettings) {
                    if (providerSettings.defaultModel) {
                        model = providerSettings.defaultModel;
                    } else {
                        // Try to get first available model - silently fail if we can't
                        try {
                            const models = await this.plugin.getModelsForProvider(providerSettings.type);
                            if (models.length > 0) {
                                model = models[0];
                            }
                        } catch (error) {
                            console.debug('Failed to get models for provider:', error);
                        }
                    }
                }

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

            // Read file content
            const content = await this.plugin.app.vault.read(flareFile);

            // Extract frontmatter and system prompt
            const frontmatterMatch = content.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
            if (!frontmatterMatch) {
                throw new Error('Invalid flare file format: missing frontmatter');
            }

            const [_, frontmatterContent, systemPrompt] = frontmatterMatch;
            const frontmatter: any = {};

            // Parse frontmatter
            frontmatterContent.split('\n').forEach(line => {
                const match = line.match(/^(\w+):\s*(.*)$/);
                if (match) {
                    const [__, key, value] = match;
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

            // Map provider name to internal ID
            let providerId = frontmatter.provider;
            if (providerId) {
                // First check if it's a valid provider ID
                if (this.plugin.settings.providers[providerId]) {
                    // Use as is - it's already a valid ID
                } else {
                    // Look for a provider with matching name
                    const matchingProvider = Object.entries(this.plugin.settings.providers)
                        .find(([_, settings]) => settings.name === providerId);
                    if (matchingProvider) {
                        providerId = matchingProvider[0];
                    } else {
                        // If no match found, use first available provider
                        providerId = Object.keys(this.plugin.settings.providers)[0] || '';
                        console.warn(`Provider "${frontmatter.provider}" not found, using ${providerId}`);
                    }
                }
            }

            // Get provider settings
            const providerSettings = this.plugin.settings.providers[providerId];
            
            // Validate windows
            const handoffContext = frontmatter.handoffContext ?? -1;
            const contextWindow = frontmatter.contextWindow ?? -1;

            return {
                name: flareName,
                provider: providerId,
                model: frontmatter.model || providerSettings?.defaultModel || '',
                temperature: frontmatter.temperature !== undefined ? frontmatter.temperature : 0.7,
                maxTokens: frontmatter.maxTokens,
                systemPrompt: systemPrompt.trim(),
                enabled: frontmatter.enabled ?? true,
                description: frontmatter.description || '',
                contextWindow: contextWindow,
                handoffContext: handoffContext,
                stream: frontmatter.stream ?? false,
                isReasoningModel: frontmatter.isReasoningModel ?? false,
                reasoningHeader: frontmatter.reasoningHeader || '<think>'
            };
        } catch (error) {
            console.error('Failed to load flare config:', error);
            return null;
        }
    }

    private parseFrontmatter(content: string): any {
        const frontmatter: any = {};
        content.split('\n').forEach(line => {
            const [key, ...values] = line.split(':');
            if (key && values.length) {
                const value = values.join(':').trim();
                if (value === 'true') frontmatter[key.trim()] = true;
                else if (value === 'false') frontmatter[key.trim()] = false;
                else if (!isNaN(Number(value))) frontmatter[key.trim()] = Number(value);
                else frontmatter[key.trim()] = value.replace(/^["']|["']$/g, '');
            }
        });
        return frontmatter;
    }

    private async loadFileInChunks(file: any): Promise<string> {
        return new Promise<string>((resolve, reject) => {
            queueMicrotask(async () => {
                try {
                    const content = await this.plugin.app.vault.read(file);
                    resolve(content);
                } catch (error) {
                    reject(error);
                }
            });
        });
    }

    private async processFrontmatter(content: string): Promise<any> {
        return new Promise<any>((resolve) => {
            queueMicrotask(() => {
                const frontmatter: any = {};
                const frontmatterMatch = content.match(/^---\n([\s\S]*?)\n---/);
                
                if (frontmatterMatch) {
                    const frontmatterContent = frontmatterMatch[1];
                    frontmatterContent.split('\n').forEach(line => {
                        const [key, ...values] = line.split(':');
                        if (key && values.length) {
                            const value = values.join(':').trim();
                            if (value === 'true') frontmatter[key.trim()] = true;
                            else if (value === 'false') frontmatter[key.trim()] = false;
                            else if (!isNaN(Number(value))) frontmatter[key.trim()] = Number(value);
                            else frontmatter[key.trim()] = value.replace(/^["']|["']$/g, '');
                        }
                    });
                }
                
                resolve(frontmatter);
            });
        });
    }

    async loadFlares(): Promise<FlareConfig[]> {
        try {
            const flareFolder = this.plugin.settings.flaresFolder;
            if (!flareFolder) {
                console.error('Flares folder not configured');
                return [];
            }

            // Check if folder exists
            const exists = await this.plugin.app.vault.adapter.exists(flareFolder);
            if (!exists) {
                console.warn(`Flares folder "${flareFolder}" does not exist`);
                return [];
            }

            // Get all .md files in the flares folder
            const files = await this.plugin.app.vault.adapter.list(flareFolder);
            const flareFiles = files.files.filter(file => file.endsWith('.md'));

            // Load each flare file
            const flares: FlareConfig[] = [];
            for (const filePath of flareFiles) {
                try {
                    const content = await this.plugin.app.vault.adapter.read(filePath);
                    const flare = await this.parseFlareFile(content, filePath);
                    if (flare) {
                        flares.push(flare);
                        // Add to plugin's flares array
                        this.plugin.flares.push({
                            name: flare.name,
                            path: filePath
                        });
                    }
                } catch (error) {
                    console.error(`Failed to load flare file ${filePath}:`, error);
                }
            }
            
            return flares;
        } catch (error) {
            console.error('Failed to load flares:', error);
            return [];
        }
    }

    // Add cleanup method
    async cleanup() {
        this.cancelAllOperations();
        if (this.hasUnsavedChanges && this.currentFlare) {
            await this.saveFlareConfig(this.currentFlare);
        }
        this.flareCache.clear();
    }

    // Add debouncing for flare loading
    private loadDebounceTimeout: NodeJS.Timeout | null = null;
    async debouncedLoadFlare(flareName: string): Promise<FlareConfig | null> {
        return new Promise((resolve, reject) => {
            if (this.loadDebounceTimeout) {
                clearTimeout(this.loadDebounceTimeout);
            }
            
            this.loadDebounceTimeout = setTimeout(async () => {
                try {
                    // Check cache first
                    const cached = this.flareCache.get(flareName);
                    if (cached) {
                        resolve(cached);
                        return;
                    }

                    const config = await this.loadFlareConfig(flareName);
                    if (config) {
                        this.flareCache.set(flareName, config);
                    }
                    resolve(config);
                } catch (error) {
                    reject(error);
                }
            }, 100); // 100ms debounce
        });
    }

    async initialize() {
        if (this.isInitialized) return;

        try {
            // Ensure flares folder exists
            await this.plugin.ensureFlaresFolderExists();
            
            // Clear existing flares
            this.plugin.flares = [];
            
            // Initial load of flares
            const loadedFlares = await this.loadFlares();
            
            // Create default flare if no flares exist
            if (loadedFlares.length === 0) {
                console.debug('No flares found during initialization, creating default flare');
                const defaultFlareName = await this.createNewFlare();
                if (!defaultFlareName) {
                    throw new Error('Failed to create default flare');
                }
                await this.loadFlares();  // Reload flares after creating default
            }

            this.isInitialized = true;
        } catch (error) {
            console.error('Failed to initialize FlareManager:', error);
            new Notice('Failed to initialize FlareManager');
            throw error;  // Re-throw to handle in createSettingsUI
        }
    }

    async createSettingsUI(containerEl: HTMLElement) {
        try {
            // Ensure we're initialized
            if (!this.isInitialized) {
                await this.initialize();
            }

            const wrapper = containerEl.createDiv('flare-manager');

            // Header with dropdown and actions
            const header = wrapper.createDiv('flare-header');
            
            // Create a container for the dropdown and its buttons
            const dropdownGroup = header.createDiv('flare-dropdown-group');
            
            // Flare selector with Add and Delete buttons
            const select = new Setting(dropdownGroup)
                .addDropdown(async (dropdown) => {
                    // Add default option
                    dropdown.addOption('', 'Select a flare...');
                    
                    // Add options for existing flares
                    const flares = await this.loadFlares();
                    flares.forEach(flare => {
                        dropdown.addOption(flare.name, flare.name);
                    });

                    // Set current value if exists
                    if (this.currentFlare) {
                        dropdown.setValue(this.currentFlare);
                    }

                    // Handle selection changes
                    dropdown.onChange(async (value) => {
                        if (value) {
                            this.currentFlare = value;
                            await this.showFlareSettings(wrapper, value);
                            // Enable delete button when a flare is selected
                            const deleteButton = wrapper.querySelector('.flare-buttons .clickable-icon[aria-label="Delete flare"]');
                            if (deleteButton instanceof HTMLElement) {
                                deleteButton.removeClass('disabled');
                            }
                        } else {
                            // Disable delete button when no flare is selected
                            const deleteButton = wrapper.querySelector('.flare-buttons .clickable-icon[aria-label="Delete flare"]');
                            if (deleteButton instanceof HTMLElement) {
                                deleteButton.addClass('disabled');
                            }
                        }
                    });
                });

            // Add buttons container
            const buttonsContainer = dropdownGroup.createEl('div', { cls: 'flare-buttons' });
            
            // Add new flare button
            const addButton = buttonsContainer.createEl('button', {
                cls: 'clickable-icon',
                attr: { 'aria-label': 'Add new flare' }
            });
            setIcon(addButton, 'plus');
            addButton.addEventListener('click', async () => {
                const newFlareName = await this.createNewFlare();
                if (newFlareName) {
                    // Update dropdown with new option
                    const dropdownComponent = select.components[0] as DropdownComponent;
                    if (dropdownComponent) {
                        dropdownComponent.addOption(newFlareName, newFlareName);
                        dropdownComponent.setValue(newFlareName);
                        // Set current flare and show its settings
                        this.currentFlare = newFlareName;
                        await this.showFlareSettings(wrapper, newFlareName);
                    }
                    new Notice('New flare created');
                }
            });

            // Add delete button
            const deleteButton = buttonsContainer.createEl('button', {
                cls: 'clickable-icon',
                attr: { 'aria-label': 'Delete flare' }
            });
            setIcon(deleteButton, 'trash');
            if (!this.currentFlare) {
                deleteButton.addClass('disabled');
            }
            deleteButton.addEventListener('click', async () => {
                if (!this.currentFlare) return;
                
                const confirmed = await new Promise<boolean>((resolve) => {
                    const modal = new ConfirmModal(
                        this.plugin.app,
                        'Delete flare',
                        `Are you sure you want to delete "${this.currentFlare}"?`,
                        () => resolve(true)
                    );
                    modal.onClose = () => resolve(false);
                    modal.open();
                });

                if (confirmed) {
                    try {
                        // Avoid conflict if we're already loading
                        if (this.isLoadingFlares) {
                            return;
                        }
                        this.isLoadingFlares = true;

                        const flareName = this.currentFlare; // Store for notice
                        
                        // Proceed with deletion
                        const filePath = `${this.plugin.settings.flaresFolder}/${this.currentFlare}.md`;
                        await this.plugin.app.vault.adapter.remove(filePath);

                        // Update dropdown
                        const dropdownComponent = select.components[0] as DropdownComponent;
                        if (dropdownComponent) {
                            dropdownComponent.selectEl.querySelector(`option[value="${this.currentFlare}"]`)?.remove();
                            dropdownComponent.setValue('');
                        }
                        
                        // Clear settings area
                        const settingsArea = wrapper.querySelector('.flare-settings-area');
                        if (settingsArea) {
                            settingsArea.empty();
                        }
                        
                        this.currentFlare = null;
                        this.currentFlareConfig = null;
                        this.originalSettings = null;
                        this.hasUnsavedChanges = false;
                        deleteButton.addClass('disabled');

                        new Notice(`Deleted flare: ${flareName}`);
                    } catch (error) {
                        console.error('Failed to delete flare:', error);
                        new Notice('Failed to delete flare');
                    } finally {
                        this.isLoadingFlares = false;
                    }
                }
            });

            // Settings area
            wrapper.createDiv('flare-settings-area');

            // If there's a current flare, show its settings
            if (this.currentFlare) {
                await this.showFlareSettings(wrapper, this.currentFlare);
            }

            return wrapper;
        } catch (error) {
            console.error('Failed to create settings UI:', error);
            const errorEl = containerEl.createDiv('flare-error-message');
            errorEl.setText('Failed to load flare settings. Please try again.');
            
            const retryButton = errorEl.createEl('button', {
                text: 'Retry',
                cls: 'mod-warning'
            });
            retryButton.onclick = async () => {
                errorEl.remove();
                await this.createSettingsUI(containerEl);
            };
        }
    }

    private createFlareSettingsUI(containerEl: HTMLElement, name: string, settings: FlareConfig) {
        const flareContainer = containerEl.createDiv('flare-settings');

        // Flare name
        new Setting(flareContainer)
            .setName('Flare Name')
            .addText(text => text
                .setValue(settings.name)
                .onChange(value => {
                    settings.name = value;
                    this.markAsChanged();
                }));

        // Enabled toggle
        new Setting(flareContainer)
            .setName('Enabled')
            .addToggle(toggle => toggle
                .setValue(settings.enabled)
                .onChange(value => {
                    settings.enabled = value;
                    this.markAsChanged();
                }));

        // Provider selection
        new Setting(flareContainer)
            .setName('Provider')
            .addDropdown((dropdown) => {
                if (!this.currentFlareConfig) return dropdown;
                
                // Add default option
                dropdown.addOption('', 'Select a provider...');
                
                // Add provider options
                Object.entries(this.plugin.settings.providers).forEach(([id, provider]) => {
                    if (provider.enabled) {
                        dropdown.addOption(id, provider.name);
                    }
                });
                
                // Set current value if it exists and the provider is still valid
                const currentProvider = this.plugin.settings.providers[this.currentFlareConfig.provider || ''];
                if (currentProvider?.enabled && currentProvider.type && this.plugin.providers.has(currentProvider.type)) {
                    dropdown.setValue(this.currentFlareConfig.provider);
                } else {
                    dropdown.setValue('');
                }

                dropdown.onChange(async (value) => {
                    if (!this.currentFlareConfig) return;
                    this.currentFlareConfig.provider = value;
                    // Reset model when provider changes
                    this.currentFlareConfig.model = '';
                    const settingItem = (dropdown as any).settingEl || dropdown.selectEl.closest('.setting-item');
                    if (settingItem) {
                        this.markAsChanged(containerEl, settingItem);
                    }
                    // Update the model dropdown with the new provider's models
                    await this.updateModelDropdown(containerEl, value);
                });
                return dropdown;
            });

        // Only show reasoning model settings for Ollama provider
        if (settings.provider && this.plugin.settings.providers[settings.provider]?.type === 'ollama') {
            new Setting(flareContainer)
                .setName('Reasoning Model')
                .setDesc('Enable for models that support reasoning (e.g. deepseek-coder)')
                .addToggle(toggle => toggle
                    .setValue(settings.isReasoningModel ?? false)
                    .onChange(value => {
                        settings.isReasoningModel = value;
                        this.markAsChanged();
                        // Instead of recreating the entire UI, just update this section
                        const headerSetting = flareContainer.querySelector('.reasoning-header-setting');
                        if (value) {
                            // Add header setting if it doesn't exist
                            if (!headerSetting) {
                                new Setting(flareContainer)
                                    .setClass('reasoning-header-setting')
                                    .setName('Reasoning Header')
                                    .setDesc('The tag that marks the start of reasoning (e.g. <think>)')
                                    .addText(text => text
                                        .setValue(settings.reasoningHeader || '<think>')
                                        .onChange(headerValue => {
                                            settings.reasoningHeader = headerValue;
                                            this.markAsChanged();
                                        }));
                            }
                        } else {
                            // Remove header setting if it exists
                            headerSetting?.remove();
                        }
                    }));

            // Only show reasoning header if reasoning model is enabled
            if (settings.isReasoningModel) {
                new Setting(flareContainer)
                    .setClass('reasoning-header-setting')
                    .setName('Reasoning Header')
                    .setDesc('The tag that marks the start of reasoning (e.g. <think>)')
                    .addText(text => text
                        .setValue(settings.reasoningHeader || '<think>')
                        .onChange(value => {
                            settings.reasoningHeader = value;
                            this.markAsChanged();
                        }));
            }
        }

        // Model selection
        if (settings.provider) {
            const provider = this.plugin.settings.providers[settings.provider];
            if (provider) {
                new Setting(flareContainer)
                    .setName('Model')
                    .addDropdown(async (dropdown) => {
                        try {
                            const models = await this.plugin.getModelsForProvider(provider.type);
                            const visibleModels = provider.visibleModels && provider.visibleModels.length > 0 
                                ? models.filter(model => provider.visibleModels && provider.visibleModels.includes(model))
                                : models;

                            visibleModels.forEach(model => {
                                dropdown.addOption(model, model);
                            });

                            dropdown.setValue(settings.model || provider.defaultModel || '')
                                .onChange(value => {
                                    settings.model = value;
                                    this.markAsChanged();
                                });
                        } catch (error) {
                            console.debug('Failed to load models:', error);
                            // Only show notice if this isn't a new provider (no models configured yet)
                            if (Array.isArray(provider.availableModels) && provider.availableModels.length > 0) {
                                new Notice('Failed to load models');
                            }

                            // Remove any existing error messages
                            const existingError = containerEl.querySelector('.flare-error-message');
                            if (existingError) existingError.remove();

                            // Create error message container
                            const errorDiv = document.createElement('div');
                            errorDiv.className = 'flare-error-message';
                            errorDiv.textContent = 'Failed to load models. Please try again.';
                            
                            // Create retry button
                            const retryButton = document.createElement('button');
                            retryButton.className = 'mod-warning';
                            retryButton.textContent = 'Retry';
                            retryButton.onclick = () => {
                                errorDiv.remove();
                                this.updateModelDropdown(containerEl, settings.provider);
                            };
                            
                            // Add button to error message
                            errorDiv.appendChild(retryButton);
                            
                            // Add error message to container
                            if (containerEl instanceof HTMLElement) {
                                containerEl.appendChild(errorDiv);
                            }
                        }
                    });
            }
        }

        // System prompt
        new Setting(flareContainer)
            .setName('System Prompt')
            .setDesc('Instructions for the AI')
            .addTextArea(text => text
                .setValue(settings.systemPrompt || '')
                .onChange(value => {
                    settings.systemPrompt = value;
                    this.markAsChanged();
                }));

        // Context Window (formerly History Window)
        new Setting(flareContainer)
            .setName('Context Window')
            .setDesc('Maximum number of conversation pairs to maintain during chat (-1 for all)')
            .addText(text => text
                .setValue(String(settings.contextWindow))
                .onChange(value => {
                    const num = parseInt(value);
                    if (!isNaN(num) && (num > 0 || num === -1)) {
                        settings.contextWindow = num;
                        this.markAsChanged();
                    }
                }));

        // Handoff Context (formerly Handoff Window)
        new Setting(flareContainer)
            .setName('Handoff Context')
            .setDesc('Number of conversation pairs to carry over when switching to this flare (-1 for all)')
            .addText(text => text
                .setValue(String(settings.handoffContext ?? -1))
                .onChange(value => {
                    const num = parseInt(value);
                    if (!isNaN(num) && (num > 0 || num === -1)) {
                        settings.handoffContext = num;
                        this.markAsChanged();
                    }
                }));

        // Temperature
        new Setting(flareContainer)
            .setName('Default Temperature')
            .setDesc('Higher values make output more random (0-1.5)')
            .addText(text => text
                .setValue(String(settings.temperature || 0.7))
                .onChange(value => {
                    const num = parseFloat(value);
                    if (!isNaN(num) && num >= 0 && num <= 1.5) {
                        settings.temperature = num;
                        this.markAsChanged();
                    }
                }));

        // Delete flare button
        new Setting(flareContainer)
            .addButton(button => button
                .setButtonText('Delete Flare')
                .setWarning()
                .onClick(() => {
                    delete this.plugin.settings.flares[name];
                    this.markAsChanged();
                    this.createSettingsUI(containerEl);
                }));
    }

    private markAsChanged(form?: HTMLElement, settingItem?: HTMLElement): void {
        this.hasUnsavedChanges = true;
        
        // Show action buttons
        if (this.actionButtons) {
            this.actionButtons.classList.add('is-visible');
        }
        
        // If a specific setting item was changed, add visual indicator
        if (settingItem) {
            settingItem.addClass('is-changed');
        }
    }

    private async saveChanges() {
        if (!this.currentFlare || !this.currentFlareConfig) return;
        
        try {
            const oldName = this.currentFlare;
            const newName = this.currentFlareConfig.name;
            
            // Use saveFlareConfig as the single source of truth for saving
            await this.saveFlareConfig(oldName);
            
            // Handle rename if needed
            if (oldName !== newName) {
                const oldPath = `${this.plugin.settings.flaresFolder}/${oldName}.md`;
                const newPath = `${this.plugin.settings.flaresFolder}/${newName}.md`;
                const file = this.plugin.app.vault.getAbstractFileByPath(oldPath);
                if (file instanceof TFile) {
                    await this.plugin.app.fileManager.renameFile(file, newPath);
                }
            }

            // Reload flares to ensure everything is in sync
            await this.loadFlares();
            
            this.hasUnsavedChanges = false;
            this.originalSettings = await this.loadFlareConfig(newName);
            
            // Hide action buttons
            if (this.actionButtons) {
                this.actionButtons.classList.remove('is-visible');
            }

            // Remove changed indicators from all setting items
            const settingItems = document.querySelectorAll('.setting-item.is-changed');
            settingItems.forEach(item => item.classList.remove('is-changed'));

            // Update UI if name changed
            if (oldName !== newName) {
                const dropdown = document.querySelector('.flare-dropdown-group select') as HTMLSelectElement;
                if (dropdown) {
                    const oldOption = dropdown.querySelector(`option[value="${oldName}"]`);
                    if (oldOption) oldOption.remove();
                    
                    const newOption = document.createElement('option');
                    newOption.value = newName;
                    newOption.text = newName;
                    dropdown.add(newOption);
                    dropdown.value = newName;
                    this.currentFlare = newName;
                }
            }
            
            new Notice('Flare settings saved');
        } catch (error) {
            console.error('Failed to save flare settings:', error);
            new Notice('Failed to save flare settings');
        }
    }

    private async revertChanges(containerEl: HTMLElement) {
        if (!this.currentFlare || !this.originalSettings) return;
        
        try {
            // Reset current config to original settings
            this.currentFlareConfig = { ...this.originalSettings };
            
            // Reload the settings UI
            await this.showFlareSettings(containerEl, this.currentFlare);
            
            this.hasUnsavedChanges = false;
            
            // Hide action buttons
            if (this.actionButtons) {
                this.actionButtons.classList.remove('is-visible');
            }

            // Remove changed indicators from all setting items
            const settingItems = document.querySelectorAll('.setting-item.is-changed');
            settingItems.forEach(item => item.classList.remove('is-changed'));
            
            new Notice('Flare settings reverted');
        } catch (error) {
            console.error('Failed to revert flare settings:', error);
            new Notice('Failed to revert flare settings');
        }
    }

    private async deleteFlare(flareName: string) {
        const modal = new ConfirmModal(
            this.plugin.app,
            'Delete Flare',
            `Are you sure you want to delete "${flareName}"?`,
            async () => {
                try {
                    // Avoid conflict if we're already loading
                    if (this.isLoadingFlares) {
                        return;
                    }
                    this.isLoadingFlares = true;

                    // Proceed with deletion
                    const filePath = `${this.plugin.settings.flaresFolder}/${flareName}.md`;
                    await this.plugin.app.vault.adapter.remove(filePath);

                    if (this.currentFlare === flareName) {
                        this.currentFlare = null;
                        this.currentFlareConfig = null;
                        this.originalSettings = null;
                        this.hasUnsavedChanges = false;
                    }

                    // Reload flares after deletion
                    await this.loadFlares();
                    
                    // Find the settings container and recreate the UI
                    const settingsContainer = document.querySelector('.flare-manager');
                    if (settingsContainer instanceof HTMLElement) {
                        settingsContainer.empty();
                        await this.createSettingsUI(settingsContainer);
                    }
                    
                    new Notice(`Deleted flare: ${flareName}`);
                } catch (error) {
                    console.error('Failed to delete flare:', error);
                    new Notice('Failed to delete flare');
                } finally {
                    this.isLoadingFlares = false;
                }
            }
        );
        modal.open();
    }

    private async showFlareSettings(containerEl: HTMLElement, flareName: string) {
        // Reset state when switching flares
        this.currentFlare = flareName;
        this.hasUnsavedChanges = false;

        // Create loading indicator
        const loadingIndicator = containerEl.createDiv('loading-indicator');
        loadingIndicator.setText('Loading flare settings...');
        containerEl.addClass('loading');

        // Clear existing settings first
        const settingsArea = containerEl.querySelector('.flare-settings-area');
        if (settingsArea) {
            settingsArea.empty();
        }

        try {
            // Load flare config
            const flare = await this.loadFlareConfig(flareName);
            if (!flare) {
                throw new Error('Failed to load flare configuration');
            }

            // Store original settings for comparison
            this.originalSettings = Object.freeze({ ...flare });
            this.currentFlareConfig = { ...flare };

            if (!settingsArea) return;

            // Create form for settings
            const form = settingsArea.createDiv('flare-settings-form');

            // Create action buttons container
            this.actionButtons = form.createDiv({ cls: 'flare-form-actions' });
            
            // Add save and revert buttons
            new Setting(this.actionButtons)
                .addButton(button => {
                    button
                        .setButtonText('Save')
                        .setCta()
                        .onClick(async () => {
                            await this.saveChanges();
                        });
                })
                .addButton(button => {
                    button
                        .setButtonText('Revert')
                        .onClick(async () => {
                            await this.revertChanges(containerEl);
                        });
                });

            // Create sections
            await Promise.all([
                this.createBasicSettingsSection(form),
                this.createProviderSettingsSection(form),
                this.createAdvancedSettingsSection(form),
                this.createSystemPromptSection(form)
            ]);

            return form;
        } catch (error: unknown) {
            if (error instanceof Error && error.message !== 'Operation cancelled') {
                console.error('Error loading flare:', error);
                new Notice('Error loading flare: ' + getErrorMessage(error));
            }
            if (settingsArea) {
                settingsArea.empty();
                const errorMessage = settingsArea.createEl('div', {
                    text: 'Failed to load flare settings: ' + getErrorMessage(error),
                    cls: 'flare-error-message'
                });
                
                // Add retry button
                const retryButton = errorMessage.createEl('button', {
                    text: 'Retry',
                    cls: 'mod-warning'
                });
                retryButton.onclick = () => this.showFlareSettings(containerEl, flareName);
            }
            return null;
        } finally {
            // Clean up loading state
            containerEl.removeClass('loading');
            loadingIndicator?.remove();
        }
    }

    private async createBasicSettingsSection(form: HTMLElement) {
        const basicSection = this.createSection(form, 'Basic Settings', true);
        
        await new Promise<void>(resolve => {
            setTimeout(() => {
                // Flare name
                new Setting(basicSection)
                    .setName('Name')
                    .addText(text => {
                        if (!this.currentFlareConfig) return text;
                        text.setValue(this.currentFlareConfig.name)
                            .onChange(value => {
                                if (!this.currentFlareConfig) return;
                                this.currentFlareConfig.name = value;
                                const settingItem = (text as any).settingEl || text.inputEl.closest('.setting-item');
                                if (settingItem) {
                                    this.markAsChanged(form, settingItem);
                                }
                            });
                        return text;
                    });

                // Description
                new Setting(basicSection)
                    .setName('Description')
                    .setDesc('Brief description of this flare\'s purpose')
                    .addTextArea(text => {
                        if (!this.currentFlareConfig) return text;
                        text.setValue(this.currentFlareConfig.description || '')
                            .onChange(value => {
                                if (!this.currentFlareConfig) return;
                                this.currentFlareConfig.description = value;
                                const settingItem = (text as any).settingEl || text.inputEl.closest('.setting-item');
                                if (settingItem) {
                                    this.markAsChanged(form, settingItem);
                                }
                            });
                        return text;
                    });
                resolve();
            }, 0);
        });
    }

    private async createProviderSettingsSection(formElement: HTMLElement) {
        const providerSectionElement = this.createSection(formElement, 'Provider Settings');
        
        new Setting(providerSectionElement)
            .setName('Provider')
            .setDesc('Select the AI provider to use')
            .addDropdown((dropdown) => {
                if (!this.currentFlareConfig) return dropdown;
                
                // Add default option
                dropdown.addOption('', 'Select a provider...');
                
                // Add provider options
                Object.entries(this.plugin.settings.providers).forEach(([id, provider]) => {
                    if (provider.enabled) {
                        dropdown.addOption(id, provider.name);
                    }
                });
                
                // Set current value if it exists and the provider is still valid
                const currentProvider = this.plugin.settings.providers[this.currentFlareConfig.provider || ''];
                if (currentProvider?.enabled && currentProvider.type && this.plugin.providers.has(currentProvider.type)) {
                    dropdown.setValue(this.currentFlareConfig.provider);
                } else {
                    dropdown.setValue('');
                }

                dropdown.onChange(async (value) => {
                    if (!this.currentFlareConfig) return;
                    this.currentFlareConfig.provider = value;
                    // Reset model when provider changes
                    this.currentFlareConfig.model = '';
                    const settingItem = (dropdown as any).settingEl || dropdown.selectEl.closest('.setting-item');
                    if (settingItem) {
                        this.markAsChanged(formElement, settingItem);
                    }
                    // Update the model dropdown with the new provider's models
                    await this.updateModelDropdown(providerSectionElement, value);
                });
                return dropdown;
            });

        // Only show reasoning model settings for Ollama provider
        if (this.currentFlareConfig?.provider) {
            const provider = this.plugin.settings.providers[this.currentFlareConfig.provider];
            if (provider?.type === 'ollama') {
                new Setting(providerSectionElement)
                    .setName('Reasoning Model')
                    .setDesc('Enable for models that support reasoning (e.g. deepseek-coder)')
                    .addToggle(toggle => toggle
                        .setValue(this.currentFlareConfig?.isReasoningModel ?? false)
                        .onChange(value => {
                            if (!this.currentFlareConfig) return;
                            this.currentFlareConfig.isReasoningModel = value;
                            const settingItem = (toggle as any).settingEl || toggle.toggleEl.closest('.setting-item');
                            if (settingItem) {
                                this.markAsChanged(formElement, settingItem);
                            }
                            // Instead of recreating the entire section, just update the header setting
                            const headerSetting = providerSectionElement.querySelector('.reasoning-header-setting');
                            if (value) {
                                if (!headerSetting) {
                                    new Setting(providerSectionElement)
                                        .setClass('reasoning-header-setting')
                                        .setName('Reasoning Header')
                                        .setDesc('The tag that marks the start of reasoning (e.g. <think>)')
                                        .addText(text => {
                                            if (!this.currentFlareConfig) return text;
                                            return text
                                                .setValue(this.currentFlareConfig.reasoningHeader || '<think>')
                                                .onChange(headerValue => {
                                                    if (!this.currentFlareConfig) return;
                                                    this.currentFlareConfig.reasoningHeader = headerValue;
                                                    const headerSettingItem = (text as any).settingEl || text.inputEl.closest('.setting-item');
                                                    if (headerSettingItem) {
                                                        this.markAsChanged(formElement, headerSettingItem);
                                                    }
                                                });
                                        });
                                }
                            } else {
                                headerSetting?.remove();
                            }
                        }));

                // Only show reasoning header if reasoning model is enabled
                if (this.currentFlareConfig.isReasoningModel) {
                    new Setting(providerSectionElement)
                        .setClass('reasoning-header-setting')
                        .setName('Reasoning Header')
                        .setDesc('The tag that marks the start of reasoning (e.g. <think>)')
                        .addText(text => {
                            if (!this.currentFlareConfig) return text;
                            return text
                                .setValue(this.currentFlareConfig.reasoningHeader || '<think>')
                                .onChange(value => {
                                    if (!this.currentFlareConfig) return;
                                    this.currentFlareConfig.reasoningHeader = value;
                                    const settingItem = (text as any).settingEl || text.inputEl.closest('.setting-item');
                                    if (settingItem) {
                                        this.markAsChanged(formElement, settingItem);
                                    }
                                });
                        });
                }
            }
        }

        // Initial model dropdown
        if (this.currentFlareConfig?.provider) {
            this.updateModelDropdown(providerSectionElement, this.currentFlareConfig.provider);
        }
    }

    private async updateModelDropdown(container: HTMLElement, providerId: string) {
        const provider = this.plugin.settings.providers[providerId];
        if (!provider) return;

        // Remove any existing model settings first
        const existingModelSetting = container.querySelector('.flare-model-setting');
        if (existingModelSetting) {
            existingModelSetting.remove();
        }

        const modelSettingContainer = container.createDiv('flare-model-setting');
        new Setting(modelSettingContainer)
            .setName('Model')
            .setDesc('Select the model to use for this flare')
            .addDropdown(async (dropdown) => {
                try {
                    // Get all available models
                    const allModels = await this.plugin.getModelsForProvider(provider.type);
                    
                    // Filter models based on visibility settings
                    let visibleModels = allModels;
                    if (provider.visibleModels && provider.visibleModels.length > 0) {
                        visibleModels = allModels.filter(model => 
                            provider.visibleModels?.includes(model) ?? false
                        );
                    }

                    visibleModels.forEach(model => {
                        dropdown.addOption(model, model);
                    });

                    if (this.currentFlareConfig) {
                        dropdown.setValue(this.currentFlareConfig.model || provider.defaultModel || '')
                            .onChange(value => {
                                if (this.currentFlareConfig) {
                                    this.currentFlareConfig.model = value;
                                    this.markAsChanged();
                                }
                            });
                    }
                } catch (error) {
                    console.debug('Failed to load models:', error);
                    // Only show notice if this isn't a new provider (no models configured yet)
                    if (Array.isArray(provider.availableModels) && provider.availableModels.length > 0) {
                        new Notice('Failed to load models');
                    }

                    // Remove any existing error messages
                    const existingError = container.querySelector('.flare-error-message');
                    if (existingError) existingError.remove();

                    // Create error message container
                    const errorDiv = document.createElement('div');
                    errorDiv.className = 'flare-error-message';
                    errorDiv.textContent = 'Failed to load models. Please try again.';
                    
                    // Create retry button
                    const retryButton = document.createElement('button');
                    retryButton.className = 'mod-warning';
                    retryButton.textContent = 'Retry';
                    retryButton.onclick = () => {
                        errorDiv.remove();
                        this.updateModelDropdown(container, providerId);
                    };
                    
                    // Add button to error message
                    errorDiv.appendChild(retryButton);
                    
                    // Add error message to container
                    container.appendChild(errorDiv);
                }
            });
    }

    private async createAdvancedSettingsSection(form: HTMLElement) {
        const advancedSection = this.createSection(form, 'Advanced Settings', true);
        
        await new Promise<void>(resolve => {
            setTimeout(() => {
                // Streaming toggle
                new Setting(advancedSection)
                    .setName('Enable Streaming')
                    .setDesc('Stream tokens as they are generated. Only supported by some providers.')
                    .addToggle(toggle => {
                        if (!this.currentFlareConfig) return toggle;
                        toggle.setValue(this.currentFlareConfig.stream ?? false)
                            .onChange(value => {
                                if (!this.currentFlareConfig) return;
                                this.currentFlareConfig.stream = value;
                                const settingItem = (toggle as any).settingEl || toggle.toggleEl.closest('.setting-item');
                                if (settingItem) {
                                    this.markAsChanged(form, settingItem);
                                }
                            });
                        return toggle;
                    });

                // Temperature
                new Setting(advancedSection)
                    .setName('Temperature')
                    .setDesc('Higher values make output more random (0-1.5)')
                    .addText(text => {
                        if (!this.currentFlareConfig) return text;
                        text.setValue(String(this.currentFlareConfig.temperature))
                            .onChange(value => {
                                if (!this.currentFlareConfig) return;
                                const num = parseFloat(value);
                                if (!isNaN(num) && num >= 0 && num <= 1.5) {
                                    this.currentFlareConfig.temperature = num;
                                    const settingItem = (text as any).settingEl || text.inputEl.closest('.setting-item');
                                    if (settingItem) {
                                        this.markAsChanged(form, settingItem);
                                    }
                                }
                            });
                        return text;
                    });

                // Max tokens
                new Setting(advancedSection)
                    .setName('Max Tokens')
                    .setDesc('Maximum length of the response')
                    .addText(text => {
                        if (!this.currentFlareConfig) return text;
                        text.setValue(String(this.currentFlareConfig.maxTokens))
                            .onChange(value => {
                                if (!this.currentFlareConfig) return;
                                const num = parseInt(value);
                                if (!isNaN(num) && num > 0) {
                                    this.currentFlareConfig.maxTokens = num;
                                    const settingItem = (text as any).settingEl || text.inputEl.closest('.setting-item');
                                    if (settingItem) {
                                        this.markAsChanged(form, settingItem);
                                    }
                                }
                            });
                        return text;
                    });

                // Context Window (formerly History Window)
                new Setting(advancedSection)
                    .setName('Context Window')
                    .setDesc('Maximum number of conversation pairs to maintain during chat (-1 for all)')
                    .addText(text => {
                        if (!this.currentFlareConfig) return text;
                        text.setValue(String(this.currentFlareConfig.contextWindow))
                            .onChange(value => {
                                if (!this.currentFlareConfig) return;
                                const num = parseInt(value);
                                if (!isNaN(num) && (num > 0 || num === -1)) {
                                    this.currentFlareConfig.contextWindow = num;
                                    const settingItem = (text as any).settingEl || text.inputEl.closest('.setting-item');
                                    if (settingItem) {
                                        this.markAsChanged(form, settingItem);
                                    }
                                }
                            });
                        return text;
                    });

                // Handoff Context (formerly Handoff Window)
                new Setting(advancedSection)
                    .setName('Handoff Context')
                    .setDesc('Number of conversation pairs to carry over when switching to this flare (-1 for all)')
                    .addText(text => {
                        if (!this.currentFlareConfig) return text;
                        text.setValue(String(this.currentFlareConfig.handoffContext ?? -1))
                            .onChange(value => {
                                if (!this.currentFlareConfig) return;
                                const num = parseInt(value);
                                if (!isNaN(num) && (num > 0 || num === -1)) {
                                    this.currentFlareConfig.handoffContext = num;
                                    const settingItem = (text as any).settingEl || text.inputEl.closest('.setting-item');
                                    if (settingItem) {
                                        this.markAsChanged(form, settingItem);
                                    }
                                }
                            });
                        return text;
                    });

                resolve();
            }, 0);
        });
    }

    private async createSystemPromptSection(form: HTMLElement) {
        const promptSection = this.createSection(form, 'System Prompt', true);
        
        await new Promise<void>(resolve => {
            setTimeout(() => {
                const promptContainer = promptSection.createDiv('system-prompt-container');
                const promptArea = new TextAreaComponent(promptContainer);
                
                if (this.currentFlareConfig) {
                    promptArea
                        .setValue(this.currentFlareConfig.systemPrompt || '')
                        .onChange(value => {
                            if (!this.currentFlareConfig) return;
                            this.currentFlareConfig.systemPrompt = value;
                            this.markAsChanged(form, promptContainer);
                        });
                }
                
                promptArea.inputEl.addClass('system-prompt');
                promptArea.inputEl.rows = 10;
                resolve();
            }, 0);
        });
    }

    private createSection(parent: HTMLElement, title: string, expanded = true) {
        const section = parent.createDiv('flare-section');
        const header = section.createDiv('flare-section-header');
        header.createEl('h4', { text: title });

        const content = section.createDiv('flare-section-content');
        
        // Set initial state
        if (!expanded) {
            header.addClass('is-collapsed');
        }

        // Toggle handler
        header.onclick = () => {
            const isCollapsed = header.hasClass('is-collapsed');
            header.toggleClass('is-collapsed', !isCollapsed);
        };

        return content;
    }

    private async confirmDiscardChanges(): Promise<boolean> {
        return new Promise((resolve) => {
            const modal = new ConfirmModal(
                this.plugin.app,
                'Unsaved Changes',
                'You have unsaved changes. Do you want to discard them?',
                () => resolve(true)
            );
            modal.onClose = () => resolve(false);
            modal.open();
        });
    }

    private async saveFlareConfig(flareName: string): Promise<void> {
        if (!this.currentFlareConfig) return;

        try {
            console.debug('Saving flare config:', {
                name: flareName,
                isReasoningModel: this.currentFlareConfig.isReasoningModel,
                reasoningHeader: this.currentFlareConfig.reasoningHeader
            });

            // Format frontmatter
            const frontmatter = [
                '---',
                `provider: ${this.currentFlareConfig.provider}`,
                `model: ${this.currentFlareConfig.model}`,
                `enabled: ${this.currentFlareConfig.enabled}`,
                `description: "${this.currentFlareConfig.description}"`,
                `temperature: ${this.currentFlareConfig.temperature}`,
                `maxTokens: ${this.currentFlareConfig.maxTokens}`,
                '# Context Window: number of pairs to maintain during chat',
                `contextWindow: ${this.currentFlareConfig.contextWindow}`,
                '# Handoff Context: number of pairs to carry over when switching flares',
                `handoffContext: ${this.currentFlareConfig.handoffContext}`,
                `stream: ${this.currentFlareConfig.stream}`,
                `isReasoningModel: ${this.currentFlareConfig.isReasoningModel}`,
                `reasoningHeader: "${this.currentFlareConfig.reasoningHeader}"`,
                '---'
            ].join('\n');

            // Get system prompt (everything after frontmatter)
            const systemPrompt = this.currentFlareConfig.systemPrompt || '';

            // Format the flare content with ALL fields
            const content = frontmatter + '\n\n' + systemPrompt;

            // Get file path
            const filePath = `${this.plugin.settings.flaresFolder}/${flareName}.md`;
            const file = this.plugin.app.vault.getAbstractFileByPath(filePath);
            
            if (file instanceof TFile) {
                await this.plugin.app.vault.modify(file, content);
                console.debug('Saved flare file content:', content);
            } else {
                await this.plugin.app.vault.create(filePath, content);
                console.debug('Created new flare file:', filePath);
            }

            // Update cache
            this.flareCache.set(this.currentFlareConfig.name, { ...this.currentFlareConfig });
        } catch (error) {
            console.error('Failed to save flare config:', error);
            throw error;
        }
    }

    private async getNextAvailableFlareNumber(baseName: string): Promise<string> {
        try {
            const flareFolder = this.plugin.settings.flaresFolder;
            if (!flareFolder) return baseName;

            const files = await this.plugin.app.vault.adapter.list(flareFolder);
            const flareFiles = files.files.filter(file => file.endsWith('.md'));
            
            // If no file with baseName exists, return baseName
            const baseNameExists = flareFiles.some(file => 
                file === `${flareFolder}/${baseName}.md`
            );
            if (!baseNameExists) return baseName;

            // Find the highest number
            let maxNumber = 1;
            const regex = new RegExp(`${baseName}(\\d+)\\.md$`);
            
            flareFiles.forEach(file => {
                const match = file.match(regex);
                if (match) {
                    const num = parseInt(match[1]);
                    if (!isNaN(num) && num >= maxNumber) {
                        maxNumber = num + 1;
                    }
                }
            });

            return `${baseName}${maxNumber}`;
        } catch (error) {
            console.error('Error finding next available flare number:', error);
            return `${baseName}1`; // Fallback
        }
    }

    private async createNewFlare(): Promise<string> {
        try {
            const flareFolder = this.plugin.settings.flaresFolder;
            if (!flareFolder) {
                new Notice('Flares folder not configured; cannot create new flare.');
                return '';
            }

            // Ensure the flares folder exists
            await this.plugin.ensureFlaresFolderExists();

            // Get a unique name starting with "NewFlare"
            const name = await this.getNextAvailableFlareNumber('NewFlare');
            const flare: FlareConfig = {
                name,
                provider: Object.keys(this.plugin.settings.providers)[0] || '',
                model: '',
                enabled: true,
                description: 'New Flare',
                temperature: 0.7,
                maxTokens: 2048,
                systemPrompt: "You are a helpful AI assistant.",
                contextWindow: -1, // Default to all context
                handoffContext: -1, // Default to no handoff context
                stream: false, // Default to no streaming
                isReasoningModel: false,
                reasoningHeader: '<think>'
            };

            // Format frontmatter
            const frontmatter = [
                '---',
                `provider: ${flare.provider}`,
                `model: ${flare.model}`,
                `enabled: ${flare.enabled}`,
                `description: "${flare.description}"`,
                `temperature: ${flare.temperature}`,
                `maxTokens: ${flare.maxTokens}`,
                '# Context Window: number of pairs to maintain during chat',
                `contextWindow: ${flare.contextWindow}`,
                '# Handoff Context: number of pairs to carry over when switching flares',
                `handoffContext: ${flare.handoffContext}`,
                `stream: ${flare.stream}`,
                `isReasoningModel: ${flare.isReasoningModel}`,
                `reasoningHeader: "${flare.reasoningHeader}"`,
                '---'
            ].join('\n');

            // Add an extra newline after frontmatter and then the system prompt
            const content = frontmatter + '\n\n' + flare.systemPrompt;

            // Save the flare file
            const filePath = `${flareFolder}/${name}.md`;
            await this.plugin.app.vault.adapter.write(filePath, content);

            return name;
        } catch (error) {
            console.error('Failed to create new flare:', error);
            new Notice('Failed to create new flare');
            return '';
        }
    }

    // Helper to manage async operations
    private async withLoading<T>(
        operationId: string,
        operation: () => Promise<T>,
        cleanup?: () => void
    ): Promise<T | null> {
        // Cancel any existing operation with the same ID
        this.cancelOperation(operationId);

        let cancel = () => {};
        const promise = new Promise<T>(async (resolve, reject) => {
            cancel = () => {
                cleanup?.();
                reject(new Error('Operation cancelled'));
            };

            try {
                const result = await operation();
                resolve(result);
            } catch (error) {
                reject(error);
            }
        });

        // Register new operation
        this.pendingOperations.set(operationId, {
            operation: operationId,
            promise,
            cancel
        });

        try {
            return await promise;
        } catch (error: unknown) {
            if (error instanceof Error && error.message !== 'Operation cancelled') {
                console.error(`Operation ${operationId} failed:`, error);
                new Notice(`Failed to ${operationId}. Please try again.`);
            }
            return null;
        } finally {
            this.pendingOperations.delete(operationId);
        }
    }

    private cancelOperation(operationId: string) {
        const existing = this.pendingOperations.get(operationId);
        if (existing) {
            existing.cancel();
            this.pendingOperations.delete(operationId);
        }
    }

    private cancelAllOperations() {
        for (const [id, operation] of this.pendingOperations) {
            operation.cancel();
            this.pendingOperations.delete(id);
        }
    }

    private async parseFlareFile(content: string, filePath: string): Promise<FlareConfig | null> {
        try {
            const lines = content.split('\n');
            let frontmatterStart = -1;
            let frontmatterEnd = -1;
            
            // Find frontmatter boundaries
            for (let i = 0; i < lines.length; i++) {
                if (lines[i].trim() === '---') {
                    if (frontmatterStart === -1) {
                        frontmatterStart = i;
                    } else {
                        frontmatterEnd = i;
                        break;
                    }
                }
            }
            
            if (frontmatterStart === -1 || frontmatterEnd === -1) {
                console.error('Invalid frontmatter format');
                return null;
            }
            
            // Parse frontmatter
            const frontmatter: Record<string, any> = {};
            for (let i = frontmatterStart + 1; i < frontmatterEnd; i++) {
                const line = lines[i].trim();
                if (!line) continue;
                
                const [key, ...valueParts] = line.split(':');
                if (!key) continue;
                
                let value: string | boolean | number = valueParts.join(':').trim();
                
                // Handle quoted strings
                if (typeof value === 'string' && value.startsWith('"') && value.endsWith('"')) {
                    value = value.slice(1, -1);
                }
                
                // Convert boolean strings
                if (value === 'true') value = true;
                if (value === 'false') value = false;
                
                // Convert numbers
                if (typeof value === 'string' && !isNaN(Number(value))) {
                    value = Number(value);
                }
                
                frontmatter[key.trim()] = value;
            }

            // Get system prompt (everything after frontmatter)
            const systemPrompt = lines.slice(frontmatterEnd + 1).join('\n').trim();
            
            // Extract basename from filePath
            const basename = filePath.split('/').pop()?.replace('.md', '') || '';
            
            // Create flare config
            const flare: FlareConfig = {
                name: basename,
                provider: frontmatter.provider || '',
                model: frontmatter.model || '',
                enabled: frontmatter.enabled ?? true,
                description: frontmatter.description || '',
                temperature: frontmatter.temperature ?? 0.7,
                maxTokens: frontmatter.maxTokens ?? 2048,
                contextWindow: frontmatter.contextWindow ?? -1,
                handoffContext: frontmatter.handoffContext ?? -1,
                systemPrompt: systemPrompt,
                stream: frontmatter.stream ?? false,
                isReasoningModel: frontmatter.isReasoningModel ?? false,
                reasoningHeader: frontmatter.reasoningHeader || '<think>'
            };
            
            return flare;
        } catch (error) {
            console.error('Failed to parse flare file:', error);
            return null;
        }
    }
} 