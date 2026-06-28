import 'obsidian';
import type { App, TFile } from 'obsidian';

/**
 * Ambient declarations for the undocumented Obsidian internals we rely on to
 * instantiate a live Markdown editor inside an arbitrary container.
 *
 * These are intentionally minimal and may change between Obsidian releases —
 * they are not part of the public API. All usage is funnelled through
 * `editor/embeddable-editor.ts`, which guards every access with try/catch.
 */
declare module 'obsidian' {
	interface App {
		embedRegistry: EmbedRegistry;
	}
}

/** Factory Obsidian registers per file extension to render an embed. */
export type EmbedCreator = (
	ctx: { app: App; containerEl: HTMLElement },
	file: TFile | null,
	subpath: string,
) => MarkdownEmbedWidget;

export interface EmbedRegistry {
	embedByExtension: Record<string, EmbedCreator>;
}

/** The slice of the markdown embed widget we touch while recovering the editor. */
export interface MarkdownEmbedWidget {
	editable?: boolean;
	/** Instance of the internal MarkdownEditor once `showEditor()` has run. */
	editMode?: object;
	load?(): void;
	unload?(): void;
	showEditor?(): void;
}
