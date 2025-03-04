import { Setting, DropdownComponent, Modal, Notice, setIcon, setTooltip } from 'obsidian';
import type FlarePlugin from '../../../main';
import type { ProviderSettings } from '../../types/AIProvider';
import { ProviderSettingsView } from './ProviderSettingsView';

// CSS class constants for consistency
const CSS_CLASSES = {
    DISABLED: 'disabled',
    VISIBLE: 'is-visible',
    FORM_ACTIONS: 'flare-form-actions',
    PROVIDER_BUTTONS: 'flare-provider-buttons',
    HIGHLIGHTED: 'is-highlighted'
};

export class ProviderSettingsUI {
    private currentProvider: string | null = null;
    private providerDropdown: DropdownComponent | null = null;
    private originalSettings: any;
    private actionButtons: HTMLElement | null = null;
    private providerSettingsView: ProviderSettingsView | null = null;
    private hasUnsavedChanges: boolean = false;
    private eventHandlers: Array<{element: HTMLElement, type: string, handler: EventListener}> = [];

    constructor(
        private plugin: FlarePlugin,
        private container: HTMLElement,
        private onProviderChange: (providerId: string | null) => void
    ) {
        // Store original settings for revert
        this.originalSettings = JSON.parse(JSON.stringify(this.plugin.settings));
    }

