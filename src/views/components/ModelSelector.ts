import { setIcon } from 'obsidian';
import type FlarePlugin from '../../../main';
import { FlareConfig } from '../../flares/FlareConfig';
import { TempDialog } from './TempDialog';

/**
 * Settings for model selection
 */
interface ModelSelectorSettings {
    provider: string;
    model: string;
    temperature: number;
}

/**
 * Provider information structure
 */
interface ProviderInfo {
    name: string;
    type: string;
    enabled: boolean;
    visibleModels?: string[];
}

/**
 * UI component for selecting AI models and temperature
 */
export class ModelSelector {
    private settingsBarEl!: HTMLElement;
    private dropupEl: HTMLElement | null = null;
    private isActive = false;
    private currentSettings: ModelSelectorSettings;
    private onSettingsChange: (settings: ModelSelectorSettings) => void;
    private modelButton: HTMLDivElement | null = null;
    private modelNameEl!: HTMLSpanElement;
    private plugin: FlarePlugin;
    private footerLeftEl: HTMLElement | null = null;
    private footerRightEl: HTMLElement | null = null;
    private clickHandler: () => void;
    private boundHandleResize: () => void;
    private eventListeners: Array<{el: HTMLElement, type: string, listener: EventListenerOrEventListenerObject}> = [];

    constructor(
        private containerEl: HTMLElement,
        plugin: FlarePlugin,
        initialSettings: ModelSelectorSettings,
        onChange: (settings: ModelSelectorSettings) => void
    ) {
        this.plugin = plugin;
        this.currentSettings = { ...initialSettings };
        this.onSettingsChange = onChange;
        this.clickHandler = this.showModelMenu.bind(this);
        this.boundHandleResize = this.updateDropupPosition.bind(this);
        this.createUI();
    }

    /**
     * Truncates model name for display
     */
    private truncateModelName(name: string): string {
        const maxLength = 30;
        if (!name || typeof name !== 'string') return '--';
        if (name.length <= maxLength) return name;
        const start = name.slice(0, 10);
        const end = name.slice(-20);
        return `${start}...${end}`;
    }

    /**
     * Creates the UI components
     */
    private createUI() {
        try {
            // Clean up any existing UI elements
            this.cleanup();

            // Find or create footer elements
            this.footerLeftEl = this.containerEl.querySelector('.flare-footer-left');
            this.footerRightEl = this.containerEl.querySelector('.flare-footer-right');

            // Create them if they don't exist
            if (!this.footerLeftEl) {
                this.footerLeftEl = this.containerEl.createDiv('flare-footer-left');
            }
            if (!this.footerRightEl) {
                this.footerRightEl = this.containerEl.createDiv('flare-footer-right');
            }

            // -- Model selector on the left --
            this.modelButton = this.footerLeftEl.createDiv('flare-model-display');
            
            const clickListener = this.clickHandler as EventListener;
            this.modelButton.addEventListener('click', clickListener);
            this.eventListeners.push({
                el: this.modelButton,
                type: 'click',
                listener: clickListener
            });

            const modelIcon = this.modelButton.createSpan('flare-model-icon');
            setIcon(modelIcon, 'cpu');

            this.modelNameEl = this.modelButton.createSpan('flare-model-name');
            this.modelNameEl.setText(this.currentSettings.model ? 
                this.truncateModelName(this.currentSettings.model) : 
                '--');

            // -- Temperature control on the right --
            const tempControl = this.footerRightEl.createDiv('flare-temp-control');
            
            const tempClickListener = (() => {
                try {
                    new TempDialog(
                        this.plugin,
                        this.currentSettings.temperature,
                        (temp) => this.updateSettings({ temperature: temp })
                    ).open();
                } catch (error) {
                    console.error('Error opening temperature dialog:', error);
                }
            }) as EventListener;
            
            tempControl.addEventListener('click', tempClickListener);
            this.eventListeners.push({
                el: tempControl,
                type: 'click',
                listener: tempClickListener
            });

            const tempIcon = tempControl.createSpan('flare-temp-icon');
            setIcon(tempIcon, 'thermometer');

            const tempValue = tempControl.createSpan('flare-temp-value');
            tempValue.setText(this.currentSettings.model && this.currentSettings.temperature !== undefined ? 
                this.currentSettings.temperature.toFixed(2) : 
                '--');
        } catch (error) {
            console.error('Error creating ModelSelector UI:', error);
        }

        // Keep track, e.g. for future checks
        // Ensure footerLeftEl exists before assignment
        if (this.footerLeftEl) {
            this.settingsBarEl = this.footerLeftEl;
        } else {
            // Create a fallback element if footerLeftEl doesn't exist
            this.settingsBarEl = this.containerEl.createDiv('flare-footer-left');
        }
    }

