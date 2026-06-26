/* eslint-disable @typescript-eslint/no-explicit-any */
import 'obsidian';
import type { TFile } from 'obsidian';

/**
 * Ambient declarations for the undocumented Obsidian internals we rely on to
 * instantiate a live Markdown editor inside an arbitrary container.
 *
 * These are intentionally loose (`any`) — they are not part of the public API
 * and can change between Obsidian releases. All usage is funnelled through
 * `editor/embeddable-editor.ts`, which guards every access with try/catch.
 */
declare module 'obsidian' {
	interface App {
		embedRegistry: {
			embedByExtension: Record<
				string,
				(ctx: { app: App; containerEl: HTMLElement }, file: TFile | null, subpath: string) => any
			>;
		};
		internalPlugins: {
			plugins: Record<string, any>;
			getPluginById(id: string): any;
		};
	}
}
