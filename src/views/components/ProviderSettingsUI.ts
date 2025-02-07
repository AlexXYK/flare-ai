import { Setting, DropdownComponent, Modal, Notice, setIcon } from 'obsidian';
import type FlarePlugin from '../../../main';
import type { ProviderSettings } from '../../types/AIProvider';

export class ProviderSettingsUI {
    private currentProvider: string | null = null;

    constructor(
        private plugin: FlarePlugin,
        private container: HTMLElement,
        private onProviderChange: (providerId: string | null) => void
    ) {}

    display(): void {
        // Store original settings for revert
        const originalSettings = JSON.parse(JSON.stringify(this.plugin.settings));

        // Provider selector with add/remove buttons
        const selectorContainer = this.container.createEl('div', { cls: 'flare-provider-selector' });
        let dropdownRef: DropdownComponent;
        const dropdownContainer = new Setting(selectorContainer)
            .setName('Active provider')
            .setDesc('Select a provider to configure')
            .addDropdown(dropdown => {
                dropdownRef = dropdown;
                // Add placeholder option
                dropdown.addOption('', 'Select a provider...');
                
                // Add existing providers
                Object.entries(this.plugin.settings.providers)
                    .sort(([, a], [, b]) => (a.name || '').localeCompare(b.name || ''))
                    .forEach(([id, provider]) => {
                        dropdown.addOption(id, provider.name || id);
                    });

                dropdown.setValue(this.currentProvider || '');
                dropdown.onChange(value => {
                    this.currentProvider = value || null;
                    this.onProviderChange(this.currentProvider);
                    // Update delete button state
                    if (!value) {
                        deleteButton.addClass('disabled');
                    } else {
                        deleteButton.removeClass('disabled');
                    }
                    // Update provider type dropdown
                    updateProviderType();
                });

                return dropdown;
            });

        // Add buttons container
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

        // Add provider type setting
        const providerTypeContainer = selectorContainer.createEl('div', { cls: 'provider-type-setting' });
        let providerTypeDropdown: DropdownComponent;
        const providerTypeSetting = new Setting(providerTypeContainer)
            .setName('Provider type')
            .setDesc('Select the type of provider')
            .addDropdown(dropdown => {
                providerTypeDropdown = dropdown;
                // Add provider type options
                dropdown.addOption('', 'Select a type...');
                
                // Define available provider types
                const providerTypes = {
                    'openai': 'OpenAI',
                    'openrouter': 'OpenRouter',
                    'ollama': 'Ollama'
                };
                
                // Always add provider types without filtering so that new providers can choose any type
                Object.entries(providerTypes)
                    .forEach(([type, label]) => {
                        dropdown.addOption(type, label);
                    });

                dropdown.onChange(async value => {
                    if (!this.currentProvider) return;
                    this.plugin.settings.providers[this.currentProvider].type = value;
                    showActionButtons();
                    // Trigger provider change to update the settings view
                    this.onProviderChange(this.currentProvider);
                });

                return dropdown;
            });

        // Add action buttons container
        const actionButtons = selectorContainer.createEl('div', { cls: 'flare-form-actions' });
        new Setting(actionButtons)
            .addButton(button => {
                button
                    .setButtonText('Save')
                    .setCta()
                    .onClick(async () => {
                        await this.plugin.saveData(this.plugin.settings);
                        hideActionButtons();
                        new Notice('Provider settings saved');
                    });
            })
            .addButton(button => {
                button
                    .setButtonText('Revert')
                    .onClick(() => {
                        if (!this.currentProvider) return;
                        // Restore original provider type
                        const originalProvider = originalSettings.providers[this.currentProvider];
                        if (originalProvider) {
                            this.plugin.settings.providers[this.currentProvider].type = originalProvider.type;
                            providerTypeDropdown.setValue(originalProvider.type || '');
                        }
                        hideActionButtons();
                        new Notice('Provider settings reverted');
                    });
            });

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
            dropdownRef.addOption(id, 'New Provider');
            dropdownRef.setValue(id);
            this.currentProvider = id;
            this.onProviderChange(id);
            updateProviderType();
            deleteButton.removeClass('disabled');
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
                
                // Remove from dropdown
                const option = dropdownRef.selectEl.querySelector(`option[value="${this.currentProvider}"]`);
                if (option) option.remove();
                
                // Reset selection
                this.currentProvider = null;
                dropdownRef.setValue('');
                this.onProviderChange(null);
                
                // Disable delete button
                deleteButton.addClass('disabled');
                
                new Notice(`Provider "${providerName}" deleted`);
                modal.close();
            });
            
            modal.open();
        });

        const showActionButtons = () => {
            actionButtons.addClass('is-visible');
        };

        const hideActionButtons = () => {
            actionButtons.removeClass('is-visible');
        };

        const updateProviderType = () => {
            if (!this.currentProvider) {
                providerTypeContainer.removeClass('is-visible');
                hideActionButtons();
                return;
            }

            const provider = this.plugin.settings.providers[this.currentProvider];
            providerTypeContainer.addClass('is-visible');
            providerTypeDropdown.setValue(provider.type || '');
            hideActionButtons();
        };
    }
} 