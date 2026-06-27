import { ItemView, Menu, TFile, WorkspaceLeaf, moment, setIcon } from 'obsidian';
import { BDN_CALENDAR_ICON, VIEW_TYPE_BDN_CALENDAR } from '../constants';
import { DailyNotesSource } from '../data/daily-notes-source';
import type BetterDailyNotesPlugin from '../main';

type Moment = ReturnType<typeof moment>;

const CELL_COUNT = 42; // 6 weeks × 7 days

/**
 * A month calendar in the sidebar. Marks today and days that have notes, and
 * clicking a day opens the infinite-scroll view scrolled to that date (creating
 * the note first if it doesn't exist). Highlights follow the infinite view's
 * scroll position via `setActiveDate()`.
 */
export class CalendarView extends ItemView {
	private plugin: BetterDailyNotesPlugin;
	private source: DailyNotesSource;

	private displayedMonth: Moment;
	private activeDate: Moment | null = null;

	/** Persistent shell elements, built once so the header never re-renders. */
	private titleEl!: HTMLElement;
	/** Month-navigation buttons (‹ today ›), shown when the picker is closed. */
	private monthControlsEl!: HTMLElement;
	/** Year-navigation buttons (‹ year ›), shown while the picker is open. */
	private yearControlsEl!: HTMLElement;
	private yearLabelEl!: HTMLElement;
	/** Forward-navigation arrows, disabled when "Show future" is off. */
	private nextMonthBtn!: HTMLElement;
	private nextYearBtn!: HTMLElement;
	/** Month view (weekday row + day grid); swapped with the picker pane. */
	private monthPaneEl!: HTMLElement;
	private weekdaysEl!: HTMLElement;
	private gridEl!: HTMLElement;
	/** Year view (month chooser); the other swappable pane. */
	private pickerEl!: HTMLElement;

	/** Year shown in the month picker, or null when the picker is closed. */
	private pickerYear: number | null = null;

	constructor(leaf: WorkspaceLeaf, plugin: BetterDailyNotesPlugin) {
		super(leaf);
		this.plugin = plugin;
		this.source = new DailyNotesSource(this.app, plugin.settings);
		this.displayedMonth = moment().startOf('month');
	}

	getViewType(): string {
		return VIEW_TYPE_BDN_CALENDAR;
	}

	getDisplayText(): string {
		return 'Daily notes calendar';
	}

	getIcon(): string {
		return BDN_CALENDAR_ICON;
	}

	async onOpen(): Promise<void> {
		this.source.refresh();
		this.buildShell();
		this.redraw();
		this.registerVaultEvents();
	}

	async onClose(): Promise<void> {
		this.contentEl.empty();
	}

	/** Re-read the note list and redraw the grid (called from vault events). */
	refresh(): void {
		this.source.refresh();
		this.redraw();
		if (this.pickerYear != null) this.renderPicker();
	}

	/** Highlight `date`, switching the displayed month if needed. */
	setActiveDate(date: Moment): void {
		const prev = this.activeDate;
		this.activeDate = date.clone();
		if (!date.isSame(this.displayedMonth, 'month')) {
			// New month: redraw the grid (the header/arrows stay put).
			this.displayedMonth = date.clone().startOf('month');
			this.redraw();
			return;
		}
		if (prev?.isSame(date, 'day')) return;
		// Same month: just move the highlight.
		this.updateActiveHighlight();
	}

	private updateActiveHighlight(): void {
		const key = this.activeDate?.format('YYYY-MM-DD') ?? null;
		this.gridEl.querySelectorAll('.bdn-cal-day').forEach((el) => {
			el.toggleClass('is-active', key != null && el.getAttr('data-day') === key);
		});
	}

	// --- rendering ---

