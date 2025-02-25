import { Setting, setIcon, Notice, Modal, App, DropdownComponent, TextComponent, TextAreaComponent, TFile, TAbstractFile, debounce, Debouncer, setTooltip } from 'obsidian';
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
    private actionButtons: HTMLElement | null = null;
    private saveButtonComponent: any = null;
    private revertButtonComponent: any = null;
    private flareDropdown: DropdownComponent | null = null;
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
    private loadFlareDebouncer: Debouncer<[string, (value: FlareConfig | null) => void, (error: Error) => void], void>;
    private hasSettingsChanged: boolean = false;
    private markAsChangedDebouncer: Debouncer<[HTMLElement | undefined, HTMLElement | undefined], void>;

    constructor(private plugin: FlarePlugin) {
        this.plugin.flares = [];
        // Initialize the debouncer with proper typing and abort handling
        this.loadFlareDebouncer = debounce(
            async (
                flareName: string,
                resolve: (value: FlareConfig | null) => void,
                reject: (error: Error) => void
            ): Promise<void> => {
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
                    // Don't log or reject AbortError as it's an expected case
                    if (error instanceof Error && error.name === 'AbortError') {
                        resolve(null);
                        return;
                    }
                    console.error('Error in loadFlareDebouncer:', error);
                    reject(error instanceof Error ? error : new Error(String(error)));
                }
            },
            100,
            true
        );
        // Initialize debouncer for settings changes
        this.markAsChangedDebouncer = debounce(
            (form?: HTMLElement, settingItem?: HTMLElement) => {
                this.hasUnsavedChanges = true;
                
                // Show action buttons
                if (this.actionButtons) {
                    this.actionButtons.classList.add('is-visible');
                    // Update button states
                    if (this.saveButtonComponent) {
                        this.saveButtonComponent.setDisabled(false);
                    }
                    if (this.revertButtonComponent) {
                        this.revertButtonComponent.setDisabled(false);
                    }
                }
                
                // If a specific setting item was changed, add visual indicator
                if (settingItem) {
                    settingItem.classList.add('is-changed');
                }
            },
            100,
            true
        );
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
            const files = this.plugin.app.vault.getMarkdownFiles();
            const flareFile = files.find(file => 
                file.path.startsWith(this.plugin.settings.flaresFolder + '/') && 
                file.basename === flareName
            );

            const defaultProvider = Object.keys(this.plugin.settings.providers)[0];
            const defaultProviderSettings = this.plugin.settings.providers[defaultProvider];
            
            // Ensure we have a valid model
            let model = '';
            if (defaultProviderSettings) {
                if (defaultProviderSettings.defaultModel) {
                    model = defaultProviderSettings.defaultModel;
                } else {
                    // Try to get first available model
                    try {
                        const models = await this.plugin.getModelsForProvider(defaultProviderSettings.type);
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
            const fileCache = this.plugin.app.metadataCache.getFileCache(flareFile);
            if (!fileCache || !fileCache.frontmatter) {
                throw new Error('Invalid flare file format: missing frontmatter');
            }

            // Read file content for system prompt
            const content = await this.plugin.app.vault.read(flareFile);
            const frontmatterMatch = content.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
            if (!frontmatterMatch) {
                throw new Error('Invalid flare file format: missing frontmatter');
            }
            const systemPrompt = frontmatterMatch[2].trim();

            // Map provider name to internal ID
            let providerId = fileCache.frontmatter.provider;
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
                        console.warn(`Provider "${fileCache.frontmatter.provider}" not found, using ${providerId}`);
                    }
                }
            }

            // Get provider settings
            const selectedProviderSettings = this.plugin.settings.providers[providerId];
            
            // Validate windows
            const handoffContext = fileCache.frontmatter.handoffContext ?? -1;
            const contextWindow = fileCache.frontmatter.contextWindow ?? -1;

            return {
                name: flareName,
                provider: providerId,
                model: fileCache.frontmatter.model || selectedProviderSettings?.defaultModel || '',
                temperature: fileCache.frontmatter.temperature !== undefined ? fileCache.frontmatter.temperature : 0.7,
                maxTokens: fileCache.frontmatter.maxTokens,
                systemPrompt: systemPrompt,
                enabled: fileCache.frontmatter.enabled ?? true,
                description: fileCache.frontmatter.description || '',
                contextWindow: contextWindow,
                handoffContext: handoffContext,
                stream: fileCache.frontmatter.stream ?? false,
                isReasoningModel: fileCache.frontmatter.isReasoningModel ?? false,
                reasoningHeader: fileCache.frontmatter.reasoningHeader || '<think>'
            };
        } catch (error) {
            console.error('Failed to load flare config:', error);
            return null;
        }
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
        try {
            this.cancelAllOperations();
            if (this.hasUnsavedChanges && this.currentFlare) {
                await this.saveFlareConfig(this.currentFlare);
            }
            this.flareCache.clear();
            // Properly cancel debouncer and handle any pending promises
            if (this.loadFlareDebouncer) {
                this.loadFlareDebouncer.cancel();
                this.loadFlareDebouncer.run(); // Run any pending operations to resolve them
            }
        } catch (error) {
            // Don't throw AbortError during cleanup
            if (error instanceof Error && error.name === 'AbortError') {
                console.debug('Stream aborted during cleanup');
                return;
            }
            console.error('Error during cleanup:', error);
            throw error;
        }
    }

    // Improved debounced load flare with better error handling
    async debouncedLoadFlare(flareName: string): Promise<FlareConfig | null> {
        if (!flareName) {
            throw new Error('Flare name is required');
        }

        return new Promise<FlareConfig | null>((resolve, reject) => {
            try {
                this.loadFlareDebouncer(flareName, resolve, (error: Error) => {
                    // Don't reject AbortError, resolve with null instead
                    if (error.name === 'AbortError') {
                        console.debug('Stream aborted, resolving with null');
                        resolve(null);
                        return;
                    }
                    reject(error);
                });
            } catch (error) {
                // Handle synchronous AbortError
                if (error instanceof Error && error.name === 'AbortError') {
                    console.debug('Stream aborted synchronously');
                    resolve(null);
                    return;
                }
                console.error('Error in debouncedLoadFlare:', error);
                reject(error instanceof Error ? error : new Error(String(error)));
            }
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

    /** Creates the settings UI for flares
     * @param containerEl The container element to create the UI in
     */
    async createSettingsUI(containerEl: HTMLElement) {
        try {
            // Ensure we're initialized
            if (!this.isInitialized) {
                await this.initialize();
            }

            // Clear container
            containerEl.empty();

            // Add section heading first
            new Setting(containerEl).setName('Flare configuration').setHeading();

            // Create flare selector
            const dropdownContainer = new Setting(containerEl)
                .setName('Active flare')
                .setDesc('Select a flare to configure');

            dropdownContainer.addDropdown(async (d) => {
                this.flareDropdown = d;
                // Add default option
                d.addOption('', 'Select a flare...');
                
                // Add options for existing flares
                const flares = await this.loadFlares();
                flares.forEach(flare => {
                    d.addOption(flare.name, flare.name);
                });

                // Set current value if exists
                if (this.currentFlare) {
                    d.setValue(this.currentFlare);
                }

                // Handle selection changes
                d.onChange(async (value) => {
                    if (value) {
                        // Check for unsaved changes before switching
                        if (this.hasUnsavedChanges) {
                            const confirmed = await this.confirmDiscardChanges();
                            if (!confirmed) {
                                // Revert dropdown to previous value
                                if (this.flareDropdown && this.currentFlare) {
                                    this.flareDropdown.setValue(this.currentFlare);
                                }
                                return;
                            }
                        }
                        this.currentFlare = value;
                        // Enable delete button when a flare is selected
                        const deleteButton = containerEl.querySelector('.flare-buttons .clickable-icon.delete-flare');
                        if (deleteButton instanceof HTMLElement) {
                            deleteButton.classList.remove('disabled');
                        }
                    } else {
                        // Reset state when no flare is selected
                        this.currentFlare = null;
                        this.currentFlareConfig = null;
                        this.originalSettings = null;
                        this.hasUnsavedChanges = false;
                        // Disable delete button when no flare is selected
                        const deleteButton = containerEl.querySelector('.flare-buttons .clickable-icon.delete-flare');
                        if (deleteButton instanceof HTMLElement) {
                            deleteButton.classList.add('disabled');
                        }
                    }
                    // Show settings directly in container
                    await this.showFlareSettings(containerEl, value || null);
                });
            });

            // Add buttons container for add/delete in the flare selector area
            const buttonsContainer = dropdownContainer.controlEl.createEl('div', { cls: 'flare-buttons' });
            
            // Add new flare button
            const addButton = buttonsContainer.createEl('button', {
                cls: 'clickable-icon add-flare'
            });
            setIcon(addButton, 'plus');
            setTooltip(addButton, 'Add new flare');

            // Delete flare button
            const deleteButton = buttonsContainer.createEl('button', {
                cls: 'clickable-icon delete-flare'
            });
            setIcon(deleteButton, 'trash');
            setTooltip(deleteButton, 'Delete flare');
            if (!this.currentFlare) {
                deleteButton.classList.add('disabled');
            }

            // Add event handlers for buttons
            addButton.addEventListener('click', async () => {
                const newFlareName = await this.createNewFlare();
                if (newFlareName) {
                    // Update dropdown
                    if (this.flareDropdown) {
                        this.flareDropdown.addOption(newFlareName, newFlareName);
                        this.flareDropdown.setValue(newFlareName);
                    }
                    new Notice(`Created new flare: ${newFlareName}`);
                }
            });

            deleteButton.addEventListener('click', async () => {
                if (!this.currentFlare) return;
                await this.deleteFlare(this.currentFlare);
            });

            // Create action buttons container right after the dropdown
            this.actionButtons = containerEl.createEl('div', { cls: 'flare-form-actions' });
            
            // Add save and revert buttons
            new Setting(this.actionButtons)
                .addButton(button => {
                    this.saveButtonComponent = button
                        .setButtonText('Save')
                        .setCta()
                        .setDisabled(!this.currentFlare || !this.hasUnsavedChanges)
                        .onClick(async () => {
                            await this.saveChanges();
                        });
                })
                .addButton(button => {
                    this.revertButtonComponent = button
                        .setButtonText('Revert')
                        .setDisabled(!this.currentFlare || !this.hasUnsavedChanges)
                        .onClick(async () => {
                            await this.revertChanges(containerEl);
                        });
                });

            // Show settings immediately (will be disabled if no flare selected)
            await this.showFlareSettings(containerEl, this.currentFlare);

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

    /** Shows or updates the flare settings in the container
     * @param containerEl The container element to show settings in
     * @param flareName The name of the flare to show settings for, or null for empty state
     */
    private async showFlareSettings(containerEl: HTMLElement, flareName: string | null) {
        // Reset state when switching flares
        this.currentFlare = flareName;
        this.hasUnsavedChanges = false;

        try {
            // Keep the heading, selector, and action buttons
            const heading = containerEl.querySelector('.setting-item.setting-item-heading');
            const selector = containerEl.querySelector('.setting-item:not(.setting-item-heading)');
            const actionButtons = containerEl.querySelector('.flare-form-actions') as HTMLElement;
            containerEl.empty();

            // Restore elements in correct order
            if (heading) containerEl.appendChild(heading);
            if (selector) containerEl.appendChild(selector);
            if (actionButtons) {
                containerEl.appendChild(actionButtons);
                this.actionButtons = actionButtons;
                
                // Update button states through components
                if (this.saveButtonComponent) {
                    this.saveButtonComponent.setDisabled(!flareName || !this.hasUnsavedChanges);
                }
                if (this.revertButtonComponent) {
                    this.revertButtonComponent.setDisabled(!flareName || !this.hasUnsavedChanges);
                }
                actionButtons.classList.toggle('is-visible', this.hasUnsavedChanges);
            }

            // Load flare config if we have a flare selected
            if (flareName) {
                const flare = await this.loadFlareConfig(flareName);
                if (!flare) {
                    throw new Error('Failed to load flare configuration');
                }
                // Store original settings for comparison
                this.originalSettings = Object.freeze({ ...flare });
                this.currentFlareConfig = { ...flare };
            } else {
                // Use empty config for disabled state
                this.currentFlareConfig = {
                    name: '',
                    provider: '',
                    model: '',
                    enabled: true,
                    description: '',
                    temperature: 0.7,
                    maxTokens: 2048,
                    systemPrompt: '',
                    contextWindow: -1,
                    handoffContext: -1,
                    stream: false,
                    isReasoningModel: false,
                    reasoningHeader: '<think>'
                };
            }

            // Create settings sections synchronously
            this.createBasicSettingsSection(containerEl, !flareName);
            this.createProviderSettingsSection(containerEl, !flareName);
            this.createAdvancedSettingsSection(containerEl, !flareName);
            this.createSystemPromptSection(containerEl, !flareName);

        } catch (error) {
            if (error instanceof Error && error.message !== 'Operation cancelled') {
                console.error('Error loading flare:', error);
                new Notice('Error loading flare: ' + getErrorMessage(error));
            }
            const errorMessage = containerEl.createEl('div', {
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
    }

    /** Creates the basic settings section with name and description
     * @param form The form element to add settings to
     * @param isDisabled Whether the settings should be disabled
     */
    private createBasicSettingsSection(form: HTMLElement, isDisabled: boolean) {
        // Flare name
        new Setting(form)
            .setName('Name')
            .setDesc('A unique name for this flare')
            .setDisabled(isDisabled)
            .addText(text => {
                if (!this.currentFlareConfig) return text;
                text.setValue(this.currentFlareConfig.name)
                    .setPlaceholder('Enter flare name')
                    .setDisabled(isDisabled)
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
        new Setting(form)
            .setName('Description')
            .setDesc('Brief description of this flare\'s purpose')
            .setDisabled(isDisabled)
            .addTextArea(text => {
                if (!this.currentFlareConfig) return text;
                text.setValue(this.currentFlareConfig.description || '')
                    .setPlaceholder('Enter description')
                    .setDisabled(isDisabled)
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
    }

    /** Creates the provider settings section with provider selection and model settings
     * @param formElement The form element to add settings to
     * @param isDisabled Whether the settings should be disabled
     */
    private createProviderSettingsSection(formElement: HTMLElement, isDisabled: boolean) {
        new Setting(formElement)
            .setName('Provider')
            .setDesc('Select the AI provider to use')
            .setDisabled(isDisabled)
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

                dropdown.setDisabled(isDisabled)
                    .onChange(async (value) => {
                        if (!this.currentFlareConfig) return;
                        this.currentFlareConfig.provider = value;
                        // Reset model when provider changes
                        this.currentFlareConfig.model = '';
                        const settingItem = (dropdown as any).settingEl || dropdown.selectEl.closest('.setting-item');
                        if (settingItem) {
                            this.markAsChanged(formElement, settingItem);
                        }
                        // Update the model dropdown with the new provider's models
                        await this.updateModelDropdown(formElement, value);
                    });
                return dropdown;
            });

        // Add reasoning model toggle for all providers
        new Setting(formElement)
            .setName('Reasoning Model')
            .setDesc('Enable for models that support reasoning (e.g. deepseek-coder)')
            .setDisabled(isDisabled)
            .addToggle(toggle => {
                if (!this.currentFlareConfig) return toggle;
                toggle.setValue(this.currentFlareConfig.isReasoningModel ?? false)
                    .setDisabled(isDisabled)
                    .onChange(value => {
                        if (!this.currentFlareConfig) return;
                        this.currentFlareConfig.isReasoningModel = value;
                        const settingItem = (toggle as any).settingEl || toggle.toggleEl.closest('.setting-item');
                        if (settingItem) {
                            this.markAsChanged(formElement, settingItem);
                        }
                        // Show/hide reasoning header based on toggle
                        const headerSetting = formElement.querySelector('.setting-item[data-reasoning-header]');
                        if (headerSetting instanceof HTMLElement) {
                            headerSetting.style.display = value ? '' : 'none';
                        }
                    });
                return toggle;
            });

        // Add reasoning header setting (standard setting-item)
        const reasoningHeaderSetting = new Setting(formElement)
            .setName('Reasoning Header')
            .setDesc('The tag that marks the start of reasoning (e.g. <think>)')
            .setDisabled(isDisabled)
            .addText(text => {
                if (!this.currentFlareConfig) return text;
                const textComponent = text
                    .setValue(this.currentFlareConfig.reasoningHeader || '<think>')
                    .setDisabled(isDisabled)
                    .onChange(headerValue => {
                        if (!this.currentFlareConfig) return;
                        this.currentFlareConfig.reasoningHeader = headerValue;
                        const headerSettingItem = (text as any).settingEl || text.inputEl.closest('.setting-item');
                        if (headerSettingItem) {
                            this.markAsChanged(formElement, headerSettingItem);
                        }
                    });
                return textComponent;
            });

        // Add data attribute for targeting
        reasoningHeaderSetting.settingEl.dataset.reasoningHeader = 'true';
        // Set initial visibility
        reasoningHeaderSetting.settingEl.style.display = 
            this.currentFlareConfig?.isReasoningModel ? '' : 'none';

        // Initial model dropdown
        if (this.currentFlareConfig?.provider) {
            this.updateModelDropdown(formElement, this.currentFlareConfig.provider, isDisabled);
        }
    }

    private async createAdvancedSettingsSection(form: HTMLElement, isDisabled: boolean) {
        // Streaming toggle
        new Setting(form)
            .setName('Enable Streaming')
            .setDesc('Stream tokens as they are generated. Only supported by some providers.')
            .setDisabled(isDisabled)
            .addToggle(toggle => {
                if (!this.currentFlareConfig) return toggle;
                toggle.setValue(this.currentFlareConfig.stream ?? false)
                    .setDisabled(isDisabled)
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
        new Setting(form)
            .setName('Temperature')
            .setDesc('Higher values make output more random (0-1.5)')
            .setDisabled(isDisabled)
            .addText(text => {
                if (!this.currentFlareConfig) return text;
                text.setValue(String(this.currentFlareConfig.temperature))
                    .setPlaceholder('0.7')
                    .setDisabled(isDisabled)
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
        new Setting(form)
            .setName('Max Tokens')
            .setDesc('Maximum length of the response')
            .setDisabled(isDisabled)
            .addText(text => {
                if (!this.currentFlareConfig) return text;
                text.setValue(String(this.currentFlareConfig.maxTokens))
                    .setPlaceholder('2048')
                    .setDisabled(isDisabled)
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

        // Context Window
        new Setting(form)
            .setName('Context Window')
            .setDesc('Maximum number of conversation pairs to maintain during chat (-1 for all)')
            .setDisabled(isDisabled)
            .addText(text => {
                if (!this.currentFlareConfig) return text;
                text.setValue(String(this.currentFlareConfig.contextWindow))
                    .setPlaceholder('-1')
                    .setDisabled(isDisabled)
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

        // Handoff Context
        new Setting(form)
            .setName('Handoff Context')
            .setDesc('Number of conversation pairs to carry over when switching to this flare (-1 for all)')
            .setDisabled(isDisabled)
            .addText(text => {
                if (!this.currentFlareConfig) return text;
                text.setValue(String(this.currentFlareConfig.handoffContext ?? -1))
                    .setPlaceholder('-1')
                    .setDisabled(isDisabled)
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
    }

    private async createSystemPromptSection(form: HTMLElement, isDisabled: boolean) {
        // System prompt
        new Setting(form)
            .setName('System Prompt')
            .setDesc('Instructions for the AI')
            .setDisabled(isDisabled);

        const promptArea = new TextAreaComponent(form);
        
        if (this.currentFlareConfig) {
            promptArea
                .setValue(this.currentFlareConfig.systemPrompt || '')
                .setPlaceholder('Enter system prompt')
                .setDisabled(isDisabled)
                .onChange(value => {
                    if (!this.currentFlareConfig) return;
                    this.currentFlareConfig.systemPrompt = value;
                    this.markAsChanged(form, form);
                });
        }
        
        promptArea.inputEl.addClass('system-prompt');
        promptArea.inputEl.rows = 10;
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
                    
                    // Update dropdown using the stored component
                    if (this.flareDropdown) {
                        // Get current select element
                        const selectEl = this.flareDropdown.selectEl;
                        
                        // Remove all existing options
                        while (selectEl.firstChild) {
                            selectEl.removeChild(selectEl.firstChild);
                        }
                        
                        // Add default option
                        this.flareDropdown.addOption('', 'Select a flare...');
                        
                        // Add all current flares
                        const flares = await this.loadFlares();
                        flares.forEach(flare => {
                            this.flareDropdown?.addOption(flare.name, flare.name);
                        });
                        
                        // Select the new name
                        this.flareDropdown.setValue(newName);
                    }
                    
                    // Update current flare reference
                    this.currentFlare = newName;
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
                    const settingsContainer = document.querySelector('.workspace-leaf-content[data-type="flare-chat"] .view-content');
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

    /** Updates the model dropdown based on the selected provider
     * @param container The container element for the dropdown
     * @param providerId The ID of the selected provider
     * @param isDisabled Whether the dropdown should be disabled
     */
    private async updateModelDropdown(container: HTMLElement, providerId: string, isDisabled: boolean = false) {
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
            .setDisabled(isDisabled)
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
                            .setDisabled(isDisabled)
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
                        this.updateModelDropdown(container, providerId, isDisabled);
                    };
                    
                    // Add button to error message
                    errorDiv.appendChild(retryButton);
                    
                    // Add error message to container
                    container.appendChild(errorDiv);
                }
            });
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

            // Create the file path
            const filePath = `${flareFolder}/${name}.md`;

            // Create initial file with empty frontmatter
            const file = await this.plugin.app.vault.create(filePath, '---\n---\n\n' + flare.systemPrompt);

            // Update frontmatter using processFrontMatter
            await this.plugin.app.fileManager.processFrontMatter(file, (frontmatter) => {
                frontmatter.provider = flare.provider;
                frontmatter.model = flare.model;
                frontmatter.enabled = flare.enabled;
                frontmatter.description = flare.description;
                frontmatter.temperature = flare.temperature;
                frontmatter.maxTokens = flare.maxTokens;
                frontmatter.contextWindow = flare.contextWindow;
                frontmatter.handoffContext = flare.handoffContext;
                frontmatter.stream = flare.stream;
                frontmatter.isReasoningModel = flare.isReasoningModel;
                frontmatter.reasoningHeader = flare.reasoningHeader;
            });

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
            // Get file reference
            const file = this.plugin.app.vault.getAbstractFileByPath(filePath);
            if (!(file instanceof TFile)) {
                throw new Error('Invalid file reference');
            }

            // Get file metadata from cache
            const fileCache = this.plugin.app.metadataCache.getFileCache(file);
            if (!fileCache || !fileCache.frontmatter) {
                throw new Error('Invalid flare file format: missing frontmatter');
            }

            // Extract system prompt (everything after frontmatter)
            const systemPrompt = content.split(/^---\n[\s\S]*?\n---\n/)[1]?.trim() || '';
            
            // Extract basename from filePath
            const basename = filePath.split('/').pop()?.replace('.md', '') || '';
            
            // Create flare config
            const flare: FlareConfig = {
                name: basename,
                provider: fileCache.frontmatter.provider || '',
                model: fileCache.frontmatter.model || '',
                enabled: fileCache.frontmatter.enabled ?? true,
                description: fileCache.frontmatter.description || '',
                temperature: fileCache.frontmatter.temperature ?? 0.7,
                maxTokens: fileCache.frontmatter.maxTokens ?? 2048,
                contextWindow: fileCache.frontmatter.contextWindow ?? -1,
                handoffContext: fileCache.frontmatter.handoffContext ?? -1,
                systemPrompt: systemPrompt,
                stream: fileCache.frontmatter.stream ?? false,
                isReasoningModel: fileCache.frontmatter.isReasoningModel ?? false,
                reasoningHeader: fileCache.frontmatter.reasoningHeader || '<think>'
            };
            
            return flare;
        } catch (error) {
            console.error('Failed to parse flare file:', error);
            return null;
        }
    }

    // Add method to refresh all provider dropdowns
    public refreshProviderDropdowns() {
        // Find all provider dropdowns in flare settings
        const dropdowns = document.querySelectorAll('.flare-settings .setting-item select, .flare-section-content .setting-item select') as NodeListOf<HTMLSelectElement>;
        dropdowns.forEach(select => {
            const dropdown = select as any;
            if (dropdown.getValue) {
                const currentValue = dropdown.getValue();
                this.populateProviderDropdown(dropdown);
                dropdown.setValue(currentValue);
            }
        });
    }

    private populateProviderDropdown(dropdown: DropdownComponent) {
        // Clear existing options
        dropdown.selectEl.empty();
        
        // Add default option
        dropdown.addOption('', 'Select a provider...');
        
        Object.entries(this.plugin.settings.providers).forEach(([id, provider]) => {
            if (provider.type && this.plugin.providers.has(provider.type)) {
                dropdown.addOption(id, provider.name || id);
            }
        });
    }

    /** Marks settings as changed and shows appropriate UI indicators
     * @param form The form element containing the changed setting
     * @param settingItem The specific setting item that changed
     */
    private markAsChanged(form?: HTMLElement, settingItem?: HTMLElement): void {
        this.markAsChangedDebouncer.call(this, form, settingItem);
    }

    /** Saves the flare configuration to disk
     * @param flareName The name of the flare to save
     */
    private async saveFlareConfig(flareName: string): Promise<void> {
        if (!this.currentFlareConfig) return;

        try {
            console.debug('Saving flare config:', {
                name: flareName,
                isReasoningModel: this.currentFlareConfig.isReasoningModel,
                reasoningHeader: this.currentFlareConfig.reasoningHeader
            });

            // Get file path and reference
            const filePath = `${this.plugin.settings.flaresFolder}/${flareName}.md`;
            let file = this.plugin.app.vault.getAbstractFileByPath(filePath);
            
            // Get system prompt (everything after frontmatter)
            const systemPrompt = this.currentFlareConfig.systemPrompt || '';

            if (file instanceof TFile) {
                // Update existing file
                await this.plugin.app.fileManager.processFrontMatter(file, (frontmatter) => {
                    frontmatter.provider = this.currentFlareConfig?.provider;
                    frontmatter.model = this.currentFlareConfig?.model;
                    frontmatter.enabled = this.currentFlareConfig?.enabled;
                    frontmatter.description = this.currentFlareConfig?.description;
                    frontmatter.temperature = this.currentFlareConfig?.temperature;
                    frontmatter.maxTokens = this.currentFlareConfig?.maxTokens;
                    frontmatter.contextWindow = this.currentFlareConfig?.contextWindow;
                    frontmatter.handoffContext = this.currentFlareConfig?.handoffContext;
                    frontmatter.stream = this.currentFlareConfig?.stream;
                    frontmatter.isReasoningModel = this.currentFlareConfig?.isReasoningModel;
                    frontmatter.reasoningHeader = this.currentFlareConfig?.reasoningHeader;
                });

                // Update system prompt separately
                const content = await this.plugin.app.vault.read(file);
                const frontmatterMatch = content.match(/^---\n[\s\S]*?\n---\n([\s\S]*)$/);
                if (frontmatterMatch) {
                    const newContent = content.replace(frontmatterMatch[1], '\n' + systemPrompt);
                    await this.plugin.app.vault.modify(file, newContent);
                }
            } else {
                // Create new file with initial frontmatter and content
                const initialContent = `---\nprovider: ${this.currentFlareConfig.provider}\nmodel: ${this.currentFlareConfig.model}\nenabled: ${this.currentFlareConfig.enabled}\ndescription: "${this.currentFlareConfig.description}"\ntemperature: ${this.currentFlareConfig.temperature}\nmaxTokens: ${this.currentFlareConfig.maxTokens}\ncontextWindow: ${this.currentFlareConfig.contextWindow}\nhandoffContext: ${this.currentFlareConfig.handoffContext}\nstream: ${this.currentFlareConfig.stream}\nisReasoningModel: ${this.currentFlareConfig.isReasoningModel}\nreasoningHeader: "${this.currentFlareConfig.reasoningHeader}"\n---\n\n${systemPrompt}`;
                file = await this.plugin.app.vault.create(filePath, initialContent);
            }

            // Update cache
            this.flareCache.set(this.currentFlareConfig.name, { ...this.currentFlareConfig });
        } catch (error) {
            console.error('Failed to save flare config:', error);
            throw error;
        }
    }
} 