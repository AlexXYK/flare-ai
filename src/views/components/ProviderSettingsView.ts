import { Setting, Notice, Platform, setIcon, setTooltip } from 'obsidian';
import type FlarePlugin from '../../../main';
import type { ProviderSettings } from '../../types/AIProvider';

export class ProviderSettingsView {
    private originalSettings: ProviderSettings;
    private actionButtons: HTMLElement | null = null;
    private hasSettingsChanged: boolean = false;
    private currentSortOrder: 'asc' | 'desc' = 'asc';
    private currentSortCriteria: 'name' | 'visibility' = 'name';

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

        // Ensure visibleModels is initialized
        if (this.settings) {
            this.settings.visibleModels = this.settings.visibleModels || [];
        }
    }

    private settingChanged(newValue: any, path: string) {
        if (!this.settings) return;

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
        
        // Only trigger if the value actually changed
        if (hasChanged !== this.hasSettingsChanged) {
            this.hasSettingsChanged = hasChanged;
            this.onSettingsChange();
        }
    }

    updateOriginalSettings(): void {
        // Update original settings with a deep copy of current settings
        this.originalSettings = JSON.parse(JSON.stringify(this.settings || {
            name: '',
            type: '',
            enabled: false,
            visibleModels: []
        }));
        this.hasSettingsChanged = false;
    }

    display(): void {
        const isDisabled = !this.settings;

        // Name setting
        new Setting(this.container)
            .setName('Name')
            .setDesc('A unique name for this provider')
            .setDisabled(isDisabled)
            .addText(text => text
                .setPlaceholder('Enter provider name')
                .setValue(this.settings?.name || '')
                .setDisabled(isDisabled)
                .onChange(value => {
                    if (!this.settings) return;
                    this.settings.name = value;
                    this.settingChanged(value, 'name');
                }));

        // Enable toggle
        new Setting(this.container)
            .setName('Enable provider')
            .setDesc('Enable or disable this provider')
            .setDisabled(isDisabled)
            .addToggle(toggle => toggle
                .setValue(this.settings?.enabled || false)
                .setDisabled(isDisabled)
                .onChange(value => {
                    if (!this.settings) return;
                    this.settings.enabled = value;
                    this.settingChanged(value, 'enabled');
                }));

        // API Key setting (always show, just disabled if not needed)
        new Setting(this.container)
            .setName('API Key')
            .setDesc('Your provider API key')
            .setDisabled(isDisabled || !['openai', 'openrouter', 'anthropic', 'azure'].includes(this.settings?.type || ''))
            .addText(text => {
                const input = text
                    .setPlaceholder('Enter API key')
                    .setValue(this.settings?.apiKey || '')
                    .setDisabled(isDisabled || !['openai', 'openrouter', 'anthropic', 'azure'].includes(this.settings?.type || ''))
                    .onChange(value => {
                        if (!this.settings) return;
                        this.settings.apiKey = value.trim();
                        this.settingChanged(value, 'apiKey');
                    });
                input.inputEl.type = 'password';
                this.addPasswordToggle(input.inputEl);
            });

        // Base URL setting (always show, just disabled if not needed)
        new Setting(this.container)
            .setName('Base URL')
            .setDesc('API endpoint URL')
            .setDisabled(isDisabled || !['openai', 'azure', 'ollama', 'openrouter'].includes(this.settings?.type || ''))
            .addText(text => {
                const defaultUrls: Record<string, string> = {
                    openai: 'https://api.openai.com/v1',
                    azure: 'https://<resource>.openai.azure.com',
                    ollama: 'http://localhost:11434',
                    openrouter: 'https://openrouter.ai/api/v1'
                };
                return text
                    .setPlaceholder(defaultUrls[this.settings?.type || ''] || '')
                    .setValue(this.settings?.baseUrl || '')
                    .setDisabled(isDisabled || !['openai', 'azure', 'ollama', 'openrouter'].includes(this.settings?.type || ''))
                    .onChange(value => {
                        if (!this.settings) return;
                        this.settings.baseUrl = value.trim();
                        this.settingChanged(value, 'baseUrl');
                    });
            });

        // Models section (always show, just disabled if no provider)
        const modelsHeading = new Setting(this.container)
            .setName('Available Models')
            .setDesc('Select which models to show in the model selector')
            .setDisabled(isDisabled)
            .addButton(button => button
                .setButtonText('Refresh Models')
                .setDisabled(isDisabled)
                .onClick(async () => {
                    if (!this.settings) return;
                    try {
                        button.setButtonText('Refreshing...');
                        button.setDisabled(true);

                        // Clear existing models list first
                        this.settings.availableModels = [];
                        const modelsContent = this.container.querySelector('.models-list-content') as HTMLElement;
                        if (modelsContent) {
                            modelsContent.empty();
                            // Show loading state
                            new Setting(modelsContent)
                                .setName('Loading models...')
                                .setDesc('Please wait while models are being fetched')
                                .setDisabled(true);
                        }

                        const models = await this.plugin.providerManager.getAvailableModels(this.settings);
                        this.settings.availableModels = models;
                        this.settings.visibleModels = this.settings.visibleModels || [];
                        
                        // Clear existing models list content
                        if (modelsContent) {
                            modelsContent.empty();
                            
                            // Sort models by visibility first, then alphabetically
                            const sortedModels = [...models].sort((a, b) => {
                                const aVisible = this.settings?.visibleModels?.includes(a) || false;
                                const bVisible = this.settings?.visibleModels?.includes(b) || false;
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
                        this.settings.availableModels = [];
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

        // Add header
        const header = modelsContainer.createEl('div', { cls: 'models-list-header' });
        const modelHeader = header.createEl('div', { 
            cls: 'model-header model-name-header',
            text: 'Model'
        });
        const visibilityHeader = header.createEl('div', { 
            cls: 'model-header visibility-header',
            text: 'Show'
        });

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
        if (!isDisabled && this.settings?.availableModels?.length) {
            this.renderModels(modelsContent);
        } else {
            // Show empty state as a disabled setting
            new Setting(modelsContent)
                .setName('No models available')
                .setDesc(isDisabled ? 'Select a provider to view available models' : 'Click "Refresh Models" to load available models')
                .setDisabled(true);
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
        if (!this.settings || !this.settings.availableModels) return;

        const visibleModels = this.settings.visibleModels || [];

        const sortedModels = [...this.settings.availableModels].sort((a, b) => {
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

    private renderModels(modelsContent: HTMLElement, models = this.settings?.availableModels || []) {
        models.forEach(model => {
            new Setting(modelsContent)
                .setName(model)
                .addToggle(toggle => toggle
                    .setValue(this.settings?.visibleModels?.includes(model) || false)
                    .onChange(value => {
                        if (!this.settings) return;
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
        if (!this.settings) return models;
        
        const visibleModels = this.settings.visibleModels || [];
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

    async validateSettings(): Promise<void> {
        if (!this.settings) return;
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