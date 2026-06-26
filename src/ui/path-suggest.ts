import { AbstractInputSuggest, App, TFile, TFolder } from 'obsidian';

const MAX_SUGGESTIONS = 50;

/** Write the chosen path back into the text box and fire its change handler. */
function commit(suggest: AbstractInputSuggest<unknown>, inputEl: HTMLInputElement, path: string): void {
	suggest.setValue(path);
	inputEl.trigger('input');
	suggest.close();
}

/** Autocomplete a folder path against the vault's folders. */
export class FolderSuggest extends AbstractInputSuggest<TFolder> {
	constructor(
		app: App,
		private inputEl: HTMLInputElement,
	) {
		super(app, inputEl);
	}

	protected getSuggestions(query: string): TFolder[] {
		const q = query.toLowerCase();
		return this.app.vault
			.getAllLoadedFiles()
			.filter((f): f is TFolder => f instanceof TFolder && f.path.toLowerCase().includes(q))
			.slice(0, MAX_SUGGESTIONS);
	}

	renderSuggestion(folder: TFolder, el: HTMLElement): void {
		el.setText(folder.path === '/' ? '/' : folder.path);
	}

	selectSuggestion(folder: TFolder): void {
		commit(this, this.inputEl, folder.path);
	}
}

/** Autocomplete a file path against the vault's Markdown files. */
export class FileSuggest extends AbstractInputSuggest<TFile> {
	constructor(
		app: App,
		private inputEl: HTMLInputElement,
	) {
		super(app, inputEl);
	}

	protected getSuggestions(query: string): TFile[] {
		const q = query.toLowerCase();
		return this.app.vault
			.getMarkdownFiles()
			.filter((f) => f.path.toLowerCase().includes(q))
			.slice(0, MAX_SUGGESTIONS);
	}

	renderSuggestion(file: TFile, el: HTMLElement): void {
		el.setText(file.path);
	}

	selectSuggestion(file: TFile): void {
		commit(this, this.inputEl, file.path);
	}
}
