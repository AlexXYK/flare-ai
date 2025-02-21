import { Notice, Setting, DropdownComponent, Modal, Platform, setIcon, App } from 'obsidian';
import type FlarePlugin from '../../main';
import { ProviderSettings } from '../types/AIProvider';
import { AIProvider } from './aiProviders';
import { ProviderSettingsUI } from '../views/components/ProviderSettingsUI';
import { ProviderSettingsView } from '../views/components/ProviderSettingsView';
import { OpenAIProvider, OllamaProvider, OpenRouterProvider } from './aiProviders';

export abstract class ProviderManager {
    protected provider: AIProvider | null = null;
    private currentProvider: string | null = null;
    public id: string;

    constructor(protected plugin: FlarePlugin) {
        this.id = '';  // Should be set by implementing classes
    }

    createSettingsUI(containerEl: HTMLElement) {
        // Create provider selector UI
        const settingsUI = new ProviderSettingsUI(this.plugin, containerEl, (providerId) => {
            this.currentProvider = providerId;
            // Clear previous settings
            const existingSettings = containerEl.querySelector('.provider-settings');
            if (existingSettings) existingSettings.remove();
            // Create new settings if a provider is selected
            if (providerId && this.plugin.settings.providers[providerId]) {
                const settings = this.plugin.settings.providers[providerId];
                const settingsView = new ProviderSettingsView(
                    this.plugin,
                    containerEl,
                    settings,
                    async () => {
                        await this.plugin.saveData(this.plugin.settings);
                    },
                    () => {
                        // Show action buttons when settings change
                        const actionButtons = containerEl.querySelector('.flare-form-actions');
                        if (actionButtons) {
                            actionButtons.classList.add('is-visible');
                        }
                    }
                );
                settingsView.display();
            }
        });
        settingsUI.display();
    }

    public abstract createProvider(settings: ProviderSettings): AIProvider | null;

    async getAvailableModels(settings: ProviderSettings): Promise<string[]> {
        try {
            const provider = this.createProvider(settings);
            if (!provider) {
                throw new Error('Failed to create provider');
            }
            return await provider.getAvailableModels();
        } catch (error) {
            if (error instanceof Error) {
                throw new Error(`Failed to get available models: ${error.message}`);
            }
            throw error;
        }
    }

    async initialize() {
        // Initialize providers if needed
    }

    private createActionButtons(container: HTMLElement): HTMLElement {
        const actionButtons = container.createDiv('flare-form-actions');
        return actionButtons;
    }

    private async validateSettings(settings: ProviderSettings): Promise<void> {
        if (!settings.name) {
            throw new Error('Provider name is required');
        }
        if (!settings.type) {
            throw new Error('Provider type is required');
        }
        if (!settings.apiKey) {
            throw new Error('API key is required');
        }
    }

    private addPasswordToggle(inputEl: HTMLInputElement): void {
        const toggleBtn = inputEl.parentElement?.createEl('button', {
            cls: ['password-visibility-toggle'],
            text: '👁️'
        });
        toggleBtn?.addEventListener('click', (e) => {
            e.preventDefault();
            inputEl.type = inputEl.type === 'password' ? 'text' : 'password';
        });
    }

    private createSection(container: HTMLElement, title: string): HTMLElement {
        const section = container.createEl('div', { cls: 'flare-section' });
        
        // Create header
        const header = section.createEl('div', { cls: 'flare-section-header' });
        header.createEl('h4', { text: title });
        
        // Create content container
        const content = section.createEl('div', { cls: 'flare-section-content' });
        
        return content;
    }

    private createProviderSettings(container: HTMLElement, settings: ProviderSettings) {
        const settingsContainer = container.createEl('div', { cls: 'provider-settings' });
        const actionButtons = settingsContainer.createEl('div', { cls: 'flare-form-actions' });

        // Create General Settings Section
        new Setting(settingsContainer).setName('General settings').setHeading();
        const generalSection = settingsContainer.createDiv({ cls: 'flare-section-content' });
        
        // Add name setting
        new Setting(generalSection)
            .setName('Provider Name')
            .setDesc('A unique name for this provider')
            .addText(text => text
                .setPlaceholder('Enter provider name')
                .setValue(settings.name || '')
                .onChange(async (value) => {
                    settings.name = value;
                    this.showActionButtons(actionButtons);
                }));

        // Add enabled toggle
        new Setting(generalSection)
            .setName('Enable Provider')
            .setDesc('Enable or disable this provider')
            .addToggle(toggle => toggle
                .setValue(settings.enabled || false)
                .onChange(async (value) => {
                    settings.enabled = value;
                    this.showActionButtons(actionButtons);
                }));

        // Create Authentication Section
        new Setting(settingsContainer).setName('Authentication').setHeading();
        const authSection = settingsContainer.createDiv({ cls: 'flare-section-content' });
        this.updateProviderSpecificSettings(authSection, settings, actionButtons);

        // Add save and cancel buttons
        const saveBtn = actionButtons.createEl('button', {
            text: 'Save',
            cls: 'mod-cta'
        });
        saveBtn.addEventListener('click', async () => {
            try {
                await this.validateSettings(settings);
                await this.plugin.saveData(this.plugin.settings);
                new Notice('Provider settings saved');
                this.hideActionButtons(actionButtons);
            } catch (error) {
                new Notice('Error saving settings: ' + (error as Error).message);
            }
        });

        const cancelBtn = actionButtons.createEl('button', {
            text: 'Cancel'
        });
        cancelBtn.addEventListener('click', () => {
            this.hideActionButtons(actionButtons);
        });
    }

