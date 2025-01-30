import { TFile, setIcon, App } from 'obsidian';
import type FlarePlugin from '../../../main';

interface HistoryTreeItem {
    type: 'folder' | 'file';
    name: string;
    path: string;
    children?: HistoryTreeItem[];
    file?: TFile;
}

export class HistorySidebar {
    private sidebarEl: HTMLElement;
    private searchInput: HTMLInputElement;
    private treeContainer: HTMLElement;
    private historyTree: HistoryTreeItem[] = [];
    public isVisible: boolean = false;
    private contextMenu: HTMLElement | null = null;
    private longPressTimeout: NodeJS.Timeout | null = null;
    private longPressDelay: number = 500; // ms
    private isSelecting: boolean = false;
    private selectionTimeout: NodeJS.Timeout | null = null;
    private currentPath: string | null = null;

    constructor(
        private plugin: FlarePlugin,
        private onSelect: (file: TFile) => Promise<void>
    ) {
        this.createSidebar();
    }

    private createSidebar() {
        this.sidebarEl = createDiv('flare-history-sidebar');
        
        // Create header
        const header = this.sidebarEl.createDiv('flare-history-header');
        header.createEl('h2', { text: 'Chat History' });
        
        // Create actions container
        const actions = header.createDiv('flare-history-actions');
        
        // Add refresh button
        const refreshButton = this.createActionButton(actions, 'refresh-cw', 'Refresh History');
        refreshButton.onclick = async () => {
            await this.loadHistory();
            this.displayTree(this.historyTree);
        };
        
        // Add close button
        const closeButton = header.createDiv('flare-history-close');
        setIcon(closeButton, 'x');
        closeButton.onclick = () => this.hide();

        // Create search
        const searchContainer = this.sidebarEl.createDiv('flare-history-search');
        this.searchInput = searchContainer.createEl('input', {
            type: 'text',
            placeholder: 'Search history...',
            cls: 'flare-history-search-input'
        });

        // Add clear button
        const clearButton = searchContainer.createDiv('flare-history-search-clear');
        setIcon(clearButton, 'x');
        clearButton.style.display = 'none';
        
        this.searchInput.addEventListener('input', () => {
            clearButton.style.display = this.searchInput.value ? 'flex' : 'none';
            this.filterTree();
        });
        
        clearButton.onclick = () => {
            this.searchInput.value = '';
            clearButton.style.display = 'none';
            this.filterTree();
        };

        // Create tree container
        this.treeContainer = this.sidebarEl.createDiv('flare-history-tree');
    }

    private createActionButton(container: HTMLElement, icon: string, tooltip: string): HTMLElement {
        const button = container.createEl('button', {
            cls: 'flare-history-action-button',
            attr: { 'aria-label': tooltip, title: tooltip }
        });
        setIcon(button, icon);
        return button;
    }

    attachTo(container: HTMLElement) {
        // Remove any existing instance
        this.sidebarEl.detach();
        
        // Append sidebar to the container
        container.appendChild(this.sidebarEl);
        
        // Load initial history
        this.loadHistory().then(() => {
            this.displayTree(this.historyTree);
        }).catch(error => {
            console.error('Error loading initial history:', error);
            this.showEmptyState();
        });
        
        this.addEventListeners();
    }

