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
        const providersSection = this.container.createEl('div', { cls: 'providers-section' });

        // Provider selector with add/remove buttons
        const selectorContainer = providersSection.createEl('div', { cls: 'provider-selector' });
        const dropdownContainer = new Setting(selectorContainer)
            .setName('Provider')
            .setDesc('Select a provider to configure');

        // Create the dropdown
        const dropdown = new DropdownComponent(dropdownContainer.controlEl);
        dropdown.selectEl.addClass('provider-dropdown');
        
        // Add placeholder option
        dropdown.addOption('', 'Choose provider to configure...');
        
        // Add existing providers
        Object.entries(this.plugin.settings.providers)
            .sort(([, a], [, b]) => (a.name || '').localeCompare(b.name || ''))
            .forEach(([id, provider]) => {
                dropdown.addOption(id, provider.name || id);
            });

        // Add buttons container
        const buttonsContainer = dropdownContainer.controlEl.createEl('div', { cls: 'provider-buttons' });
        
        // Add new provider button
        const addButton = buttonsContainer.createEl('button', {
            cls: 'clickable-icon',
            attr: { 'aria-label': 'Add new provider' }
        });
        setIcon(addButton, 'plus');
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
            if (deleteButton) deleteButton.removeClass('disabled');
        });

        // Add delete button
        const deleteButton = buttonsContainer.createEl('button', {
            cls: 'clickable-icon',
            attr: { 'aria-label': 'Delete provider' }
        });
        setIcon(deleteButton, 'trash');
        if (!this.currentProvider) {
            deleteButton.addClass('disabled');
        }
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
            const cancelBtn = buttonContainer.createEl('button', {
                text: 'Cancel',
                cls: 'mod-secondary'
            });
            cancelBtn.addEventListener('click', () => {
                modal.close();
            });
            
            // Delete button
            const deleteBtn = buttonContainer.createEl('button', {
                text: 'Delete',
                cls: 'mod-warning'
            });
            deleteBtn.addEventListener('click', async () => {
                // Remove from settings
                delete this.plugin.settings.providers[this.currentProvider!];
                await this.plugin.saveData(this.plugin.settings);
                
                // Remove from dropdown
                const option = dropdown.selectEl.querySelector(`option[value="${this.currentProvider}"]`);
                if (option) option.remove();
                
                // Reset selection
                this.currentProvider = null;
                dropdown.setValue('');
                this.onProviderChange(null);
                
                // Disable delete button
                deleteButton.addClass('disabled');
                
                new Notice(`Provider "${providerName}" deleted`);
                modal.close();
            });
            
            modal.open();
        });

        // Set initial value and handle changes
        dropdown.setValue(this.currentProvider || '');
        dropdown.onChange(value => {
            this.currentProvider = value || null;
            this.onProviderChange(this.currentProvider);
            // Update delete button state
            deleteButton.toggleClass('disabled', !value);
        });
    }
} 