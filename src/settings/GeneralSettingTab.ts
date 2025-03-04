import { App, PluginSettingTab, Setting, DropdownComponent, TextComponent, ButtonComponent, Notice, setIcon, setTooltip } from 'obsidian';
import type FlarePlugin from '../../main';
import { ProviderSettings } from '../types/AIProvider';
import { PluginSettings } from '../types/PluginSettings';

export class GeneralSettingTab extends PluginSettingTab {
    private hasUnsavedChanges = false;
    private originalSettings: PluginSettings | null = null;
    private titleModelDropdown!: DropdownComponent;
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

        // Create sections directly in the container with more specific classes
        const providersSection = containerEl.createDiv({ cls: 'settings-section providers-section' });
        const flaresSection = containerEl.createDiv({ cls: 'settings-section flares-section' });
        const generalSection = containerEl.createDiv({ cls: 'settings-section general-section' });
        const historySection = containerEl.createDiv({ cls: 'settings-section history-section' });
        const titleSection = containerEl.createDiv({ cls: 'settings-section title-section' });
        const exportSection = containerEl.createDiv({ cls: 'settings-section export-section' });

        // Providers Section
        new Setting(providersSection).setName('Providers').setHeading();
        this.plugin.providerManager.createSettingsUI(providersSection);

        // Flares Section
        new Setting(flaresSection).setName('Flares').setHeading();
        this.plugin.flareManager.createSettingsUI(flaresSection);

        // General Section
        new Setting(generalSection).setName('General').setHeading();
        this.addGeneralSettings(generalSection);

        // History Section
        new Setting(historySection).setName('History').setHeading();
        this.addHistorySettings(historySection);

        // Title Generation Section
        this.addTitleGenerationSettings(titleSection);
        
        // Export Section
        this.addExportSettings(exportSection);
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