    private addEventListeners() {
        // Handle clicks and touches outside the sidebar
        const handleOutsideClick = (e: MouseEvent | TouchEvent) => {
            const target = e.target as HTMLElement;
            if (this.isVisible && 
                !this.sidebarEl.contains(target) && 
                !this.contextMenu?.contains(target)) {
                this.hide();
            }
        };

        // Add both mouse and touch handlers
        document.addEventListener('mousedown', handleOutsideClick);
        document.addEventListener('touchstart', handleOutsideClick, { passive: true });

        // Handle touch events for mobile
        this.sidebarEl.addEventListener('touchstart', (e) => {
            if (this.longPressTimeout) clearTimeout(this.longPressTimeout);
            
            const target = e.target as HTMLElement;
            const item = target.closest('.flare-history-item') as HTMLElement;
            if (!item) return;

            this.longPressTimeout = setTimeout(() => {
                e.preventDefault();
                const rect = item.getBoundingClientRect();
                this.showContextMenu(item, rect.left, rect.bottom);
            }, this.longPressDelay);
        }, { passive: true });

        this.sidebarEl.addEventListener('touchend', () => {
            if (this.longPressTimeout) {
                clearTimeout(this.longPressTimeout);
            }
        }, { passive: true });

        this.sidebarEl.addEventListener('touchmove', () => {
            if (this.longPressTimeout) {
                clearTimeout(this.longPressTimeout);
            }
        }, { passive: true });

        // Handle right-click for desktop
        this.sidebarEl.addEventListener('contextmenu', (e) => {
            const target = e.target as HTMLElement;
            const item = target.closest('.flare-history-item') as HTMLElement;
            if (!item) return;

            e.preventDefault();
            this.showContextMenu(item, e.pageX, e.pageY);
        });

        // Handle keyboard navigation
        this.sidebarEl.addEventListener('keydown', (e) => {
            const target = e.target as HTMLElement;
            const item = target.closest('.flare-history-item') as HTMLElement;
            if (!item) return;

            switch (e.key) {
                case 'Enter':
                    e.preventDefault();
                    this.handleItemClick(item);
                    break;
                case 'ArrowDown':
                    e.preventDefault();
                    this.focusNextItem(item);
                    break;
                case 'ArrowUp':
                    e.preventDefault();
                    this.focusPreviousItem(item);
                    break;
            }
        });
    }

    private focusNextItem(currentItem: HTMLElement) {
        const items = Array.from(this.treeContainer.querySelectorAll('.flare-history-item')) as HTMLElement[];
        const currentIndex = items.indexOf(currentItem);
        const nextItem = items[currentIndex + 1];
        if (nextItem) {
            nextItem.focus();
        }
    }

    private focusPreviousItem(currentItem: HTMLElement) {
        const items = Array.from(this.treeContainer.querySelectorAll('.flare-history-item')) as HTMLElement[];
        const currentIndex = items.indexOf(currentItem);
        const previousItem = items[currentIndex - 1];
        if (previousItem) {
            previousItem.focus();
        }
    }

    async show() {
        if (this.isVisible) return;

        try {
            // Make sidebar visible first
            this.sidebarEl.style.display = 'flex'; // Ensure it's displayed before adding visible class
            this.sidebarEl.addClass('is-visible');
            this.isVisible = true;
            
            // Load history data
            await this.loadHistory();
            
            // Display tree in the next frame
            requestAnimationFrame(() => {
                this.showHistoryTree();
                
                // Focus search input
                this.searchInput.focus();
            });
        } catch (error) {
            console.error('Error showing sidebar:', error);
            this.isSelecting = false;
            this.showEmptyState();
        }
    }

    hide() {
        if (!this.isVisible) return;
        this.sidebarEl.removeClass('is-visible');
        // Wait for transition to complete before hiding
        setTimeout(() => {
            if (!this.isVisible) {
                this.sidebarEl.style.display = 'none';
            }
        }, 300); // Match transition duration
        this.isVisible = false;
        this.hideContextMenu();
    }

    private async loadHistory() {
        try {
            const basePath = this.plugin.settings.historyFolder;
            const adapter = this.plugin.app.vault.adapter;
            const exists = await adapter.exists(basePath);
            
            if (!exists) {
                await this.plugin.app.vault.createFolder(basePath);
            }

            this.historyTree = await this.buildTree(basePath);
        } catch (error) {
            console.error('Error loading history:', error);
            this.historyTree = [];
        }
    }

    private async buildTree(path: string): Promise<HistoryTreeItem[]> {
        const tree: HistoryTreeItem[] = [];
        const adapter = this.plugin.app.vault.adapter;
        
        try {
            const items = await adapter.list(path);
            
            // Add files first (we want them at the top)
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

            // Then add folders
            for (const folder of items.folders) {
                const name = folder.split('/').pop();
                if (name) {
                    const children = await this.buildTree(folder);
                    if (children.length > 0) { // Only add folders that have contents
                        tree.push({
                            type: 'folder',
                            name,
                            path: folder,
                            children
                        });
                    }
                }
            }

            // Sort items alphabetically by name, files first
            tree.sort((a, b) => {
                // If types are different, files come first
                if (a.type !== b.type) {
                    return a.type === 'file' ? -1 : 1;
                }
                // If same type, sort alphabetically
                return a.name.localeCompare(b.name);
            });

        } catch (error) {
            console.error('Failed to build history tree for path:', path, error);
        }

        return tree;
    }

