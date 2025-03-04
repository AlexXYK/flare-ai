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

            // Find a default provider to use
            let defaultProviderEntry = Object.entries(this.plugin.settings.providers)[0] || [null, null];
            let defaultProviderId = defaultProviderEntry[0] || '';
            let defaultProviderSettings = defaultProviderEntry[1];
            
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
                    providerName: defaultProviderSettings?.name || 'Default Provider',
                    providerType: defaultProviderSettings?.type || '',
                    provider: defaultProviderId, // Keep for backward compatibility
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

            // Extract provider information from frontmatter
            const providerName = fileCache.frontmatter?.providerName || '';
            const providerType = fileCache.frontmatter?.providerType || '';
            const providerId = fileCache.frontmatter?.provider || '';
            
            // Find the matching provider using name and type
            let matchedProviderId: string | null = null;
            let matchedProviderSettings: any = null;
            
            // First try to match by name (preferred method)
            if (providerName) {
                const matchByName = Object.entries(this.plugin.settings.providers)
                    .find(([_, settings]) => settings.name === providerName);
                if (matchByName) {
                    matchedProviderId = matchByName[0];
                    matchedProviderSettings = matchByName[1];
                }
            }
            
            // If no match by name, try by type
            if (!matchedProviderId && providerType) {
                const matchByType = Object.entries(this.plugin.settings.providers)
                    .find(([_, settings]) => settings.type === providerType);
                if (matchByType) {
                    matchedProviderId = matchByType[0];
                    matchedProviderSettings = matchByType[1];
                }
            }
            
            // If still no match, try by ID for backward compatibility
            if (!matchedProviderId && providerId) {
                if (this.plugin.settings.providers[providerId]) {
                    matchedProviderId = providerId;
                    matchedProviderSettings = this.plugin.settings.providers[providerId];
                }
            }
            
            // If no match found, use the first available provider
            if (!matchedProviderId || !matchedProviderSettings) {
                matchedProviderId = defaultProviderId;
                matchedProviderSettings = defaultProviderSettings;
                console.warn(`No matching provider found for flare "${flareName}", using ${matchedProviderSettings?.name || 'default provider'}`);
            }
            
            // Validate windows
            const handoffContext = fileCache.frontmatter?.handoffContext ?? -1;
            const contextWindow = fileCache.frontmatter?.contextWindow ?? -1;

            // Create the flare config with complete provider information
            return {
                name: flareName,
                providerName: matchedProviderSettings?.name || providerName || 'Unknown Provider',
                providerType: matchedProviderSettings?.type || providerType || '',
                provider: matchedProviderId || '', // Keep for backward compatibility
                model: fileCache.frontmatter?.model || matchedProviderSettings?.defaultModel || '',
                temperature: fileCache.frontmatter?.temperature !== undefined ? fileCache.frontmatter.temperature : 0.7,
                maxTokens: fileCache.frontmatter?.maxTokens,
                systemPrompt: systemPrompt,
                enabled: fileCache.frontmatter?.enabled ?? true,
                description: fileCache.frontmatter?.description || '',
                contextWindow: contextWindow,
                handoffContext: handoffContext,
                stream: fileCache.frontmatter?.stream ?? false,
                isReasoningModel: fileCache.frontmatter?.isReasoningModel ?? false,
                reasoningHeader: fileCache.frontmatter?.reasoningHeader || '<think>'
            };
        } catch (error) {
            console.error('Error loading flare config:', error);
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
            await this.loadFlares();
            
            // Set initialization flag
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
                    
                    // Set as current flare
                    this.currentFlare = newFlareName;
                    
                    // Enable the delete button since we now have a selected flare
                    const deleteButton = buttonsContainer.querySelector('.clickable-icon.delete-flare');
                    if (deleteButton instanceof HTMLElement) {
                        deleteButton.classList.remove('disabled');
                    }
                    
                    // Load and show the settings for the new flare
                    await this.showFlareSettings(containerEl, newFlareName);
                    
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
            // Create a reference to the existing elements we want to preserve
            const heading = containerEl.querySelector('.setting-item.setting-item-heading');
            const selector = containerEl.querySelector('.setting-item:not(.setting-item-heading)');
            const actionButtons = containerEl.querySelector('.flare-form-actions') as HTMLElement;
            
            // Clear only the settings content, preserving the structure
            // Find all settings below the selector but not including the action buttons
            const settingsToRemove = Array.from(containerEl.children).filter(el => {
                // Keep heading and selector
                if (el === heading || el === selector || el === actionButtons) {
                    return false;
                }
                return true;
            });
            
            // Remove only those elements that should be removed
            settingsToRemove.forEach(el => el.remove());
            
            // Ensure action buttons are at the end
            if (actionButtons && actionButtons.parentElement === containerEl) {
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
                try {
                    const flare = await this.loadFlareConfig(flareName);
                    if (!flare) {
                        console.error('Failed to load flare configuration for ' + flareName);
                        // Use default config instead of throwing
                        this.currentFlareConfig = this.getDefaultFlareConfig(flareName);
                    } else {
                        // Store original settings for comparison
                        this.originalSettings = Object.freeze({ ...flare });
                        this.currentFlareConfig = { ...flare };
                    }
                } catch (configError) {
                    console.error('Error loading flare config:', configError);
                    // Use default config instead of throwing
                    this.currentFlareConfig = this.getDefaultFlareConfig(flareName);
                }
            } else {
                // Use empty config for disabled state
                this.currentFlareConfig = {
                    name: '',
                    provider: '',
                    providerType: '',
                    providerName: '',
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
                // Only show notice, don't create error message in UI
                new Notice('Error loading flare: ' + getErrorMessage(error));
            }
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
        // Provider dropdown
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
                    dropdown.setValue(this.currentFlareConfig.provider || '');
                } else {
                    dropdown.setValue('');
                }

                dropdown.setDisabled(isDisabled)
                    .onChange(async (value) => {
                        if (!this.currentFlareConfig) return;
                        
                        // Store the old provider type for comparison
                        const oldProviderId = this.currentFlareConfig.provider || '';
                        const oldProviderSettings = oldProviderId ? this.plugin.settings.providers[oldProviderId] : null;
                        const oldProviderType = oldProviderSettings?.type || '';
                        
                        // Update current flare config with new provider
                        this.currentFlareConfig.provider = value;
                        
                        // Get new provider settings
                        const newProviderSettings = value ? this.plugin.settings.providers[value] : null;
                        const newProviderType = newProviderSettings?.type || '';
                        
                        // Update providerName and providerType in the config
                        if (newProviderSettings) {
                            this.currentFlareConfig.providerName = newProviderSettings.name || '';
                            this.currentFlareConfig.providerType = newProviderType;
                        } else {
                            this.currentFlareConfig.providerName = '';
                            this.currentFlareConfig.providerType = '';
                        }
                        
                        // Reset model when provider changes
                        this.currentFlareConfig.model = '';
                        
                        const settingItem = (dropdown as any).settingEl || dropdown.selectEl.closest('.setting-item');
                        if (settingItem) {
                            this.markAsChanged(formElement, settingItem);
                        }
                        
                        // Check if streaming is supported by this provider
                        const supportsStreaming = newProviderType === 'openai' || 
                                               newProviderType === 'ollama' || 
                                               newProviderType === 'openrouter';
                        
                        // Find streaming toggle setting using the data attribute
                        const streamingSetting = formElement.querySelector('[data-setting-id="streaming-toggle"]');
                        if (streamingSetting instanceof HTMLElement) {
                            const toggleEl = streamingSetting.querySelector('input[type="checkbox"]');
                            
                            if (toggleEl instanceof HTMLInputElement) {
                                // Update the streaming toggle based on the new provider
                                if (!supportsStreaming) {
                                    // Disable streaming for unsupported providers
                                    toggleEl.disabled = true;
                                    streamingSetting.classList.add('is-disabled');
                                    
                                    // Set stream to false for unsupported providers
                                    this.currentFlareConfig.stream = false;
                                    toggleEl.checked = false;
                                } else {
                                    // Enable streaming for supported providers
                                    toggleEl.disabled = isDisabled; // Only disable if the form is disabled
                                    streamingSetting.classList.remove('is-disabled');
                                    
                                    // Don't automatically turn on streaming when switching providers
                                    // Just ensure the toggle is correctly reflecting the current config value
                                    toggleEl.checked = !!this.currentFlareConfig.stream;
                                }
                            }
                        }
                        
                        // Update the model dropdown with the new provider's models
                        await this.updateModelDropdown(formElement, value);
                    });
                return dropdown;
            });

        // Model dropdown - create as a regular setting-item
        const modelSetting = new Setting(formElement)
            .setName('Model')
            .setDesc('Select the model to use for this flare')
            .setDisabled(isDisabled)
            .addDropdown((dropdown) => {
                if (!this.currentFlareConfig) return dropdown;
                
                // Add default option
                dropdown.addOption('', 'Select a model...');
                
                // Set up change handler
                dropdown.onChange(value => {
                    if (!this.currentFlareConfig) return;
                    this.currentFlareConfig.model = value;
                    const settingItem = modelSetting.settingEl;
                    if (settingItem) {
                        this.markAsChanged(formElement, settingItem);
                    }
                });

                // If we have a provider, load its models
                if (this.currentFlareConfig.provider) {
                    // Load models after dropdown is initialized
                    this.loadModelsForDropdown(this.currentFlareConfig.provider, dropdown);
                }
                
                return dropdown;
            });

        // Store reference to model setting for updates
        (formElement as any).modelSetting = modelSetting;

        // Add reasoning model toggle for all providers
        new Setting(formElement)
            .setName('Reasoning model')
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
    }

    /** Loads models for a provider into a dropdown
     * @param providerId The ID of the provider
     * @param dropdown The dropdown to populate
     */
    private async loadModelsForDropdown(providerId: string, dropdown: DropdownComponent) {
        const provider = this.plugin.settings.providers[providerId];
        if (!provider) return;

        try {
            // Get all available models
            const allModels = await this.plugin.getModelsForProvider(provider.type);
            
            // Filter models based on visibility settings
            let visibleModels = allModels;
            if (provider.visibleModels && provider.visibleModels.length > 0) {
                // For Gemini and Ollama, directly use the visible models from provider settings
                // This ensures custom models added by the user are included
                if (provider.type === 'gemini' || provider.type === 'ollama') {
                    visibleModels = provider.visibleModels;
                } else {
                    visibleModels = allModels.filter(model => 
                        provider.visibleModels?.includes(model) ?? false
                    );
                }
            }

            // Clear existing options except the default
            dropdown.selectEl.empty();
            dropdown.addOption('', 'Select a model...');

            // Add model options
            visibleModels.forEach(model => {
                dropdown.addOption(model, model);
            });
            
            // Check if current flare's model exists in the dropdown but is not in visibleModels
            if (this.currentFlareConfig?.model && 
                !visibleModels.includes(this.currentFlareConfig.model)) {
                
                // Add the missing model with a special class
                const option = document.createElement('option');
                option.value = this.currentFlareConfig.model;
                option.textContent = this.currentFlareConfig.model;
                option.className = 'flare-missing-model';
                dropdown.selectEl.appendChild(option);
                
                // Sort options alphabetically (except the first "Select a model..." option)
                const options = Array.from(dropdown.selectEl.options).slice(1);
                options.sort((a, b) => a.text.localeCompare(b.text));
                
                // Clear and re-add sorted options
                dropdown.selectEl.innerHTML = '';
                dropdown.selectEl.appendChild(document.createElement('option')).textContent = 'Select a model...';
                options.forEach(opt => dropdown.selectEl.appendChild(opt));
            }

            // Set current value if exists
            if (this.currentFlareConfig) {
                dropdown.setValue(this.currentFlareConfig.model || provider.defaultModel || '');
            }
        } catch (error) {
            console.error('Failed to load models:', error);
            if (Array.isArray(provider.availableModels) && provider.availableModels.length > 0) {
                new Notice('Failed to load models');
            }
        }
    }

    private async createAdvancedSettingsSection(form: HTMLElement, isDisabled: boolean) {
        // Check if current flare uses anthropic provider
        let isAnthropicProvider = false;
        let isGeminiProvider = false;
        let supportsStreaming = false;
        
        if (this.currentFlareConfig && this.currentFlareConfig.provider) {
            const providerSettings = this.plugin.settings.providers[this.currentFlareConfig.provider];
            isAnthropicProvider = providerSettings?.type === 'anthropic';
            isGeminiProvider = providerSettings?.type === 'gemini';
            supportsStreaming = providerSettings?.type === 'openai' || 
                               providerSettings?.type === 'ollama' || 
                               providerSettings?.type === 'openrouter';
        }

        // Streaming toggle
        const streamingSetting = new Setting(form)
            .setName('Enable streaming')
            .setDesc('Stream tokens as they are generated. Only supported by OpenAI, Ollama, and OpenRouter.')
            .setDisabled(isDisabled || !supportsStreaming);
            
        // Ensure the setting item has a data attribute to easily find it later
        streamingSetting.settingEl.setAttribute('data-setting-id', 'streaming-toggle');
            
        streamingSetting.addToggle(toggle => {
            if (!this.currentFlareConfig) return toggle;
            
            // Use streaming setting from config, default to false
            toggle.setValue(this.currentFlareConfig.stream ?? false)
                .setDisabled(isDisabled || !supportsStreaming)
                .onChange(value => {
                    if (!this.currentFlareConfig) return;
                    this.currentFlareConfig.stream = value;
                    const settingItem = streamingSetting.settingEl;
                    if (settingItem) {
                        this.markAsChanged(form, settingItem);
                    }
                });
            
            // Add disabled class for styling if provider doesn't support streaming
            if (!supportsStreaming) {
                streamingSetting.settingEl.classList.add('is-disabled');
            }
            
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
            .setName('Max tokens')
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
            .setName('Context window')
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

        // Handoff context
        new Setting(form)
            .setName('Handoff context')
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
            .setName('System prompt')
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
                    
                    // Update the dropdown
                    if (this.flareDropdown) {
                        // Remove the option from the dropdown
                        const optionToRemove = this.flareDropdown.selectEl.querySelector(`option[value="${flareName}"]`);
                        if (optionToRemove) {
                            optionToRemove.remove();
                        }
                        
                        // Set dropdown to default "Select a flare..." option
                        this.flareDropdown.setValue('');
                    }
                    
                    // Find the appropriate container - target just the flares-section to prevent affecting provider settings
                    const flareSettingsContainer = document.querySelector('.flares-section');
                    
                    if (flareSettingsContainer instanceof HTMLElement) {
                        // Instead of trying to update the current container which might have mixed content,
                        // recreate the entire flare settings UI in the proper container
                        await this.createSettingsUI(flareSettingsContainer);
                    } else {
                        // Fallback to more targeted approach if we can't find the main container
                        // Find the settings container - try multiple potential selectors
                        let settingsContainer = document.querySelector('.flare-settings-container') as HTMLElement | null;
                        
                        // If not found, try looking in the plugin view
                        if (!settingsContainer) {
                            settingsContainer = document.querySelector('.workspace-leaf-content[data-type="flare-chat"] .view-content .flare-settings') as HTMLElement | null;
                        }
                        
                        // Or if it's in the flare settings modal
                        if (!settingsContainer) {
                            settingsContainer = document.querySelector('.modal .flare-settings') as HTMLElement | null;
                        }
                        
                        if (settingsContainer instanceof HTMLElement) {
                            // Show empty/disabled settings
                            await this.showFlareSettings(settingsContainer, null);
                            
                            // Disable delete button
                            const deleteButton = settingsContainer.querySelector('.flare-buttons .clickable-icon.delete-flare');
                            if (deleteButton instanceof HTMLElement) {
                                deleteButton.classList.add('disabled');
                            }
                        }
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

        // Get the model setting from the container
        const modelSetting = (container as any).modelSetting;
        if (!modelSetting) return;

        // Get the dropdown component
        const dropdown = modelSetting.components[0] as DropdownComponent;
        if (!dropdown) return;

        try {
            // Get all available models
            const allModels = await this.plugin.getModelsForProvider(provider.type);
            
            // Filter models based on visibility settings
            let visibleModels = allModels;
            if (provider.visibleModels && provider.visibleModels.length > 0) {
                // For Gemini and Ollama, directly use the visible models from provider settings
                // This ensures custom models added by the user are included
                if (provider.type === 'gemini' || provider.type === 'ollama') {
                    visibleModels = provider.visibleModels;
                } else {
                    visibleModels = allModels.filter(model => 
                        provider.visibleModels?.includes(model) ?? false
                    );
                }
            }

            // Clear existing options
            dropdown.selectEl.empty();
            dropdown.addOption('', 'Select a model...');

            // Add model options
            visibleModels.forEach(model => {
                dropdown.addOption(model, model);
            });
            
            // Check if current flare's model exists in the dropdown but is not in visibleModels
            if (this.currentFlareConfig?.model && 
                !visibleModels.includes(this.currentFlareConfig.model)) {
                
                // Add the missing model with a special class
                const option = document.createElement('option');
                option.value = this.currentFlareConfig.model;
                option.textContent = this.currentFlareConfig.model;
                option.className = 'flare-missing-model';
                dropdown.selectEl.appendChild(option);
                
                // Sort options alphabetically (except the first "Select a model..." option)
                const options = Array.from(dropdown.selectEl.options).slice(1);
                options.sort((a, b) => a.text.localeCompare(b.text));
                
                // Clear and re-add sorted options
                dropdown.selectEl.innerHTML = '';
                dropdown.selectEl.appendChild(document.createElement('option')).textContent = 'Select a model...';
                options.forEach(opt => dropdown.selectEl.appendChild(opt));
            }

            // Set current value if exists
            if (this.currentFlareConfig) {
                dropdown.setValue(this.currentFlareConfig.model || provider.defaultModel || '')
                    .setDisabled(isDisabled)
                    .onChange(value => {
                        if (this.currentFlareConfig) {
                            this.currentFlareConfig.model = value;
                            const settingItem = modelSetting.settingEl;
                            if (settingItem) {
                                this.markAsChanged(container, settingItem);
                            }
                        }
                    });
            }
        } catch (error) {
            console.error('Failed to load models:', error);
            // Only show notice if this isn't a new provider (no models configured yet)
            if (Array.isArray(provider.availableModels) && provider.availableModels.length > 0) {
                new Notice('Failed to load models');
            }
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
            
            // Look for a default provider setting in plugin settings
            let defaultProviderId = this.plugin.settings.defaultProvider;
            
            // If no default is set, try to find a suitable default
            if (!defaultProviderId || !this.plugin.settings.providers[defaultProviderId]) {
                // Try to find OpenAI, Ollama, or any other provider in that order
                const providerEntries = Object.entries(this.plugin.settings.providers);
                
                // First, look for specific provider types (prefer OpenAI, then Ollama)
                const preferredTypes = ['openai', 'ollama', 'openrouter'];
                
                for (const preferredType of preferredTypes) {
                    const matchingProvider = providerEntries.find(([_, settings]) => 
                        settings.type === preferredType && settings.enabled
                    );
                    
                    if (matchingProvider) {
                        defaultProviderId = matchingProvider[0];
                        break;
                    }
                }
                
                // If none of the preferred types found, use the first available
                if (!defaultProviderId) {
                    const firstEnabled = providerEntries.find(([_, settings]) => 
                        settings.enabled
                    );
                    
                    if (firstEnabled) {
                        defaultProviderId = firstEnabled[0];
                    } else {
                        // Fallback to the first provider if nothing else available
                        defaultProviderId = Object.keys(this.plugin.settings.providers)[0] || '';
                    }
                }
            }
            
            const defaultProviderSettings = this.plugin.settings.providers[defaultProviderId];
            
            // Determine if streaming should be enabled based on provider type
            const providerType = defaultProviderSettings?.type || '';
            const supportsStreaming = providerType === 'openai' || 
                                     providerType === 'ollama' || 
                                     providerType === 'openrouter';
            
            const flare: FlareConfig = {
                name,
                providerName: defaultProviderSettings?.name || 'Default Provider',
                providerType: providerType,
                provider: defaultProviderId, // Keep for backward compatibility
                model: '',
                enabled: true,
                description: 'New Flare',
                temperature: 0.7,
                maxTokens: 2048,
                systemPrompt: "You are a helpful AI assistant.",
                contextWindow: -1, // Default to all context
                handoffContext: -1, // Default to no handoff context
                stream: false, // Default to no streaming, even for supported providers
                isReasoningModel: false,
                reasoningHeader: '<think>'
            };

            // Create the file path
            const filePath = `${flareFolder}/${name}.md`;

            // Create initial file with complete frontmatter instead of empty
            const initialContent = `---
providerName: ${flare.providerName}
providerType: ${flare.providerType}
provider: ${flare.provider}
model: ${flare.model}
enabled: ${flare.enabled}
description: "${flare.description}"
temperature: ${flare.temperature}
maxTokens: ${flare.maxTokens}
contextWindow: ${flare.contextWindow}
handoffContext: ${flare.handoffContext}
stream: ${flare.stream}
isReasoningModel: ${flare.isReasoningModel}
reasoningHeader: "${flare.reasoningHeader}"
---

${flare.systemPrompt}`;

            // Create the file with all frontmatter already populated
            const file = await this.plugin.app.vault.create(filePath, initialContent);
            
            // Add to cache and reload flares
            this.flareCache.set(name, flare);
            await this.loadFlares();

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
            
            // Get provider id, ensure we have type and name
            const providerId = fileCache.frontmatter.provider || '';
            let providerName = fileCache.frontmatter.providerName || '';
            let providerType = fileCache.frontmatter.providerType || '';
            
            // If we have a provider ID but no type/name, try to get them from settings
            if (providerId && (!providerName || !providerType)) {
                const providerSettings = this.plugin.settings.providers[providerId];
                if (providerSettings) {
                    providerType = providerType || providerSettings.type || '';
                    providerName = providerName || providerSettings.name || 'Default Provider';
                }
            }
            
            // If we still don't have name/type, set defaults
            if (!providerName) {
                providerName = 'Default Provider';
            }
            
            // Create flare config
            const flare: FlareConfig = {
                name: basename,
                providerName: providerName,
                providerType: providerType,
                provider: providerId, // Keep for backward compatibility
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
            // Get file path and reference
            const filePath = `${this.plugin.settings.flaresFolder}/${flareName}.md`;
            let file = this.plugin.app.vault.getAbstractFileByPath(filePath);
            
            // Get system prompt (everything after frontmatter)
            const systemPrompt = this.currentFlareConfig.systemPrompt || '';

            // Make sure provider name and type are set (should be, but just in case)
            if (!this.currentFlareConfig.providerName || !this.currentFlareConfig.providerType) {
                const providerId = this.currentFlareConfig.provider || '';
                const providerSettings = providerId ? this.plugin.settings.providers[providerId] : null;
                
                if (providerSettings) {
                    this.currentFlareConfig.providerName = this.currentFlareConfig?.providerName;
                    this.currentFlareConfig.providerType = this.currentFlareConfig?.providerType;
                } else {
                    // Fallback to the first available provider if we can't find a match
                    const firstProvider = Object.entries(this.plugin.settings.providers)[0];
                    if (firstProvider && firstProvider[1]) {
                        this.currentFlareConfig.providerName = firstProvider[1].name || 'Default Provider';
                        this.currentFlareConfig.providerType = firstProvider[1].type || '';
                        this.currentFlareConfig.provider = firstProvider[0]; // update ID too
                    } else {
                        // Absolute fallback with defaults if no providers exist
                        this.currentFlareConfig.providerName = 'Default Provider';
                        this.currentFlareConfig.providerType = '';
                        this.currentFlareConfig.provider = '';
                    }
                }
            }

            if (file instanceof TFile) {
                // Update existing file
                await this.plugin.app.fileManager.processFrontMatter(file, (frontmatter) => {
                    // Use name and type as primary identifiers
                    frontmatter.providerName = this.currentFlareConfig?.providerName;
                    frontmatter.providerType = this.currentFlareConfig?.providerType;
                    // Keep provider ID for backward compatibility
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
                const initialContent = `---
providerName: ${this.currentFlareConfig.providerName}
providerType: ${this.currentFlareConfig.providerType}
provider: ${this.currentFlareConfig.provider}
model: ${this.currentFlareConfig.model}
enabled: ${this.currentFlareConfig.enabled}
description: "${this.currentFlareConfig.description}"
temperature: ${this.currentFlareConfig.temperature}
maxTokens: ${this.currentFlareConfig.maxTokens}
contextWindow: ${this.currentFlareConfig.contextWindow}
handoffContext: ${this.currentFlareConfig.handoffContext}
stream: ${this.currentFlareConfig.stream}
isReasoningModel: ${this.currentFlareConfig.isReasoningModel}
reasoningHeader: "${this.currentFlareConfig.reasoningHeader}"
---

${systemPrompt}`;
                file = await this.plugin.app.vault.create(filePath, initialContent);
            }

            // Update cache
            this.flareCache.set(this.currentFlareConfig.name, { ...this.currentFlareConfig });
        } catch (error) {
            console.error('Failed to save flare config:', error);
            throw error;
        }
    }

    // Helper method to get default flare config
    private getDefaultFlareConfig(flareName: string): FlareConfig {
        const defaultProviderId = Object.keys(this.plugin.settings.providers)[0] || '';
        const defaultProvider = this.plugin.settings.providers[defaultProviderId];
        
        return {
            name: flareName,
            providerName: defaultProvider?.name || 'Default Provider',
            providerType: defaultProvider?.type || '',
            provider: defaultProviderId, // Keep for backward compatibility
            model: '',
            enabled: true,
            description: 'New Flare',
            temperature: 0.7,
            maxTokens: 2048,
            systemPrompt: "You are a helpful AI assistant.",
            contextWindow: -1,
            handoffContext: -1,
            stream: false,
            isReasoningModel: false,
            reasoningHeader: '<think>'
        };
    }
} 