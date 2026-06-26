/*
 * This module deliberately reaches into undocumented Obsidian internals to
 * recover the live Markdown editor class. The unsafe-any lint rules are
 * disabled here only — every access is guarded at runtime with try/catch.
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
/* eslint-disable @typescript-eslint/no-unsafe-member-access */
/* eslint-disable @typescript-eslint/no-unsafe-call */
/* eslint-disable @typescript-eslint/no-unsafe-assignment */
/* eslint-disable @typescript-eslint/no-unsafe-return */
import { App, TFile } from 'obsidian';
import { EditorView, placeholder } from '@codemirror/view';

/**
 * A live, fully-featured Obsidian Markdown editor embedded inside an arbitrary
 * HTMLElement. This is the load-bearing trick of the plugin: it reuses the same
 * editor Obsidian renders inside note embeds (CodeMirror 6 with link
 * autocomplete, slash commands and every registered editor extension), so each
 * day in the infinite-scroll view edits exactly like a normal note.
 *
 * The editor class is not part of Obsidian's public API. We recover it at
 * runtime from the embed registry (see {@link resolveEditorBase}). Everything
 * here is defensive — if the internal shape changes, construction throws and
 * the caller falls back to a read-only rendered preview.
 */

export interface EmbeddableEditorOptions {
	value: string;
	placeholder?: string;
	cls?: string;
	/** Fired (un-debounced) on every document change. */
	onChange?: (value: string) => void;
	/** Fired when the editor loses focus. */
	onBlur?: (value: string) => void;
}

/** Cached dynamic subclass of the resolved internal MarkdownEditor. */
let CachedEditorClass: (new (app: App, container: HTMLElement, owner: any) => any) | null = null;
/** Set once we know the internal API is unavailable, to avoid retrying. */
let resolutionFailed = false;

/**
 * Recover the internal MarkdownEditor constructor by briefly spinning up the
 * editor Obsidian uses for markdown embeds, then walking its prototype chain.
 */
function resolveEditorBase(app: App): new (...args: any[]) => any {
	const createEmbed = app.embedRegistry?.embedByExtension?.md;
	if (typeof createEmbed !== 'function') {
		throw new Error('embedRegistry.embedByExtension.md is unavailable');
	}
	const widget = createEmbed({ app, containerEl: createDiv() }, null, '');
	widget.load?.();
	widget.editable = true;
	widget.showEditor?.();
	// editMode is an instance of the MarkdownEditor; its grandparent prototype is
	// the base class we want to subclass.
	const base = Object.getPrototypeOf(Object.getPrototypeOf(widget.editMode));
	widget.unload?.();
	return base.constructor as new (...args: any[]) => any;
}

function buildEditorClass(app: App): new (app: App, container: HTMLElement, owner: any) => any {
	if (CachedEditorClass) return CachedEditorClass;
	const Base = resolveEditorBase(app);

	CachedEditorClass = class EmbeddedMarkdownEditorImpl extends Base {
		/** Back-reference to our wrapper. NOT named `owner` — the base stores its
		 *  own `this.owner` (the 3rd super() arg) and reads it to decide editor
		 *  mode / live preview; clobbering it forces raw source rendering. */
		bdn!: EmbeddableMarkdownEditor;
		options!: EmbeddableEditorOptions;
		/** True only while the initial content loads, to suppress onChange. */
		private _initializing = false;

		constructor(app: App, container: HTMLElement, wrapper: EmbeddableMarkdownEditor) {
			super(app, container, {
				app,
				onMarkdownScroll: () => {},
				getMode: () => 'source',
			});
			this.bdn = wrapper;
			this.options = wrapper.options;

			// Present ourselves to the base's owner object as its live editor, the
			// same wiring a real MarkdownView does. This is what makes the embedded
			// editor render in Live Preview rather than plain source.
			this.owner.editMode = this;
			this.owner.editor = this.editor;

			this._initializing = true;
			this.set(this.options.value || '', true);
			this._initializing = false;

			const contentDOM: HTMLElement | undefined = this.editor?.cm?.contentDOM;
			if (contentDOM) {
				contentDOM.addEventListener('focusin', () => {
					this.app.workspace.activeEditor = this.owner;
				});
				contentDOM.addEventListener('blur', () => {
					if (this._loaded) this.bdn.handleBlur();
				});
			}
			if (this.options.cls) this.editorEl?.classList.add(this.options.cls);
		}

		// Called by the base when assembling the editor's CM extensions, once
		// `this.options` is set (during the `set()` above), so options are ready.
		buildLocalExtensions(): unknown[] {
			const extensions: unknown[] = super.buildLocalExtensions?.() ?? [];
			if (this.options?.placeholder) extensions.push(placeholder(this.options.placeholder));
			extensions.push(
				EditorView.updateListener.of((update) => {
					if (update.docChanged && !this._initializing && this.bdn) this.bdn.handleChange();
				}),
			);
			return extensions;
		}

		destroy() {
			if (this._loaded) this.unload();
			this.containerEl?.empty?.();
			super.destroy?.();
		}

		onunload() {
			super.onunload?.();
			this.destroy();
		}
	};

	return CachedEditorClass;
}

function getCM(instance: any): EditorView | null {
	return (instance?.editor?.cm ?? instance?.cm ?? null) as EditorView | null;
}

export class EmbeddableMarkdownEditor {
	readonly options: EmbeddableEditorOptions;
	private instance: any = null;

	constructor(app: App, container: HTMLElement, _file: TFile | null, options: EmbeddableEditorOptions) {
		this.options = options;
		const Clazz = buildEditorClass(app);
		this.instance = new Clazz(app, container, this);
		// Load the editor component so its live-preview view plugins activate.
		this.instance.load?.();
	}

	/** Whether the internal editor API is available in this Obsidian build. */
	static isSupported(app: App): boolean {
		if (CachedEditorClass) return true;
		if (resolutionFailed) return false;
		try {
			buildEditorClass(app);
			return true;
		} catch (e) {
			resolutionFailed = true;
			console.warn('[better-daily-notes] live editor unavailable, falling back to preview:', e);
			return false;
		}
	}

	get value(): string {
		const cm = getCM(this.instance);
		if (cm) return cm.state.doc.toString();
		return this.instance?.get?.() ?? '';
	}

	set value(v: string) {
		const cm = getCM(this.instance);
		if (cm) {
			cm.dispatch({ changes: { from: 0, to: cm.state.doc.length, insert: v } });
		} else {
			this.instance?.set?.(v, true);
		}
	}

	get hasFocus(): boolean {
		return getCM(this.instance)?.hasFocus ?? false;
	}

	focus() {
		getCM(this.instance)?.focus();
	}

	/** @internal called by the dynamic subclass */
	handleChange() {
		this.options.onChange?.(this.value);
	}

	/** @internal called by the dynamic subclass */
	handleBlur() {
		this.options.onBlur?.(this.value);
	}

	destroy() {
		try {
			this.instance?.destroy?.();
		} catch {
			/* ignore teardown errors */
		}
		this.instance = null;
	}
}