    private displayTree(items: HistoryTreeItem[], container: HTMLElement = this.treeContainer) {
        container.empty();
        
        if (!items || items.length === 0) {
            this.showEmptyState();
            return;
        }

        // Create a document fragment for better performance
        const fragment = document.createDocumentFragment();

        items.forEach(item => {
            const itemEl = document.createElement('div');
            itemEl.className = `flare-history-item ${item.type}`;
            itemEl.setAttribute('data-path', item.path);
            itemEl.setAttribute('tabindex', '0');

            // Create content container
            const content = document.createElement('div');
            content.className = 'flare-history-item-content';
            
            // Icon
            const icon = document.createElement('span');
            icon.className = 'flare-history-icon';
            setIcon(icon, item.type === 'folder' ? 'folder' : 'file-text');
            content.appendChild(icon);

            // Name
            const nameSpan = document.createElement('span');
            nameSpan.className = 'flare-history-name';
            nameSpan.textContent = item.name;
            content.appendChild(nameSpan);

            itemEl.appendChild(content);

            if (item.type === 'folder') {
                // Show children if they exist
                if (item.children?.length) {
                    const childContainer = document.createElement('div');
                    childContainer.className = 'flare-history-children';
                    this.displayTree(item.children, childContainer);
                    itemEl.appendChild(childContainer);
                }

                // Toggle folder
                content.addEventListener('click', (e) => {
                    e.stopPropagation();
                    itemEl.classList.toggle('is-collapsed');
                    const chevron = icon.querySelector('svg');
                    if (chevron) {
                        chevron.style.transform = itemEl.classList.contains('is-collapsed') ? 'rotate(-90deg)' : '';
                    }
                });
            } else {
                // Handle file click
                itemEl.addEventListener('click', () => {
                    if (item.file) {
                        this.handleItemClick(itemEl);
                    }
                });
            }

            fragment.appendChild(itemEl);
        });

        // Append all items at once
        container.appendChild(fragment);
    }

    private showEmptyState() {
        const emptyState = this.treeContainer.createDiv('flare-history-empty');
        const icon = emptyState.createDiv('flare-history-empty-icon');
        setIcon(icon, 'message-square');
        emptyState.createEl('p', { text: 'No chat history yet' });
        emptyState.createEl('p', { 
            text: 'Start a new chat to begin',
            cls: 'flare-history-empty-hint'
        });
    }