	/** Build the static parts (header + weekday row + grid container) once. */
	private buildShell(): void {
		const root = this.contentEl;
		root.empty();
		root.addClass('bdn-calendar');

		const header = root.createDiv({ cls: 'bdn-cal-header' });
		// The title is a header-styled text label (see headerLabel) that doubles as a
		// button opening the month/year picker.
		this.titleEl = this.headerLabel(header, 'Jump to month', () => this.togglePicker());

		const controls = header.createDiv({ cls: 'bdn-cal-controls' });

		// Month navigation (default): ‹ Today ›.
		this.monthControlsEl = controls.createDiv({ cls: 'bdn-cal-controls-group' });
		this.iconButton(this.monthControlsEl, 'chevron-left', 'Previous month', () =>
			this.shiftMonth(-1),
		);
		// "Today" as a header-styled text label (opens today's note, which scrolls the
		// infinite view and re-syncs our month).
		this.headerLabel(this.monthControlsEl, 'Go to today', () =>
			void this.plugin.openDate(moment()),
		).setText('Today');
		this.nextMonthBtn = this.iconButton(this.monthControlsEl, 'chevron-right', 'Next month', () =>
			this.shiftMonth(1),
		);

		// Year navigation (while picking): ‹ 2026 ›, the year opening a dropdown.
		this.yearControlsEl = controls.createDiv({ cls: 'bdn-cal-controls-group' });
		this.iconButton(this.yearControlsEl, 'chevron-left', 'Previous year', () =>
			this.shiftPickerYear(-1),
		);
		// The year reads as a header-styled label too (matching the title/Today).
		this.yearLabelEl = this.headerLabel(this.yearControlsEl, 'Choose year', (e) =>
			this.openYearMenu(e),
		);
		this.nextYearBtn = this.iconButton(this.yearControlsEl, 'chevron-right', 'Next year', () =>
			this.shiftPickerYear(1),
		);
		this.yearControlsEl.hide();

		// The month view and the year picker are sibling panes that swap via
		// hide()/show(). Each is a `.workspace-leaf`, so whatever a theme does to
		// sidebar leaves when they become visible (e.g. a scale/fade entrance, like
		// when switching sidebar tabs) is naturally applied as we switch views — no
		// animation is defined by the plugin, and themes without one (e.g. default)
		// simply show no animation. See `.bdn-cal-pane` in styles.css.
		this.monthPaneEl = root.createDiv({ cls: 'bdn-cal-pane workspace-leaf' });
		this.weekdaysEl = this.monthPaneEl.createDiv({ cls: 'bdn-cal-weekdays' });
		const first = moment.localeData().firstDayOfWeek();
		const labels = moment.localeData().weekdaysMin();
		for (let i = 0; i < 7; i++) {
			// Single-letter labels (S M T W ...).
			this.weekdaysEl.createDiv({
				cls: 'bdn-cal-weekday',
				text: (labels[(first + i) % 7] ?? '').charAt(0),
			});
		}
		this.gridEl = this.monthPaneEl.createDiv({ cls: 'bdn-cal-grid' });

		// Year + month chooser, hidden until the title is clicked.
		this.pickerEl = root.createDiv({ cls: 'bdn-cal-picker bdn-cal-pane workspace-leaf' });
		this.pickerEl.hide();
	}

	/** Update the month title and rebuild the day cells. */
	private redraw(): void {
		this.titleEl.setText(this.displayedMonth.format('MMMM YYYY'));

		const grid = this.gridEl;
		grid.empty();
		const today = moment();

		// With "Show future" off, block stepping past the current month.
		const blockFuture = !this.plugin.settings.showFuture;
		this.setDisabled(this.nextMonthBtn, blockFuture && !this.displayedMonth.isBefore(today, 'month'));
		const first = moment.localeData().firstDayOfWeek();

		const start = this.displayedMonth.clone();
		const offset = (start.day() - first + 7) % 7;
		start.subtract(offset, 'days');

		for (let i = 0; i < CELL_COUNT; i++) {
			const date = start.clone().add(i, 'days');
			const cell = grid.createDiv({
				cls: 'bdn-cal-day',
				text: String(date.date()),
				attr: { 'data-day': date.format('YYYY-MM-DD') },
			});
			if (!date.isSame(this.displayedMonth, 'month')) {
				// Outside the current month: render as a blank spacer (no number, not clickable).
				cell.addClass('is-adjacent');
				continue;
			}
			const isToday = date.isSame(today, 'day');
			if (isToday) cell.addClass('is-today');
			if (this.activeDate && date.isSame(this.activeDate, 'day')) cell.addClass('is-active');
			const hasNote = this.source.entryOn(date) != null;
			if (hasNote) cell.addClass('has-note');

			// Days with a note are always clickable, as is today (so the current note
			// can always be created); other empty days only when the user has opted
			// into creating notes by clicking the calendar.
			if (hasNote || isToday || this.plugin.settings.allowCreateFromCalendar) {
				// Reuse Obsidian's interactive class so hover/press/shrink follow the theme.
				cell.addClass('clickable-icon');
				this.registerDomEvent(cell, 'click', () => void this.plugin.openDate(date));
			}
		}
	}

	/**
	 * Build a clickable text label styled like a backlinks pane section header
	 * ("LINKED MENTIONS"): theme-driven size/weight/casing/color plus the native
	 * hover background, inherited from `.backlink-pane > .tree-item-self` and its
	 * `.tree-item-inner` child. The host is a display:contents shell, present only
	 * to satisfy the `.backlink-pane >` parent. Returns the inner element, where
	 * the caller sets (and later updates) the text.
	 */
	private headerLabel(
		parent: HTMLElement,
		ariaLabel: string,
		onClick: (evt: MouseEvent) => void,
	): HTMLElement {
		const host = parent.createDiv({ cls: 'bdn-cal-headtext-host backlink-pane' });
		// `is-clickable` gives it the pane header's native hover background.
		const self = host.createDiv({ cls: 'bdn-cal-headtext tree-item-self is-clickable' });
		self.setAttr('aria-label', ariaLabel);
		this.registerDomEvent(self, 'click', onClick);
		return self.createDiv({ cls: 'bdn-cal-headtext-inner tree-item-inner' });
	}

