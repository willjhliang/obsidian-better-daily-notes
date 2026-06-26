import { App, PluginSettingTab, Setting, moment } from 'obsidian';
import type BetterDailyNotesPlugin from './main';
import { FileSuggest, FolderSuggest } from './ui/path-suggest';

export interface BetterDailyNotesSettings {
	/** Editable inline title shown at the top of the view; also the tab name. */
	pageTitle: string;

	/** Moment.js format used to name (and detect) daily-note files. */
	dateFormat: string;
	/** Folder new daily notes live in (and are scanned for). */
	folder: string;
	/** Template file applied to new notes; empty for none. */
	template: string;

	/** Whether the month calendar is shown in the right sidebar. */
	calendarEnabled: boolean;
	/** Allow clicking a calendar day without a note to create one. */
	allowCreateFromCalendar: boolean;
	/** Allow navigating past today; when off, the forward arrows are disabled. */
	showFuture: boolean;

	/** Moment.js format for each day's header (display only). */
	headerDateFormat: string;
	/** How many older notes to load per batch as you scroll. */
	loadBatch: number;
	/** Max number of simultaneously-live editors (windowing cap). */
	maxLiveEditors: number;
}

/** Preset date formats offered in the dropdown; anything else is "Custom". */
const PRESET_DATE_FORMATS = ['YYYY-MM-DD', 'YYYY.MM.DD', 'YYYY/MM/DD', 'YYYY/MM/YYYY-MM-DD'];

export const DEFAULT_SETTINGS: BetterDailyNotesSettings = {
	pageTitle: 'Daily Notes',
	dateFormat: 'YYYY-MM-DD',
	folder: 'Daily/Entries',
	template: 'Templates/Daily Note Template',
	calendarEnabled: true,
	allowCreateFromCalendar: false,
	showFuture: false,
	headerDateFormat: 'dddd, MMMM D, YYYY',
	loadBatch: 10,
	maxLiveEditors: 5,
};

export class BetterDailyNotesSettingTab extends PluginSettingTab {
	plugin: BetterDailyNotesPlugin;

