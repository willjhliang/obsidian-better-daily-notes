import { ItemView, Notice, TFile, WorkspaceLeaf, debounce, moment } from 'obsidian';
import {
	ACTIVE_DATE_DEBOUNCE_MS,
	ACTIVE_DATE_OFFSET_PX,
	BDN_ICON,
	MID_MARGIN_PX,
	NEAR_MARGIN_PX,
	SENTINEL_MARGIN,
	VIEW_TYPE_BDN,
} from '../constants';
import { DailyNotesSource } from '../data/daily-notes-source';
import { DaySection, type DaySectionHost } from './day-section';
import type BetterDailyNotesPlugin from '../main';

type Moment = ReturnType<typeof moment>;

/**
 * The infinite-scroll view: a single scrollable surface stacking every existing
 * daily note newest-first. Visible days get a live editor; days further away
 * degrade to a rendered preview and then to a frozen placeholder, so memory
 * stays bounded no matter how far back you scroll. Reaching the bottom lazily
 * loads the next batch of older notes.
 */
export class InfiniteScrollView extends ItemView implements DaySectionHost {
	private plugin: BetterDailyNotesPlugin;
	private source: DailyNotesSource;

	private scrollEl!: HTMLElement;
	private stackEl!: HTMLElement;
	private sentinelEl!: HTMLElement;

	private sections: DaySection[] = [];
	private loadedCount = 0;

	private sentinelObserver: IntersectionObserver | null = null;
	private scrollHandler: (() => void) | null = null;
	private windowingScheduled = false;

	/** Last day reported to the calendar, to suppress duplicate notifications. */
	private lastActiveKey: string | null = null;
	private readonly emitActiveDate: (date: Moment) => void;

	/** Key of the day a reveal is actively pinning to (null when not revealing). */
	private revealKey: string | null = null;

	constructor(leaf: WorkspaceLeaf, plugin: BetterDailyNotesPlugin) {
		super(leaf);
		this.plugin = plugin;
		this.source = new DailyNotesSource(this.app, plugin.settings);
		this.emitActiveDate = debounce(
			(date: Moment) => this.plugin.notifyActiveDate(date),
			ACTIVE_DATE_DEBOUNCE_MS,
		);
	}

	get settings() {
		return this.plugin.settings;
	}

	getViewType(): string {
		return VIEW_TYPE_BDN;
	}

	getDisplayText(): string {
		return this.settings.pageTitle || 'Daily Notes';
	}

	getIcon(): string {
		return BDN_ICON;
	}

	async onOpen(): Promise<void> {
		this.build();
		this.registerVaultEvents();
	}

	async onClose(): Promise<void> {
		this.teardownObservers();
		await Promise.all(this.sections.map((s) => s.destroy()));
		this.sections = [];
	}

	// --- DaySectionHost ---

	openFileInTab(file: TFile): void {
		void this.app.workspace.getLeaf('tab').openFile(file);
	}

	// --- construction ---

	private build(): void {
		this.contentEl.empty();
		this.contentEl.addClass('bdn-view');

		this.scrollEl = this.contentEl.createDiv({ cls: 'bdn-scroll' });
		this.buildPageTitle();
		this.stackEl = this.scrollEl.createDiv({ cls: 'bdn-stack' });
		this.sentinelEl = this.scrollEl.createDiv({ cls: 'bdn-sentinel' });

		this.source.refresh();
		this.renderFromTop();
		this.setupObservers();
	}

	/** Editable inline title at the top of the content, like a note's title. */
	private buildPageTitle(): void {
		const header = this.scrollEl.createDiv({ cls: 'bdn-page-header' });
		const title = header.createDiv({
			cls: 'inline-title bdn-inline-title',
			text: this.settings.pageTitle || 'Daily Notes',
		});
		title.contentEditable = 'true';
		title.spellcheck = false;
		title.setAttr('data-placeholder', 'Daily Notes');

		this.registerDomEvent(title, 'keydown', (e: KeyboardEvent) => {
			if (e.key === 'Enter') {
				e.preventDefault();
				title.blur();
			}
		});
		this.registerDomEvent(title, 'blur', () => void this.commitTitle(title));
	}

	private async commitTitle(titleEl: HTMLElement): Promise<void> {
		const next = (titleEl.textContent ?? '').trim() || 'Daily Notes';
		titleEl.textContent = next;
		if (next === this.settings.pageTitle) return;
		this.plugin.settings.pageTitle = next;
		await this.plugin.saveSettings();
		// Refresh the tab header so it reflects the new title.
		(this.leaf as unknown as { updateHeader?: () => void }).updateHeader?.();
	}

	/** (Re)build the stack from the newest note, loading `targetCount` days. */
	private renderFromTop(targetCount = this.settings.loadBatch): void {
		this.clearSections();
		this.loadedCount = 0;
		if (this.source.total === 0) {
			this.showEmpty();
			return;
		}
		this.loadMore(targetCount);
	}

