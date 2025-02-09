import { Setting, Notice } from 'obsidian';
import type FlarePlugin from '../../../main';
import type { ProviderSettings } from '../../types/AIProvider';

export class ProviderSettingsView {
    private originalSettings: ProviderSettings;
    private actionButtons: HTMLElement | null = null;

    constructor(
        private plugin: FlarePlugin,
        private container: HTMLElement,
        private settings: ProviderSettings,
        private onSave: () => Promise<void>,
        private onSettingsChange: () => void
    ) {
        // Store original settings for revert
        this.originalSettings = JSON.parse(JSON.stringify(settings));
    }

    display(): void {
        const settingsContainer = this.container.createEl('div', { cls: 'provider-settings' });
        
        // Create General Settings Section
        const generalSection = this.createSection(settingsContainer, 'General');
        this.createGeneralSettings(generalSection);

        // Create Authentication Section
        const authSection = this.createSection(settingsContainer, 'Authentication');
        this.createAuthSettings(authSection);

        // Create Models Section
        const modelsSection = this.createSection(settingsContainer, 'Available models');
        this.createModelsSection(modelsSection);
    }

    private createSection(container: HTMLElement, title: string): HTMLElement {
        const section = container.createDiv({ cls: 'flare-section' });
        const header = section.createDiv({ cls: 'flare-section-header' });
        const content = section.createDiv({ cls: 'flare-section-content' });

        header.createSpan({ cls: 'flare-section-chevron' });
        header.createSpan({ text: title });

        header.addEventListener('click', () => {
            header.classList.toggle('is-collapsed');
            content.classList.toggle('is-hidden');
        });

        return content;
    }

    private createGeneralSettings(container: HTMLElement): void {
        // Add name setting
        new Setting(container)
            .setName('Name')
            .setDesc('A unique name for this provider')
            .addText(text => text
                .setPlaceholder('Enter provider name')
                .setValue(this.settings.name || '')
                .onChange(value => {
                    this.settings.name = value;
                    this.onSettingsChange();
                }));

        // Add enabled toggle
        new Setting(container)
            .setName('Enable provider')
            .setDesc('Enable or disable this provider')
            .addToggle(toggle => toggle
                .setValue(this.settings.enabled || false)
                .onChange(value => {
                    this.settings.enabled = value;
                    this.onSettingsChange();
                }));
    }

    private createAuthSettings(container: HTMLElement): void {
        switch (this.settings.type) {
            case 'anthropic':
                this.createAnthropicSettings(container);
                break;
            case 'openai':
                this.createOpenAISettings(container);
                break;
            case 'azure':
                this.createAzureSettings(container);
                break;
            case 'ollama':
                this.createOllamaSettings(container);
                break;
            case 'openrouter':
                this.createOpenRouterSettings(container);
                break;
        }
    }

    private createAnthropicSettings(container: HTMLElement): void {
        new Setting(container)
            .setName('API Key')
            .setDesc('Your Anthropic API key')
            .addText(text => {
                const input = text
                    .setPlaceholder('Enter API key')
                    .setValue(this.settings.apiKey || '')
                    .onChange(value => {
                        this.settings.apiKey = value;
                        this.onSettingsChange();
                    });
                input.inputEl.type = 'password';
                this.addPasswordToggle(input.inputEl);
            });
    }

    private createOpenAISettings(container: HTMLElement): void {
        // API Key
        new Setting(container)
            .setName('API Key')
            .setDesc('Your OpenAI API key')
            .addText(text => {
                const input = text
                    .setPlaceholder('Enter API key')
                    .setValue(this.settings.apiKey || '')
                    .onChange(value => {
                        this.settings.apiKey = value;
                        this.onSettingsChange();
                    });
                input.inputEl.type = 'password';
                this.addPasswordToggle(input.inputEl);
            });

        // Base URL
        new Setting(container)
            .setName('Base URL')
            .setDesc('Optional: Custom base URL for API requests')
            .addText(text => text
                .setPlaceholder('https://api.openai.com/v1')
                .setValue(this.settings.baseUrl || '')
                .onChange(value => {
                    this.settings.baseUrl = value;
                    this.onSettingsChange();
                }));
    }

    private createAzureSettings(container: HTMLElement): void {
        // API Key
        new Setting(container)
            .setName('API Key')
            .setDesc('Your Azure OpenAI API key')
            .addText(text => {
                const input = text
                    .setPlaceholder('Enter API key')
                    .setValue(this.settings.apiKey || '')
                    .onChange(value => {
                        this.settings.apiKey = value;
                        this.onSettingsChange();
                    });
                input.inputEl.type = 'password';
                this.addPasswordToggle(input.inputEl);
            });

        // Base URL
        new Setting(container)
            .setName('Base URL')
            .setDesc('Your Azure OpenAI endpoint URL')
            .addText(text => text
                .setPlaceholder('https://<resource>.openai.azure.com')
                .setValue(this.settings.baseUrl || '')
                .onChange(value => {
                    this.settings.baseUrl = value;
                    this.onSettingsChange();
                }));
    }

