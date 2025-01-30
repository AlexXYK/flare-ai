import { Notice, Setting, DropdownComponent, Modal, Platform } from 'obsidian';
import type FlarePlugin from '../../main';
import { ProviderSettings } from '../types/AIProvider';
import { AIProvider } from './aiProviders';

export class ProviderManager {
    protected provider: any;
    private currentProvider: string | null = null;
    public id: string;

    constructor(private plugin: FlarePlugin) {
        this.id = '';  // Should be set by implementing classes
    }

    createProvider(settings: ProviderSettings): AIProvider | null {
        // Should be implemented by subclasses
        return null;
    }

    async initialize() {
        // Initialize providers if needed
    }

    async getAvailableModels(settings: ProviderSettings): Promise<string[]> {
        return this.getModelsForProvider(settings.type);
    }

    createSettingsUI(containerEl: HTMLElement) {
        const providersSection = containerEl.createDiv('providers-section');

        // Provider selector with add/remove buttons
        const selectorContainer = providersSection.createDiv('provider-selector');
        const dropdownContainer = new Setting(selectorContainer)
            .setName('Provider')
            .setDesc('Select a provider to configure');

        // Create the dropdown
        const dropdown = new DropdownComponent(dropdownContainer.controlEl);
        dropdown.addOption('', 'Choose provider to configure...');
        Object.entries(this.plugin.settings.providers).forEach(([id, provider]) => {
            dropdown.addOption(id, provider.name || id);
        });
        
        let deleteButton: HTMLElement | null = null;
        
        // Add the buttons
        dropdownContainer
            .addExtraButton(button => button
                .setIcon('plus')
                .setTooltip('Add new provider')
                .onClick(() => {
                    const id = `provider_${Date.now()}`;
                    this.plugin.settings.providers[id] = {
                        name: 'New Provider',
                        type: '',
                        enabled: true,
                        visibleModels: []
                    };
                    this.plugin.saveData(this.plugin.settings);
                    dropdown.addOption(id, 'New Provider');
                    dropdown.setValue(id);
                    this.currentProvider = id;
                    this.createProviderSettings(providersSection);
                    if (deleteButton) deleteButton.removeClass('disabled');
                }))
            .addExtraButton(button => {
                deleteButton = button.setIcon('trash')
                    .setTooltip('Delete provider')
                    .setDisabled(!this.currentProvider)
                    .onClick(async () => {
                        if (!this.currentProvider) return;
                        
                        const providerName = this.plugin.settings.providers[this.currentProvider].name || this.currentProvider;
                        
                        // Show confirmation dialog
                        const modal = new Modal(this.plugin.app);
                        modal.titleEl.setText('Delete Provider');
                        modal.contentEl.createEl('p', {
                            text: `Are you sure you want to delete the provider "${providerName}"? This action cannot be undone.`
                        });
                        
                        // Add buttons
                        const buttonContainer = modal.contentEl.createDiv('modal-button-container');
                        
                        // Cancel button
                        buttonContainer.createEl('button', {
                            text: 'Cancel',
                            cls: 'mod-secondary'
                        }).addEventListener('click', () => {
                            modal.close();
                        });
                        
                        // Delete button
                        buttonContainer.createEl('button', {
                            text: 'Delete',
                            cls: 'mod-warning'
                        }).addEventListener('click', async () => {
                            // Remove from settings
                            delete this.plugin.settings.providers[this.currentProvider!];
                            await this.plugin.saveData(this.plugin.settings);
                            
                            // Remove from dropdown
                            const select = dropdown.selectEl;
                            const option = select.querySelector(`option[value="${this.currentProvider}"]`);
                            if (option) option.remove();
                            
                            // Reset selection
                            this.currentProvider = null;
                            dropdown.setValue('');
                            
                            // Clear settings display
                            const existingSettings = providersSection.querySelector('.provider-settings');
                            if (existingSettings) existingSettings.remove();
                            
                            // Disable delete button
                            if (deleteButton) deleteButton.addClass('disabled');
                            
                            new Notice(`Provider "${providerName}" deleted`);
                            modal.close();
                        });
                        
                        modal.open();
                    }).extraSettingsEl;
            });

        // Set initial value and handle changes
        dropdown.setValue('');

        dropdown.onChange(value => {
            this.currentProvider = value || null;
            // Clear previous settings
            const existingSettings = providersSection.querySelector('.provider-settings');
            if (existingSettings) existingSettings.remove();
            // Create new settings if a provider is selected
            if (value) {
                this.createProviderSettings(providersSection);
            }
            // Update delete button state
            if (deleteButton) {
                deleteButton.toggleClass('disabled', !value);
            }
        });

        // Add action buttons container
        const actionButtons = providersSection.createDiv({ cls: 'flare-form-actions' });
        new Setting(actionButtons)
            .addButton(button => {
                button
                    .setButtonText('Save')
                    .setCta()
                    .onClick(async () => {
                        await this.plugin.saveData(this.plugin.settings);
                        new Notice('Provider settings saved');
                        actionButtons.style.display = 'none';
                    });
            })
            .addButton(button => {
                button
                    .setButtonText('Revert')
                    .onClick(async () => {
                        await this.plugin.loadData();
                        this.createSettingsUI(containerEl);
                        new Notice('Provider settings reverted');
                    });
            });

        // Initially hide the action buttons
        actionButtons.style.display = 'none';
    }

