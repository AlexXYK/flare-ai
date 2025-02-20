import { Setting, DropdownComponent, Modal, Notice, setIcon } from 'obsidian';
import type FlarePlugin from '../../../main';
import type { ProviderSettings } from '../../types/AIProvider';
import { ProviderSettingsView } from './ProviderSettingsView';

export class ProviderSettingsUI {
    private currentProvider: string | null = null;
    private providerDropdown: DropdownComponent | null = null;
    private originalSettings: any;
    private actionButtons: HTMLElement | null = null;
    private providerSettingsView: ProviderSettingsView | null = null;
    private hasUnsavedChanges: boolean = false;

    constructor(
        private plugin: FlarePlugin,
        private container: HTMLElement,
        private onProviderChange: (providerId: string | null) => void
    ) {
        // Store original settings for revert
        this.originalSettings = JSON.parse(JSON.stringify(this.plugin.settings));
    }

    display(): void {
        this.container.empty();

        // Create main container
        const mainContainer = this.container.createEl('div', { cls: 'provider-settings-main' });
        
        // Create left and right containers
        const leftContainer = mainContainer.createEl('div', { cls: 'provider-settings-left' });
        const rightContainer = mainContainer.createEl('div', { cls: 'provider-settings-right' });

        // Create provider selector area
        const selectorContainer = leftContainer.createEl('div', { cls: 'flare-provider-selector' });
        this.createProviderSelector(selectorContainer);

        // Create provider type setting right after the selector
        const providerTypeContainer = leftContainer.createEl('div', { cls: 'provider-type-setting' });
        this.createProviderTypeDropdown(providerTypeContainer);

        // Create action buttons container after the type dropdown
        this.actionButtons = leftContainer.createEl('div', { cls: 'flare-form-actions' });

        // Add save/revert buttons
        new Setting(this.actionButtons)
            .addButton(button => {
                button
                    .setButtonText('Save')
                    .setCta()
                    .onClick(async () => {
                        try {
                            if (this.providerSettingsView) {
                                await this.providerSettingsView.validateSettings();
                            }
                            await this.plugin.saveData(this.plugin.settings);
                            // Update original settings after successful save
                            this.originalSettings = JSON.parse(JSON.stringify(this.plugin.settings));
                            this.hasUnsavedChanges = false; // Reset unsaved changes flag
                            this.hideActionButtons();
                            // After successful save, refresh all dropdowns
                            this.refreshDropdown();
                            // Refresh provider dropdowns in flare settings
                            if (this.plugin.flareManager) {
                                this.plugin.flareManager.refreshProviderDropdowns();
                            }
                            // Refresh provider dropdowns in title settings
                            if (this.plugin.settingTab) {
                                this.plugin.settingTab.refreshTitleProviderDropdowns();
                            }
                            // Update provider settings view's original settings
                            if (this.providerSettingsView) {
                                this.providerSettingsView.updateOriginalSettings();
                            }
                            new Notice('Provider settings saved');
                        } catch (error) {
                            console.error('Failed to save provider settings:', error);
                            new Notice('Error saving settings: ' + (error instanceof Error ? error.message : 'Unknown error'));
                        }
                    });
            })
            .addButton(button => {
                button
                    .setButtonText('Revert')
                    .onClick(() => {
                        try {
                            // Restore all settings
                            Object.assign(this.plugin.settings, JSON.parse(JSON.stringify(this.originalSettings)));
                            // Refresh the UI
                            this.display();
                            this.hideActionButtons();
                            new Notice('Provider settings reverted');
                        } catch (error) {
                            console.error('Failed to revert provider settings:', error);
                            new Notice('Failed to revert settings');
                        }
                    });
            });

        // Create provider settings view in the right container
        if (this.currentProvider) {
            const settings = this.plugin.settings.providers[this.currentProvider];
            this.providerSettingsView = new ProviderSettingsView(
                this.plugin,
                rightContainer,
                settings,
                async () => {
                    await this.plugin.saveData(this.plugin.settings);
                },
                this.handleSettingsChange
            );
            this.providerSettingsView.display();
        }
    }

