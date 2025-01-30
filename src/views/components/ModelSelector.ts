import { setIcon, Modal } from 'obsidian';
import type FlarePlugin from '../../../main';
import { FlareConfig } from '../../flares/FlareConfig';

class TempDialog extends Modal {
    private temp: number;
    private onConfirm: (temp: number) => void;

    constructor(plugin: FlarePlugin, currentTemp: number, onConfirm: (temp: number) => void) {
        super(plugin.app);
        this.temp = currentTemp;
        this.onConfirm = onConfirm;
    }

    onOpen() {
        const { contentEl } = this;
        contentEl.empty();
        contentEl.addClass('flare-temp-dialog');

        // Number input
        const inputContainer = contentEl.createDiv('flare-temp-input-container');
        const input = inputContainer.createEl('input', {
            type: 'number',
            value: this.temp.toString(),
            attr: {
                min: '0',
                max: '1',
                step: '0.1'
            }
        });

        // Slider
        const sliderContainer = contentEl.createDiv('flare-temp-slider-container');
        const slider = sliderContainer.createEl('input', {
            type: 'range',
            value: this.temp.toString(),
            attr: {
                min: '0',
                max: '1',
                step: '0.1'
            }
        });

        // Sync input and slider
        input.addEventListener('input', () => {
            const value = parseFloat(input.value);
            if (!isNaN(value) && value >= 0 && value <= 1) {
                slider.value = value.toString();
                this.temp = value;
            }
        });

        slider.addEventListener('input', () => {
            input.value = slider.value;
            this.temp = parseFloat(slider.value);
        });

        // OK button
        const buttonContainer = contentEl.createDiv('flare-temp-button-container');
        const okButton = buttonContainer.createEl('button', {
            text: 'OK',
            cls: 'mod-cta'
        });
        okButton.onclick = () => {
            this.onConfirm(this.temp);
            this.close();
        };
    }
}

export class ModelSelector {
    private settingsBarEl: HTMLElement;
    private dropupEl: HTMLElement | null = null;
    private isActive = false;
    private currentSettings: {
        provider: string;
        model: string;
        temperature: number;
    };
    private onSettingsChange: (settings: any) => void;
    private modelButton: HTMLDivElement;
    private modelNameEl: HTMLSpanElement;

    constructor(
        private containerEl: HTMLElement,
        private plugin: FlarePlugin,
        initialSettings: any,
        onChange: (settings: any) => void
    ) {
        this.currentSettings = { ...initialSettings };
        this.onSettingsChange = onChange;
        this.createUI();
    }

    private truncateModelName(name: string): string {
        const maxLength = 30;
        if (name.length <= maxLength) return name;
        const start = name.slice(0, 10);
        const end = name.slice(-20);
        return `${start}...${end}`;
    }

    private createUI() {
        // If we previously created something, remove it
        // or just re-populate to avoid duplicates
        if (this.settingsBarEl) {
            this.settingsBarEl.empty?.();
        }

        // containerEl should be the .flare-footer (or parent).
        // Let's find .flare-footer-left and .flare-footer-right inside it.
        const footerLeftEl = this.containerEl.querySelector('.flare-footer-left');
        const footerRightEl = this.containerEl.querySelector('.flare-footer-right');

        // If they're missing for any reason, bail out
        if (!footerLeftEl || !footerRightEl) {
            console.warn('Footer left/right not found');
            return;
        }

        // Clear them for a fresh UI
        footerLeftEl.empty();
        footerRightEl.empty();

        // -- Model selector on the left --
        this.modelButton = footerLeftEl.createDiv('flare-model-display');
        this.modelButton.addEventListener('click', () => this.showModelMenu());

        const modelIcon = this.modelButton.createSpan('flare-model-icon');
        setIcon(modelIcon, 'cpu');

        this.modelNameEl = this.modelButton.createSpan('flare-model-name');
        this.modelNameEl.setText(this.truncateModelName(this.currentSettings.model));

        // -- Temperature control on the right --
        const tempControl = footerRightEl.createDiv('flare-temp-control');
        tempControl.onclick = () => {
            new TempDialog(
                this.plugin,
                this.currentSettings.temperature,
                (temp) => this.updateSettings({ temperature: temp })
            ).open();
        };

        const tempIcon = tempControl.createSpan('flare-temp-icon');
        setIcon(tempIcon, 'thermometer');

        const tempValue = tempControl.createSpan('flare-temp-value');
        tempValue.setText(String(this.currentSettings.temperature));

        // Keep track, e.g. for future checks
        this.settingsBarEl = footerLeftEl as HTMLElement;
    }

