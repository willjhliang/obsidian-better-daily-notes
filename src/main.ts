import { Plugin, WorkspaceLeaf, moment } from 'obsidian';
import {
	BetterDailyNotesSettings,
	BetterDailyNotesSettingTab,
	DEFAULT_SETTINGS,
} from './settings';
import { BDN_ICON, VIEW_TYPE_BDN, VIEW_TYPE_BDN_CALENDAR } from './constants';
import { InfiniteScrollView } from './view/infinite-scroll-view';
import { CalendarView } from './view/calendar-view';

type Moment = ReturnType<typeof moment>;

export default class BetterDailyNotesPlugin extends Plugin {
	settings!: BetterDailyNotesSettings;

	async onload() {
		await this.loadSettings();

		this.registerView(VIEW_TYPE_BDN, (leaf) => new InfiniteScrollView(leaf, this));
		this.registerView(VIEW_TYPE_BDN_CALENDAR, (leaf) => new CalendarView(leaf, this));

		this.addRibbonIcon(BDN_ICON, 'Open daily notes', () => void this.activateView());

		this.addCommand({
			id: 'open-infinite-daily-notes',
			name: 'Open daily notes',
			callback: () => void this.activateView(),
		});

		this.addCommand({
			id: 'open-daily-notes-calendar',
			name: 'Open daily notes calendar',
			callback: () => void this.activateCalendarView(),
		});

		this.addCommand({
			id: 'open-todays-daily-note',
			name: "Open today's daily note",
			callback: () => void this.openDate(moment()),
		});

		this.addSettingTab(new BetterDailyNotesSettingTab(this.app, this));

		// Show the calendar's in-view (grey) day highlight only while the daily
		// notes view is the focused main-area tab. Sidebar focus changes (e.g.
		// clicking the calendar itself) are ignored so they don't toggle it.
		this.registerEvent(
			this.app.workspace.on('active-leaf-change', (leaf) => {
				if (!leaf || leaf.getRoot() !== this.app.workspace.rootSplit) return;
				this.setCalendarActiveVisible(leaf.view instanceof InfiniteScrollView);
			}),
		);

		// Auto-open the calendar in the right sidebar once the workspace is ready,
		// unless the user has turned it off.
		this.app.workspace.onLayoutReady(() => {
			if (
				this.settings.calendarEnabled &&
				this.app.workspace.getLeavesOfType(VIEW_TYPE_BDN_CALENDAR).length === 0
			) {
				void this.activateCalendarView();
			}
		});
	}

	onunload() {
		// Per Obsidian guidance, don't detach leaves on unload — the view's
		// onClose() handles teardown of editors and observers.
	}

	/** Open the infinite-scroll view, reusing an existing leaf if present. */
	async activateView(): Promise<void> {
		const { workspace } = this.app;
		let leaf: WorkspaceLeaf | null = workspace.getLeavesOfType(VIEW_TYPE_BDN)[0] ?? null;
		if (!leaf) {
			leaf = workspace.getLeaf(true);
			await leaf.setViewState({ type: VIEW_TYPE_BDN, active: true });
		}
		await workspace.revealLeaf(leaf);
	}

	/** Open or detach the calendar sidebar to match the `calendarEnabled` setting. */
	applyCalendarSetting(): void {
		const leaves = this.app.workspace.getLeavesOfType(VIEW_TYPE_BDN_CALENDAR);
		if (this.settings.calendarEnabled) {
			if (leaves.length === 0) void this.activateCalendarView();
		} else {
			for (const leaf of leaves) leaf.detach();
		}
	}

	/** Open the calendar view in the right sidebar, reusing an existing leaf. */
	async activateCalendarView(): Promise<void> {
		const { workspace } = this.app;
		let leaf: WorkspaceLeaf | null = workspace.getLeavesOfType(VIEW_TYPE_BDN_CALENDAR)[0] ?? null;
		if (!leaf) {
			leaf = workspace.getRightLeaf(false);
			if (!leaf) return;
			await leaf.setViewState({ type: VIEW_TYPE_BDN_CALENDAR, active: false });
		}
		await workspace.revealLeaf(leaf);
	}

	/** Open the infinite-scroll view and scroll it to `date` (creating the note). */
	async openDate(date: Moment): Promise<void> {
		await this.activateView();
		const leaf = this.app.workspace.getLeavesOfType(VIEW_TYPE_BDN)[0];
		const view = leaf?.view;
		if (view instanceof InfiniteScrollView) await view.revealDate(date);
	}

	/** Forward the infinite view's scrolled-to day to any open calendar(s). */
	notifyActiveDate(date: Moment): void {
		for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE_BDN_CALENDAR)) {
			const view = leaf.view;
			if (view instanceof CalendarView) view.setActiveDate(date);
		}
	}

	/** Toggle the in-view day highlight in any open calendar(s). */
	setCalendarActiveVisible(visible: boolean): void {
		for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE_BDN_CALENDAR)) {
			const view = leaf.view;
			if (view instanceof CalendarView) view.setActiveVisible(visible);
		}
	}

	/** Push current settings into any open views (called from the settings tab). */
	refreshViews(): void {
		for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE_BDN)) {
			const view = leaf.view;
			if (view instanceof InfiniteScrollView) view.applySettings();
		}
		for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE_BDN_CALENDAR)) {
			const view = leaf.view;
			if (view instanceof CalendarView) view.refresh();
		}
	}

	async loadSettings() {
		this.settings = Object.assign(
			{},
			DEFAULT_SETTINGS,
			(await this.loadData()) as Partial<BetterDailyNotesSettings>,
		);
	}

	async saveSettings() {
		await this.saveData(this.settings);
	}
}
