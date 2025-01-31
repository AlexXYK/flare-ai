import { Modal, TFile, setIcon } from 'obsidian';
import type FlarePlugin from '../../../main';

interface HistoryTreeItem {
    type: 'folder' | 'file';
    name: string;
    path: string;
    children?: HistoryTreeItem[];
    file?: TFile;
}

export class HistoryModal extends Modal {
    private searchInput: HTMLInputElement;
    private treeContainer: HTMLElement;
    private historyTree: HistoryTreeItem[] = [];

    constructor(
        private plugin: FlarePlugin,
        private onSelect: (file: TFile) => void
    ) {
        super(plugin.app);
    }

    async onOpen() {
        const { contentEl } = this;
        contentEl.empty();
        contentEl.addClass('flare-history-modal');

        // Header
        const header = contentEl.createDiv('flare-history-header');
        header.createEl('h2', { text: 'Chat History' });

        // Search bar
        const searchContainer = contentEl.createDiv('flare-history-search');
        this.searchInput = searchContainer.createEl('input', {
            type: 'text',
            placeholder: 'Search history...'
        });
        this.searchInput.addEventListener('input', () => this.filterTree());

        // New chat button
        const newChatButton = searchContainer.createEl('button', {
            cls: 'mod-cta',
            text: 'New Chat'
        });
        setIcon(newChatButton.createSpan(), 'plus');
        newChatButton.onclick = () => this.createNewChat();

        // Tree container
        this.treeContainer = contentEl.createDiv('flare-history-tree');

        // Load and display history
        await this.loadHistory();
        this.displayTree(this.historyTree);
    }

    private async loadHistory() {
        const basePath = this.plugin.settings.historyFolder;
        this.historyTree = await this.buildTree(basePath);
    }

    private async buildTree(path: string): Promise<HistoryTreeItem[]> {
        const tree: HistoryTreeItem[] = [];
        const adapter = this.plugin.app.vault.adapter;
        
        try {
            const items = await adapter.list(path);
            
            // Add folders first
            for (const folder of items.folders) {
                const name = folder.split('/').pop();
                if (name) {
                    tree.push({
                        type: 'folder',
                        name,
                        path: folder,
                        children: await this.buildTree(folder)
                    });
                }
            }

            // Then add files
            for (const file of items.files) {
                if (file.endsWith('.md')) {
                    const name = file.split('/').pop()?.replace('.md', '');
                    if (name) {
                        const tfile = this.plugin.app.vault.getAbstractFileByPath(file);
                        if (tfile instanceof TFile) {
                            tree.push({
                                type: 'file',
                                name,
                                path: file,
                                file: tfile
                            });
                        }
                    }
                }
            }
        } catch (error) {
            console.error('Failed to build history tree:', error);
        }

        return tree;
    }

    private displayTree(items: HistoryTreeItem[], container: HTMLElement = this.treeContainer, level: number = 0) {
        container.empty();

        items.forEach(item => {
            const itemEl = container.createDiv({
                cls: `flare-history-item ${item.type}`,
                attr: { 'data-path': item.path }
            });

            // Set indentation using CSS custom property
            itemEl.style.setProperty('--indent-level', `${level * 20}px`);

            // Icon and name container
            const content = itemEl.createDiv('flare-history-item-content');
            
            // Icon
            const icon = content.createSpan('flare-history-icon');
            setIcon(icon, item.type === 'folder' ? 'folder' : 'file-text');

            // Name
            content.createSpan('flare-history-name').setText(item.name);

            if (item.type === 'folder') {
                // Add folder actions
                const actions = itemEl.createDiv('flare-history-actions');
                
                const newFolderBtn = actions.createEl('button', { cls: 'flare-history-action' });
                setIcon(newFolderBtn, 'folder-plus');
                newFolderBtn.onclick = (e) => {
                    e.stopPropagation();
                    this.createNewFolder(item.path);
                };

                const newChatBtn = actions.createEl('button', { cls: 'flare-history-action' });
                setIcon(newChatBtn, 'plus');
                newChatBtn.onclick = (e) => {
                    e.stopPropagation();
                    this.createNewChat(item.path);
                };

                // Show children if they exist
                if (item.children?.length) {
                    const childContainer = itemEl.createDiv('flare-history-children');
                    this.displayTree(item.children, childContainer, level + 1);
                }

                // Toggle folder
                itemEl.onclick = () => {
                    const children = itemEl.querySelector('.flare-history-children');
                    if (children) {
                        children.toggleClass('is-collapsed', !children.hasClass('is-collapsed'));
                        icon.toggleClass('is-collapsed', !icon.hasClass('is-collapsed'));
                    }
                };
            } else if (item.file) {
                // Add file actions
                const actions = itemEl.createDiv('flare-history-actions');
                
                const deleteBtn = actions.createEl('button', { cls: 'flare-history-action' });
                setIcon(deleteBtn, 'trash-2');
                deleteBtn.onclick = async (e) => {
                    e.stopPropagation();
                    if (item.file) {
                        await this.deleteHistory(item.file);
                    }
                };

                // Open file on click
                itemEl.onclick = () => {
                    if (item.file) {
                        this.onSelect(item.file);
                        this.close();
                    }
                };
            }
        });
    }

    private filterTree() {
        const query = this.searchInput.value.toLowerCase();
        const filteredTree = this.filterTreeItems(this.historyTree, query);
        this.displayTree(filteredTree);
    }

    private filterTreeItems(items: HistoryTreeItem[], query: string): HistoryTreeItem[] {
        return items.reduce((filtered: HistoryTreeItem[], item) => {
            if (item.type === 'folder') {
                const filteredChildren = item.children ? this.filterTreeItems(item.children, query) : [];
                if (filteredChildren.length || item.name.toLowerCase().includes(query)) {
                    filtered.push({
                        ...item,
                        children: filteredChildren
                    });
                }
            } else if (item.name.toLowerCase().includes(query)) {
                filtered.push(item);
            }
            return filtered;
        }, []);
    }

    private async createNewFolder(parentPath?: string) {
        const folderName = await this.plugin.app.vault.create(
            `${parentPath || this.plugin.settings.historyFolder}/New Folder`,
            ''
        );
        await this.loadHistory();
        this.displayTree(this.historyTree);
    }

    private async createNewChat(folder?: string) {
        this.close();
        await this.plugin.chatHistoryManager.createNewHistory();
    }

    private async deleteHistory(file: TFile) {
        await this.plugin.app.vault.delete(file);
        await this.loadHistory();
        this.displayTree(this.historyTree);
    }
} 