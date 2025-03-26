import { Setting, TextComponent, TextAreaComponent, ToggleComponent, Notice, Platform, setIcon, setTooltip, DropdownComponent, ExtraButtonComponent } from 'obsidian';
import type FlarePlugin from '../../../main';
import type { ProviderSettings } from '../../types/AIProvider';

// CSS class constants
const CSS_CLASSES = {
    PROVIDER_SETTINGS: 'flare-provider-settings',
    MODEL_SETTINGS: 'flare-model-settings',
    MODEL_LIST: 'flare-model-list',
    MODEL_ITEM: 'flare-model-item',
    SORT_BTN: 'flare-model-sort',
    ARROW_ICON: 'flare-arrow-icon',
    IS_ASCENDING: 'is-ascending',
    IS_DESCENDING: 'is-descending',
    IS_ENABLED: 'is-enabled',
    IS_VISIBLE: 'is-visible',
    IS_ACTIVE: 'is-active',
    LOADING: 'is-loading',
    DISABLED: 'is-disabled',
    CHECKBOX: 'flare-checkbox'
};

// Common attributes for accessibility
const ARIA_ATTRS = {
    MODEL_LIST: { 'role': 'list' },
    MODEL_ITEM: { 'role': 'listitem' },
    SORT_BTN: { 'role': 'button' }
};

export class ProviderSettingsView {
    private originalSettings: ProviderSettings;
    private workingSettings: ProviderSettings; // Working copy of settings
    private actionButtons: HTMLElement | null = null;
    private hasSettingsChanged: boolean = false;
    private currentSortOrder: 'asc' | 'desc' = 'asc';
    private currentSortCriteria: 'name' | 'visibility' = 'name';
    private modelsContainer: HTMLElement | null = null;
    private isLoading: boolean = false;
    private settingsComponents: Map<string, { 
        component: TextComponent | TextAreaComponent | ToggleComponent;
        setting: Setting;
        isModel?: boolean;
    }> = new Map();
    private originalSettingsSnapshot: string = '';

    constructor(
        private plugin: FlarePlugin,
        private container: HTMLElement,
        private settings: ProviderSettings | null,
        private onSave: () => Promise<void>,
        private onSettingsChange: () => void
    ) {
        // Store original settings for revert
        this.originalSettings = JSON.parse(JSON.stringify(settings || {
            name: '',
            type: '',
            enabled: false,
            visibleModels: []
        }));
        
        // Create a working copy of settings
        this.workingSettings = JSON.parse(JSON.stringify(this.originalSettings));

        // Ensure visibleModels is initialized
        if (this.workingSettings) {
            this.workingSettings.visibleModels = this.workingSettings.visibleModels || [];
        }

        // Store original settings as JSON string for comparison
        this.originalSettingsSnapshot = JSON.stringify(this.originalSettings);
    }

    private settingChanged(newValue: any, path: string) {
        if (!this.workingSettings) return;

        // Get the old value using the path
        const pathParts = path.split('.');
        let oldValue = this.originalSettings;
        for (const part of pathParts) {
            if (oldValue === undefined) break;
            oldValue = oldValue[part];
        }

        // Handle arrays and objects properly
        let hasChanged: boolean;
        if (Array.isArray(newValue) || typeof newValue === 'object') {
            hasChanged = JSON.stringify(newValue) !== JSON.stringify(oldValue);
        } else {
            // For primitive values, use direct comparison
            hasChanged = newValue !== oldValue;
        }
        
        // Always check overall settings difference too, in case other properties have changed
        const overallDifference = JSON.stringify(this.workingSettings) !== JSON.stringify(this.originalSettings);
        
        // If either the specific property or overall settings changed, mark as changed
        if (hasChanged || overallDifference) {
            this.hasSettingsChanged = true;
            this.onSettingsChange();
        }
    }

    updateOriginalSettings(): void {
        // Update original settings with a deep copy of current working settings
        this.originalSettings = JSON.parse(JSON.stringify(this.workingSettings || {
            name: '',
            type: '',
            enabled: false,
            visibleModels: []
        }));
        
        // Apply working settings to actual settings
        if (this.settings && this.workingSettings) {
            Object.assign(this.settings, this.workingSettings);
        }
        
        this.hasSettingsChanged = false;

        // Update original settings snapshot
        this.originalSettingsSnapshot = JSON.stringify(this.originalSettings);
    }