    /**
     * Creates the model selection dropdown
     */
    private createDropup() {
        try {
            // Remove any existing dropup and cleanup
            this.cleanup();

            // Create new dropup
            this.dropupEl = document.body.createDiv('flare-model-dropup');
            
            // Position the dropup above the settings bar
            this.updateDropupPosition();
            
            // Add resize listener for repositioning
            window.addEventListener('resize', this.boundHandleResize);
            this.eventListeners.push({
                el: window as unknown as HTMLElement,
                type: 'resize',
                listener: this.boundHandleResize
            });
            
            // Create provider sections
            if (this.dropupEl && this.plugin.settings.providers) {
                // Group models by provider
                Object.entries(this.plugin.settings.providers).forEach(([providerId, provider]) => {
                    if (!provider.enabled || !this.dropupEl) return;
                    
                    // Check if section already exists
                    const existingSection = this.dropupEl.querySelector(`[data-provider-id="${providerId}"]`);
                    if (existingSection) return;
                    
                    const section = this.dropupEl.createDiv('flare-provider-section');
                    section.dataset.providerId = providerId;
                    
                    // Provider header
                    const header = section.createDiv('flare-provider-header');
                    const icon = header.createDiv('flare-provider-icon');
                    setIcon(icon, this.getProviderIcon(providerId));
                    header.createSpan().setText(provider.name);
                    
                    // Models list
                    const modelList = section.createDiv('flare-model-list');
                    this.loadModels(modelList, providerId, provider);
                });
            }
        } catch (error) {
            console.error('Error creating model dropup:', error);
        }
    }

    /**
     * Updates the position of the dropdown menu
     */
    private updateDropupPosition() {
        if (!this.dropupEl) return;
        
        try {
            const settingsRect = this.containerEl.getBoundingClientRect();
            
            // Add CSS classes for positioning
            this.dropupEl.addClass('flare-model-dropup-positioned');
            
            // Update CSS variables for positioning
            document.documentElement.style.setProperty('--flare-dropdown-bottom', `${window.innerHeight - settingsRect.top + 8}px`);
            document.documentElement.style.setProperty('--flare-dropdown-left', `${settingsRect.left}px`);
            document.documentElement.style.setProperty('--flare-dropdown-width', `${settingsRect.width}px`);
        } catch (error) {
            console.error('Error updating dropup position:', error);
        }
    }

    /**
     * Loads models for a specific provider
     */
    private async loadModels(container: HTMLElement, providerId: string, provider: ProviderInfo) {
        try {
            // Clear existing models first
            container.empty();
            
            const allModels = await this.plugin.getModelsForProvider(provider.type);
            
            // Filter models based on visibility settings
            const visibleModels = provider.visibleModels && provider.visibleModels.length > 0
                ? allModels.filter(model => provider.visibleModels?.includes(model))
                : allModels;

            visibleModels.forEach(model => {
                const option = container.createDiv('flare-model-option');
                if (this.currentSettings.provider === providerId && this.currentSettings.model === model) {
                    option.addClass('is-selected');
                }
                
                option.createSpan().setText(model);
                
                const modelClickListener = (() => {
                    this.updateSettings({
                        provider: providerId,
                        model: model
                    });
                    this.toggleDropup();
                }) as EventListener;
                
                option.addEventListener('click', modelClickListener);
                this.eventListeners.push({
                    el: option,
                    type: 'click',
                    listener: modelClickListener
                });
            });
        } catch (error) {
            console.error('Failed to load models:', error);
            container.createDiv('flare-model-error').setText('Failed to load models');
        }
    }

