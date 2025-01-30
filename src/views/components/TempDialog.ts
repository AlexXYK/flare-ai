import { Modal, Setting } from 'obsidian';
import type FlarePlugin from '../../../main';

export class TempDialog extends Modal {
    private temp: number;
    private onConfirm: (temp: number) => void;

    constructor(plugin: FlarePlugin, currentTemp: number, onConfirm: (temp: number) => void) {
        super(plugin.app);
        this.temp = currentTemp;
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
                text.setValue(this.temp.toFixed(2))
                    .setPlaceholder('0.70')
                    .onChange(value => {
                        // Clean and validate input
                        value = value.replace(/[^\d.]/g, '');
                        const temp = parseFloat(value);
                        
                        if (!isNaN(temp)) {
                            this.temp = Math.max(0, Math.min(1.5, temp));
                            this.temp = Math.round(this.temp * 100) / 100;
                            
                            // Only update display if not focused (to avoid cursor jumping)
                            if (document.activeElement !== text.inputEl) {
                                text.setValue(this.temp.toFixed(2));
                            }
                        }
                    });

                // Handle enter key
                text.inputEl.addEventListener('keydown', (e) => {
                    if (e.key === 'Enter') {
                        this.onConfirm(this.temp);
                        this.close();
                    }
                });

                // Handle blur
                text.inputEl.addEventListener('blur', () => {
                    text.setValue(this.temp.toFixed(2));
                });

                // Focus input
                setTimeout(() => text.inputEl.focus(), 10);
            });

        // Add buttons
        const buttonContainer = contentEl.createDiv('modal-button-container');
        
        // Cancel button
        buttonContainer.createEl('button', {
            text: 'Cancel',
            cls: 'flare-temp-button'
        }).onclick = () => this.close();
        
        // OK button
        buttonContainer.createEl('button', {
            text: 'OK',
            cls: ['flare-temp-button', 'mod-cta']
        }).onclick = () => {
            this.onConfirm(this.temp);
            this.close();
        };
    }
} 