    // Commit working settings to the actual settings object
    commitSettings(): void {
        if (this.settings && this.workingSettings) {
            // First store the original type to ensure it's preserved
            const originalType = this.workingSettings.type;
            // Also store the base URL
            const originalBaseUrl = this.workingSettings.baseUrl;
            // Store the name to ensure it's preserved
            const originalName = this.workingSettings.name;
            
            // Make a deep copy to ensure all properties are properly transferred
            Object.assign(this.settings, JSON.parse(JSON.stringify(this.workingSettings)));
            
            // Double-check that the type is preserved - just to be super safe
            if (originalType && (!this.settings.type || this.settings.type !== originalType)) {
                this.settings.type = originalType;
            }
            
            // Double-check that the base URL is preserved
            if (originalBaseUrl && (!this.settings.baseUrl || this.settings.baseUrl !== originalBaseUrl)) {
                this.settings.baseUrl = originalBaseUrl;
            }
            
            // Double-check that the name is preserved
            if (originalName && (!this.settings.name || this.settings.name !== originalName)) {
                this.settings.name = originalName;
            }
        }
    }

    display(): void {
        // Check if settings have already changed at initialization
        if (!this.hasSettingsChanged) {
            const hasDifferences = JSON.stringify(this.workingSettings) !== JSON.stringify(this.originalSettings);
            if (hasDifferences) {
                this.hasSettingsChanged = true;
                this.onSettingsChange();
            }
        }
        
        const isDisabled = !this.workingSettings;

        // Name setting
        new Setting(this.container)
            .setName('Name')
            .setDesc('A unique name for this provider')
            .setDisabled(isDisabled)
            .addText(text => text
                .setPlaceholder('Enter provider name')
                .setValue(this.workingSettings?.name || '')
                .setDisabled(isDisabled)
                .onChange(value => {
                    if (!this.workingSettings) return;
                    this.workingSettings.name = value;
                    // Force a check for changes
                    this.hasSettingsChanged = JSON.stringify(this.workingSettings) !== JSON.stringify(this.originalSettings);
                    this.onSettingsChange();
                }));

        // Enable toggle
        new Setting(this.container)
            .setName('Enable provider')
            .setDesc('Enable or disable this provider')
            .setDisabled(isDisabled)
            .addToggle(toggle => toggle
                .setValue(this.workingSettings?.enabled || false)
                .setDisabled(isDisabled)
                .onChange(value => {
                    if (!this.workingSettings) return;
                    this.workingSettings.enabled = value;
                    // Force a check for changes
                    this.hasSettingsChanged = JSON.stringify(this.workingSettings) !== JSON.stringify(this.originalSettings);
                    this.onSettingsChange();
                }));

        // API Key setting (always show, just disabled if not needed)
        new Setting(this.container)
            .setName('API Key')
            .setDesc('Your provider API key')
            .setDisabled(isDisabled || !['openai', 'openrouter', 'anthropic', 'azure', 'gemini'].includes(this.workingSettings?.type || ''))
            .addText(text => {
                const input = text
                    .setPlaceholder('Enter API key')
                    .setValue(this.workingSettings?.apiKey || '')
                    .setDisabled(isDisabled || !['openai', 'openrouter', 'anthropic', 'azure', 'gemini'].includes(this.workingSettings?.type || ''))
                    .onChange(value => {
                        if (!this.workingSettings) return;
                        this.workingSettings.apiKey = value.trim();
                        // Force a check for changes
                        this.hasSettingsChanged = JSON.stringify(this.workingSettings) !== JSON.stringify(this.originalSettings);
                        this.onSettingsChange();
                    });
                input.inputEl.type = 'password';
                this.addPasswordToggle(input.inputEl);
            });

        // Base URL setting (always show, just disabled if not needed)
        new Setting(this.container)
            .setName('Base URL')
            .setDesc('API endpoint URL')
            .setDisabled(isDisabled || !['openai', 'azure', 'ollama', 'openrouter', 'anthropic', 'gemini'].includes(this.workingSettings?.type || ''))
            .addText(text => {
                const defaultUrls: Record<string, string> = {
                    openai: 'https://api.openai.com/v1',
                    azure: 'https://<resource>.openai.azure.com',
                    ollama: 'http://localhost:11434',
                    openrouter: 'https://openrouter.ai/api/v1',
                    anthropic: 'https://api.anthropic.com/v1',
                    gemini: 'https://generativelanguage.googleapis.com/v1beta'
                };
                return text
                    .setPlaceholder(defaultUrls[this.workingSettings?.type || ''] || '')
                    .setValue(this.workingSettings?.baseUrl || '')
                    .setDisabled(isDisabled || !['openai', 'azure', 'ollama', 'openrouter', 'anthropic', 'gemini'].includes(this.workingSettings?.type || ''))
                    .onChange(value => {
                        if (!this.workingSettings) return;
                        this.workingSettings.baseUrl = value.trim();
                        // Force a check for changes
                        this.hasSettingsChanged = JSON.stringify(this.workingSettings) !== JSON.stringify(this.originalSettings);
                        this.onSettingsChange();
                    });
            });

        // Models section
        if (this.workingSettings?.type === 'gemini') {
            // Initialize visible models only if not set at all
            if (!this.workingSettings.visibleModels) {
                this.workingSettings.visibleModels = [];
            }
            
            // Add model selector dropdown
            const modelSetting = new Setting(this.container)
                .setName('Available models')
                .setDesc('Select a model to use with Google Gemini')
                .addDropdown(dropdown => {
                    // Clear any existing options
                    if (dropdown.selectEl) {
                        dropdown.selectEl.innerHTML = '';
                    }
                    
                    // Add models to dropdown
                    if (this.workingSettings?.visibleModels && this.workingSettings.visibleModels.length > 0) {
                        this.workingSettings.visibleModels.forEach(model => {
                            dropdown.addOption(model, model);
                        });
                        
                        // Set default model if it exists
                        if (this.workingSettings.defaultModel && 
                            this.workingSettings.visibleModels.includes(this.workingSettings.defaultModel)) {
                            dropdown.setValue(this.workingSettings.defaultModel);
                        } else {
                            // Otherwise set first model as default
                            this.workingSettings.defaultModel = this.workingSettings.visibleModels[0];
                            dropdown.setValue(this.workingSettings.visibleModels[0]);
                        }
                    } else {
                        // Add placeholder if no models
                        dropdown.addOption('', 'No models available');
                        dropdown.setValue('');
                    }
                    
                    // Update default model when changed
                    dropdown.onChange(value => {
                        if (!this.workingSettings || !value) return;
                        this.workingSettings.defaultModel = value;
                        this.hasSettingsChanged = true;
                        this.onSettingsChange();
                    });
                })
                .addExtraButton(button => {
                    button.setIcon('trash');
                    button.setTooltip('Delete selected model');
                    
                    const buttonEl = (button as any).extraSettingsEl;
                    
                    buttonEl.addEventListener('click', () => {
                        if (!this.workingSettings) return;
                        
                        const dropdown = modelSetting.components[0] as DropdownComponent;
                        const selectedModel = dropdown.getValue();
                        
                        if (!selectedModel) {
                            new Notice('No model selected');
                            return;
                        }
                        
                        // Remove the model
                        if (this.workingSettings.visibleModels) {
                            this.workingSettings.visibleModels = this.workingSettings.visibleModels.filter(m => m !== selectedModel);
                            
                            // Update default model if it was removed
                            if (this.workingSettings.defaultModel === selectedModel) {
                                this.workingSettings.defaultModel = this.workingSettings.visibleModels[0] || undefined;
                            }
                            
                            // Force a check for changes
                            this.hasSettingsChanged = true;
                            this.onSettingsChange();
                            
                            // Update the dropdown
                            if (dropdown.selectEl) {
                                dropdown.selectEl.innerHTML = '';
                                
                                if (this.workingSettings.visibleModels.length > 0) {
                                    this.workingSettings.visibleModels.forEach(model => {
                                        dropdown.addOption(model, model);
                                    });
                                    
                                    // Set default model
                                    if (this.workingSettings.defaultModel) {
                                        dropdown.setValue(this.workingSettings.defaultModel);
                                    }
                                } else {
                                    dropdown.addOption('', 'No models available');
                                    dropdown.setValue('');
                                }
                            }
                            
                            new Notice(`Removed model '${selectedModel}'`);
                        }
                    });
                    
                    return button;
                });
            
            // Add model input field with plus button
            new Setting(this.container)
                .setName('Add Model')
                .setDesc('Type a model name and click + to add it (e.g., gemini-1.5-pro)')
                .addText(text => text
                    .setPlaceholder('Enter model name')
                    .onChange(() => {}))
                .addExtraButton(button => {
                    button.setIcon('plus');
                    button.setTooltip('Add model');
                    
                    const buttonEl = (button as any).extraSettingsEl;
                    
                    buttonEl.addEventListener('click', () => {
                        const inputEl = button.extraSettingsEl.parentElement?.querySelector('input') as HTMLInputElement;
                        if (!inputEl) return;
                        
                        const modelName = inputEl.value.trim();
                        
                        if (!modelName) {
                            new Notice('Please enter a model name');
                            return;
                        }
                        
                        // Check if model already exists
                        if (this.workingSettings?.visibleModels?.includes(modelName)) {
                            new Notice(`Model '${modelName}' already exists`);
                            return;
                        }
                        
                        // Add the model
                        if (this.workingSettings) {
                            if (!this.workingSettings.visibleModels) {
                                this.workingSettings.visibleModels = [];
                            }
                            this.workingSettings.visibleModels.push(modelName);
                            
                            // If this is the first model, set it as default
                            if (this.workingSettings.visibleModels.length === 1) {
                                this.workingSettings.defaultModel = modelName;
                            }
                            
                            // Clear the input field
                            inputEl.value = '';
                            
                            // Force a check for changes
                            this.hasSettingsChanged = true;
                            this.onSettingsChange();
                            
                            // Update the dropdown
                            const dropdown = modelSetting.components[0] as DropdownComponent;
                            if (dropdown.selectEl) {
                                dropdown.addOption(modelName, modelName);
                            }
                            
                            new Notice(`Added model '${modelName}'`);
                        }
                    });
                    
                    return button;
                });
            
            // Add a note about API URL structure at the bottom
            new Setting(this.container)
                .setName('')
                .setDesc('Gemini models are used in the URL path: models/[model]:generateContent')
                .setClass('setting-item-info');
        } else {
            // Models section heading - only create for non-Gemini providers
            const modelsHeading = new Setting(this.container)
                .setName('Available models')
                .setDesc('Select which models to show in the model selector')
                .setDisabled(isDisabled);
            
            // Original Refresh Models button for non-Gemini providers
            modelsHeading.addButton(button => button
                .setButtonText('Refresh Models')
                .setDisabled(isDisabled)
                .onClick(async () => {
                    if (!this.workingSettings) return;
                    try {
                        button.setButtonText('Refreshing...');
                        button.setDisabled(true);

                        // Apply working settings temporarily to get models
                        this.commitSettings();

                        // Clear existing models list first
                        this.workingSettings.availableModels = [];
                        const modelsContent = this.container.querySelector('.models-list-content') as HTMLElement;
                        if (modelsContent) {
                            modelsContent.empty();
                            // Show loading state
                            new Setting(modelsContent)
                                .setName('Loading models...')
                                .setDesc('Please wait while models are being fetched')
                                .setDisabled(true);
                        }

                        // Make sure settings is not null before proceeding
                        if (!this.settings) {
                            throw new Error("Provider settings not found");
                        }

                        const models = await this.plugin.providerManager.getAvailableModels(this.settings);
                        this.workingSettings.availableModels = models;
                        this.workingSettings.visibleModels = this.workingSettings.visibleModels || [];
                        
                        // Clear existing models list content
                        if (modelsContent) {
                            modelsContent.empty();
                            
                            // Sort models by visibility first, then alphabetically
                            const sortedModels = [...models].sort((a, b) => {
                                const aVisible = this.workingSettings?.visibleModels?.includes(a) || false;
                                const bVisible = this.workingSettings?.visibleModels?.includes(b) || false;
                                if (aVisible !== bVisible) {
                                    return bVisible ? 1 : -1;
                                }
                                return a.localeCompare(b);
                            });

                            // Repopulate the models list
                            if (sortedModels.length) {
                                this.renderModels(modelsContent, sortedModels);
                            } else {
                                // Show empty state
                                new Setting(modelsContent)
                                    .setName('No models available')
                                    .setDesc('No models were found for this provider')
                                    .setDisabled(true);
                            }
                        }
                        
                        this.onSettingsChange();
                        new Notice('Models refreshed');
                    } catch (error) {
                        // Clear models on error
                        this.workingSettings.availableModels = [];
                        const modelsContent = this.container.querySelector('.models-list-content') as HTMLElement;
                        if (modelsContent) {
                            modelsContent.empty();
                            // Show error state
                            new Setting(modelsContent)
                                .setName('Error loading models')
                                .setDesc(error instanceof Error ? error.message : 'Failed to load models. Please try again.')
                                .setDisabled(true);
                        }
                        if (error instanceof Error) {
                            new Notice('Error refreshing models: ' + error.message);
                        }
                    } finally {
                        button.setButtonText('Refresh Models');
                        button.setDisabled(isDisabled);
                    }
                }));

            // Create models list container with scrollable area
            const modelsContainer = this.container.createEl('div', { cls: 'models-list' });
            setTooltip(modelsContainer, 'Available models');

            // Add header
            const header = modelsContainer.createEl('div', { cls: 'models-list-header' });
            const modelHeader = header.createEl('div', { 
                cls: 'model-header model-name-header',
                text: 'Model'
            });
            setTooltip(modelHeader, 'Sort models by name');
            
            const visibilityHeader = header.createEl('div', { 
                cls: 'model-header visibility-header',
                text: 'Show'
            });
            setTooltip(visibilityHeader, 'Sort models by visibility');

            // Add click event for sorting
            modelHeader.addEventListener('click', () => {
                this.toggleSortOrder('name');
            });

            visibilityHeader.addEventListener('click', () => {
                this.toggleSortOrder('visibility');
            });

            // Add chevron to indicate sorting direction
            const modelChevron = modelHeader.createEl('span', { cls: 'chevron' });
            const visibilityChevron = visibilityHeader.createEl('span', { cls: 'chevron' });
            this.updateChevron(modelChevron, visibilityChevron);

            // Create models list content
            const modelsContent = modelsContainer.createEl('div', { cls: 'models-list-content' });

            // Create models list if we have models
            if (!isDisabled && this.workingSettings?.availableModels?.length) {
                this.renderModels(modelsContent);
            } else {
                // Show empty state as a disabled setting
                new Setting(modelsContent)
                    .setName('No models available')
                    .setDesc(isDisabled ? 'Select a provider to view available models' : 'Click "Refresh Models" to load available models')
                    .setDisabled(true);
            }
        }
    }