    private createOllamaSettings(container: HTMLElement): void {
        // Base URL setting
        new Setting(container)
            .setName('Endpoint URL')
            .setDesc('Ollama API endpoint URL')
            .addText(text => text
                .setPlaceholder('http://localhost:11434')
                .setValue(this.settings.baseUrl || 'http://localhost:11434')
                .onChange(async value => {
                    this.settings.baseUrl = value;
                    this.onSettingsChange();
                }));
    }

    private createOpenRouterSettings(container: HTMLElement): void {
        new Setting(container)
            .setName('API Key')
            .setDesc('Your OpenRouter API key')
            .addText(text => {
                const input = text
                    .setPlaceholder('Enter API key')
                    .setValue(this.settings.apiKey || '')
                    .onChange(value => {
                        this.settings.apiKey = value;
                        this.onSettingsChange();
                    });
                input.inputEl.type = 'password';
                this.addPasswordToggle(input.inputEl);
            });
    }

    private async createModelsSection(container: HTMLElement): Promise<void> {
        // Clear the container first
        container.empty();

        // Add refresh models button
        new Setting(container)
            .setName('Available models')
            .setDesc('Select which models to show in the model selector')
            .addButton(button => button
                .setButtonText('Refresh models')
                .onClick(async () => {
                    try {
                        // Show loading state
                        button.setButtonText('Refreshing...');
                        button.setDisabled(true);

                        const models = await this.plugin.providerManager.getAvailableModels(this.settings);
                        this.settings.availableModels = models;
                        this.settings.visibleModels = this.settings.visibleModels || [];
                        
                        this.onSettingsChange();
                        await this.createModelsSection(container);
                        new Notice('Models refreshed');
                    } catch (error) {
                        if (error instanceof Error) {
                            new Notice('Error refreshing models: ' + error.message);
                        }
                    } finally {
                        // Reset button state
                        button.setButtonText('Refresh models');
                        button.setDisabled(false);
                    }
                }));

        // Try to load models if none are loaded
        if (!this.settings.availableModels?.length) {
            try {
                const models = await this.plugin.providerManager.getAvailableModels(this.settings);
                this.settings.availableModels = models;
                this.settings.visibleModels = this.settings.visibleModels || [];
            } catch (error) {
                if (error instanceof Error) {
                    new Notice('Error loading models: ' + error.message);
                }
            }
        }

        // Add model toggles
        if (this.settings.availableModels?.length) {
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

            // Sort models alphabetically
            const sortedModels = [...this.settings.availableModels].sort((a, b) => a.localeCompare(b));

            sortedModels.forEach((model: string) => {
                new Setting(modelsList)
                    .setName(model)
                    .addToggle(toggle => toggle
                        .setValue(this.settings.visibleModels?.includes(model) || false)
                        .onChange(value => {
                            if (!this.settings.visibleModels) {
                                this.settings.visibleModels = [];
                            }
                            
                            if (value) {
                                if (!this.settings.visibleModels.includes(model)) {
                                    this.settings.visibleModels.push(model);
                                }
                            } else {
                                this.settings.visibleModels = this.settings.visibleModels.filter(m => m !== model);
                            }
                            this.onSettingsChange();
                        }));
            });
        } else {
            // Show empty state
            const emptyState = container.createDiv('models-empty-state');
            emptyState.setText('No models available. Click "Refresh models" to load the available models.');
        }
    }

    private addPasswordToggle(inputEl: HTMLInputElement): void {
        const toggleBtn = inputEl.parentElement?.createEl('button', {
            cls: 'password-visibility-toggle',
            attr: { 'aria-label': 'Toggle password visibility' }
        });
        toggleBtn?.createEl('span', { text: '👁️' });
        toggleBtn?.addEventListener('click', (e) => {
            e.preventDefault();
            inputEl.type = inputEl.type === 'password' ? 'text' : 'password';
        });
    }

    async validateSettings(): Promise<void> {
        // Name is always required
        if (!this.settings.name?.trim()) {
            throw new Error('Provider name is required');
        }

        // Type is always required
        if (!this.settings.type?.trim()) {
            throw new Error('Provider type is required');
        }

        // API key is only required for certain providers
        if (['openai', 'openrouter', 'anthropic'].includes(this.settings.type)) {
            if (!this.settings.apiKey?.trim()) {
                throw new Error(`API key is required for ${this.settings.type} provider`);
            }
        }

        // Set default Ollama URL if not provided
        if (this.settings.type === 'ollama' && !this.settings.baseUrl?.trim()) {
            this.settings.baseUrl = 'http://localhost:11434';
        }
    }
} 