    display(): void {
        // Clean up any existing event handlers
        this.cleanup();
        
        // Clear container
        this.container.empty();
 
        // Add Providers heading
        new Setting(this.container)
            .setName('Providers')
            .setHeading();

        // Create provider selector
        const dropdownContainer = new Setting(this.container)
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
            d.onChange(value => this.handleProviderChange(value, d));
        });

        // Add buttons container for add/delete in the provider selector area
        const buttonsContainer = dropdownContainer.controlEl.createEl('div', { 
            cls: CSS_CLASSES.PROVIDER_BUTTONS
        });
        setTooltip(buttonsContainer, 'Provider actions');
        
        // Add new provider button
        const addButton = buttonsContainer.createEl('button', {
            cls: 'clickable-icon',
            attr: {
                'role': 'button'
            }
        });
        setIcon(addButton, 'plus');
        setTooltip(addButton, 'Add new provider');

        // Delete provider button
        const deleteButton = buttonsContainer.createEl('button', {
            cls: 'clickable-icon',
            attr: {
                'role': 'button'
            }
        });
        setIcon(deleteButton, 'trash');
        setTooltip(deleteButton, 'Delete provider');
        
        // Set disabled state based on current provider
        if (!this.currentProvider) {
            deleteButton.addClass(CSS_CLASSES.DISABLED);
            deleteButton.setAttribute('aria-disabled', 'true');
        }

        // Add event handlers for add/delete buttons
        if (dropdown) {
            this.setupAddDeleteHandlers(addButton, deleteButton, dropdown);
        }

        // Create action buttons container
        this.actionButtons = this.container.createEl('div', { 
            cls: CSS_CLASSES.FORM_ACTIONS,
            attr: { 'aria-hidden': 'true' }
        });
        
        // Add save/revert buttons
        new Setting(this.actionButtons)
            .addButton(button => {
                button
                    .setButtonText('Save')
                    .setCta()
                    .setDisabled(!this.currentProvider)
                    .onClick(async () => {
                        try {
                            if (this.providerSettingsView) {
                                // Get the selected provider type from the dropdown before validation
                                const typeDropdown = this.container.querySelector('select[data-setting="provider-type"]');
                                if (typeDropdown instanceof HTMLSelectElement && typeDropdown.value && this.currentProvider) {
                                    // Get current provider settings to check if type has changed
                                    const currentSettings = this.plugin.settings.providers[this.currentProvider];
                                    const currentName = currentSettings.name;
                                    
                                    // Only update provider type if it's actually different to avoid resetting baseUrl
                                    if (!currentSettings.type || currentSettings.type !== typeDropdown.value) {
                                        // Ensure the working settings have the correct type
                                        this.providerSettingsView.updateProviderType(typeDropdown.value);
                                        
                                        // Explicitly preserve the original name
                                        if (currentName) {
                                            this.providerSettingsView.preserveName(currentName);
                                        }
                                    }
                                }
                                
                                await this.providerSettingsView.validateSettings();
                                
                                // Call our centralized save method instead of doing everything inline
                                await this.saveSettings();
                            }
                        } catch (error) {
                            console.error('Failed to save provider settings:', error);
                            new Notice('Error saving settings: ' + (error instanceof Error ? error.message : 'Unknown error'));
                        }
                    });
            })
            .addButton(button => {
                button
                    .setButtonText('Revert')
                    .setDisabled(!this.currentProvider)
                    .onClick(() => {
                        this.revertChanges();
                    });
            });

        // Create provider type setting
        new Setting(this.container)
            .setName('Provider type')
            .setDesc('Select the type of provider')
            .setDisabled(!this.currentProvider)
            .addDropdown(dropdown => {
                // Add provider type options
                dropdown.addOption('', 'Select a type...');
                
                // Define available provider types
                const providerTypes = {
                    'openai': 'OpenAI',
                    'openrouter': 'OpenRouter',
                    'ollama': 'Ollama',
                    'anthropic': 'Anthropic',
                    'gemini': 'Google Gemini'
                };
                
                Object.entries(providerTypes)
                    .forEach(([type, label]) => {
                        dropdown.addOption(type, label);
                    });

                // Add data attribute for selection
                if (dropdown.selectEl) {
                    dropdown.selectEl.setAttribute('data-setting', 'provider-type');
                    setTooltip(dropdown.selectEl, 'Provider type');
                }

                // Set current value if we have a provider
                if (this.currentProvider) {
                    const provider = this.plugin.settings.providers[this.currentProvider];
                    dropdown.setValue(provider.type || '');
                }

                dropdown.onChange(async value => {
                    if (!this.currentProvider) return;
                    
                    // Store current provider settings to preserve important values
                    const currentProviderSettings = this.plugin.settings.providers[this.currentProvider];
                    const currentName = currentProviderSettings.name;
                    
                    // Initialize provider settings view if needed
                    if (!this.providerSettingsView) {
                        this.providerSettingsView = new ProviderSettingsView(
                            this.plugin,
                            this.container,
                            this.currentProvider ? this.plugin.settings.providers[this.currentProvider] : null,
                            async () => {
                                await this.plugin.saveData(this.plugin.settings);
                            },
                            this.handleSettingsChange
                        );
                    }
                    
                    // Make sure to save the name before updating type
                    if (currentName) {
                        // Store name in provider settings directly to ensure it's preserved
                        if (this.plugin.settings.providers[this.currentProvider]) {
                            this.plugin.settings.providers[this.currentProvider].name = currentName;
                        }
                    }
                    
                    // Update the type and default URLs in the working copy
                    this.providerSettingsView.updateProviderType(value);
                    
                    // Ensure the name is preserved after type change
                    if (this.providerSettingsView && currentName) {
                        // Set the name explicitly in working settings
                        this.providerSettingsView.preserveName(currentName);
                    }
                    
                    // Completely redraw the UI to ensure all fields are properly enabled/disabled
                    this.container.empty();
                    this.display();
                    
                    // Check one more time after redraw to make sure name is preserved
                    if (this.providerSettingsView && currentName) {
                        this.providerSettingsView.preserveName(currentName);
                    }
                    
                    // Always show action buttons on type change
                    this.hasUnsavedChanges = true;
                    this.showActionButtons();
                });
            });

        // Create provider settings view
        this.providerSettingsView = new ProviderSettingsView(
            this.plugin,
            this.container,
            this.currentProvider ? this.plugin.settings.providers[this.currentProvider] : null,
            async () => {
                await this.plugin.saveData(this.plugin.settings);
            },
            this.handleSettingsChange
        );
        this.providerSettingsView.display();
    }

    private setupAddDeleteHandlers(addButton: HTMLElement, deleteButton: HTMLElement, dropdown: DropdownComponent): void {
        // Add event handlers
        const addHandler = async () => {
            try {
                const providerName = this.getNextAvailableProviderName();
                
                // Create a more consistent ID based on the provider name
                // This will make IDs more predictable across devices
                const sanitizedName = providerName.toLowerCase().replace(/[^a-z0-9]/g, '_');
                const id = `provider_${sanitizedName}`;
                
                // If there's an ID conflict, add a timestamp
                let providerId: string;
                if (this.plugin.settings.providers[id]) {
                    const uniqueId = `${id}_${Date.now()}`;
                    this.plugin.settings.providers[uniqueId] = {
                        name: providerName,
                        type: '',
                        enabled: true,
                        visibleModels: []
                    };
                    providerId = uniqueId;
                } else {
                    // No conflict, use the name-based ID
                    this.plugin.settings.providers[id] = {
                        name: providerName,
                        type: '',
                        enabled: true,
                        visibleModels: []
                    };
                    providerId = id;
                }
                
                // Immediately save when adding a new provider
                await this.plugin.saveData(this.plugin.settings);
                
                // Update dropdown with new provider
                dropdown.addOption(providerId, providerName);
                dropdown.setValue(providerId);
                
                // Store the current provider ID
                this.currentProvider = providerId;
                
                // First fully commit this change to the plugin settings
                // Update original settings after save
                this.originalSettings = JSON.parse(JSON.stringify(this.plugin.settings));
                
                // Instead of calling display(), directly create a provider settings view
                // This avoids resetting the UI state
                this.createProviderSettingsView();
                
                // Force the action buttons to be visible for newly created providers
                this.hasUnsavedChanges = true;
                this.showActionButtons();
                
                // Finally notify about provider change
                this.onProviderChange(providerId);
                
                // Show a notification that the provider was created and explain next steps
                new Notice(`Provider "${providerName}" created. Select a provider type and configure settings, then click Save.`, 8000);
            } catch (error) {
                console.error('Failed to add new provider:', error);
                new Notice('Failed to add new provider');
            }
        };
        this.addEventHandler(addButton, 'click', addHandler as EventListener);

        const deleteHandler = async () => {
            if (!this.currentProvider) return;
            
            const providerName = this.plugin.settings.providers[this.currentProvider].name || this.currentProvider;
            
            // Show confirmation dialog
            const modal = new Modal(this.plugin.app);
            modal.titleEl.setText('Delete provider');
            modal.contentEl.createEl('p', {
                text: `Are you sure you want to delete the provider "${providerName}"? This action cannot be undone.`,
                attr: { 'aria-live': 'polite' }
            });
            
            // Add buttons container
            const buttonContainer = modal.contentEl.createEl('div', { 
                cls: 'modal-button-container',
                attr: { 'role': 'group' }
            });
            setTooltip(buttonContainer, 'Confirmation actions');
            
            // Cancel button
            const cancelButton = buttonContainer.createEl('button', {
                text: 'Cancel',
                cls: 'mod-secondary'
            });
            setTooltip(cancelButton, 'Cancel deletion');
            this.addEventHandler(cancelButton, 'click', () => {
                modal.close();
            });
            
            // Delete button
            const confirmButton = buttonContainer.createEl('button', {
                text: 'Delete',
                cls: 'mod-warning'
            });
            setTooltip(confirmButton, 'Confirm deletion');
            this.addEventHandler(confirmButton, 'click', async () => {
                // Remove from settings
                delete this.plugin.settings.providers[this.currentProvider!];
                await this.plugin.saveData(this.plugin.settings);
                
                // Update original settings after deletion and save
                this.originalSettings = JSON.parse(JSON.stringify(this.plugin.settings));
                
                // Reset selection and refresh UI
                this.currentProvider = null;
                this.hasUnsavedChanges = false;
                this.display();
                
                new Notice(`Provider "${providerName}" deleted`);
                modal.close();
            });
            
            modal.open();
        };
        this.addEventHandler(deleteButton, 'click', deleteHandler as EventListener);
    }

    private showActionButtons(): void {
        if (this.actionButtons) {
            this.actionButtons.addClass(CSS_CLASSES.VISIBLE);
            this.actionButtons.setAttribute('aria-hidden', 'false');
        }
    }

    private hideActionButtons(): void {
        if (this.actionButtons) {
            this.actionButtons.removeClass(CSS_CLASSES.VISIBLE);
            this.actionButtons.setAttribute('aria-hidden', 'true');
        }
    }

    private handleSettingsChange = (): void => {
        // Check if provider settings view reports changes
        if (this.providerSettingsView) {
            const hasChanges = this.providerSettingsView.isSettingsChanged();
            
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
        // Set current provider value first before calling onProviderChange
        const oldProvider = this.currentProvider;
        this.currentProvider = value;
        
        // Notify about provider change
        this.onProviderChange(value);
        
        // Store current settings before display refresh
        if (oldProvider) {
            this.originalSettings = JSON.parse(JSON.stringify(this.plugin.settings));
            this.hasUnsavedChanges = false; // Reset unsaved changes flag
            this.hideActionButtons(); // Hide action buttons when switching
        }
        
        // Get current provider settings BEFORE redisplaying
        let currentType = '';
        if (value && this.plugin.settings.providers[value]) {
            currentType = this.plugin.settings.providers[value].type || '';
        }
        
        // Full UI refresh to ensure correct state
        this.container.empty();
        this.display(); 
        
        // Verify provider type after refresh with a more robust approach
        if (this.currentProvider && currentType) {
            // Immediately try to set the provider type dropdown
            const typeDropdown = this.container.querySelector('select[data-setting="provider-type"]');
            if (typeDropdown instanceof HTMLSelectElement) {
                typeDropdown.value = currentType;
            }
            
            // Also set it after a delay to ensure it takes effect after async operations
            setTimeout(() => {
                const delayedTypeDropdown = this.container.querySelector('select[data-setting="provider-type"]');
                if (delayedTypeDropdown instanceof HTMLSelectElement && currentType && delayedTypeDropdown.value !== currentType) {
                    // First check if the option exists
                    const optionExists = Array.from(delayedTypeDropdown.options).some(opt => opt.value === currentType);
                    
                    if (optionExists) {
                        delayedTypeDropdown.value = currentType;
                        
                        // Trigger change event to ensure all dependent UI is updated
                        const changeEvent = new Event('change', { bubbles: true });
                        delayedTypeDropdown.dispatchEvent(changeEvent);
                    }
                }
            }, 50);
        }
    }

    refreshDropdown(): void {
        const dropdown = this.providerDropdown;
        if (!dropdown) return;
        // Clear current dropdown options
        if (dropdown.selectEl) {
            dropdown.selectEl.empty();
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

    private revertChanges(): void {
        try {
            // Don't modify plugin.settings directly, just recreate the provider view
            this.display();
            this.hideActionButtons();
            this.hasUnsavedChanges = false;
            new Notice('Provider settings reverted');
        } catch (error) {
            console.error('Failed to revert provider settings:', error);
            new Notice('Failed to revert settings');
        }
    }

    private handleProviderChange(value: string, dropdown: DropdownComponent): void {
        const oldProvider = this.currentProvider;
        this.currentProvider = value || null;
        
        // Only refresh UI if actually changing provider
        if (oldProvider !== this.currentProvider) {
            // If there are unsaved changes, ask for confirmation
            if (this.hasUnsavedChanges) {
                const modal = new Modal(this.plugin.app);
                modal.titleEl.setText('Unsaved Changes');
                modal.contentEl.createEl('p', {
                    text: 'You have unsaved changes. Do you want to save them before switching providers?',
                    attr: { 'aria-live': 'polite' }
                });
                
                const buttonContainer = modal.contentEl.createEl('div', { 
                    cls: 'modal-button-container',
                    attr: { 'role': 'group' }
                });
                setTooltip(buttonContainer, 'Confirmation actions');
                
                // Save button
                const saveButton = buttonContainer.createEl('button', {
                    text: 'Save',
                    cls: 'mod-cta'
                });
                setTooltip(saveButton, 'Save changes');
                this.addEventHandler(saveButton, 'click', async () => {
                    try {
                        if (this.providerSettingsView) {
                            await this.providerSettingsView.validateSettings();
                            // Commit the working settings to the actual settings object
                            this.providerSettingsView.commitSettings();
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
                        dropdown.setValue(oldProvider || '');
                        this.currentProvider = oldProvider;
                    }
                    modal.close();
                });
                
                // Discard button
                const discardButton = buttonContainer.createEl('button', {
                    text: 'Discard',
                    cls: 'mod-warning'
                });
                setTooltip(discardButton, 'Discard changes');
                this.addEventHandler(discardButton, 'click', () => {
                    this.hasUnsavedChanges = false;
                    this.hideActionButtons();
                    this.switchProvider(value);
                    modal.close();
                });
                
                // Cancel button
                const cancelButton = buttonContainer.createEl('button', {
                    text: 'Cancel',
                    cls: 'mod-secondary'
                });
                setTooltip(cancelButton, 'Cancel');
                this.addEventHandler(cancelButton, 'click', () => {
                    // Revert dropdown selection
                    dropdown.setValue(oldProvider || '');
                    this.currentProvider = oldProvider;
                    modal.close();
                });
                
                modal.open();
            } else {
                this.switchProvider(value);
            }
        }
    }

    /**
     * Adds an event handler and tracks it for cleanup
     */
    private addEventHandler(element: HTMLElement, type: string, handler: EventListener): void {
        element.addEventListener(type, handler);
        this.eventHandlers.push({element, type, handler});
    }

    /**
     * Cleans up registered event handlers
     */
    private cleanup(): void {
        this.eventHandlers.forEach(({element, type, handler}) => {
            element.removeEventListener(type, handler);
        });
        this.eventHandlers = [];
    }

    /**
     * Gets the next available provider name
     * Follows a pattern like "New Provider", "New Provider2", "New Provider3", etc.
     */
    private getNextAvailableProviderName(): string {
        const baseName = "New Provider";
        
        // Get all existing provider names
        const existingNames = Object.values(this.plugin.settings.providers)
            .map(provider => provider.name || '');
        
        // If no provider with baseName exists, return baseName
        if (!existingNames.includes(baseName)) {
            return baseName;
        }
        
        // Find the highest number suffix
        let maxNumber = 1;
        const regex = new RegExp(`^${baseName}(\\d+)$`);
        
        existingNames.forEach(name => {
            const match = name.match(regex);
            if (match) {
                const num = parseInt(match[1]);
                if (!isNaN(num) && num >= maxNumber) {
                    maxNumber = num + 1;
                }
            }
        });
        
        return `${baseName}${maxNumber}`;
    }

    /**
     * Saves the current provider settings
     */
    private async saveSettings(): Promise<void> {
        try {
            if (!this.currentProvider || !this.providerSettingsView) {
                new Notice('No provider selected to save');
                return;
            }
            
            // First commit working settings to the provider object
            this.providerSettingsView.commitSettings();
            
            // Ensure the provider has a type selected - can't save without it
            const currentSettings = this.plugin.settings.providers[this.currentProvider];
            if (!currentSettings.type) {
                new Notice('Please select a provider type before saving', 4000);
                
                // Make sure the type dropdown is highlighted/focused
                const typeDropdown = this.container.querySelector('select[data-setting="provider-type"]');
                if (typeDropdown instanceof HTMLSelectElement) {
                    typeDropdown.focus();
                    typeDropdown.classList.add(CSS_CLASSES.HIGHLIGHTED);
                    
                    // Remove highlight after a delay
                    setTimeout(() => {
                        typeDropdown.classList.remove(CSS_CLASSES.HIGHLIGHTED);
                    }, 3000);
                }
                return;
            }
            
            // Update original settings to reflect current state
            this.providerSettingsView.updateOriginalSettings();
            
            // Save to plugin settings
            await this.plugin.saveData(this.plugin.settings);
            
            // Reset the change flag
            this.hasUnsavedChanges = false;
            
            // Hide action buttons
            this.hideActionButtons();
            
            // Update the provider name in the dropdown
            if (this.providerDropdown && currentSettings.name) {
                // Get option element for this provider
                const option = this.providerDropdown.selectEl.querySelector(`option[value="${this.currentProvider}"]`);
                if (option) {
                    // Update the text content of the option
                    option.textContent = currentSettings.name;
                }
            }
            
            // Refresh related components
            if (this.plugin.flareManager) {
                this.plugin.flareManager.refreshProviderDropdowns();
            }
            if (this.plugin.settingTab) {
                this.plugin.settingTab.refreshTitleProviderDropdowns();
            }
            
            // Show success notification
            new Notice(`Provider "${currentSettings.name}" settings saved`);
            
            // Make sure to update the original settings snapshot
            this.originalSettings = JSON.parse(JSON.stringify(this.plugin.settings));
        } catch (error) {
            console.error('Failed to save provider settings:', error);
            new Notice('Failed to save settings');
        }
    }

    /**
     * Creates the provider settings view for the current provider
     * This is separate from display() to allow better control of when the view is created
     */
    private createProviderSettingsView(): void {
        if (!this.currentProvider) {
            console.warn('Cannot create provider settings view: No provider selected');
            return;
        }
        
        // Create provider settings view
        this.providerSettingsView = new ProviderSettingsView(
            this.plugin,
            this.container,
            this.plugin.settings.providers[this.currentProvider],
            async () => {
                await this.plugin.saveData(this.plugin.settings);
            },
            this.handleSettingsChange
        );
        
        // Display the view
        this.providerSettingsView.display();
    }
} 