	private loadMore(count: number): void {
		const slice = this.source.slice(this.loadedCount, count);
		for (const entry of slice) {
			this.sections.push(new DaySection(this, entry, this.stackEl));
		}
		this.loadedCount += slice.length;
		this.scheduleWindowing();
		if (this.loadedCount >= this.source.total) {
			this.sentinelObserver?.unobserve(this.sentinelEl);
		}
		this.updateBottomSpacer();
	}

	/**
	 * Trailing whitespace under the last (oldest) entry, mirroring a normal
	 * note's "scroll past end" padding (~half the editor height). Only applied
	 * once every note is loaded, so it never sits between us and the next batch.
	 */
	private updateBottomSpacer(): void {
		if (!this.scrollEl || !this.stackEl) return;
		const allLoaded = this.loadedCount >= this.source.total;
		const pad = allLoaded ? Math.round(this.scrollEl.clientHeight * 0.5) : 0;
		this.stackEl.setCssStyles({ paddingBottom: `${pad}px` });
	}

	onResize(): void {
		this.updateBottomSpacer();
	}

	private clearSections(): void {
		for (const section of this.sections) void section.destroy();
		this.sections = [];
		this.stackEl.empty();
	}

	private showEmpty(): void {
		const empty = this.stackEl.createDiv({ cls: 'bdn-empty' });
		empty.createEl('p', { text: 'No daily notes yet.' });
	}

	// --- observers / windowing ---

	private setupObservers(): void {
		this.sentinelObserver = new IntersectionObserver(
			(entries) => {
				for (const e of entries) {
					if (e.isIntersecting && this.loadedCount < this.source.total) {
						this.loadMore(this.loadedCount + this.settings.loadBatch);
					}
				}
			},
			{ root: this.scrollEl, rootMargin: SENTINEL_MARGIN },
		);
		this.sentinelObserver.observe(this.sentinelEl);

		this.scrollHandler = () => this.scheduleWindowing();
		this.registerDomEvent(this.scrollEl, 'scroll', this.scrollHandler);

		// A deliberate user scroll cancels an in-progress reveal pin.
		const cancelReveal = () => {
			if (this.revealKey != null) this.endReveal();
		};
		this.registerDomEvent(this.scrollEl, 'wheel', cancelReveal);
		this.registerDomEvent(this.scrollEl, 'touchmove', cancelReveal);
	}

	private teardownObservers(): void {
		this.sentinelObserver?.disconnect();
		this.sentinelObserver = null;
	}

	private scheduleWindowing(): void {
		if (this.windowingScheduled) return;
		this.windowingScheduled = true;
		window.requestAnimationFrame(() => {
			this.windowingScheduled = false;
			this.updateWindowing();
		});
	}

	/** Assign each section a mode based on distance from the viewport. */
	private updateWindowing(): void {
		if (this.sections.length === 0) return;
		const view = this.scrollEl.getBoundingClientRect();

		const measured = this.sections.map((section) => {
			const r = section.el.getBoundingClientRect();
			let dist = 0;
			if (r.bottom < view.top) dist = view.top - r.bottom;
			else if (r.top > view.bottom) dist = r.top - view.bottom;
			return { section, dist };
		});

		// Nearest sections get a live editor, capped at maxLiveEditors.
		const editorSet = new Set<DaySection>(
			measured
				.filter((m) => m.dist <= NEAR_MARGIN_PX)
				.sort((a, b) => a.dist - b.dist)
				.slice(0, this.settings.maxLiveEditors)
				.map((m) => m.section),
		);
		// Never yank an editor out from under an active edit.
		for (const { section } of measured) {
			if (section.isEditing || section.isDirty) editorSet.add(section);
		}

		for (const { section, dist } of measured) {
			const mode = editorSet.has(section)
				? 'editor'
				: dist <= MID_MARGIN_PX
					? 'preview'
					: 'placeholder';
			void section.setMode(mode);
		}

		this.reportActiveDate(view.top);
	}

	/** Tell the calendar which day sits at the top of the viewport. */
	private reportActiveDate(viewTop: number): void {
		// During a reveal the layout is still settling; keep the clicked day
		// highlighted instead of emitting whatever transiently sits at the top.
		if (this.revealKey != null) return;
		// Topmost section crossing the offset line below the viewport top. Using the
		// same offset as the jump keeps the highlight in sync and (since the previous
		// day's bottom only touches the line) avoids flipping off a jumped-to day.
		const line = viewTop + ACTIVE_DATE_OFFSET_PX;
		let top: DaySection | null = null;
		for (const section of this.sections) {
			if (section.el.getBoundingClientRect().bottom > line) {
				top = section;
				break;
			}
		}
		if (!top) return;
		const key = top.entry.key;
		if (key === this.lastActiveKey) return;
		this.lastActiveKey = key;
		this.emitActiveDate(top.entry.date);
	}

	// --- actions ---