    private toggleSortOrder(criteria: 'name' | 'visibility') {
        if (this.currentSortCriteria === criteria) {
            this.currentSortOrder = this.currentSortOrder === 'asc' ? 'desc' : 'asc';
        } else {
            this.currentSortCriteria = criteria;
            this.currentSortOrder = 'asc';
        }
        this.sortModels(criteria);
    }

    private sortModels(criteria: 'name' | 'visibility') {
        if (!this.workingSettings || !this.workingSettings.availableModels) return;

        const visibleModels = this.workingSettings.visibleModels || [];

        const sortedModels = [...this.workingSettings.availableModels].sort((a, b) => {
            let comparison = 0;
            if (criteria === 'name') {
                comparison = a.localeCompare(b);
            } else {
                const aVisible = visibleModels.includes(a);
                const bVisible = visibleModels.includes(b);
                comparison = aVisible === bVisible ? a.localeCompare(b) : (aVisible ? -1 : 1);
            }
            return this.currentSortOrder === 'asc' ? comparison : -comparison;
        });

        // Update the models list
        const modelsContent = this.container.querySelector('.models-list-content') as HTMLElement;
        if (modelsContent) {
            modelsContent.empty();
            this.renderModels(modelsContent, sortedModels);
        }

        // Update chevron direction
        const modelChevron = this.container.querySelector('.model-name-header .chevron') as HTMLElement;
        const visibilityChevron = this.container.querySelector('.visibility-header .chevron') as HTMLElement;
        this.updateChevron(modelChevron, visibilityChevron);
    }

