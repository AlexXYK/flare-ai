import { App, PluginSettingTab, Setting, Notice, DropdownComponent } from 'obsidian';
import type FlarePlugin from '../../main';
import { ProviderSettings } from '../types/AIProvider';
import { PluginSettings } from '../types/PluginSettings';

export class GeneralSettingTab extends PluginSettingTab {
    private hasUnsavedChanges = false;
    private originalSettings: PluginSettings | null = null;
    private titleModelDropdown: DropdownComponent;
    private sectionActionButtons: Map<string, HTMLElement> = new Map();
    private titleSettingsActionButtons: HTMLElement | null = null;

    constructor(app: App, private plugin: FlarePlugin) {
        super(app, plugin);
    }

    display() {
        const { containerEl } = this;
        containerEl.empty();

        // Store original settings
        this.originalSettings = JSON.parse(JSON.stringify(this.plugin.settings));
        this.hasUnsavedChanges = false;
        this.sectionActionButtons.clear();

        // Header
        containerEl.createEl('h1', { text: 'FLARE.ai' });
        
        const wrapper = containerEl.createDiv('flare-manager');

        // Providers Section
        const providersSection = this.createSection(wrapper, 'Providers', true);
        this.plugin.providerManager.createSettingsUI(providersSection);

        // Flares Section
        const flaresSection = this.createSection(wrapper, 'Flares', true);
        this.plugin.flareManager.createSettingsUI(flaresSection);

        // General Section (no "Settings" suffix)
        const generalSection = this.createSection(wrapper, 'General', true);
        this.addGeneralSettings(generalSection);

        // History Section (no "Settings" suffix)
        const historySection = this.createSection(wrapper, 'History', true);
        this.addHistorySettings(historySection);

        // Title Generation Section
        this.addTitleGenerationSettings(wrapper);
    }

    private createSection(containerEl: HTMLElement, title: string, collapsible: boolean = false): HTMLElement {
        const section = containerEl.createDiv({ cls: 'flare-section' });
        const header = section.createDiv({ cls: 'flare-section-header' });
        const content = section.createDiv({ cls: 'flare-section-content' });

        header.createSpan({ cls: 'flare-section-chevron' });
        header.createSpan({ text: title });

        if (collapsible) {
            header.addEventListener('click', () => {
                header.classList.toggle('is-collapsed');
                content.classList.toggle('is-hidden');
            });
        }

        return content;
    }

    private addProviderSettings(containerEl: HTMLElement) {
        // Add action buttons container
        const actionButtons = containerEl.createDiv({ cls: 'flare-form-actions' });
        this.sectionActionButtons.set('providers', actionButtons);

        // Create provider settings UI
        this.plugin.providerManager.createSettingsUI(containerEl);

        // Add save/revert buttons
        new Setting(actionButtons)
            .addButton(button => {
                button
                    .setButtonText('Save')
                    .setCta()
                    .onClick(async () => {
                        await this.saveSectionSettings('providers');
                    });
            })
            .addButton(button => {
                button
                    .setButtonText('Revert')
                    .onClick(async () => {
                        await this.revertSectionSettings('providers');
                    });
            });
    }

    private addGeneralSettings(containerEl: HTMLElement) {
        // Add action buttons container
        const actionButtons = containerEl.createDiv({ cls: 'flare-form-actions' });
        this.sectionActionButtons.set('general', actionButtons);

        // Flares folder
        new Setting(containerEl)
            .setName('Flares location')
            .setDesc('Where to store your flare configurations')
            .addText(text => text
                .setPlaceholder('FLAREai/flares')
                .setValue(this.plugin.settings.flaresFolder)
                .onChange(value => {
                    this.plugin.settings.flaresFolder = value || 'FLAREai/flares';
                    this.markSectionAsChanged('general');
                }));

        // History folder
        new Setting(containerEl)
            .setName('History location')
            .setDesc('Where to store your chat history')
            .addText(text => text
                .setPlaceholder('FLAREai/history')
                .setValue(this.plugin.settings.historyFolder)
                .onChange(value => {
                    this.plugin.settings.historyFolder = value || 'FLAREai/history';
                    this.markSectionAsChanged('general');
                }));

        // Add save/revert buttons
        new Setting(actionButtons)
            .addButton(button => {
                button
                    .setButtonText('Save')
                    .setCta()
                    .onClick(async () => {
                        await this.saveSectionSettings('general');
                    });
            })
            .addButton(button => {
                button
                    .setButtonText('Revert')
                    .onClick(async () => {
                        await this.revertSectionSettings('general');
                    });
            });
    }