    private createProviderSelector(container: HTMLElement): void {
        const dropdownContainer = new Setting(container)
            .setName('Active provider')
            .setDesc('Select a provider to configure');

        let dropdown: DropdownComponent | null = null;
        dropdownContainer.addDropdown(d => {
            dropdown = d;
            this.providerDropdown = d;
            // Add placeholder option
            d.addOption('', 'Select a provider...');
            
            // Add existing providers
            Object.entries(this.plugin.settings.providers)
                .sort(([, a], [, b]) => (a.name || '').localeCompare(b.name || ''))
                .forEach(([id, provider]) => {
                    d.addOption(id, provider.name || id);
                });

            d.setValue(this.currentProvider || '');
            d.onChange(value => {
                const oldProvider = this.currentProvider;
                this.currentProvider = value || null;
                
                // Only refresh UI if actually changing provider
                if (oldProvider !== this.currentProvider) {
                    // If there are unsaved changes, ask for confirmation
                    if (this.hasUnsavedChanges) {
                        const modal = new Modal(this.plugin.app);
                        modal.titleEl.setText('Unsaved Changes');
                        modal.contentEl.createEl('p', {
                            text: 'You have unsaved changes. Do you want to save them before switching providers?'
                        });
                        
                        const buttonContainer = modal.contentEl.createEl('div', { cls: 'modal-button-container' });
                        
                        // Save button
                        buttonContainer.createEl('button', {
                            text: 'Save',
                            cls: 'mod-cta'
                        }).addEventListener('click', async () => {
                            try {
                                if (this.providerSettingsView) {
                                    await this.providerSettingsView.validateSettings();
                                }
                                await this.plugin.saveData(this.plugin.settings);
                                this.hasUnsavedChanges = false;
                                this.hideActionButtons();
                                this.switchProvider(value);
                                new Notice('Provider settings saved');
                            } catch (error) {
                                console.error('Failed to save provider settings:', error);
                                new Notice('Error saving settings: ' + (error instanceof Error ? error.message : 'Unknown error'));
                                // Revert dropdown selection
                                d.setValue(oldProvider || '');
                                this.currentProvider = oldProvider;
                            }
                            modal.close();
                        });
                        
                        // Discard button
                        buttonContainer.createEl('button', {
                            text: 'Discard',
                            cls: 'mod-warning'
                        }).addEventListener('click', () => {
                            this.hasUnsavedChanges = false;
                            this.hideActionButtons();
                            this.switchProvider(value);
                            modal.close();
                        });
                        
                        // Cancel button
                        buttonContainer.createEl('button', {
                            text: 'Cancel',
                            cls: 'mod-secondary'
                        }).addEventListener('click', () => {
                            // Revert dropdown selection
                            d.setValue(oldProvider || '');
                            this.currentProvider = oldProvider;
                            modal.close();
                        });
                        
                        modal.open();
                    } else {
                        this.switchProvider(value);
                    }
                }
            });

            return d;
        });

        // Add buttons container for add/delete in the provider selector area
        const buttonsContainer = dropdownContainer.controlEl.createEl('div', { cls: 'flare-provider-buttons' });
        
        // Add new provider button
        const addButton = buttonsContainer.createEl('button', {
            cls: 'clickable-icon',
            attr: { 'aria-label': 'Add new provider' }
        });
        setIcon(addButton, 'plus');

        // Add delete button
        const deleteButton = buttonsContainer.createEl('button', {
            cls: 'clickable-icon',
            attr: { 'aria-label': 'Delete provider' }
        });
        setIcon(deleteButton, 'trash');
        if (!this.currentProvider) {
            deleteButton.addClass('disabled');
        }

        // Add event handlers for add/delete buttons
        if (dropdown) {
            this.setupAddDeleteHandlers(addButton, deleteButton, dropdown);
        }
    }