    private createDropup() {
        if (this.dropupEl) {
            this.dropupEl.remove();
        }

        this.dropupEl = document.body.createDiv('flare-model-dropup');
        
        // Position the dropup above the settings bar
        const settingsRect = this.settingsBarEl.getBoundingClientRect();
        this.dropupEl.style.position = 'fixed';
        this.dropupEl.style.bottom = `${window.innerHeight - settingsRect.top + 8}px`;
        this.dropupEl.style.left = `${settingsRect.left}px`;
        this.dropupEl.style.width = `${settingsRect.width}px`;
        
        // Group models by provider
        Object.entries(this.plugin.settings.providers).forEach(([providerId, provider]) => {
            if (!provider.enabled) return;
            
            const section = (this.dropupEl as HTMLElement).createDiv('flare-provider-section');
            
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

    private async loadModels(container: HTMLElement, providerId: string, provider: any) {
        try {
            const models = await this.plugin.getModelsForProvider(provider.type);
            models.forEach(model => {
                const option = container.createDiv('flare-model-option');
                if (this.currentSettings.provider === providerId && this.currentSettings.model === model) {
                    option.addClass('is-selected');
                }
                
                option.createSpan().setText(model);
                option.onclick = () => {
                    this.updateSettings({
                        provider: providerId,
                        model: model
                    });
                    this.toggleDropup();
                };
            });
        } catch (error) {
            container.createDiv('flare-model-error').setText('Failed to load models');
        }
    }

    private toggleDropup() {
        this.isActive = !this.isActive;
        
        if (this.isActive) {
            this.createDropup();
            
            // Close when clicking outside
            const onClick = (e: MouseEvent) => {
                if (this.dropupEl && !this.dropupEl.contains(e.target as Node) && !this.settingsBarEl.contains(e.target as Node)) {
                    this.toggleDropup();
                    document.removeEventListener('click', onClick);
                }
            };
            // Delay to avoid immediate trigger
            setTimeout(() => document.addEventListener('click', onClick), 0);
        } else if (this.dropupEl) {
            this.dropupEl.remove();
            this.dropupEl = null;
        }
    }

    public updateSettings(newSettings: Partial<typeof this.currentSettings>) {
        this.currentSettings = { ...this.currentSettings, ...newSettings };
        this.onSettingsChange(this.currentSettings);
        this.createUI();
    }

    public getCurrentSettings() {
        return { ...this.currentSettings };
    }

    private getProviderIcon(providerId: string): string {
        switch (providerId) {
            case 'ollama': return 'cpu';
            case 'openai': return 'message-square';
            case 'openrouter': return 'network';
            default: return 'bot';
        }
    }

    public refreshDisplay(flareConfig?: FlareConfig) {
        if (flareConfig) {
            // Update UI to show differences from flare
            const differs = 
                flareConfig.provider !== this.currentSettings.provider ||
                flareConfig.model !== this.currentSettings.model ||
                flareConfig.temperature !== this.currentSettings.temperature;
            
            if (differs) {
                const existingIndicator = this.settingsBarEl.querySelector('.flare-differs-indicator');
                if (!existingIndicator) {
                    this.settingsBarEl.querySelector('.flare-settings-button')?.appendChild(
                        createDiv('flare-differs-indicator')
                    );
                }
            } else {
                this.settingsBarEl.querySelector('.flare-differs-indicator')?.remove();
            }
        } else {
            this.settingsBarEl.querySelector('.flare-differs-indicator')?.remove();
        }
    }

    public display(flareConfig?: FlareConfig) {
        this.createUI();
        this.refreshDisplay(flareConfig);
    }

    public updateDisplay(flare?: FlareConfig) {
        if (!flare || !flare.model) {
            this.modelNameEl.setText('');
            return;
        }
        this.modelNameEl.setText(this.truncateModelName(flare.model));
    }

    private showModelMenu() {
        this.toggleDropup();
    }
} 