	/**
	 * Load (creating if necessary) the note for `date` and scroll it to the top.
	 * Called from the calendar when a day is clicked.
	 */
	async revealDate(date: Moment): Promise<void> {
		try {
			await this.source.ensureDate(date);
		} catch (e) {
			new Notice('Could not open that day. Check the daily notes folder/template in settings.');
			console.error('[better-daily-notes]', e);
			return;
		}
		const idx = this.source.indexOfDate(date);
		if (idx < 0) return;

		// Rebuild from the top, loading enough days for the target to exist.
		const batch = this.settings.loadBatch;
		const needed = Math.ceil((idx + 1) / batch) * batch;
		if (this.sentinelObserver) this.sentinelObserver.observe(this.sentinelEl);
		this.renderFromTop(Math.max(needed, this.loadedCount));

		const target = this.sections[idx];
		if (!target) return;
		// Highlight the clicked day immediately and hold it highlighted while we
		// pin the scroll (windowing keeps emitting otherwise — see reportActiveDate).
		this.beginReveal(target.entry.key);
		this.lastActiveKey = target.entry.key;
		this.plugin.notifyActiveDate(target.entry.date);
		this.scrollSectionToOffset(target.el);
		this.pinReveal();
	}

	/**
	 * Start pinning to a day. Hides the stack (via a CSS class) so the height
	 * churn while content loads above the target stays invisible; `endReveal`
	 * fades it back in once the position settles.
	 */
	private beginReveal(key: string): void {
		this.revealKey = key;
		this.scrollEl.addClass('bdn-revealing');
	}

	/** Stop pinning and reveal the (now-settled) stack. */
	private endReveal(): void {
		this.revealKey = null;
		this.scrollEl.removeClass('bdn-revealing');
	}

	/**
	 * Re-scroll the reveal target to its offset every frame until the position
	 * stops moving (content above it finishes loading) or a frame cap is hit. This
	 * absorbs the height drift as windowing swaps placeholders for live editors.
	 */
	private pinReveal(): void {
		let frames = 0;
		let stable = 0;
		const step = () => {
			if (this.revealKey == null) return;
			const el = this.sections.find((s) => s.entry.key === this.revealKey)?.el;
			if (!el) {
				this.endReveal();
				return;
			}
			const before = this.scrollEl.scrollTop;
			this.scrollSectionToOffset(el);
			const moved = Math.abs(this.scrollEl.scrollTop - before) > 0.5;
			stable = moved ? 0 : stable + 1;
			if (++frames < 60 && stable < 3) {
				window.requestAnimationFrame(step);
			} else {
				this.endReveal();
			}
		};
		window.requestAnimationFrame(step);
	}

	/** Scroll so the section's top sits ACTIVE_DATE_OFFSET_PX below the view top. */
	private scrollSectionToOffset(el: HTMLElement): void {
		const delta =
			el.getBoundingClientRect().top -
			this.scrollEl.getBoundingClientRect().top -
			ACTIVE_DATE_OFFSET_PX;
		this.scrollEl.scrollTop += delta;
	}

	/** Re-read settings and refresh the view. */
	applySettings(): void {
		// Folder/date-format changes redefine the note set, so re-scan and rebuild.
		// While the user is mid-edit, just re-render headers to avoid losing work.
		if (this.sections.some((s) => s.isDirty || s.isEditing)) {
			for (const section of this.sections) section.applySettings();
			return;
		}
		const prevScroll = this.scrollEl.scrollTop;
		const prevCount = Math.max(this.loadedCount, this.settings.loadBatch);
		this.source.refresh();
		if (this.sentinelObserver) this.sentinelObserver.observe(this.sentinelEl);
		this.renderFromTop(prevCount);
		this.scrollEl.scrollTop = prevScroll;
	}

	// --- vault reconciliation ---

	private registerVaultEvents(): void {
		this.registerEvent(
			this.app.vault.on('modify', (file) => {
				if (!(file instanceof TFile)) return;
				const section = this.sections.find((s) => s.fileRef.path === file.path);
				if (!section) return;
				void this.app.vault.cachedRead(file).then((content) => section.reloadFromDisk(content));
			}),
		);
		const reconcile = (file: unknown) => {
			if (!(file instanceof TFile) || file.extension !== 'md') return;
			if (!this.source.isDailyNote(file)) return;
			this.reconcile();
		};
		this.registerEvent(this.app.vault.on('create', reconcile));
		this.registerEvent(this.app.vault.on('delete', reconcile));
		this.registerEvent(this.app.vault.on('rename', reconcile));
	}

	/** Rebuild after notes are added/removed, unless the user is mid-edit. */
	private reconcile(): void {
		if (this.sections.some((s) => s.isDirty || s.isEditing)) return;
		const prevScroll = this.scrollEl.scrollTop;
		const prevCount = Math.max(this.loadedCount, this.settings.loadBatch);
		this.source.refresh();
		if (this.sentinelObserver) this.sentinelObserver.observe(this.sentinelEl);
		this.renderFromTop(prevCount);
		this.scrollEl.scrollTop = prevScroll;
	}
}
