import { App, Component, MarkdownRenderer, TFile } from 'obsidian';
import { EmbeddableMarkdownEditor } from '../editor/embeddable-editor';
import { SAVE_DEBOUNCE_MS } from '../constants';
import type { BetterDailyNotesSettings } from '../settings';
import type { DailyNoteEntry } from '../data/daily-notes-source';

export type SectionMode = 'placeholder' | 'preview' | 'editor';

/** What a DaySection needs from its parent view. */
export interface DaySectionHost {
	app: App;
	settings: BetterDailyNotesSettings;
	openFileInTab(file: TFile): void;
}

/**
 * One calendar day in the infinite scroll. Owns a header and a body that swaps
 * between three modes depending on how close it is to the viewport:
 *   - `editor`      live, editable Markdown (expensive; capped by the view)
 *   - `preview`     read-only rendered Markdown (cheap)
 *   - `placeholder` emptied, height frozen (free; keeps scrollbar stable)
 */
export class DaySection {
	readonly entry: DailyNoteEntry;
	readonly el: HTMLElement;
	mode: SectionMode = 'placeholder';

	private host: DaySectionHost;
	private headerEl: HTMLElement;
	private bodyEl: HTMLElement;
	private file: TFile;

	private editor: EmbeddableMarkdownEditor | null = null;
	private preview: Component | null = null;
	private dirty = false;
	private saveTimer: number | null = null;
	/** Bumped on every mode change to cancel stale async content reads. */
	private generation = 0;

	constructor(host: DaySectionHost, entry: DailyNoteEntry, parentEl: HTMLElement) {
		this.host = host;
		this.entry = entry;
		this.file = entry.file;
		this.el = parentEl.createDiv({ cls: 'bdn-day' });
		this.headerEl = this.el.createDiv({ cls: 'bdn-day-header' });
		this.bodyEl = this.el.createDiv({ cls: 'bdn-day-body' });
		// A real <hr> so the inter-day divider matches a markdown "---" exactly,
		// inheriting the theme's hr styling. Hidden under the last day via CSS.
		this.el.createEl('hr', { cls: 'bdn-day-divider' });
		this.renderHeader();
		this.applySettings();
	}

	get fileRef(): TFile {
		return this.file;
	}

	get isEditing(): boolean {
		return this.editor?.hasFocus ?? false;
	}

	get isDirty(): boolean {
		return this.dirty;
	}

	private renderHeader(): void {
		this.headerEl.empty();
		const label = this.entry.date.format(this.host.settings.headerDateFormat);
		const link = this.headerEl.createEl('a', { cls: 'bdn-day-title', text: label });
		link.addEventListener('click', (e) => {
			e.preventDefault();
			this.host.openFileInTab(this.file);
		});
	}

	applySettings(): void {
		this.renderHeader();
	}

	async setMode(mode: SectionMode): Promise<void> {
		if (mode === this.mode) return;

		if (this.mode === 'editor') {
			await this.flush();
			this.destroyEditor();
		} else if (this.mode === 'preview') {
			this.destroyPreview();
		}

		this.mode = mode;
		const gen = ++this.generation;

		if (mode === 'placeholder') {
			this.collapse();
			return;
		}

		let content: string;
		try {
			content = await this.host.app.vault.cachedRead(this.file);
		} catch {
			return;
		}
		if (gen !== this.generation) return; // a newer transition superseded us

		// Drop the placeholder height floor (the CSS 4em estimate): the live editor
		// or rendered preview now dictates the body height, so a short note doesn't
		// keep dead space below it before the divider.
		this.bodyEl.setCssStyles({ minHeight: '0' });
		this.bodyEl.empty();
		if (mode === 'editor') this.mountEditor(content);
		else this.mountPreview(content);
	}

	/** Freeze current height, then empty the body to release resources. */
	private collapse(): void {
		const h = this.bodyEl.offsetHeight;
		if (h > 0) this.bodyEl.setCssStyles({ minHeight: `${h}px` });
		this.bodyEl.empty();
	}

	private mountEditor(content: string): void {
		if (!EmbeddableMarkdownEditor.isSupported(this.host.app)) {
			this.mode = 'preview';
			this.mountPreview(content);
			return;
		}
		try {
			this.editor = new EmbeddableMarkdownEditor(this.host.app, this.bodyEl, this.file, {
				value: content,
				cls: 'bdn-editor',
				onChange: () => this.onEdit(),
				onBlur: () => void this.flush(),
			});
		} catch (e) {
			console.warn('[better-daily-notes] editor mount failed, using preview:', e);
			this.editor = null;
			this.mode = 'preview';
			this.bodyEl.empty();
			this.mountPreview(content);
		}
	}

	private mountPreview(content: string): void {
		this.preview = new Component();
		this.preview.load();
		void MarkdownRenderer.render(this.host.app, content, this.bodyEl, this.file.path, this.preview);
	}

	private onEdit(): void {
		this.dirty = true;
		if (this.saveTimer != null) window.clearTimeout(this.saveTimer);
		this.saveTimer = window.setTimeout(() => {
			this.saveTimer = null;
			void this.flush();
		}, SAVE_DEBOUNCE_MS);
	}

	/** Write pending edits back to disk (atomic, race-safe). */
	async flush(): Promise<void> {
		if (this.saveTimer != null) {
			window.clearTimeout(this.saveTimer);
			this.saveTimer = null;
		}
		if (!this.dirty || !this.editor) return;
		const text = this.editor.value;
		this.dirty = false;
		await this.host.app.vault.process(this.file, () => text);
	}

	/** React to an on-disk change made elsewhere (sync, another tab, etc.). */
	reloadFromDisk(content: string): void {
		if (this.mode === 'editor' && this.editor) {
			if (!this.dirty && !this.editor.hasFocus) this.editor.value = content;
		} else if (this.mode === 'preview') {
			this.destroyPreview();
			this.bodyEl.empty();
			this.mountPreview(content);
		}
	}

	private destroyEditor(): void {
		this.editor?.destroy();
		this.editor = null;
	}

	private destroyPreview(): void {
		this.preview?.unload();
		this.preview = null;
	}

	async destroy(): Promise<void> {
		await this.flush();
		this.destroyEditor();
		this.destroyPreview();
		this.el.remove();
	}
}
