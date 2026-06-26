import { App, TFile, moment, normalizePath } from 'obsidian';
import type { BetterDailyNotesSettings } from '../settings';

type Moment = ReturnType<typeof moment>;

export interface DailyNoteEntry {
	date: Moment;
	file: TFile;
	/** Stable key (the note's path) for identity across refreshes. */
	key: string;
}

/**
 * Produces an ordered (newest-first) list of existing daily notes and creates
 * new ones. Driven entirely by this plugin's own folder/format/template
 * settings — it does NOT depend on the core Daily Notes plugin being enabled.
 */
export class DailyNotesSource {
	private app: App;
	private settings: BetterDailyNotesSettings;
	/** Sorted newest-first. Rebuilt by refresh(). */
	private entries: DailyNoteEntry[] = [];

	constructor(app: App, settings: BetterDailyNotesSettings) {
		this.app = app;
		this.settings = settings;
	}

	private get folder(): string {
		return this.settings.folder.trim().replace(/\/+$/, '');
	}

	private get format(): string {
		return this.settings.dateFormat || 'YYYY-MM-DD';
	}

	private get template(): string {
		return this.settings.template.trim();
	}

	// --- path <-> date ---

	/** Vault path of the note for `date`. */
	private pathFor(date: Moment): string {
		const name = date.format(this.format);
		return normalizePath(this.folder ? `${this.folder}/${name}.md` : `${name}.md`);
	}

	/**
	 * Parse a markdown file back to its daily-note date, or null if it isn't one.
	 * Confined to the configured folder, and strict + round-tripped so partial
	 * matches (e.g. a stray "2026.md") are rejected.
	 */
	private dateFromFile(file: TFile): Moment | null {
		if (file.extension !== 'md') return null;
		let rel = file.path;
		if (this.folder) {
			const prefix = `${this.folder}/`;
			if (!rel.startsWith(prefix)) return null;
			rel = rel.slice(prefix.length);
		}
		const stem = rel.replace(/\.md$/, '');
		const parsed = moment(stem, this.format, true);
		if (!parsed.isValid() || parsed.format(this.format) !== stem) return null;
		return parsed;
	}

	private fileForDate(date: Moment): TFile | null {
		const f = this.app.vault.getAbstractFileByPath(this.pathFor(date));
		return f instanceof TFile ? f : null;
	}

	// --- listing ---

	/** Rebuild the cached, ordered list of existing daily notes. */
	refresh(): void {
		const next: DailyNoteEntry[] = [];
		for (const file of this.app.vault.getMarkdownFiles()) {
			const date = this.dateFromFile(file);
			if (date) next.push({ date, file, key: file.path });
		}
		// Newest first.
		next.sort((a, b) => b.date.valueOf() - a.date.valueOf());
		this.entries = next;
	}

	/** All known entries, newest-first. */
	all(): DailyNoteEntry[] {
		return this.entries;
	}

	/** The first `count` entries (newest). */
	head(count: number): DailyNoteEntry[] {
		return this.entries.slice(0, count);
	}

	/** Entries after `offset`, up to `count` of them. */
	slice(offset: number, count: number): DailyNoteEntry[] {
		return this.entries.slice(offset, offset + count);
	}

	get total(): number {
		return this.entries.length;
	}

	/** Resolve a TFile back to its entry index, or -1. */
	indexOfFile(file: TFile): number {
		return this.entries.findIndex((e) => e.key === file.path);
	}

	/** The entry for a given calendar day, or null. */
	entryOn(date: Moment): DailyNoteEntry | null {
		return this.entries.find((e) => e.date.isSame(date, 'day')) ?? null;
	}

	/** Does any note fall within the given month? */
	hasEntryInMonth(date: Moment): boolean {
		return this.entries.some((e) => e.date.isSame(date, 'month'));
	}

	/** Distinct years that contain at least one note, newest first. */
	years(): number[] {
		const set = new Set<number>();
		for (const e of this.entries) set.add(e.date.year());
		return [...set].sort((a, b) => b - a);
	}

	/** Index of a given calendar day in the newest-first list, or -1. */
	indexOfDate(date: Moment): number {
		return this.entries.findIndex((e) => e.date.isSame(date, 'day'));
	}

	/** Is this file one of our daily notes? */
	isDailyNote(file: TFile): boolean {
		return this.dateFromFile(file) != null;
	}

	/** Today's existing note, or null. */
	today(): TFile | null {
		return this.fileForDate(moment());
	}

	// --- creation ---

	/** Ensure today's note exists (creating it from the template if needed). */
	async ensureToday(): Promise<TFile> {
		return this.ensureDate(moment());
	}

	/** Find or create the note for `date`, applying the template to new files. */
	async ensureDate(date: Moment): Promise<TFile> {
		const existing = this.fileForDate(date);
		if (existing) return existing;

		const path = this.pathFor(date);
		await this.ensureParentFolder(path);
		const content = await this.renderTemplate(date);
		const created = await this.app.vault.create(path, content);
		this.refresh();
		return created;
	}

	/** Create the note's parent folder(s) if they don't exist yet. */
	private async ensureParentFolder(filePath: string): Promise<void> {
		const dir = filePath.split('/').slice(0, -1).join('/');
		if (!dir || this.app.vault.getAbstractFileByPath(dir)) return;
		try {
			await this.app.vault.createFolder(dir);
		} catch {
			/* already exists (created concurrently) */
		}
	}

	// --- template ---

	private async renderTemplate(date: Moment): Promise<string> {
		if (!this.template) return '';
		const file = this.resolveTemplateFile();
		if (!file) return '';
		const raw = await this.app.vault.cachedRead(file);
		return this.applyTemplateTokens(raw, date);
	}

	private resolveTemplateFile(): TFile | null {
		// Accept the path with or without the .md extension.
		for (const candidate of [this.template, `${this.template}.md`]) {
			const f = this.app.vault.getAbstractFileByPath(normalizePath(candidate));
			if (f instanceof TFile) return f;
		}
		return null;
	}

	/**
	 * Substitute the same template tokens the core Daily Notes plugin supports:
	 * {{date}}, {{time}}, {{title}}, each with an optional `:format` override.
	 */
	private applyTemplateTokens(text: string, date: Moment): string {
		const title = date.format(this.format);
		return text
			.replace(/{{\s*date\s*(?::([^}]+))?\s*}}/gi, (_match, fmt: string | undefined) =>
				date.format((fmt ?? this.format).trim()),
			)
			.replace(/{{\s*time\s*(?::([^}]+))?\s*}}/gi, (_match, fmt: string | undefined) =>
				date.format((fmt ?? 'HH:mm').trim()),
			)
			.replace(/{{\s*title\s*}}/gi, title);
	}
}