    private createProviderSettings(containerEl: HTMLElement) {
        if (!this.currentProvider) return;

        const settings = this.plugin.settings.providers[this.currentProvider];
        if (!settings) return;

        // Clear any existing provider settings
        const existingSettings = containerEl.querySelector('.provider-settings');
        if (existingSettings) existingSettings.remove();

        const settingsContainer = containerEl.createDiv('provider-settings');

        // Provider name
        new Setting(settingsContainer)
            .setName('Name')
            .setDesc('Name of the provider')
            .addText(text => text
                .setPlaceholder('Provider name')
                .setValue(settings.name || '')
                .onChange(async (value) => {
                    settings.name = value;
                    this.showActionButtons();
                }));

        // Provider type
        new Setting(settingsContainer)
            .setName('Protocol')
            .setDesc('Select the provider protocol')
            .addDropdown(dropdown => dropdown
                .addOption('', 'Select a protocol...')
                .addOption('openai', 'OpenAI')
                .addOption('ollama', 'Ollama')
                .addOption('openrouter', 'OpenRouter')
                .setValue(settings.type || '')
                .onChange(async (value) => {
                    settings.type = value;
                    settings.apiKey = '';
                    settings.baseUrl = '';
                    settings.visibleModels = [];
                    this.showActionButtons();
                    // Recreate only the provider-specific settings
                    this.updateProviderSpecificSettings(settingsContainer, settings);
                }));

        // Create initial provider-specific settings
        this.updateProviderSpecificSettings(settingsContainer, settings);

        // Enable/disable toggle
        new Setting(settingsContainer)
            .setName('Enable Provider')
            .setDesc('Enable or disable this provider')
            .addToggle(toggle => toggle
                .setValue(settings.enabled ?? true)
                .onChange(async (value) => {
                    settings.enabled = value;
                    this.showActionButtons();
                }));
    }

    private showActionButtons() {
        const actionButtons = document.querySelector('.providers-section .flare-form-actions');
        if (actionButtons instanceof HTMLElement) {
            actionButtons.style.display = 'flex';
        }
    }

    private updateProviderSpecificSettings(settingsContainer: HTMLElement, settings: ProviderSettings) {
        // Clear existing provider-specific settings
        const existingSpecificSettings = settingsContainer.querySelector('.provider-specific-settings');
        if (existingSpecificSettings) existingSpecificSettings.remove();

        if (!settings.type) return;

        const specificContainer = settingsContainer.createDiv('provider-specific-settings');

        // Provider-specific settings
        switch (settings.type) {
            case 'openai':
                new Setting(specificContainer)
                    .setName('API Key')
                    .setDesc('Your OpenAI API key')
                    .addText(text => {
                        text.inputEl.type = 'password';
                        text.setPlaceholder('Enter your API key')
                        .setValue(settings.apiKey || '')
                        .onChange(value => {
                            settings.apiKey = value;
                            this.showActionButtons();
                        });
                        // Add show/hide password toggle
                        const togglePasswordBtn = text.inputEl.parentElement?.createEl('button', {
                            cls: ['password-visibility-toggle'],
                            text: '👁️'
                        });
                        togglePasswordBtn?.addEventListener('click', (e) => {
                            e.preventDefault();
                            text.inputEl.type = text.inputEl.type === 'password' ? 'text' : 'password';
                        });
                    });
                break;

            case 'ollama':
                new Setting(specificContainer)
                    .setName('Base URL')
                    .setDesc('Ollama API endpoint URL')
                    .addText(text => text
                        .setPlaceholder('http://localhost:11434')
                        .setValue(settings.baseUrl || 'http://localhost:11434')
                        .onChange(value => {
                            settings.baseUrl = value;
                            this.showActionButtons();
                        }));
                break;

            case 'openrouter':
                new Setting(specificContainer)
                    .setName('API Key')
                    .setDesc('Your OpenRouter API key')
                    .addText(text => {
                        text.inputEl.type = 'password';
                        text.setPlaceholder('Enter your API key')
                        .setValue(settings.apiKey || '')
                        .onChange(value => {
                            settings.apiKey = value;
                            this.showActionButtons();
                        });
                        // Add show/hide password toggle
                        const togglePasswordBtn = text.inputEl.parentElement?.createEl('button', {
                            cls: ['password-visibility-toggle'],
                            text: '👁️'
                        });
                        togglePasswordBtn?.addEventListener('click', (e) => {
                            e.preventDefault();
                            text.inputEl.type = text.inputEl.type === 'password' ? 'text' : 'password';
                        });
                    });
                break;
        }

        // Create models section
        this.createModelsSection(specificContainer, settings);
    }

