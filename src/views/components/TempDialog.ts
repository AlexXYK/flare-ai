import { Modal, Setting } from 'obsidian';
import type FlarePlugin from '../../../main';

/**
 * Dialog for adjusting model temperature
 */
export class TempDialog extends Modal {
    private temp: number;
    private onConfirm: (temp: number) => void;
    private textComponent: any;
    private eventListeners: Array<{el: HTMLElement, type: string, listener: EventListenerOrEventListenerObject}> = [];

    constructor(plugin: FlarePlugin, currentTemp: number, onConfirm: (temp: number) => void) {
        super(plugin.app);
        this.temp = this.validateTemperature(currentTemp);
        this.onConfirm = onConfirm;
        this.modalEl.addClass('flare-temp-dialog');
        this.titleEl.setText('Temperature');
    }

    onOpen() {
        const { contentEl } = this;
        contentEl.empty();

        // Create description
        const desc = contentEl.createDiv('setting-item-description');
        desc.setText('Higher values make output more random (0-1.5)');

        // Create temperature input using Setting
        new Setting(contentEl)
            .addText(text => {
                this.textComponent = text;
                
                text.setValue(this.temp.toFixed(2))
                    .setPlaceholder('0.70')
                    .onChange(value => {
                        try {
                            // Clean and validate input
                            value = value.replace(/[^\d.]/g, '');
                            const temp = parseFloat(value);
                            
                            if (!isNaN(temp)) {
                                this.temp = this.validateTemperature(temp);
                                
                                // Only update display if not focused (to avoid cursor jumping)
                                if (document.activeElement !== text.inputEl) {
                                    text.setValue(this.temp.toFixed(2));
                                }
                            }
                        } catch (error) {
                            console.error('Error processing temperature input:', error);
                            // Revert to previous valid value on error
                            text.setValue(this.temp.toFixed(2));
                        }
                    });

                // Register event listeners with proper error handling
                const keydownListener = ((e: Event) => {
                    const keyEvent = e as KeyboardEvent;
                    if (keyEvent.key === 'Enter') {
                        keyEvent.preventDefault();
                        this.onConfirm(this.temp);
                        this.close();
                    }
                }) as EventListener;
                
                text.inputEl.addEventListener('keydown', keydownListener);
                this.eventListeners.push({el: text.inputEl, type: 'keydown', listener: keydownListener});

                const blurListener = (() => {
                    text.setValue(this.temp.toFixed(2));
                }) as EventListener;
                
                text.inputEl.addEventListener('blur', blurListener);
                this.eventListeners.push({el: text.inputEl, type: 'blur', listener: blurListener});

                // Focus input
                setTimeout(() => text.inputEl.focus(), 10);
            });

        // Add buttons
        const buttonContainer = contentEl.createDiv('modal-button-container');
        
        // Cancel button
        const cancelButton = buttonContainer.createEl('button', {
            text: 'Cancel',
            cls: 'flare-temp-button'
        });
        const cancelListener = (() => this.close()) as EventListener;
        cancelButton.addEventListener('click', cancelListener);
        this.eventListeners.push({el: cancelButton, type: 'click', listener: cancelListener});
        
        // OK button
        const okButton = buttonContainer.createEl('button', {
            text: 'OK',
            cls: ['flare-temp-button', 'mod-cta']
        });
        const okListener = (() => {
            this.onConfirm(this.temp);
            this.close();
        }) as EventListener;
        
        okButton.addEventListener('click', okListener);
        this.eventListeners.push({el: okButton, type: 'click', listener: okListener});
    }

    /**
     * Ensures temperature is within valid range and properly rounded
     */
    private validateTemperature(value: number): number {
        // Ensure temperature is within valid bounds
        const bounded = Math.max(0, Math.min(1.5, value));
        // Round to 2 decimal places
        return Math.round(bounded * 100) / 100;
    }

    onClose() {
        // Remove all event listeners to prevent memory leaks
        this.eventListeners.forEach(({el, type, listener}) => {
            el.removeEventListener(type, listener);
        });
        this.eventListeners = [];
        
        const { contentEl } = this;
        contentEl.empty();
    }
} 