    private updateChevron(modelChevron: HTMLElement, visibilityChevron: HTMLElement) {
        const chevronDirection = this.currentSortOrder === 'asc' ? '▼' : '▲';
        if (this.currentSortCriteria === 'name') {
            modelChevron.textContent = chevronDirection;
            visibilityChevron.textContent = '';
        } else {
            modelChevron.textContent = '';
            visibilityChevron.textContent = chevronDirection;
        }
    }

    private renderModels(modelsContent: HTMLElement, models = this.workingSettings?.availableModels || []) {
        models.forEach(model => {
            new Setting(modelsContent)
                .setName(model)
                .addToggle(toggle => toggle
                    .setValue(this.workingSettings?.visibleModels?.includes(model) || false)
                    .onChange(value => {
                        if (!this.workingSettings) return;
                        if (!this.workingSettings.visibleModels) {
                            this.workingSettings.visibleModels = [];
                        }
                        
                        if (value) {
                            if (!this.workingSettings.visibleModels.includes(model)) {
                                this.workingSettings.visibleModels.push(model);
                            }
                        } else {
                            this.workingSettings.visibleModels = this.workingSettings.visibleModels.filter(m => m !== model);
                        }
                        this.settingChanged(this.workingSettings.visibleModels, 'visibleModels');
                        
                        // Update the sort order if needed without re-rendering everything
                        if (this.currentSortCriteria === 'visibility') {
                            const modelsContent = this.container.querySelector('.models-list-content') as HTMLElement;
                            if (modelsContent) {
                                modelsContent.empty();
                                const sortedModels = this.getSortedModels(models);
                                this.renderModels(modelsContent, sortedModels);
                            }
                        }
                    }));
        });
    }

