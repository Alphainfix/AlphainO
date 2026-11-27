/**
 * Asking before something that cannot be undone, in Obsidian's own dialog.
 * The shared settings ask the same question AlphainZ asks with Zotero's
 * prompt; Obsidian's dialogs do not block, so the answer is a promise.
 */
import { FuzzySuggestModal, Modal, TFolder, type App } from 'obsidian';
import { t } from '../i18n';

class ConfirmModal extends Modal {
    private answered = false;

    constructor(
        app: App,
        private readonly heading: string,
        private readonly text: string,
        private readonly confirmLabel: string,
        private readonly answer: (yes: boolean) => void,
    ) {
        super(app);
    }

    onOpen(): void {
        this.titleEl.setText(this.heading);
        // Paragraphs as the prompt shows them: the question, then what follows from it.
        for (const paragraph of this.text.split(/\n{2,}/)) {
            if (paragraph.trim()) this.contentEl.createEl('p', { text: paragraph.trim() });
        }
        const buttons = this.contentEl.createDiv({ cls: 'modal-button-container' });
        const cancel = buttons.createEl('button', { text: t('Cancel') });
        cancel.addEventListener('click', () => this.close());
        const confirm = buttons.createEl('button', { text: this.confirmLabel, cls: 'mod-warning' });
        confirm.addEventListener('click', () => {
            this.answered = true;
            this.answer(true);
            this.close();
        });
        // Cancel is the default, as in AlphainZ's prompt: Enter does not delete.
        window.setTimeout(() => cancel.focus(), 0);
    }

    onClose(): void {
        this.contentEl.empty();
        if (!this.answered) this.answer(false);
    }
}

/** Ask; resolves to whether the user confirmed. Closing the dialog is a no. */
export function confirmInModal(app: App, title: string, text: string, confirmLabel: string): Promise<boolean> {
    return new Promise((resolve) => new ConfirmModal(app, title, text, confirmLabel, resolve).open());
}

class PromptModal extends Modal {
    private answered = false;

    constructor(
        app: App,
        private readonly heading: string,
        private readonly text: string,
        private readonly initial: string,
        private readonly answer: (value: string | null) => void,
    ) {
        super(app);
    }

    onOpen(): void {
        this.titleEl.setText(this.heading);
        if (this.text) this.contentEl.createEl('p', { text: this.text });
        const input = this.contentEl.createEl('input', { cls: 'alphaino-prompt-input' });
        input.type = 'text';
        input.value = this.initial;
        input.style.width = '100%';
        const submit = () => {
            this.answered = true;
            this.answer(input.value);
            this.close();
        };
        input.addEventListener('keydown', (event) => {
            if (event.key === 'Enter' && !event.isComposing) {
                event.preventDefault();
                submit();
            }
        });
        const buttons = this.contentEl.createDiv({ cls: 'modal-button-container' });
        buttons.createEl('button', { text: t('Cancel') }).addEventListener('click', () => this.close());
        buttons.createEl('button', { text: t('Save'), cls: 'mod-cta' }).addEventListener('click', submit);
        window.setTimeout(() => {
            input.focus();
            input.select();
        }, 0);
    }

    onClose(): void {
        this.contentEl.empty();
        if (!this.answered) this.answer(null);
    }
}

/** Ask for a line of text (AlphainZ's Zotero.Prompt.prompt); null when the dialog is closed without saving. */
export function promptInModal(app: App, title: string, text: string, initial: string): Promise<string | null> {
    return new Promise((resolve) => new PromptModal(app, title, text, initial, resolve).open());
}

class FolderModal extends FuzzySuggestModal<TFolder> {
    private chosen = false;

    constructor(
        app: App,
        private readonly folders: TFolder[],
        private readonly answer: (folder: TFolder | null) => void,
    ) {
        super(app);
        this.setPlaceholder(t('Choose a folder for the note…'));
    }

    getItems(): TFolder[] {
        return this.folders;
    }

    getItemText(folder: TFolder): string {
        return folder.isRoot() ? '/' : folder.path;
    }

    onChooseItem(folder: TFolder): void {
        this.chosen = true;
        this.answer(folder);
    }

    onClose(): void {
        super.onClose();
        // Obsidian calls onChooseItem after onClose: wait a moment before calling it a cancel.
        window.setTimeout(() => {
            if (!this.chosen) this.answer(null);
        }, 0);
    }
}

/** Ask which folder a note goes in, `first` listed first (AlphainZ's "Save chat as note…" destinations). */
export function chooseFolder(app: App, first: TFolder | null): Promise<TFolder | null> {
    const all = app.vault.getAllFolders(true).filter((folder) => !folder.path.split('/').some((part) => part.startsWith('.')));
    const folders = first ? [first, ...all.filter((folder) => folder !== first)] : all;
    return new Promise((resolve) => new FolderModal(app, folders, resolve).open());
}