	private iconButton(
		parent: HTMLElement,
		icon: string,
		label: string,
		onClick: () => void,
	): HTMLElement {
		const btn = parent.createDiv({ cls: 'clickable-icon', attr: { 'aria-label': label } });
		setIcon(btn, icon);
		this.registerDomEvent(btn, 'click', () => {
			if (btn.getAttr('aria-disabled') === 'true') return;
			onClick();
		});
		return btn;
	}

	/** Toggle a clickable-icon's disabled state (dimmed + non-interactive). */
	private setDisabled(btn: HTMLElement, disabled: boolean): void {
		btn.toggleClass('is-disabled', disabled);
		btn.setAttr('aria-disabled', disabled ? 'true' : 'false');
	}

	private shiftMonth(delta: number): void {
		this.displayedMonth = this.displayedMonth.clone().add(delta, 'months').startOf('month');
		this.redraw();
	}

	// --- month/year picker ---

	private togglePicker(): void {
		if (this.pickerYear == null) this.openPicker();
		else this.closePicker();
	}

	private openPicker(): void {
		this.pickerYear = this.displayedMonth.year();
		this.monthPaneEl.hide();
		this.monthControlsEl.hide();
		this.yearControlsEl.show();
		this.pickerEl.show();
		this.renderPicker();
	}

	private closePicker(): void {
		this.pickerYear = null;
		this.pickerEl.hide();
		this.yearControlsEl.hide();
		this.monthControlsEl.show();
		this.monthPaneEl.show();
	}

	private shiftPickerYear(delta: number): void {
		if (this.pickerYear == null) return;
		this.pickerYear += delta;
		this.renderPicker();
	}

	/** Pop up a list of years (those with notes, plus the current one) to jump to. */
	private openYearMenu(evt: MouseEvent): void {
		if (this.pickerYear == null) return;
		const set = new Set<number>(this.source.years());
		set.add(moment().year());
		set.add(this.pickerYear);
		const years = [...set].sort((a, b) => b - a);

		const menu = new Menu();
		for (const year of years) {
			menu.addItem((item) => {
				item.setTitle(String(year));
				item.setChecked(year === this.pickerYear);
				item.onClick(() => {
					this.pickerYear = year;
					this.renderPicker();
				});
			});
		}
		menu.showAtMouseEvent(evt);
	}

	/** Jump the day grid to the chosen month and leave the picker. */
	private pickMonth(month: Moment): void {
		this.displayedMonth = month.clone().startOf('month');
		this.closePicker();
		this.redraw();
	}

	/** Update the year label and draw the 12 month buttons (marking ones with notes). */
	private renderPicker(): void {
		const year = this.pickerYear ?? this.displayedMonth.year();
		this.yearLabelEl.setText(String(year));
		this.pickerEl.empty();

		const today = moment();
		// With "Show future" off, block stepping past the current year.
		this.setDisabled(this.nextYearBtn, !this.plugin.settings.showFuture && year >= today.year());
		const months = this.pickerEl.createDiv({ cls: 'bdn-cal-picker-months' });
		for (let m = 0; m < 12; m++) {
			const month = moment({ year, month: m, day: 1 });
			const cell = months.createDiv({
				cls: 'bdn-cal-picker-month',
				text: month.format('MMM'),
			});
			const isThisMonth = month.isSame(today, 'month');
			if (month.isSame(this.displayedMonth, 'month')) cell.addClass('is-active');
			const hasNote = this.source.hasEntryInMonth(month);
			if (hasNote) cell.addClass('has-note');

			// Mirror the day grid: only months with notes are clickable, as is the
			// current month; other empty months only when the user has opted into
			// creating notes from the calendar.
			if (hasNote || isThisMonth || this.plugin.settings.allowCreateFromCalendar) {
				cell.addClass('is-clickable');
				this.registerDomEvent(cell, 'click', () => this.pickMonth(month));
			}
		}
	}

	// --- vault reconciliation ---

	private registerVaultEvents(): void {
		const onChange = (file: unknown) => {
			if (!(file instanceof TFile) || file.extension !== 'md') return;
			if (!this.source.isDailyNote(file)) return;
			this.refresh();
		};
		this.registerEvent(this.app.vault.on('create', onChange));
		this.registerEvent(this.app.vault.on('delete', onChange));
		this.registerEvent(this.app.vault.on('rename', onChange));
	}
}