    /**
     * Toggles the visibility of the dropdown
     */
    private toggleDropup() {
        this.isActive = !this.isActive;
        
        if (this.isActive) {
            this.createDropup();
            
            // Close when clicking outside
            const outsideClickListener = ((e: Event) => {
                const mouseEvent = e as MouseEvent;
                if (this.dropupEl && 
                    !this.dropupEl.contains(mouseEvent.target as Node) && 
                    !this.settingsBarEl.contains(mouseEvent.target as Node)) {
                    this.toggleDropup();
                    document.removeEventListener('click', outsideClickListener);
                }
            }) as EventListener;
            
            // Delay to avoid immediate trigger
            setTimeout(() => {
                document.addEventListener('click', outsideClickListener);
                this.eventListeners.push({
                    el: document as unknown as HTMLElement,
                    type: 'click',
                    listener: outsideClickListener
                });
            }, 0);
        } else {
            this.cleanup();
        }
    }

    /**
     * Updates the current settings
     */
    public updateSettings(newSettings: Partial<ModelSelectorSettings>) {
        try {
            this.currentSettings = { ...this.currentSettings, ...newSettings };
            this.onSettingsChange(this.currentSettings);
            
            // Update the display without recreating the entire UI
            if (this.modelNameEl) {
                this.modelNameEl.setText(this.truncateModelName(this.currentSettings.model));
            }
            
            // Update temperature display if it exists
            const tempValue = this.footerRightEl?.querySelector('.flare-temp-value');
            if (tempValue && typeof this.currentSettings.temperature === 'number') {
                tempValue.setText(this.currentSettings.temperature.toFixed(2));
            }
        } catch (error) {
            console.error('Error updating settings:', error);
        }
    }

    /**
     * Returns a copy of the current settings
     */
    public getCurrentSettings(): ModelSelectorSettings {
        return { ...this.currentSettings };
    }

    /**
     * Returns the appropriate icon for a provider
     */
    private getProviderIcon(providerId: string): string {
        switch (providerId) {
            case 'ollama': return 'cpu';
            case 'openai': return 'message-square';
            case 'openrouter': return 'network';
            default: return 'bot';
        }
    }

    /**
     * Refreshes the display based on the flare config
     */
    public refreshDisplay(flareConfig?: FlareConfig) {
        if (!flareConfig) {
            this.settingsBarEl.querySelector('.flare-differs-indicator')?.remove();
            return;
        }
        
        try {
            // Update UI to show differences from flare
            const differs = 
                flareConfig.provider !== this.currentSettings.provider ||
                flareConfig.model !== this.currentSettings.model ||
                flareConfig.temperature !== this.currentSettings.temperature;
            
            if (differs) {
                const existingIndicator = this.settingsBarEl.querySelector('.flare-differs-indicator');
                if (!existingIndicator) {
                    const settingsButton = this.settingsBarEl.querySelector('.flare-settings-button');
                    if (settingsButton) {
                        settingsButton.appendChild(createDiv('flare-differs-indicator'));
                    }
                }
            } else {
                this.settingsBarEl.querySelector('.flare-differs-indicator')?.remove();
            }
        } catch (error) {
            console.error('Error refreshing display:', error);
        }
    }

    /**
     * Creates and refreshes the display
     */
    public display(flareConfig?: FlareConfig) {
        this.createUI();
        this.refreshDisplay(flareConfig);
    }

    /**
     * Updates the display based on flare configuration
     */
    public updateDisplay(flare?: FlareConfig) {
        try {
            if (!flare || !flare.model) {
                this.modelNameEl.setText('--');
                return;
            }
            this.modelNameEl.setText(this.truncateModelName(flare.model));
        } catch (error) {
            console.error('Error updating display:', error);
        }
    }

    /**
     * Shows the model selection menu
     */
    private showModelMenu() {
        this.toggleDropup();
    }

    /**
     * Cleans up UI elements and event listeners
     */
    private cleanup() {
        // Remove existing dropup
        if (this.dropupEl) {
            this.dropupEl.remove();
            this.dropupEl = null;
        }

        // Remove resize listener
        window.removeEventListener('resize', this.boundHandleResize);

        // Remove any orphaned dropups
        document.querySelectorAll('.flare-model-dropup').forEach(el => el.remove());
    }

    /**
     * Completely destroys the component and cleans up resources
     */
    public destroy() {
        this.cleanup();
        
        // Remove all event listeners
        this.eventListeners.forEach(({el, type, listener}) => {
            el.removeEventListener(type, listener);
        });
        this.eventListeners = [];
        
        // Remove the footer elements completely
        this.footerLeftEl?.remove();
        this.footerRightEl?.remove();
        this.footerLeftEl = null;
        this.footerRightEl = null;
    }
} 