    private addHistorySettings(containerEl: HTMLElement) {
        // Add action buttons container
        const actionButtons = containerEl.createDiv({ cls: 'flare-form-actions' });
        this.sectionActionButtons.set('history', actionButtons);

        // Enable auto-save
        new Setting(containerEl)
            .setName('Enable auto-save')
            .setDesc('Automatically save chat history at regular intervals')
            .addToggle(toggle => toggle
                .setValue(this.plugin.settings.autoSaveEnabled ?? true)
                .onChange(value => {
                    this.plugin.settings.autoSaveEnabled = value;
                    this.markSectionAsChanged('history');
                }));

        // Auto-save interval
        new Setting(containerEl)
            .setName('Auto-save interval')
            .setDesc('How often to save chat history (in seconds)')
            .addText(text => text
                .setPlaceholder('30')
                .setValue(String(this.plugin.settings.autoSaveInterval || 30))
                .onChange(value => {
                    const interval = parseInt(value);
                    if (!isNaN(interval) && interval > 0) {
                        this.plugin.settings.autoSaveInterval = interval;
                        this.markSectionAsChanged('history');
                    }
                }));

        // Max history files
        new Setting(containerEl)
            .setName('Max history files')
            .setDesc('Maximum number of history files to keep (0 for unlimited)')
            .addText(text => text
                .setPlaceholder('100')
                .setValue(String(this.plugin.settings.maxHistoryFiles || 100))
                .onChange(value => {
                    const max = parseInt(value);
                    if (!isNaN(max) && max >= 0) {
                        this.plugin.settings.maxHistoryFiles = max;
                        this.markSectionAsChanged('history');
                    }
                }));

        // Add save/revert buttons
        new Setting(actionButtons)
            .addButton(button => {
                button
                    .setButtonText('Save')
                    .setCta()
                    .onClick(async () => {
                        await this.saveSectionSettings('history');
                    });
            })
            .addButton(button => {
                button
                    .setButtonText('Revert')
                    .onClick(async () => {
                        await this.revertSectionSettings('history');
                    });
            });
    }

    private markSectionAsChanged(section: string) {
        const actionButtons = this.sectionActionButtons.get(section);
        if (actionButtons) {
            actionButtons.classList.add('is-visible');
        }
    }

    private hideSectionButtons(section: string) {
        const actionButtons = this.sectionActionButtons.get(section);
        if (actionButtons) {
            actionButtons.classList.remove('is-visible');
        }
    }

    private async saveSectionSettings(section: string) {
        try {
            await this.plugin.saveData(this.plugin.settings);
            
            if (section === 'general') {
                await this.plugin.ensureFlaresFolderExists();
            } else if (section === 'history') {
                // Update autosave when history settings change
                this.plugin.chatHistoryManager.updateAutoSave();
            }
            
            const actionButtons = this.sectionActionButtons.get(section);
            if (actionButtons) {
                actionButtons.classList.remove('is-visible');
            }
            
            // Update original settings after saving
            this.originalSettings = JSON.parse(JSON.stringify(this.plugin.settings));
            
            new Notice('Settings saved');
        } catch (error) {
            console.error('Failed to save settings:', error);
            new Notice('Failed to save settings');
        }
    }

    private async revertSectionSettings(section: string) {
        if (!this.originalSettings) return;

        try {
            if (section === 'general') {
                this.plugin.settings.flaresFolder = this.originalSettings.flaresFolder;
                this.plugin.settings.historyFolder = this.originalSettings.historyFolder;
            } else if (section === 'history') {
                this.plugin.settings.autoSaveInterval = this.originalSettings.autoSaveInterval;
                this.plugin.settings.maxHistoryFiles = this.originalSettings.maxHistoryFiles;
            } else if (section === 'title') {
                this.plugin.settings.titleSettings = JSON.parse(JSON.stringify(this.originalSettings.titleSettings));
            }

            // Refresh the display
            this.display();
            
            new Notice('Settings reverted');
        } catch (error) {
            console.error('Failed to revert settings:', error);
            new Notice('Failed to revert settings');
        }
    }