	constructor(app: App, plugin: BetterDailyNotesPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	/**
	 * Fill a setting's description with the shared moment.js format hint (a syntax
	 * link plus an accent-colored live sample). Returns a function that re-renders
	 * the sample for a given format, falling back to `fallback` when empty.
	 */
	private addFormatHint(setting: Setting, fallback: string): (value: string) => void {
		setting.descEl.empty();
		setting.descEl.appendText('For more syntax, refer to ');
		setting.descEl.createEl('a', {
			// eslint-disable-next-line obsidianmd/ui/sentence-case -- inline link text within a sentence
			text: 'format reference',
			href: 'https://momentjs.com/docs/#/displaying/format/',
		});
		setting.descEl.appendText('.');
		setting.descEl.createEl('br');
		setting.descEl.appendText('Your current syntax looks like this: ');
		const sample = setting.descEl.createEl('b', { cls: 'bdn-format-sample' });
		return (value: string) => sample.setText(moment().format(value || fallback));
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();

		// --- Daily notes (mirrors the core Daily Notes plugin) ---
		const dateFmt = new Setting(containerEl)
			.setName('Date format')
			.setDesc('Choose how daily notes are named in your vault.');

		// "Custom format" row, revealed only when "Custom" is picked above. Holds the
		// raw moment.js format input plus a live sample and a syntax reference.
		const customSetting = new Setting(containerEl).setName('Custom format');
		const renderSample = this.addFormatHint(customSetting, DEFAULT_SETTINGS.dateFormat);
		renderSample(this.plugin.settings.dateFormat);
		customSetting.addText((text) =>
			text
				// eslint-disable-next-line obsidianmd/ui/sentence-case -- moment.js format token
				.setPlaceholder('YYYY-MM-DD')
				.setValue(this.plugin.settings.dateFormat)
				.onChange(async (value) => {
					this.plugin.settings.dateFormat = value || DEFAULT_SETTINGS.dateFormat;
					renderSample(value);
					await this.plugin.saveSettings();
					this.plugin.refreshViews();
				}),
		);

		dateFmt.addDropdown((dropdown) => {
			// Label each preset with how today's date renders under it (e.g. 2026-06-25).
			for (const fmt of PRESET_DATE_FORMATS) dropdown.addOption(fmt, moment().format(fmt));
			dropdown.addOption('custom', 'Custom');

			const isPreset = PRESET_DATE_FORMATS.includes(this.plugin.settings.dateFormat);
			dropdown.setValue(isPreset ? this.plugin.settings.dateFormat : 'custom');
			customSetting.settingEl.toggle(!isPreset);

			dropdown.onChange(async (value) => {
				if (value === 'custom') {
					// Reveal the field and keep the existing format until they edit it.
					customSetting.settingEl.toggle(true);
					return;
				}
				customSetting.settingEl.toggle(false);
				this.plugin.settings.dateFormat = value;
				renderSample(value);
				await this.plugin.saveSettings();
				this.plugin.refreshViews();
			});
		});

		new Setting(containerEl)
			.setName('New file location')
			.setDesc('New daily notes will be placed here.')
			.addText((text) => {
				text
					.setPlaceholder('Example: Daily')
					.setValue(this.plugin.settings.folder)
					.onChange(async (value) => {
						this.plugin.settings.folder = value.trim();
						await this.plugin.saveSettings();
						this.plugin.refreshViews();
					});
				new FolderSuggest(this.app, text.inputEl);
			});

		new Setting(containerEl)
			.setName('Template file location')
			.setDesc('Choose the file to use as a template.')
			.addText((text) => {
				text
					// eslint-disable-next-line obsidianmd/ui/sentence-case -- template file path
					.setPlaceholder('Example: Templates/Daily Note Template')
					.setValue(this.plugin.settings.template)
					.onChange(async (value) => {
						this.plugin.settings.template = value.trim();
						await this.plugin.saveSettings();
					});
				new FileSuggest(this.app, text.inputEl);
			});

		// --- Calendar ---
		new Setting(containerEl).setName('Calendar').setHeading();

		new Setting(containerEl)
			.setName('Show calendar')
			.setDesc('Show the month calendar in the right sidebar.')
			.addToggle((toggle) =>
				toggle.setValue(this.plugin.settings.calendarEnabled).onChange(async (value) => {
					this.plugin.settings.calendarEnabled = value;
					await this.plugin.saveSettings();
					this.plugin.applyCalendarSetting();
				}),
			);

		new Setting(containerEl)
			.setName('Create notes from calendar')
			.setDesc('Create notes by clicking previous dates on the calendar.')
			.addToggle((toggle) =>
				toggle
					.setValue(this.plugin.settings.allowCreateFromCalendar)
					.onChange(async (value) => {
						this.plugin.settings.allowCreateFromCalendar = value;
						await this.plugin.saveSettings();
						this.plugin.refreshViews();
					}),
			);

		new Setting(containerEl)
			.setName('Show future')
			.setDesc('Show future dates in the calendar.')
			.addToggle((toggle) =>
				toggle.setValue(this.plugin.settings.showFuture).onChange(async (value) => {
					this.plugin.settings.showFuture = value;
					await this.plugin.saveSettings();
					this.plugin.refreshViews();
				}),
			);

		// --- Advanced ---
		new Setting(containerEl).setName('Advanced').setHeading();

		const headerFmt = new Setting(containerEl).setName('Day header format');
		const renderHeaderSample = this.addFormatHint(headerFmt, DEFAULT_SETTINGS.headerDateFormat);
		renderHeaderSample(this.plugin.settings.headerDateFormat);
		headerFmt.addText((text) =>
			text
				// eslint-disable-next-line obsidianmd/ui/sentence-case -- moment.js format token
				.setPlaceholder('dddd, MMMM D, YYYY')
				.setValue(this.plugin.settings.headerDateFormat)
				.onChange(async (value) => {
					this.plugin.settings.headerDateFormat = value || DEFAULT_SETTINGS.headerDateFormat;
					renderHeaderSample(value);
					await this.plugin.saveSettings();
					this.plugin.refreshViews();
				}),
		);

		new Setting(containerEl)
			.setName('Notes loaded per batch')
			.setDesc('How many older notes to fetch each time you scroll to the bottom.')
			.addSlider((slider) =>
				slider
					.setLimits(5, 40, 5)
					.setValue(this.plugin.settings.loadBatch)
					.onChange(async (value) => {
						this.plugin.settings.loadBatch = value;
						await this.plugin.saveSettings();
					}),
			);

		new Setting(containerEl)
			.setName('Max live editors')
			.setDesc('Upper bound on simultaneously-editable days. Lower it if you hit performance issues.')
			.addSlider((slider) =>
				slider
					.setLimits(2, 12, 1)
					.setValue(this.plugin.settings.maxLiveEditors)
					.onChange(async (value) => {
						this.plugin.settings.maxLiveEditors = value;
						await this.plugin.saveSettings();
					}),
			);
	}
}