    private async handleItemClick(itemEl: HTMLElement) {
        const path = itemEl.getAttribute('data-path');
        if (!path || this.isSelecting) return;
        
        try {
            this.isSelecting = true;
            itemEl.addClass('is-loading');
            
            const file = this.plugin.app.vault.getAbstractFileByPath(path);
            if (file instanceof TFile) {
                // Update current path
                this.currentPath = path;
                
                // Remove active class from all items
                this.treeContainer.querySelectorAll('.flare-history-item').forEach(item => {
                    item.removeClass('is-active');
                });
                
                // Add active class to current item
                itemEl.addClass('is-active');
                
                // Hide sidebar on mobile
                if (window.innerWidth <= 768) {
                    this.hide();
                }
                
                // Load the chat history
                await this.onSelect(file);
            }
        } catch (error) {
            console.error('Error in handleItemClick:', error);
        } finally {
            itemEl.removeClass('is-loading');
            // Reset selection state after a short delay
            setTimeout(() => {
                this.isSelecting = false;
            }, 100);
        }
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

    private async createNewChat(folder?: string) {
        this.hide();
        await this.plugin.chatHistoryManager.createNewHistory();
    }

    private async deleteHistory(path: string) {
        try {
            const file = this.plugin.app.vault.getAbstractFileByPath(path);
            if (file instanceof TFile) {
                await this.plugin.app.vault.delete(file);
                await this.loadHistory();
                this.displayTree(this.historyTree);
            }
        } catch (error) {
            console.error('Error deleting history:', error);
        }
    }

    private async deleteFolder(path: string) {
        try {
            const folder = this.plugin.app.vault.getAbstractFileByPath(path);
            if (folder) {
                await this.plugin.app.vault.delete(folder);
                await this.loadHistory();
                this.displayTree(this.historyTree);
            }
        } catch (error) {
            console.error('Error deleting folder:', error);
        }
    }

    private async renameItem(itemEl: HTMLElement, path: string) {
        const nameEl = itemEl.querySelector('.flare-history-name');
        if (!nameEl || !nameEl.textContent) return;

        const currentName = nameEl.textContent;
        const input = createEl('input', {
            type: 'text',
            value: currentName,
            cls: 'flare-rename-input'
        });

        nameEl.replaceWith(input);
        input.focus();
        input.select();

        const finishRename = async (newName: string) => {
            try {
                if (newName && newName !== currentName) {
                    const file = this.plugin.app.vault.getAbstractFileByPath(path);
                    if (file) {
                        const newPath = path.replace(currentName, newName);
                        await this.plugin.app.fileManager.renameFile(file, newPath);
                        await this.loadHistory();
                        this.displayTree(this.historyTree);
                        return;
                    }
                }
            } catch (error) {
                console.error('Error renaming item:', error);
            }
            input.replaceWith(nameEl);
        };

        input.onblur = () => finishRename(input.value);
        input.onkeydown = (e) => {
            if (e.key === 'Enter') {
                e.preventDefault();
                finishRename(input.value);
            } else if (e.key === 'Escape') {
                e.preventDefault();
                input.replaceWith(nameEl);
            }
        };
    }

    private showContextMenu(item: HTMLElement, x: number, y: number) {
        this.hideContextMenu();

        const type = item.classList.contains('folder') ? 'folder' : 'file';
        const path = item.getAttribute('data-path');
        if (!path) return;

        this.contextMenu = document.body.createDiv('flare-context-menu');
        
        // Position menu
        const rect = item.getBoundingClientRect();
        const menuX = Math.min(x, window.innerWidth - 200); // Prevent overflow
        const menuY = Math.min(y, window.innerHeight - 200);
        
        this.contextMenu.style.left = `${menuX}px`;
        this.contextMenu.style.top = `${menuY}px`;

        if (type === 'folder') {
            this.addContextMenuItem('New Chat Here', 'plus', () => 
                this.createNewChat(path));
            this.addContextMenuItem('Rename', 'edit', () => 
                this.renameItem(item, path));
            this.addContextMenuItem('Delete', 'trash-2', () => 
                this.deleteFolder(path), true);
        } else {
            this.addContextMenuItem('Rename', 'edit', () => 
                this.renameItem(item, path));
            this.addContextMenuItem('Delete', 'trash-2', () => 
                this.deleteHistory(path), true);
        }

        // Close context menu when clicking outside
        setTimeout(() => {
            document.addEventListener('click', this.hideContextMenu, { once: true });
        }, 0);
    }

    private addContextMenuItem(text: string, icon: string, onClick: () => void, isDanger = false) {
        if (!this.contextMenu) return;

        const item = this.contextMenu.createDiv({
            cls: `flare-context-menu-item${isDanger ? ' is-danger' : ''}`
        });
        
        const iconSpan = item.createSpan('flare-context-menu-icon');
        setIcon(iconSpan, icon);
        
        item.createSpan('flare-context-menu-text').setText(text);
        
        item.onclick = (e) => {
            e.stopPropagation();
            onClick();
            this.hideContextMenu();
        };
    }

    private hideContextMenu = () => {
        if (this.contextMenu) {
            this.contextMenu.remove();
            this.contextMenu = null;
        }
    }

    // Clean up method to prevent memory leaks
    public cleanup() {
        if (this.longPressTimeout) {
            clearTimeout(this.longPressTimeout);
        }
        if (this.selectionTimeout) {
            clearTimeout(this.selectionTimeout);
        }
        this.sidebarEl.detach();
    }

    public async refresh() {
        // Load fresh history data
        await this.loadHistory();
        // Re-display the tree with updated data
        this.displayTree(this.historyTree);
    }

    private showHistoryTree() {
        try {
            if (this.historyTree.length > 0) {
                if (this.plugin.settings.debugLoggingEnabled) {
                    console.log('Displaying history tree with items:', this.historyTree.length);
                }
                this.displayTree(this.historyTree);
            } else {
                if (this.plugin.settings.debugLoggingEnabled) {
                    console.log('No items to display, showing empty state');
                }
                this.showEmptyState();
            }
        } catch (error) {
            console.error('Error showing history tree:', error);
        }
    }
} 