    private addTitleGenerationSettings(containerEl: HTMLElement) {
        // Create collapsible section for title generation
        const titleSection = this.createSection(containerEl, 'Title generation', true);

        // Add action buttons container
        const actionButtons = titleSection.createDiv({ cls: 'flare-form-actions' });
        this.sectionActionButtons.set('title', actionButtons);

        // Add auto title generation toggle
        new Setting(titleSection)
            .setName('Auto-generate titles')
            .setDesc('Automatically generate titles after a specified number of message exchanges')
            .addToggle(toggle => {
                toggle.setValue(this.plugin.settings.titleSettings.autoGenerate ?? false)
                    .onChange(async value => {
                        this.plugin.settings.titleSettings.autoGenerate = value;
                        // Show/hide the message pairs setting based on toggle
                        const pairsContainer = titleSection.querySelector('.auto-title-pairs-setting');
                        if (pairsContainer instanceof HTMLElement) {
                            pairsContainer.classList.toggle('is-visible', value);
                        }
                        this.markSectionAsChanged('title');
                    });
            });

        // Add message pairs setting
        const pairsContainer = titleSection.createDiv({ cls: 'auto-title-pairs-setting' });
        if (this.plugin.settings.titleSettings.autoGenerate) {
            pairsContainer.classList.add('is-visible');
        }

        new Setting(titleSection)
            .setName('Provider')
            .setDesc('Select the provider to use for title generation')
            .addDropdown(dropdown => {
                this.populateProviderDropdown(dropdown);
                dropdown.setValue(this.plugin.settings.titleSettings.provider);
                dropdown.onChange(async value => {
                    this.plugin.settings.titleSettings.provider = value;
                    this.markSectionAsChanged('title');
                    await this.refreshTitleModels();
                });
            });

        // Create model container and setting
        const modelContainer = titleSection.createDiv('model-container');
        new Setting(modelContainer)
            .setName('Model')
            .setDesc('Select the model to use for title generation')
            .addDropdown(dropdown => {
                this.titleModelDropdown = dropdown;
                dropdown.setValue(this.plugin.settings.titleSettings.model);
                dropdown.onChange(async value => {
                    this.plugin.settings.titleSettings.model = value;
                    this.markSectionAsChanged('title');
                });
            });

        // Initial model load
        setTimeout(() => this.refreshTitleModels(), 100);

        new Setting(titleSection)
            .setName('Temperature')
            .setDesc('Set the temperature for title generation (0.0 - 1.5)')
            .addText(text => {
                text.setValue(this.plugin.settings.titleSettings.temperature.toString())
                    .onChange(async value => {
                        const temp = parseFloat(value);
                        if (!isNaN(temp) && temp >= 0 && temp <= 1.5) {
                            this.plugin.settings.titleSettings.temperature = temp;
                            this.markSectionAsChanged('title');
                        }
                    });
            });

        new Setting(titleSection)
            .setName('Maximum tokens')
            .setDesc('Maximum length of generated title')
            .addText(text => {
                text.setValue(String(this.plugin.settings.titleSettings.maxTokens || 50))
                    .setPlaceholder('50')
                    .onChange(async value => {
                        const tokens = parseInt(value);
                        if (!isNaN(tokens) && tokens > 0) {
                            this.plugin.settings.titleSettings.maxTokens = tokens;
                            this.markSectionAsChanged('title');
                        }
                    });
            });

        // Create a container for the prompt setting
        const promptContainer = titleSection.createDiv('setting-item');
        const promptInfo = promptContainer.createDiv('setting-item-info');
        promptInfo.createDiv('setting-item-name').setText('Prompt');
        promptInfo.createDiv('setting-item-description').setText('Set the prompt for title generation');

        // Create a container for the textarea
        const textareaContainer = promptContainer.createDiv('setting-item-control');
        
        const promptArea = textareaContainer.createEl('textarea', {
            cls: 'flare-system-prompt',
            attr: {
                placeholder: 'Enter your prompt here...',
                spellcheck: 'false',
                rows: '8',
                'aria-label': 'Title generation prompt input'
            }
        });
        
        promptArea.value = this.plugin.settings.titleSettings.prompt;
        promptArea.addEventListener('input', () => {
            this.plugin.settings.titleSettings.prompt = promptArea.value;
            this.markSectionAsChanged('title');
        });

        // Add save/revert buttons
        new Setting(actionButtons)
            .addButton(button => {
                button
                    .setButtonText('Save')
                    .setCta()
                    .onClick(async () => {
                        await this.saveSectionSettings('title');
                    });
            })
            .addButton(button => {
                button
                    .setButtonText('Revert')
                    .onClick(async () => {
                        await this.revertSectionSettings('title');
                    });
            });
    }