    private getSortedModels(models: string[]): string[] {
        if (!this.workingSettings) return models;
        
        const visibleModels = this.workingSettings.visibleModels || [];
        return [...models].sort((a, b) => {
            if (this.currentSortCriteria === 'name') {
                const comparison = a.localeCompare(b);
                return this.currentSortOrder === 'asc' ? comparison : -comparison;
            } else {
                const aVisible = visibleModels.includes(a);
                const bVisible = visibleModels.includes(b);
                if (aVisible !== bVisible) {
                    return this.currentSortOrder === 'asc' 
                        ? (aVisible ? -1 : 1) 
                        : (aVisible ? 1 : -1);
                }
                return a.localeCompare(b);
            }
        });
    }

    private addPasswordToggle(inputEl: HTMLInputElement): void {
        if (!inputEl || !inputEl.parentElement) return;

        const toggleButton = inputEl.parentElement.createEl('button', {
            cls: 'password-visibility-toggle'
        });
        setIcon(toggleButton, 'eye-off');
        setTooltip(toggleButton, 'Toggle password visibility');
        
        toggleButton.addEventListener('click', (e: MouseEvent) => {
            e.preventDefault();
            inputEl.type = inputEl.type === 'password' ? 'text' : 'password';
        });
    }

    // Public method to check if settings have been changed
    isSettingsChanged(): boolean {
        return this.hasSettingsChanged;
    }