    private updateProviderSpecificSettings(container: HTMLElement, settings: ProviderSettings, actionButtons: HTMLElement) {
        // Clear existing provider-specific settings
        const existingSettings = container.querySelectorAll('.provider-specific-setting');
        existingSettings.forEach(el => el.remove());

        switch (settings.type) {
            case 'anthropic':
                new Setting(container)
                    .setClass('provider-specific-setting')
                    .setName('API Key')
                    .setDesc('Your Anthropic API key')
                    .addText(text => {
                        const input = text
                            .setPlaceholder('Enter API key')
                        .setValue(settings.apiKey || '')
                        .onChange(value => {
                            settings.apiKey = value;
                                this.showActionButtons(actionButtons);
                            });
                        input.inputEl.type = 'password';
                        this.addPasswordToggle(input.inputEl);
                    });
                break;

            case 'ollama':
                // Base URL setting
                new Setting(container)
                    .setClass('provider-specific-setting')
                    .setName('Base URL')
                    .setDesc('Ollama API endpoint URL')
                    .addText(text => text
                        .setPlaceholder('http://localhost:11434')
                        .setValue(settings.baseUrl || 'http://localhost:11434')
                        .onChange(async value => {
                            settings.baseUrl = value;
                            this.showActionButtons(actionButtons);
                            
                            // Try to refresh models when URL changes
                            try {
                                const models = await this.getAvailableModels(settings);
                                settings.availableModels = models;
                                settings.visibleModels = settings.visibleModels || [];
                                
                                // Refresh the models section
                                const modelsSection = container.querySelector('.flare-section-content') as HTMLElement;
                                if (modelsSection) {
                                    await this.createModelsSection(modelsSection, settings, actionButtons);
                                }
                            } catch (error) {
                                if (error instanceof Error) {
                                    new Notice('Error refreshing models: ' + error.message);
                                }
                            }
                        }));

                // Create Models Section
                const ollamaModelsSection = this.createSection(container, 'Available models');
                this.createModelsSection(ollamaModelsSection, settings, actionButtons);
                break;

            case 'openai':
                new Setting(container)
                    .setClass('provider-specific-setting')
                    .setName('API Key')
                    .setDesc('Your OpenAI API key')
                    .addText(text => {
                        const input = text
                            .setPlaceholder('Enter API key')
                            .setValue(settings.apiKey || '')
                            .onChange(value => {
                                settings.apiKey = value;
                                this.showActionButtons(actionButtons);
                            });
                        input.inputEl.type = 'password';
                        this.addPasswordToggle(input.inputEl);
                    });

                new Setting(container)
                    .setClass('provider-specific-setting')
                    .setName('Base URL')
                    .setDesc('Optional: Custom base URL for API requests')
                    .addText(text => text
                        .setPlaceholder('https://api.openai.com/v1')
                        .setValue(settings.baseUrl || '')
                        .onChange(value => {
                            settings.baseUrl = value;
                            this.showActionButtons(actionButtons);
                        }));

                // Create Models Section
                const modelsSection = this.createSection(container, 'Available models');
                this.createModelsSection(modelsSection, settings, actionButtons);
                break;

            case 'azure':
                new Setting(container)
                    .setClass('provider-specific-setting')
                    .setName('API Key')
                    .setDesc('Your Azure OpenAI API key')
                    .addText(text => {
                        const input = text
                            .setPlaceholder('Enter API key')
                        .setValue(settings.apiKey || '')
                        .onChange(value => {
                            settings.apiKey = value;
                                this.showActionButtons(actionButtons);
                            });
                        input.inputEl.type = 'password';
                        this.addPasswordToggle(input.inputEl);
                    });

                new Setting(container)
                    .setClass('provider-specific-setting')
                    .setName('Base URL')
                    .setDesc('Your Azure OpenAI endpoint URL')
                    .addText(text => text
                        .setPlaceholder('https://<resource>.openai.azure.com')
                        .setValue(settings.baseUrl || '')
                        .onChange(value => {
                            settings.baseUrl = value;
                            this.showActionButtons(actionButtons);
                        }));

                // Create Models Section
                const azureModelsSection = this.createSection(container, 'Available models');
                this.createModelsSection(azureModelsSection, settings, actionButtons);
                break;
        }
    }

