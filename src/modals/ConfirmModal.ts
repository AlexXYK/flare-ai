import { App, Modal } from 'obsidian';

export class ConfirmModal extends Modal {
    private message: string;
    private onConfirm: (confirmed: boolean) => void;

    constructor(app: App, message: string, onConfirm: (confirmed: boolean) => void) {
        super(app);
        this.message = message;
        this.onConfirm = onConfirm;
    }

    onOpen() {
        this.titleEl.setText('Confirm Resend');
        
        const contentEl = this.contentEl;
        contentEl.empty();
        contentEl.createDiv({ text: this.message });

        const buttonContainer = contentEl.createDiv({ cls: 'flare-modal-buttons' });
        
        const cancelBtn = buttonContainer.createEl('button', { text: 'Cancel' });
        cancelBtn.onclick = () => {
            this.close();
            this.onConfirm(false);
        };
        
        const confirmBtn = buttonContainer.createEl('button', {
            cls: 'mod-cta',
            text: 'Resend'
        });
        confirmBtn.onclick = () => {
            this.close();
            this.onConfirm(true);
        };
    }
} 