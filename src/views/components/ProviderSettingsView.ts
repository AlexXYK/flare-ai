import { Setting, Notice, Platform } from 'obsidian';
import type FlarePlugin from '../../../main';
import type { ProviderSettings } from '../../types/AIProvider';

export class ProviderSettingsView {
    private originalSettings: ProviderSettings;
    private actionButtons: HTMLElement | null = null;
    private hasSettingsChanged: boolean = false;

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

    private settingChanged(newValue: any, path: string) {
        // Get the old value using the path
        const pathParts = path.split('.');
        let oldValue = this.originalSettings;
        for (const part of pathParts) {
            oldValue = oldValue[part];
        }

        // Compare values
        const hasChanged = JSON.stringify(newValue) !== JSON.stringify(oldValue);
        
        // Only trigger if the value actually changed
        if (hasChanged !== this.hasSettingsChanged) {
            this.hasSettingsChanged = hasChanged;
            this.onSettingsChange();
        }
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
                    this.settingChanged(value, 'name');
                }));

        // Add enabled toggle
        new Setting(container)
            .setName('Enable provider')
            .setDesc('Enable or disable this provider')
            .addToggle(toggle => toggle
                .setValue(this.settings.enabled || false)
                .onChange(value => {
                    this.settings.enabled = value;
                    this.settingChanged(value, 'enabled');
                }));
    }

    private createAuthSettings(container: HTMLElement): void {
        if (!container) {
            console.error('Container element is null in createAuthSettings');
            return;
        }

        // Set default base URLs based on provider type
        try {
            const defaultUrls: Record<string, string> = {
                anthropic: 'https://api.anthropic.com',
                openai: 'https://api.openai.com/v1',
                ollama: 'http://localhost:11434',
                openrouter: 'https://openrouter.ai/api/v1'
            };

            // Only set default URL if it's not already set
            if (this.settings.type && this.settings.type in defaultUrls && !this.settings.baseUrl) {
                this.settings.baseUrl = defaultUrls[this.settings.type];
                // Only trigger change if we actually set a new default
                this.settingChanged(this.settings.baseUrl, 'baseUrl');
            }

            switch (this.settings.type) {
                case 'anthropic':
                    this.createAnthropicSettings(container);
                    break;
                case 'openai':
                    this.createOpenAISettings(container);
                    break;
                case 'azure':
                    // Azure doesn't have a default URL as it's customer-specific
                    this.createAzureSettings(container);
                    break;
                case 'ollama':
                    this.createOllamaSettings(container);
                    break;
                case 'openrouter':
                    this.createOpenRouterSettings(container);
                    break;
                default:
                    console.warn(`Unknown provider type: ${this.settings.type}`);
            }
        } catch (error) {
            console.error('Error in createAuthSettings:', error);
            const errorEl = container.createEl('div', {
                cls: 'flare-settings-error',
                text: 'Error creating authentication settings. Please check console for details.'
            });
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
                        this.settingChanged(value, 'apiKey');
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
                        this.settingChanged(value, 'apiKey');
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
                    this.settingChanged(value, 'baseUrl');
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
                        this.settingChanged(value, 'apiKey');
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
                    this.settingChanged(value, 'baseUrl');
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
                    this.settingChanged(value, 'baseUrl');
                }));
    }

    private createOpenRouterSettings(container: HTMLElement): void {
        if (!container) return;

        // API Key Setting
        const apiKeySetting = new Setting(container)
            .setName('API Key')
            .setDesc('Your OpenRouter API key')
            .addText(text => {
                const input = text
                    .setPlaceholder('Enter API key')
                    .setValue(this.settings.apiKey || '')
                    .onChange(value => {
                        this.settings.apiKey = value.trim();
                        this.settingChanged(value, 'apiKey');
                    });
                input.inputEl.type = 'password';
                this.addPasswordToggle(input.inputEl);
            });

        // Base URL Setting
        const baseUrlSetting = new Setting(container)
            .setName('Base URL')
            .setDesc('Optional: Custom base URL for API requests')
            .addText(text => {
                const input = text
                    .setPlaceholder('https://openrouter.ai/api/v1')
                    .setValue(this.settings.baseUrl || '')
                    .onChange(value => {
                        this.settings.baseUrl = value.trim();
                        this.settingChanged(value, 'baseUrl');
                    });
            });

        // Add appropriate classes for styling
        apiKeySetting.settingEl.addClass('flare-setting-api-key');
        baseUrlSetting.settingEl.addClass('flare-setting-base-url');
    }

    private async createModelsSection(container: HTMLElement): Promise<void> {
        // Clear the container first
        container.empty();

        // Add mobile class if on mobile platform
        if (Platform.isMobile) {
            container.addClass('is-mobile');
        }

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

        // Try to load models if none are loaded, but only show errors if this isn't a new provider
        if (!this.settings.availableModels?.length) {
            try {
                const models = await this.plugin.providerManager.getAvailableModels(this.settings);
                this.settings.availableModels = models;
                this.settings.visibleModels = this.settings.visibleModels || [];
            } catch (error) {
                // Only show error if this isn't a new provider (i.e., has a type but no models)
                if (this.settings.type && error instanceof Error) {
                    new Notice('Error loading models: ' + error.message);
                }
            }
        }

        // Add model toggles
        if (this.settings.availableModels?.length) {
            const modelsList = container.createEl('div', { cls: 'models-list' });
            
            // Add header
            const header = modelsList.createEl('div', { cls: 'models-list-header' });
            
            // Create sort state
            let currentSort = {
                field: 'name' as 'name' | 'visibility',
                direction: 'asc' as 'asc' | 'desc'
            };

            // Create headers with sort functionality
            const nameHeader = header.createEl('div', { 
                cls: 'model-header model-name-header is-sorted',
                text: 'Model'
            });

            const visibilityHeader = header.createEl('div', { 
                cls: 'model-header visibility-header',
                text: 'Show'
            });

            // Create content container for scrolling
            const content = modelsList.createEl('div', { cls: 'models-list-content' });

            // Sort function
            const sortModels = (models: string[], field: 'name' | 'visibility', direction: 'asc' | 'desc') => {
                return [...models].sort((a, b) => {
                    if (field === 'name') {
                        return direction === 'asc' ? 
                            a.localeCompare(b) : 
                            b.localeCompare(a);
                    } else {
                        const aVisible = this.settings.visibleModels?.includes(a) || false;
                        const bVisible = this.settings.visibleModels?.includes(b) || false;
                        return direction === 'asc' ? 
                            Number(aVisible) - Number(bVisible) : 
                            Number(bVisible) - Number(aVisible);
                    }
                });
            };

            // Render models function
            const renderModels = () => {
                content.empty();
                const sortedModels = sortModels(
                    this.settings.availableModels || [],
                    currentSort.field,
                    currentSort.direction
                );

                sortedModels.forEach((model: string) => {
                    new Setting(content)
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
                                this.settingChanged(this.settings.visibleModels, 'visibleModels');

                                // Re-render if sorting by visibility
                                if (currentSort.field === 'visibility') {
                                    renderModels();
                                }
                            }));
                });
            };

            // Header click handlers
            const updateSort = (field: 'name' | 'visibility') => {
                // Remove sort classes from both headers
                nameHeader.removeClass('is-sorted', 'sort-desc');
                visibilityHeader.removeClass('is-sorted', 'sort-desc');

                if (currentSort.field === field) {
                    // Toggle direction if clicking same field
                    currentSort.direction = currentSort.direction === 'asc' ? 'desc' : 'asc';
                } else {
                    // New field, reset to ascending
                    currentSort.field = field;
                    currentSort.direction = 'asc';
                }

                // Add appropriate classes
                const header = field === 'name' ? nameHeader : visibilityHeader;
                header.addClass('is-sorted');
                if (currentSort.direction === 'desc') {
                    header.addClass('sort-desc');
                }

                renderModels();
            };

            nameHeader.addEventListener('click', () => updateSort('name'));
            visibilityHeader.addEventListener('click', () => updateSort('visibility'));

            // Initial render
            renderModels();
        } else {
            // Show empty state
            const emptyState = container.createDiv('models-empty-state');
            emptyState.setText('No models available. Click "Refresh models" to load the available models.');
        }
    }

    private addPasswordToggle(inputEl: HTMLInputElement): void {
        if (!inputEl || !inputEl.parentElement) return;

        const toggleBtn = inputEl.parentElement.createEl('button', {
            cls: 'password-visibility-toggle',
            attr: {
                'type': 'button',
                'aria-label': 'Toggle password visibility'
            }
        });
        toggleBtn.createEl('span', { text: '👁️' });
        
        toggleBtn.addEventListener('click', (e: MouseEvent) => {
            e.preventDefault();
            inputEl.type = inputEl.type === 'password' ? 'text' : 'password';
        });
    }

    async validateSettings(): Promise<void> {
        const errors: string[] = [];

        // Name validation
        if (!this.settings.name?.trim()) {
            errors.push('Provider name is required');
        } else if (this.settings.name.length > 50) {
            errors.push('Provider name must be less than 50 characters');
        }

        // Type validation
        if (!this.settings.type?.trim()) {
            errors.push('Provider type is required');
        } else if (!['openai', 'anthropic', 'azure', 'ollama', 'openrouter'].includes(this.settings.type)) {
            errors.push(`Invalid provider type: ${this.settings.type}`);
        }

        // API key validation for providers that require it
        if (['openai', 'openrouter', 'anthropic', 'azure'].includes(this.settings.type)) {
            if (!this.settings.apiKey?.trim()) {
                errors.push(`API key is required for ${this.settings.type} provider`);
            } else if (this.settings.apiKey.length < 20) {
                errors.push(`API key for ${this.settings.type} appears to be invalid (too short)`);
            }
        }

        // Base URL validation
        if (this.settings.baseUrl) {
            try {
                const url = new URL(this.settings.baseUrl);
                if (!['http:', 'https:'].includes(url.protocol)) {
                    errors.push('Base URL must use HTTP or HTTPS protocol');
                }
            } catch (e) {
                errors.push('Base URL is invalid. Please enter a valid URL');
            }
        }

        // Provider-specific validation
        switch (this.settings.type) {
            case 'azure':
                if (!this.settings.baseUrl?.trim()) {
                    errors.push('Base URL is required for Azure provider');
                }
                break;
            case 'ollama':
                // Set default Ollama URL if not provided
                if (!this.settings.baseUrl?.trim()) {
                    this.settings.baseUrl = 'http://localhost:11434';
                }
                break;
        }

        // Model validation
        if (this.settings.defaultModel && (!this.settings.visibleModels?.includes(this.settings.defaultModel))) {
            errors.push('Default model must be one of the visible models');
        }

        // Throw combined errors if any
        if (errors.length > 0) {
            throw new Error(errors.join('\n'));
        }
    }
} 