    // Method to update provider type and set appropriate defaults
    updateProviderType(type: string): void {
        // Store original name if it exists
        const originalName = this.workingSettings?.name || this.settings?.name || 'New Provider';
        
        if (!this.workingSettings) {
            // Initialize working settings with the existing name if available
            this.workingSettings = {
                name: originalName,
                type: type,
                enabled: true,
                visibleModels: []
            };
        } else {
            // When changing type, preserve name but reset other type-specific properties
            const isTypeChange = this.workingSettings.type !== type;
            
            // Set the new type
            this.workingSettings.type = type;
            
            // Always preserve the name
            this.workingSettings.name = originalName;
            
            // Reset model-related lists when changing provider type
            if (isTypeChange) {
                // Reset available models
                this.workingSettings.availableModels = [];
                
                // For Gemini, initialize empty visible models
                // For other providers, keep existing visible models
                if (type === 'gemini' && (!this.workingSettings.visibleModels || this.workingSettings.visibleModels.length === 0)) {
                    this.workingSettings.visibleModels = [];
                }
                
                // Clear any default model when changing types
                this.workingSettings.defaultModel = undefined;
            }
        }
        
        // Always set default base URLs based on provider type when changing types
        if (this.workingSettings) {
            switch (type) {
                case 'ollama':
                    this.workingSettings.baseUrl = 'http://localhost:11434';
                    break;
                case 'openai':
                    this.workingSettings.baseUrl = 'https://api.openai.com/v1';
                    break;
                case 'openrouter':
                    this.workingSettings.baseUrl = 'https://openrouter.ai/api/v1';
                    break;
                case 'anthropic':
                    this.workingSettings.baseUrl = 'https://api.anthropic.com/v1';
                    break;
                case 'gemini':
                    this.workingSettings.baseUrl = 'https://generativelanguage.googleapis.com/v1beta';
                    break;
            }
        }
        
        // Mark settings as changed
        this.hasSettingsChanged = true;
        
        // Update original settings type immediately to avoid type mismatch on compare
        if (this.settings) {
            this.settings.type = type;
        }
    }

