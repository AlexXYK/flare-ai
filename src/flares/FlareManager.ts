import { Setting, setIcon, Notice, Modal, App, DropdownComponent, TextComponent, TextAreaComponent, TFile, TAbstractFile } from 'obsidian';
import type FlarePlugin from '../../main';
import { FlareConfig } from './FlareConfig';

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
                        // Try to get first available model
                        try {
                            const models = await this.plugin.getModelsForProvider(providerSettings.type);
                            if (models.length > 0) {
                                model = models[0];
                            }
                        } catch (error) {
                            console.error('Failed to get models for provider:', error);
                        }
                    }
                }

                return {
                    name: flareName,
                    provider: defaultProvider,
                    model: model,
                    enabled: true,
                    description: '',
                    historyWindow: -1,
                    handoffWindow: -1,
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
            const handoffWindow = frontmatter.handoffWindow ?? -1;
            const historyWindow = frontmatter.historyWindow ?? -1;

            return {
                name: flareName,
                provider: providerId,
                model: frontmatter.model || providerSettings?.defaultModel || '',
                temperature: frontmatter.temperature !== undefined ? frontmatter.temperature : 0.7,
                maxTokens: frontmatter.maxTokens,
                systemPrompt: systemPrompt.trim(),
                enabled: frontmatter.enabled ?? true,
                description: frontmatter.description || '',
                historyWindow: historyWindow,
                handoffWindow: handoffWindow,
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
                .setName('Flare')
                .setDesc('Select a flare to configure')
                .addDropdown(async (dropdown) => {
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
                        }
                    });
                });

            // Add buttons
            select.addButton(btn => 
                btn
                    .setIcon('plus')
                    .setTooltip('Add Flare')
                    .onClick(async () => {
                        const newFlareName = await this.createNewFlare();
                        if (newFlareName) {
                            // Update dropdown with new option
                            const dropdownComponent = select.components[0] as DropdownComponent;
                            if (dropdownComponent) {
                                dropdownComponent.addOption(newFlareName, newFlareName);
                            }
                            new Notice('New flare created. Select it from the dropdown to configure.');
                        }
                    })
            )
            .addButton(btn =>
                btn
                    .setIcon('trash')
                    .setTooltip('Delete Flare')
                    .onClick(async () => {
                        if (this.currentFlare) {
                            const confirmed = await new Promise<boolean>((resolve) => {
                                const modal = new ConfirmModal(
                                    this.plugin.app,
                                    'Delete Flare',
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

                                    new Notice(`Deleted flare: ${flareName}`);
                                } catch (error) {
                                    console.error('Failed to delete flare:', error);
                                    new Notice('Failed to delete flare');
                                } finally {
                                    this.isLoadingFlares = false;
                                }
                            }
                        }
                    })
            );

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
            .addDropdown(dropdown => {
                Object.entries(this.plugin.settings.providers).forEach(([id, provider]) => {
                    if (provider.enabled) {
                        dropdown.addOption(id, provider.name);
                    }
                });
                dropdown.setValue(settings.provider)
                    .onChange(value => {
                        settings.provider = value;
                        settings.model = ''; // Reset model when provider changes
                        this.markAsChanged();
                        this.createSettingsUI(containerEl);
                    });
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
                            console.error('Failed to load models:', error);
                            new Notice('Failed to load models');
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

        // Context window
        new Setting(flareContainer)
            .setName('Context Window')
            .setDesc('Number of previous messages to include')
            .addText(text => text
                .setValue(String(settings.historyWindow || 10))
                .onChange(value => {
                    const num = parseInt(value);
                    if (!isNaN(num) && num >= 0) {
                        settings.historyWindow = num;
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

        // Create action buttons if they don't exist
        if (!this.actionButtons) {
            const settingsArea = form?.closest('.flare-settings-area') as HTMLElement;
            if (settingsArea) {
                const actions = settingsArea.createDiv('flare-form-actions');
                // Insert at the beginning of settings area
                settingsArea.insertBefore(actions, settingsArea.firstChild);
                this.actionButtons = actions;
                
                new Setting(actions)
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
                                await this.revertChanges(settingsArea);
                            });
                    });
            }
        }
        
        // Show action buttons
        if (this.actionButtons) {
            this.actionButtons.style.display = 'flex';
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
            
            if (this.actionButtons) {
                this.actionButtons.style.display = 'none';
            }

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
        
        await this.showFlareSettings(containerEl, this.currentFlare);
        
        this.hasUnsavedChanges = false;
        if (this.actionButtons) {
            this.actionButtons.style.display = 'none';
        }
        
        new Notice('Flare settings reverted');
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
        
        // Remove any existing action buttons
        if (this.actionButtons) {
            this.actionButtons.remove();
            this.actionButtons = null;
        }

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

            // Create sections
            await Promise.all([
                this.createBasicSettingsSection(form),
                this.createProviderSettingsSection(form),
                this.createAdvancedSettingsSection(form),
                this.createSystemPromptSection(form)
            ]);

            return form;
        } catch (error) {
            console.error('Failed to show flare settings:', error);
            if (settingsArea) {
                settingsArea.empty();
                const errorMessage = settingsArea.createEl('div', {
                    text: 'Failed to load flare settings. Please try again.',
                    cls: 'flare-error-message'
                });
                
                // Add retry button
                const retryButton = errorMessage.createEl('button', {
                    text: 'Retry',
                    cls: 'mod-warning'
                });
                retryButton.onclick = () => this.showFlareSettings(containerEl, flareName);
            }
            throw error;
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

    private async createProviderSettingsSection(form: HTMLElement) {
        // Remove any existing provider settings section first
        const existingSection = form.querySelector('.flare-section[data-section="provider-settings"]');
        if (existingSection) {
            existingSection.remove();
        }

        // Find the basic settings section to insert after it
        const basicSection = form.querySelector('.flare-section[data-section="basic-settings"]');
        
        const section = document.createElement('div');
        section.className = 'flare-section';
        section.setAttribute('data-section', 'provider-settings');
        const header = section.createDiv('flare-section-header');
        header.createEl('h4', { text: 'Provider Settings' });
        const providerSection = section.createDiv('flare-section-content');

        // Insert after basic settings if it exists, otherwise prepend to form
        if (basicSection) {
            basicSection.after(section);
        } else {
            form.prepend(section);
        }
        
        await new Promise<void>(resolve => {
            setTimeout(() => {
                // Provider selection
                new Setting(providerSection)
                    .setName('Provider')
                    .setDesc('Select the AI provider for this flare')
                    .addDropdown(dropdown => {
                        if (!this.currentFlareConfig) return dropdown;
                        
                        // Add provider options
                        Object.entries(this.plugin.settings.providers).forEach(([id, provider]) => {
                            // Only show enabled providers with a valid type
                            if (provider.enabled && provider.type && this.plugin.providers.has(provider.type)) {
                                dropdown.addOption(id, provider.name || id);
                            }
                        });
                        
                        // Set current value if it exists and the provider is still valid
                        const currentProvider = this.plugin.settings.providers[this.currentFlareConfig.provider || ''];
                        if (currentProvider?.enabled && currentProvider.type && this.plugin.providers.has(currentProvider.type)) {
                            dropdown.setValue(this.currentFlareConfig.provider);
                        } else {
                            dropdown.setValue('');
                        }

                        dropdown.onChange(async value => {
                            if (!this.currentFlareConfig) return;
                            this.currentFlareConfig.provider = value;
                            // Reset model when provider changes
                            this.currentFlareConfig.model = '';
                            const settingItem = (dropdown as any).settingEl || dropdown.selectEl.closest('.setting-item');
                            if (settingItem) {
                                this.markAsChanged(form, settingItem);
                            }
                            // Update the model dropdown with the new provider's models
                            await this.updateModelDropdown(providerSection, value);
                        });
                        return dropdown;
                    });

                // Only show reasoning model settings for Ollama provider
                if (this.currentFlareConfig?.provider) {
                    const provider = this.plugin.settings.providers[this.currentFlareConfig.provider];
                    if (provider?.type === 'ollama') {
                        new Setting(providerSection)
                            .setName('Reasoning Model')
                            .setDesc('Enable for models that support reasoning (e.g. deepseek-coder)')
                            .addToggle(toggle => toggle
                                .setValue(this.currentFlareConfig?.isReasoningModel ?? false)
                                .onChange(value => {
                                    if (!this.currentFlareConfig) return;
                                    this.currentFlareConfig.isReasoningModel = value;
                                    const settingItem = (toggle as any).settingEl || toggle.toggleEl.closest('.setting-item');
                                    if (settingItem) {
                                        this.markAsChanged(form, settingItem);
                                    }
                                    // Instead of recreating the entire section, just update the header setting
                                    const headerSetting = providerSection.querySelector('.reasoning-header-setting');
                                    if (value) {
                                        if (!headerSetting) {
                                            new Setting(providerSection)
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
                                                                this.markAsChanged(form, headerSettingItem);
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
                            new Setting(providerSection)
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
                                                this.markAsChanged(form, settingItem);
                                            }
                                        });
                                });
                        }
                    }
                }

                // Initial model dropdown
                if (this.currentFlareConfig?.provider) {
                    this.updateModelDropdown(providerSection, this.currentFlareConfig.provider);
                }

                resolve();
            }, 0);
        });
    }

    private async updateModelDropdown(container: HTMLElement, providerId: string) {
        const provider = this.plugin.settings.providers[providerId];
        if (!provider) return;

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
                    if (provider.visibleModels && Array.isArray(provider.visibleModels)) {
                        visibleModels = allModels.filter(model => 
                            provider.visibleModels && provider.visibleModels.includes(model)
                        );
                    }

                    // Add models to dropdown
                    visibleModels.forEach(model => {
                        dropdown.addOption(model, model);
                    });

                    // Set current value or default
                    const config = this.currentFlareConfig;
                    if (config) {
                        if (config.model && visibleModels.includes(config.model)) {
                            dropdown.setValue(config.model);
                        } else {
                            const defaultModel = provider.defaultModel || visibleModels[0] || '';
                            config.model = defaultModel;
                            dropdown.setValue(defaultModel);
                        }
                    }

                    // Handle model selection
                    dropdown.onChange(value => {
                        const config = this.currentFlareConfig;
                        if (!config) return;
                        config.model = value;
                        const settingItem = modelSettingContainer.querySelector('.setting-item');
                        if (settingItem instanceof HTMLElement) {
                            this.markAsChanged(container, settingItem);
                        }
                    });
                } catch (error) {
                    console.error('Failed to load models:', error);
                    new Notice('Failed to load models');
                    
                    // Add retry button
                    new Setting(modelSettingContainer)
                        .setDesc('Failed to load models')
                        .addButton(button => button
                            .setButtonText('Retry')
                            .setWarning()
                            .onClick(async () => {
                                await this.updateModelDropdown(container, providerId);
                            }));
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

                // History window
                new Setting(advancedSection)
                    .setName('History Window')
                    .setDesc('Maximum number of message pairs to keep in context (-1 for all)')
                    .addText(text => {
                        if (!this.currentFlareConfig) return text;
                        text.setValue(String(this.currentFlareConfig.historyWindow))
                            .onChange(value => {
                                if (!this.currentFlareConfig) return;
                                const num = parseInt(value);
                                if (!isNaN(num) && (num > 0 || num === -1)) {
                                    this.currentFlareConfig.historyWindow = num;
                                    const settingItem = (text as any).settingEl || text.inputEl.closest('.setting-item');
                                    if (settingItem) {
                                        this.markAsChanged(form, settingItem);
                                    }
                                }
                            });
                        return text;
                    });

                // Handoff window
                new Setting(advancedSection)
                    .setName('Handoff Window')
                    .setDesc('Number of message pairs to inherit when switching to this flare (-1 for all)')
                    .addText(text => {
                        if (!this.currentFlareConfig) return text;
                        text.setValue(String(this.currentFlareConfig.handoffWindow ?? -1))
                            .onChange(value => {
                                if (!this.currentFlareConfig) return;
                                const num = parseInt(value);
                                if (!isNaN(num) && (num > 0 || num === -1)) {
                                    this.currentFlareConfig.handoffWindow = num;
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
            content.style.display = 'none';
            header.addClass('is-collapsed');
        }

        // Toggle handler
        header.onclick = () => {
            const isCollapsed = header.hasClass('is-collapsed');
            if (isCollapsed) {
                header.removeClass('is-collapsed');
                content.style.display = 'block';
            } else {
                header.addClass('is-collapsed');
                content.style.display = 'none';
            }
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

            // Format the flare content with ALL fields
            const content = [
                '---',
                `provider: "${this.currentFlareConfig.provider}"`,
                `model: "${this.currentFlareConfig.model}"`,
                `temperature: ${this.currentFlareConfig.temperature}`,
                this.currentFlareConfig.maxTokens ? `maxTokens: ${this.currentFlareConfig.maxTokens}` : null,
                `enabled: ${this.currentFlareConfig.enabled ?? true}`,
                this.currentFlareConfig.description ? `description: "${this.currentFlareConfig.description}"` : null,
                `historyWindow: ${this.currentFlareConfig.historyWindow ?? -1}`,
                `handoffWindow: ${this.currentFlareConfig.handoffWindow ?? -1}`,
                `stream: ${this.currentFlareConfig.stream ?? false}`,
                `isReasoningModel: ${this.currentFlareConfig.isReasoningModel ?? false}`,
                `reasoningHeader: "${this.currentFlareConfig.reasoningHeader || '<think>'}"`,
                '---\n',
                this.currentFlareConfig.systemPrompt || ''
            ].filter(Boolean).join('\n');

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

    private async createNewFlare(): Promise<string> {
        try {
            const flareFolder = this.plugin.settings.flaresFolder;
            if (!flareFolder) {
                new Notice('Flares folder not configured; cannot create new flare.');
                return '';
            }

            // Ensure the flares folder exists
            await this.plugin.ensureFlaresFolderExists();

            const name = `flare-${Date.now()}`;
            const flare: FlareConfig = {
                name,
                provider: Object.keys(this.plugin.settings.providers)[0] || '',
                model: '',
                enabled: true,
                description: 'New Flare',
                temperature: 0.7,
                maxTokens: 2048,
                systemPrompt: "You are a helpful AI assistant.",
                historyWindow: -1, // Default to all history
                stream: false, // Default to no streaming
                isReasoningModel: false,
                reasoningHeader: '<think>'
            };

            // Create frontmatter
            const frontmatter = [
                '---',
                `provider: ${flare.provider}`,
                `model: ${flare.model}`,
                `enabled: ${flare.enabled}`,
                `description: "${flare.description}"`,
                `temperature: ${flare.temperature}`,
                `maxTokens: ${flare.maxTokens}`,
                `historyWindow: ${flare.historyWindow}`,
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
        } catch (error) {
            if (error.message !== 'Operation cancelled') {
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
                historyWindow: frontmatter.historyWindow ?? -1,
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