    private async createModelSetting(container: HTMLElement, providerId: string) {
        const provider = this.plugin.settings.providers[providerId];
        if (!provider || !provider.type) return;

        const modelSetting = new Setting(container)
            .setName('Model')
            .setDesc('Select which model to use for generating chat titles')
            .addDropdown(dropdown => {
                dropdown.addOption('', 'Select a model...');
                dropdown.setDisabled(true);
                return dropdown;
            })
            .addButton(btn => 
                btn
                    .setIcon('refresh-cw')
                    .setTooltip('Refresh Models')
                    .onClick(() => this.refreshModelSelection(container))
            );

        // Initial model load
        await this.refreshModelSelection(container);
    }

    private async refreshModelSelection(container: HTMLElement) {
        try {
            const provider = this.plugin.settings.providers[this.plugin.settings.titleSettings.provider];
            if (!provider || !provider.type) return;

            // Add loading state to the button
            const refreshButton = container.querySelector('.clickable-icon') as HTMLElement;
            if (refreshButton) {
                refreshButton.addClass('loading');
            }

            // Add loading state to the model dropdown
            const modelSetting = container.querySelector('.setting-item') as HTMLElement;
            if (!modelSetting) return;
            modelSetting.addClass('loading');

            try {
                // Get fresh list of models
                const allModels = await this.plugin.getModelsForProvider(provider.type);
                
                // Filter models based on provider's visibleModels setting
                const models = provider.visibleModels?.length ? 
                    allModels.filter(model => provider.visibleModels?.includes(model)) :
                    allModels;
                
                // Update the dropdown
                const modelDropdown = modelSetting.querySelector('select');
                if (modelDropdown instanceof HTMLSelectElement) {
                    modelDropdown.disabled = false;
                    // Remove all existing options
                    while (modelDropdown.firstChild) {
                        modelDropdown.removeChild(modelDropdown.firstChild);
                    }
                    // Add new options
                    modelDropdown.appendChild(new Option('Select a model...', ''));
                    models.forEach(model => {
                        modelDropdown.appendChild(new Option(model, model));
                    });

                    // Keep current selection if it exists in new model list, otherwise use default
                    if (this.plugin.settings.titleSettings.model && models.includes(this.plugin.settings.titleSettings.model)) {
                        modelDropdown.value = this.plugin.settings.titleSettings.model;
                    } else {
                        const newModel = provider.defaultModel || models[0] || '';
                        this.plugin.settings.titleSettings.model = newModel;
                        modelDropdown.value = newModel;
                        this.showTitleSettingsButtons();
                    }

                    // Add change handler
                    modelDropdown.onchange = () => {
                        this.plugin.settings.titleSettings.model = modelDropdown.value;
                        this.showTitleSettingsButtons();
                    };
                }

                new Notice('Models refreshed');
            } finally {
                // Remove loading states
                if (refreshButton) {
                    refreshButton.removeClass('loading');
                }
                modelSetting.removeClass('loading');
            }
        } catch (error) {
            console.error('Failed to refresh models:', error);
            new Notice('Failed to refresh models');

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
                this.refreshModelSelection(container);
            };
            
            // Add button to error message
            errorDiv.appendChild(retryButton);
            
            // Add error message to container
            if (container instanceof HTMLElement) {
                container.appendChild(errorDiv);
            }
        }
    }

    private populateProviderDropdown(dropdown: DropdownComponent) {
        // Add default option
        dropdown.addOption('', 'Select a provider...');
        
        Object.entries(this.plugin.settings.providers).forEach(([id, provider]) => {
            if (provider.type && this.plugin.providers.has(provider.type)) {
                dropdown.addOption(id, provider.name || id);
            }
        });
    }

    private showTitleSettingsButtons() {
        if (this.titleSettingsActionButtons) {
            this.titleSettingsActionButtons.classList.add('is-visible');
        }
    }

    private hideTitleSettingsButtons() {
        if (this.titleSettingsActionButtons) {
            this.titleSettingsActionButtons.classList.remove('is-visible');
        }
    }

    private async saveSettings() {
        try {
            await this.plugin.saveData(this.plugin.settings);
            this.hideTitleSettingsButtons();
            new Notice('Settings saved');
        } catch (error) {
            console.error('Failed to save settings:', error);
            new Notice('Failed to save settings');
        }
    }

    private async loadSettings() {
        try {
            await this.plugin.loadData();
            this.display();
            new Notice('Settings loaded');
        } catch (error) {
            console.error('Failed to load settings:', error);
            new Notice('Failed to load settings');
        }
    }

    private async refreshTitleModels() {
        const modelContainer = this.containerEl.querySelector('.model-container') as HTMLElement;
        if (modelContainer) {
            await this.refreshModelSelection(modelContainer);
        }
    }
} 