    private async createModelsSection(container: HTMLElement, settings: ProviderSettings) {
        // Clear existing models section
        const existingModels = container.querySelector('.model-container');
        if (existingModels) existingModels.remove();

        const modelContainer = container.createDiv('model-container');
        
        // Create header section with title and refresh button
        const headerSection = modelContainer.createDiv('models-header');
        
        // Add title and description
        headerSection.createEl('h3', { text: 'Visible Models', cls: 'setting-item-name' });
        headerSection.createEl('div', { text: 'Select which models should be visible in dropdowns', cls: 'setting-item-description' });
        
        // Create scrollable models container
        const scrollContainer = modelContainer.createDiv({ cls: 'models-scroll-container' });
        
        // Add sortable headers
        const headerContainer = scrollContainer.createDiv({ cls: 'models-list-header' });
        const modelNameHeader = headerContainer.createDiv({ 
            cls: 'model-header model-name-header',
            text: 'Model Name'
        });
        const visibilityHeader = headerContainer.createDiv({ 
            cls: 'model-header visibility-header',
            text: 'Visible'
        });

        // Create models list container
        const modelsContainer = scrollContainer.createDiv({ cls: 'models-list' });

        try {
            const models = await this.getModelsForProvider(settings.type, settings);
            
            if (!settings.visibleModels) {
                settings.visibleModels = [...models].sort();
            }

            // Define renderModelsList function
            const renderModelsList = () => {
                // Clear existing list
                modelsContainer.empty();

                // Sort models based on current sort settings
                const sortedModels = [...models].sort((a, b) => {
                    if (sortField === 'name') {
                        return sortAsc ? 
                            a.localeCompare(b) : 
                            b.localeCompare(a);
                    } else {
                        const aVisible = settings.visibleModels?.includes(a) ?? true;
                        const bVisible = settings.visibleModels?.includes(b) ?? true;
                        return sortAsc ?
                            (aVisible === bVisible ? 0 : aVisible ? -1 : 1) :
                            (aVisible === bVisible ? 0 : aVisible ? 1 : -1);
                    }
                });

                // Render sorted models
                sortedModels.forEach(model => {
                    new Setting(modelsContainer)
                        .setName(model)
                        .addToggle(toggle => toggle
                            .setValue(settings.visibleModels?.includes(model) ?? true)
                            .onChange(value => {
                                settings.visibleModels = settings.visibleModels || [];
                                if (value && !settings.visibleModels.includes(model)) {
                                    settings.visibleModels.push(model);
                                    settings.visibleModels.sort();
                                } else if (!value) {
                                    settings.visibleModels = settings.visibleModels.filter(m => m !== model);
                                }
                                this.showActionButtons();
                            }));
                });
            };

            // Add sort indicators and click handlers
            let sortField: 'name' | 'visibility' = 'name';
            let sortAsc = true;

            const updateSortIndicators = () => {
                modelNameHeader.removeClass('sort-asc', 'sort-desc');
                visibilityHeader.removeClass('sort-asc', 'sort-desc');
                
                if (sortField === 'name') {
                    modelNameHeader.addClass(sortAsc ? 'sort-asc' : 'sort-desc');
                } else {
                    visibilityHeader.addClass(sortAsc ? 'sort-asc' : 'sort-desc');
                }
            };

            modelNameHeader.addEventListener('click', () => {
                if (sortField === 'name') {
                    sortAsc = !sortAsc;
                } else {
                    sortField = 'name';
                    sortAsc = true;
                }
                updateSortIndicators();
                renderModelsList();
            });

            visibilityHeader.addEventListener('click', () => {
                if (sortField === 'visibility') {
                    sortAsc = !sortAsc;
                } else {
                    sortField = 'visibility';
                    sortAsc = true;
                }
                updateSortIndicators();
                renderModelsList();
            });

            // Add refresh button
            new Setting(headerSection)
                .addButton(button => button
                    .setButtonText('Refresh Models')
                    .onClick(async () => {
                        button.setDisabled(true);
                        try {
                            modelContainer.addClass('loading');
                            const newModels = await this.getModelsForProvider(settings.type, settings);
                            
                            if (!settings.visibleModels) {
                                settings.visibleModels = [...newModels].sort();
                            } else {
                                settings.visibleModels = settings.visibleModels.filter(m => newModels.includes(m)).sort();
                            }
                            
                            this.showActionButtons();
                            await this.createModelsSection(container, settings);
                            new Notice('Models refreshed');
                        } catch (error) {
                            console.error('Failed to refresh models:', error);
                            new Notice('Failed to refresh models');
                        } finally {
                            button.setDisabled(false);
                            modelContainer.removeClass('loading');
                        }
                    }));

            // Initial render with default sort
            updateSortIndicators();
            renderModelsList();

        } catch (error) {
            console.error('Failed to load models:', error);
            new Notice('Failed to load models');
            
            const errorDiv = scrollContainer.createDiv('error-message');
            errorDiv.setText('Failed to load models. Please try again.');
            new Setting(errorDiv)
                .addButton(button => button
                    .setButtonText('Retry')
                    .setWarning()
                    .onClick(async () => {
                        await this.createModelsSection(container, settings);
                    }));
        }
    }