    private async createModelsSection(container: HTMLElement, settings: ProviderSettings, actionButtons: HTMLElement) {
        // Clear any existing models section
        container.empty();

        // Add refresh models button
        new Setting(container)
            .setName('Available models')
            .setDesc('Select which models to show in the model selector')
            .addButton(button => button
                .setButtonText('Refresh models')
                .onClick(async () => {
                    try {
                        const models = await this.getAvailableModels(settings);
                        settings.availableModels = models;
                        settings.visibleModels = settings.visibleModels || [];
                        
                        this.showActionButtons(actionButtons);
                        await this.createModelsSection(container, settings, actionButtons);
                        new Notice('models refreshed');
                    } catch (error) {
                        if (error instanceof Error) {
                            new Notice('Error refreshing models: ' + error.message);
                        }
                    }
                }));

        // Try to load models if none are loaded
        if (!settings.availableModels?.length) {
            try {
                const models = await this.getAvailableModels(settings);
                settings.availableModels = models;
                settings.visibleModels = settings.visibleModels || [];
            } catch (error) {
                if (error instanceof Error) {
                    new Notice('Error loading models: ' + error.message);
                }
            }
        }

        // Add model toggles
        if (settings.availableModels?.length) {
            const modelsList = container.createEl('div', { cls: 'models-list' });
            
            // Add header
            const header = modelsList.createEl('div', { cls: 'models-list-header' });
            header.createEl('div', { 
                cls: 'model-header model-name-header',
                text: 'Model'
            });
            header.createEl('div', { 
                cls: 'model-header visibility-header',
                text: 'Show'
            });

            settings.availableModels.forEach((model: string) => {
                new Setting(modelsList)
                    .setName(model)
                    .addToggle(toggle => toggle
                        .setValue(settings.visibleModels?.includes(model) || false)
                        .onChange(value => {
                            if (!settings.visibleModels) {
                                settings.visibleModels = [];
                            }
                            
                            if (value) {
                                if (!settings.visibleModels.includes(model)) {
                                    settings.visibleModels.push(model);
                                }
                            } else {
                                settings.visibleModels = settings.visibleModels.filter(m => m !== model);
                            }
                            this.showActionButtons(actionButtons);
                        }));
            });
        }
    }

    private toggleActionButtons(actionButtons: HTMLElement, show: boolean) {
        if (show) {
            actionButtons.classList.add('is-visible');
        } else {
            actionButtons.classList.remove('is-visible');
        }
    }

    private hideActionButtons(actionButtons: HTMLElement) {
        this.toggleActionButtons(actionButtons, false);
    }

    private showActionButtons(actionButtons: HTMLElement) {
        this.toggleActionButtons(actionButtons, true);
    }

    async getModelsForProvider(settings?: ProviderSettings): Promise<string[]> {
        if (!settings) {
            throw new Error('No provider settings provided to getModelsForProvider');
        }

        const providerType = settings.type;
        const models: string[] = [];

        try {
            switch (providerType) {
                case 'openai': {
                    if (!settings.apiKey) {
                        throw new Error('No API key provided for OpenAI provider');
                    }

                    const provider = new OpenAIProvider(settings.apiKey, settings.baseUrl);
                    provider.setConfig(settings);
                    const allModels = await provider.getAvailableModels();

                    // Filter models based on settings
                    if (settings.visibleModels?.length) {
                        return allModels.filter(model => settings.visibleModels?.includes(model));
                    }

                    return allModels;
                }

                case 'ollama': {
                    const provider = new OllamaProvider(settings.baseUrl || '');
                    provider.setConfig(settings);
                    const allModels = await provider.getAvailableModels();

                    // Filter models based on settings
                    if (settings.visibleModels?.length) {
                        return allModels.filter(model => settings.visibleModels?.includes(model));
                    }

                    return allModels;
                }

                case 'openrouter': {
                    if (!settings.apiKey) {
                        throw new Error('No API key provided for OpenRouter provider');
                    }

                    const provider = new OpenRouterProvider(settings.apiKey);
                    provider.setConfig(settings);
                    const allModels = await provider.getAvailableModels();

                    // Filter models based on settings
                    if (settings.visibleModels?.length) {
                        return allModels.filter(model => settings.visibleModels?.includes(model));
                    }

                    return allModels;
                }

                default:
                    throw new Error(`Unknown provider type: ${providerType}`);
            }
        } catch (error) {
            throw error;
        }
    }
} 