        // Export folder - moved from export settings
        new Setting(containerEl)
            .setName('Export location')
            .setDesc('Where to store your exported chat histories')
            .addText(text => text
                .setPlaceholder('FLAREai/exports')
                .setValue(this.plugin.settings.exportSettings?.exportFolder || 'FLAREai/exports')
                .onChange(value => {
                    if (!this.plugin.settings.exportSettings) {
                        this.plugin.settings.exportSettings = {
                            exportFolder: value || 'FLAREai/exports',
                            frontmatterTemplate: '',
                            metadataTemplate: '',
                            includeSystemMessages: true,
                            includeReasoningBlocks: true
                        };
                    } else {
                        this.plugin.settings.exportSettings.exportFolder = value || 'FLAREai/exports';
                    }
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
            .setDesc('Save chat history to disk automatically. When disabled, chats exist only in memory and are lost when Obsidian is closed.')
            .addToggle(toggle => toggle
                .setValue(this.plugin.settings.autoSaveEnabled ?? true)
                .onChange(value => {
                    this.plugin.settings.autoSaveEnabled = value;
                    this.markSectionAsChanged('history');
                }));

        // Date format setting
        new Setting(containerEl)
            .setName('Date format')
            .setDesc('Format for dates in chat history filenames')
            .addDropdown(dropdown => {
                const formats = {
                    'MM-DD-YYYY': 'MM-DD-YYYY (e.g., 12-31-2023)',
                    'DD-MM-YYYY': 'DD-MM-YYYY (e.g., 31-12-2023)',
                    'YYYY-MM-DD': 'YYYY-MM-DD (e.g., 2023-12-31)',
                    'MM-DD-YY': 'MM-DD-YY (e.g., 12-31-23)',
                    'DD-MM-YY': 'DD-MM-YY (e.g., 31-12-23)',
                    'YY-MM-DD': 'YY-MM-DD (e.g., 23-12-31)'
                };
                
                Object.entries(formats).forEach(([value, label]) => {
                    dropdown.addOption(value, label);
                });
                
                dropdown.setValue(this.plugin.settings.dateFormat || 'MM-DD-YYYY')
                    .onChange(value => {
                        this.plugin.settings.dateFormat = value;
                        this.markSectionAsChanged('history');
                    });
            });

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
            } else if (section === 'export') {
                this.plugin.settings.exportSettings = JSON.parse(JSON.stringify(this.originalSettings.exportSettings));
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
        // Create section for title generation
        new Setting(containerEl).setName('Title generation').setHeading();

        // Add action buttons container
        const actionButtons = containerEl.createDiv({ cls: 'flare-form-actions' });
        this.sectionActionButtons.set('title', actionButtons);

        // Add auto title generation toggle
        new Setting(containerEl)
            .setName('Auto-generate titles')
            .setDesc('Automatically generate titles after a specified number of message exchanges')
            .addToggle(toggle => {
                toggle.setValue(this.plugin.settings.titleSettings.autoGenerate ?? false)
                    .onChange(async value => {
                        this.plugin.settings.titleSettings.autoGenerate = value;
                        this.markSectionAsChanged('title');
                    });
            });

        // Add message pairs setting
        new Setting(containerEl)
            .setName('Auto-generate after pairs')
            .setDesc('Number of message pairs after which to automatically generate a title')
            .addText(text => {
                text.inputEl.addClass('flare-pairs-input');
                text.setValue(String(this.plugin.settings.titleSettings.autoGenerateAfterPairs || 2))
                    .setPlaceholder('2')
                    .onChange(async value => {
                        const pairs = parseInt(value);
                        if (!isNaN(pairs) && pairs > 0) {
                            this.plugin.settings.titleSettings.autoGenerateAfterPairs = pairs;
                            this.markSectionAsChanged('title');
                        }
                    });
            });

        // Add provider setting
        new Setting(containerEl)
            .setName('Provider')
            .setDesc('Select the provider to use for title generation')
            .addDropdown(dropdown => {
                this.populateProviderDropdown(dropdown);
                dropdown.setValue(this.plugin.settings.titleSettings.provider);
                dropdown.onChange(async value => {
                    this.plugin.settings.titleSettings.provider = value;
                    this.markSectionAsChanged('title');
                    
                    // Immediately load models for the selected provider
                    if (this.titleModelDropdown && value) {
                        await this.updateTitleModels(value);
                    } else if (this.titleModelDropdown) {
                        this.titleModelDropdown.selectEl.empty();
                        this.titleModelDropdown.addOption('', 'Select a model...');
                        this.titleModelDropdown.setValue('');
                    }
                });
            });

        // Model dropdown - create as a regular setting-item
        const modelSetting = new Setting(containerEl)
            .setName('Model')
            .setDesc('Select the model to use for title generation')
            .addDropdown(dropdown => {
                this.titleModelDropdown = dropdown;
                
                // Add default option
                dropdown.addOption('', 'Select a model...');
                
                // Set up change handler
                dropdown.onChange(value => {
                    this.plugin.settings.titleSettings.model = value;
                    this.markSectionAsChanged('title');
                });

                // If we have a provider, load its models
                if (this.plugin.settings.titleSettings.provider) {
                    // Load models for the current provider automatically when settings tab is displayed
                    this.loadTitleModels(this.plugin.settings.titleSettings.provider, dropdown);
                }
                
                return dropdown;
            });

        new Setting(containerEl)
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

        new Setting(containerEl)
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

        // Add the prompt description as a separate setting
        new Setting(containerEl)
            .setName('Prompt')
            .setDesc('Set the prompt for title generation');

        // Create a container for the textarea (flat structure)
        const titlePromptInput = containerEl.createEl('textarea', {
            cls: 'system-prompt'
        });
        setTooltip(titlePromptInput, 'Title generation prompt input');
        
        titlePromptInput.value = this.plugin.settings.titleSettings.prompt;
        titlePromptInput.addEventListener('input', () => {
            this.plugin.settings.titleSettings.prompt = titlePromptInput.value;
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

    /** Loads models for a provider into the title generation dropdown
     * @param providerId The ID of the provider
     * @param dropdown The dropdown to populate
     */
    private async loadTitleModels(providerId: string, dropdown: DropdownComponent) {
        const provider = this.plugin.settings.providers[providerId];
        if (!provider) return;

        try {
            // Show loading state
            dropdown.selectEl.empty();
            dropdown.addOption('loading', 'Loading models...');
            dropdown.setValue('loading');
            dropdown.selectEl.disabled = true;
            
            // If provider has visibleModels configured, use them directly
            if (provider.visibleModels && provider.visibleModels.length > 0) {
                // Clear loading state
                dropdown.selectEl.empty();
                dropdown.addOption('', 'Select a model...');
                dropdown.selectEl.disabled = false;
                
                // Add visible models directly from provider settings
                provider.visibleModels.forEach(model => {
                    dropdown.addOption(model, model);
                });
                
                // Set current value if exists
                dropdown.setValue(this.plugin.settings.titleSettings.model || provider.defaultModel || '');
                return;
            }
            
            // Only if we don't have visibleModels, try to get models from the provider
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

            // Clear loading state
            dropdown.selectEl.empty();
            dropdown.addOption('', 'Select a model...');
            dropdown.selectEl.disabled = false;

            // Add model options
            visibleModels.forEach(model => {
                dropdown.addOption(model, model);
            });

            // Set current value if exists
            dropdown.setValue(this.plugin.settings.titleSettings.model || provider.defaultModel || '');
        } catch (error) {
            // Reset dropdown on error
            dropdown.selectEl.empty();
            dropdown.addOption('', 'Error loading models');
            dropdown.selectEl.disabled = false;
            
            console.error('Failed to load models:', error);
            if (error instanceof Error) {
                new Notice('Failed to load models: ' + error.message);
            } else {
                new Notice('Failed to load models');
            }
        }
    }

    /** Updates the title generation model dropdown based on the selected provider
     * @param providerId The ID of the selected provider
     */
    private async updateTitleModels(providerId: string) {
        if (!this.titleModelDropdown) return;

        const provider = this.plugin.settings.providers[providerId];
        if (!provider) return;

        try {
            // Clear existing options and show loading state
            this.titleModelDropdown.selectEl.empty();
            this.titleModelDropdown.addOption('loading', 'Loading models...');
            this.titleModelDropdown.setValue('loading');
            this.titleModelDropdown.selectEl.disabled = true;

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

            // Clear loading state
            this.titleModelDropdown.selectEl.empty();
            this.titleModelDropdown.addOption('', 'Select a model...');
            this.titleModelDropdown.selectEl.disabled = false;

            // Add model options
            visibleModels.forEach(model => {
                this.titleModelDropdown.addOption(model, model);
            });

            // Set current value if exists
            this.titleModelDropdown.setValue(this.plugin.settings.titleSettings.model || provider.defaultModel || '');
        } catch (error) {
            // Reset dropdown on error
            this.titleModelDropdown.selectEl.empty();
            this.titleModelDropdown.addOption('', 'Error loading models');
            this.titleModelDropdown.selectEl.disabled = false;
            
            console.error('Failed to load models:', error);
            if (error instanceof Error) {
                new Notice('Failed to load models: ' + error.message);
            } else {
                new Notice('Failed to load models');
            }
        }
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

    // Add method to refresh all provider dropdowns in title settings
    public refreshTitleProviderDropdowns() {
        // Find all provider dropdowns in title settings
        const dropdowns = document.querySelectorAll('.title-generation select, .title-settings select, [class*="title"] .setting-item select') as NodeListOf<HTMLSelectElement>;
        dropdowns.forEach(select => {
            const dropdown = select as any;
            if (dropdown.getValue) {
                const currentValue = dropdown.getValue();
                // Clear existing options
                dropdown.selectEl.empty();
                // Add default option
                dropdown.addOption('', 'Select a provider...');
                // Add provider options
                Object.entries(this.plugin.settings.providers).forEach(([id, provider]) => {
                    if (provider.type && this.plugin.providers.has(provider.type)) {
                        dropdown.addOption(id, provider.name || id);
                    }
                });
                // Restore current value if it still exists
                dropdown.setValue(currentValue);
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

    private addExportSettings(containerEl: HTMLElement) {
        // Create section for export settings
        new Setting(containerEl).setName('Export settings').setHeading();

        // Add action buttons container
        const actionButtons = containerEl.createDiv({ cls: 'flare-form-actions' });
        this.sectionActionButtons.set('export', actionButtons);

        // Include system messages
        new Setting(containerEl)
            .setName('Include system messages')
            .setDesc('Include system messages in exported chat histories')
            .addToggle(toggle => toggle
                .setValue(this.plugin.settings.exportSettings?.includeSystemMessages ?? true)
                .onChange(value => {
                    if (!this.plugin.settings.exportSettings) {
                        this.plugin.settings.exportSettings = {
                            exportFolder: 'FLAREai/exports',
                            frontmatterTemplate: '',
                            metadataTemplate: '',
                            includeSystemMessages: value,
                            includeReasoningBlocks: true
                        };
                    } else {
                        this.plugin.settings.exportSettings.includeSystemMessages = value;
                    }
                    this.markSectionAsChanged('export');
                }));
        
        // Include reasoning blocks
        new Setting(containerEl)
            .setName('Include reasoning blocks')
            .setDesc('Include AI reasoning blocks in exported chat histories')
            .addToggle(toggle => toggle
                .setValue(this.plugin.settings.exportSettings?.includeReasoningBlocks ?? true)
                .onChange(value => {
                    if (!this.plugin.settings.exportSettings) {
                        this.plugin.settings.exportSettings = {
                            exportFolder: 'FLAREai/exports',
                            frontmatterTemplate: '',
                            metadataTemplate: '',
                            includeSystemMessages: true,
                            includeReasoningBlocks: value
                        };
                    } else {
                        this.plugin.settings.exportSettings.includeReasoningBlocks = value;
                    }
                    this.markSectionAsChanged('export');
                }));

        // Add frontmatter template description as a separate setting
        new Setting(containerEl)
            .setName('Frontmatter template')
            .setDesc('Template for frontmatter in exported chats. Available variables: {{title}}, {{date}}');

        // Create the textarea in flat structure
        const frontmatterInput = containerEl.createEl('textarea', {
            cls: 'system-prompt'
        });
        setTooltip(frontmatterInput, 'Frontmatter template for exports');

        frontmatterInput.value = this.plugin.settings.exportSettings?.frontmatterTemplate || `---
title: {{title}}
date: {{date}}
---`;

        frontmatterInput.addEventListener('input', () => {
            if (!this.plugin.settings.exportSettings) {
                this.plugin.settings.exportSettings = {
                    exportFolder: 'FLAREai/exports',
                    frontmatterTemplate: frontmatterInput.value,
                    metadataTemplate: '',
                    includeSystemMessages: true,
                    includeReasoningBlocks: true
                };
            } else {
                this.plugin.settings.exportSettings.frontmatterTemplate = frontmatterInput.value;
            }
            this.markSectionAsChanged('export');
        });

        // Add metadata template description as a separate setting
        new Setting(containerEl)
            .setName('Message metadata template')
            .setDesc('Template for message metadata in exported chats. Leave empty for no metadata.');

        // Create the textarea in flat structure
        const metadataInput = containerEl.createEl('textarea', {
            cls: 'system-prompt'
        });
        setTooltip(metadataInput, 'Message metadata template for exports');

        metadataInput.value = this.plugin.settings.exportSettings?.metadataTemplate || '';

        metadataInput.addEventListener('input', () => {
            if (!this.plugin.settings.exportSettings) {
                this.plugin.settings.exportSettings = {
                    exportFolder: 'FLAREai/exports',
                    frontmatterTemplate: '',
                    metadataTemplate: metadataInput.value,
                    includeSystemMessages: true,
                    includeReasoningBlocks: true
                };
            } else {
                this.plugin.settings.exportSettings.metadataTemplate = metadataInput.value;
            }
            this.markSectionAsChanged('export');
        });

        // Add save/revert buttons
        new Setting(actionButtons)
            .addButton(button => {
                button
                    .setButtonText('Save')
                    .setCta()
                    .onClick(async () => {
                        await this.saveSectionSettings('export');
                    });
            })
            .addButton(button => {
                button
                    .setButtonText('Revert')
                    .onClick(async () => {
                        await this.revertSectionSettings('export');
                    });
            });
    }
} 