    async getModelsForProvider(providerType: string, settings?: ProviderSettings): Promise<string[]> {
        try {
            if (!settings) {
                if (this.plugin.settings.debugLoggingEnabled) {
                    console.warn('No provider settings provided to getModelsForProvider');
                }
                return [];
            }

            if (this.plugin.settings.debugLoggingEnabled) {
                console.log('Provider settings:', settings);
            }

            switch (providerType) {
                case 'openai': {
                    if (!settings.apiKey) {
                        console.warn('No API key provided for OpenAI provider');
                        return [];
                    }
                    
                    try {
                        const url = settings.baseUrl || 'https://api.openai.com/v1';
                        const response = await fetch(`${url}/models`, {
                            headers: {
                                'Authorization': `Bearer ${settings.apiKey}`,
                                'Content-Type': 'application/json',
                            }
                        });
                        
                        if (!response.ok) {
                            throw new Error(`Failed to fetch models: ${response.statusText}`);
                        }
                        
                        const data = await response.json();
                        const models = data.data
                            .filter((m: any) => m.id.startsWith('gpt-'))
                            .map((m: any) => m.id);

                        if (this.plugin.settings.debugLoggingEnabled) {
                            console.log('Using visible models:', models);
                        }

                        return models;
                    } catch (error) {
                        console.error('Failed to fetch OpenAI models');
                        new Notice('Failed to fetch OpenAI models. Check your API key.');
                        return [];
                    }
                }
                case 'ollama': {
                    const url = settings.baseUrl || 'http://localhost:11434';
                    try {
                        const controller = new AbortController();
                        const timeoutId = setTimeout(() => controller.abort(), 5000);
                        const response = await fetch(`${url}/api/tags`, {
                            signal: controller.signal
                        });
                        clearTimeout(timeoutId);
                        
                        if (!response.ok) {
                            throw new Error(`Failed to fetch models: ${response.statusText}`);
                        }
                        
                        const data = await response.json();
                        if (!data.models || !Array.isArray(data.models)) {
                            console.warn('Invalid response format from Ollama API');
                            return [];
                        }
                        
                        const models = data.models.map((model: { name: string }) => model.name);

                        if (this.plugin.settings.debugLoggingEnabled) {
                            console.log('Using visible models:', models);
                        }

                        return models;
                    } catch (error) {
                        console.error('Failed to fetch Ollama models:', error);
                        new Notice('Failed to fetch Ollama models. Check if Ollama is running.');
                        return [];
                    }
                }
                case 'openrouter': {
                    if (!settings.apiKey) {
                        console.warn('No API key provided for OpenRouter provider');
                        return [];
                    }
                    
                    try {
                        const response = await fetch('https://openrouter.ai/api/v1/models', {
                            headers: {
                                'Authorization': `Bearer ${settings.apiKey}`,
                                'HTTP-Referer': window.location.href,
                                'Content-Type': 'application/json',
                            }
                        });
                        
                        if (!response.ok) {
                            throw new Error(`Failed to fetch models: ${response.statusText}`);
                        }
                        
                        const data = await response.json();
                        const models = data.data
                            .filter((m: any) => m.id)
                            .map((m: any) => m.id);

                        if (this.plugin.settings.debugLoggingEnabled) {
                            console.log('Using visible models:', models);
                        }

                        return models;
                    } catch (error) {
                        console.error('Failed to fetch OpenRouter models');
                        new Notice('Failed to fetch OpenRouter models. Check your API key.');
                        return [];
                    }
                }
                default:
                    console.warn(`Unknown provider type: ${providerType}`);
                    return [];
            }
        } catch (error) {
            console.error('Failed to get models for provider:', error);
            return [];
        }
    }
} 