    // Method to explicitly preserve the provider name
    preserveName(name: string): void {
        if (this.workingSettings && name) {
            this.workingSettings.name = name;
        }
        
        // Also update the name field in the UI if it exists
        const nameInput = this.container.querySelector('input[placeholder="Enter provider name"]') as HTMLInputElement;
        if (nameInput) {
            nameInput.value = name;
        }
    }

    async validateSettings(): Promise<void> {
        try {
            if (!this.workingSettings) {
                throw new Error('No working settings available');
            }

            // Check for provider type
            if (!this.workingSettings.type) {
                // Try to get from UI if not set in working settings
                const typeDropdown = this.container.querySelector('select[data-setting="provider-type"]');
                if (typeDropdown instanceof HTMLSelectElement && typeDropdown.value) {
                    this.workingSettings.type = typeDropdown.value;
                } else {
                    throw new Error('Provider type is required');
                }
            }

            // Check for provider name
            if (!this.workingSettings.name || this.workingSettings.name.trim() === '') {
                throw new Error('Provider name is required');
            }

            // Check API key requirement based on provider type
            if (['openai', 'azure', 'anthropic', 'openrouter', 'gemini'].includes(this.workingSettings.type)) {
                if (!this.workingSettings.apiKey || this.workingSettings.apiKey.trim() === '') {
                    throw new Error(`API key is required for ${this.workingSettings.type} provider`);
                }
                
                // Warn about short API keys but don't block
                if (this.workingSettings.apiKey.length < 16) {
                    // Just warning, don't throw
                }
            }

            // For Ollama, check baseUrl if provided
            if (this.workingSettings.type === 'ollama') {
                if (this.workingSettings.baseUrl && !this.workingSettings.baseUrl.startsWith('http')) {
                    throw new Error('Ollama base URL must start with http:// or https://');
                }
            }

            // For Azure, additional validations
            if (this.workingSettings.type === 'azure') {
                if (!this.workingSettings.resourceName || this.workingSettings.resourceName.trim() === '') {
                    throw new Error('Azure resource name is required');
                }
                
                if (!this.workingSettings.deploymentId || this.workingSettings.deploymentId.trim() === '') {
                    throw new Error('Azure deployment ID is required');
                }
            }
        } catch (error) {
            if (error instanceof Error) {
                new Notice(error.message);
                throw error;
            } else {
                throw new Error('Unknown validation error');
            }
        }
    }
} 