    private createProviderTypeDropdown(container: HTMLElement): void {
        if (!this.currentProvider) {
            container.style.display = 'none';
            return;
        }

        const provider = this.plugin.settings.providers[this.currentProvider];
        if (!provider) return;

        container.style.display = 'block';
        new Setting(container)
            .setName('Provider type')
            .setDesc('Select the type of provider')
            .addDropdown(dropdown => {
                // Add provider type options
                dropdown.addOption('', 'Select a type...');
                
                // Define available provider types
                const providerTypes = {
                    'openai': 'OpenAI',
                    'openrouter': 'OpenRouter',
                    'ollama': 'Ollama'
                };
                
                Object.entries(providerTypes)
                    .forEach(([type, label]) => {
                        dropdown.addOption(type, label);
                    });

                // Set current value
                dropdown.setValue(provider.type || '');

                dropdown.onChange(async value => {
                    if (!this.currentProvider) return;
                    
                    // Store old type to check if this is a new provider
                    const oldType = this.plugin.settings.providers[this.currentProvider].type;
                    const isNewProvider = !oldType;
                    
                    // Set default base URLs based on provider type
                    switch (value) {
                        case 'ollama':
                            this.plugin.settings.providers[this.currentProvider].baseUrl = 'http://localhost:11434';
                            break;
                        case 'openai':
                            this.plugin.settings.providers[this.currentProvider].baseUrl = 'https://api.openai.com/v1';
                            break;
                        case 'openrouter':
                            this.plugin.settings.providers[this.currentProvider].baseUrl = 'https://openrouter.ai/api/v1';
                            break;
                    }
                    
                    this.plugin.settings.providers[this.currentProvider].type = value;
                    
                    // Skip the provider change callback since the display() call below will handle it
                    this.display(); // Refresh the UI to show appropriate settings
                    this.showActionButtons(); // Always show action buttons on type change
                });

                return dropdown;
            });
    }

    private setupAddDeleteHandlers(addButton: HTMLElement, deleteButton: HTMLElement, dropdown: DropdownComponent): void {
        // Add event handlers
        addButton.addEventListener('click', () => {
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
            this.onProviderChange(id);
            this.display();
        });

        deleteButton.addEventListener('click', async () => {
            if (!this.currentProvider) return;
            
            const providerName = this.plugin.settings.providers[this.currentProvider].name || this.currentProvider;
            
            // Show confirmation dialog
            const modal = new Modal(this.plugin.app);
            modal.titleEl.setText('Delete provider');
            modal.contentEl.createEl('p', {
                text: `Are you sure you want to delete the provider "${providerName}"? This action cannot be undone.`
            });
            
            // Add buttons container
            const buttonContainer = modal.contentEl.createEl('div', { cls: 'modal-button-container' });
            
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
                
                // Reset selection and refresh UI
                this.currentProvider = null;
                this.display();
                
                new Notice(`Provider "${providerName}" deleted`);
                modal.close();
            });
            
            modal.open();
        });
    }

    private showActionButtons(): void {
        if (this.actionButtons) {
            this.actionButtons.classList.add('is-visible');
        }
    }

    private hideActionButtons(): void {
        if (this.actionButtons) {
            this.actionButtons.classList.remove('is-visible');
        }
    }

    private handleSettingsChange = (): void => {
        // Compare current settings with original to determine if there are actual changes
        const currentProviderSettings = this.currentProvider ? 
            this.plugin.settings.providers[this.currentProvider] : null;
        const originalProviderSettings = this.currentProvider && this.originalSettings.providers ? 
            this.originalSettings.providers[this.currentProvider] : null;

        if (currentProviderSettings && originalProviderSettings) {
            const hasChanges = JSON.stringify(currentProviderSettings) !== JSON.stringify(originalProviderSettings);
            
            if (hasChanges !== this.hasUnsavedChanges) {
                this.hasUnsavedChanges = hasChanges;
                if (hasChanges) {
                    this.showActionButtons();
                } else {
                    this.hideActionButtons();
                }
            }
        }
    };

    private switchProvider(value: string | null): void {
        this.onProviderChange(this.currentProvider);
        // Store current settings before display refresh
        if (this.currentProvider) {
            this.originalSettings = JSON.parse(JSON.stringify(this.plugin.settings));
            this.hasUnsavedChanges = false; // Reset unsaved changes flag
            this.hideActionButtons(); // Hide action buttons when switching
        }
        this.display(); // Refresh the entire UI
    }

    refreshDropdown(): void {
        const dropdown = this.providerDropdown;
        if (!dropdown) return;
        // Clear current dropdown options
        if (dropdown.selectEl) {
            dropdown.selectEl.innerHTML = '';
        }
        // Add placeholder option
        dropdown.addOption('', 'Select a provider...');
        // Add all providers from settings, sorted alphabetically
        Object.entries(this.plugin.settings.providers)
            .sort(([, a], [, b]) => (a.name || '').localeCompare(b.name || ''))
            .forEach(([id, provider]) => {
                dropdown.addOption(id, provider.name || id);
            });
        // Reset the dropdown's value to currentProvider, if any
        dropdown.setValue(this.currentProvider || '');
    }
} 