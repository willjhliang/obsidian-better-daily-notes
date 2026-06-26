export const VIEW_TYPE_BDN = 'better-daily-notes-infinite';
export const VIEW_TYPE_BDN_CALENDAR = 'better-daily-notes-calendar';

/** Lucide icon used for the ribbon button and the view tab. */
export const BDN_ICON = 'calendar-days';

/** Lucide icon used for the calendar sidebar view. */
export const BDN_CALENDAR_ICON = 'calendar';

/** Debounce (ms) for pushing the scrolled-to "active" day back to the calendar. */
export const ACTIVE_DATE_DEBOUNCE_MS = 120;

/** Vertical gap (px) below the viewport top for the active/jumped-to day. */
export const ACTIVE_DATE_OFFSET_PX = 64;

/** How many older notes to fetch each time the bottom sentinel is reached. */
export const LOAD_BATCH = 10;

/** Debounce window (ms) for writing editor changes back to disk. */
export const SAVE_DEBOUNCE_MS = 400;

/**
 * Margin (px) added around the scroll viewport when deciding which sections get
 * a live editor vs. a cheap rendered preview vs. a frozen placeholder.
 */
export const NEAR_MARGIN_PX = 400;
export const MID_MARGIN_PX = 1500;

/** Margin used by the bottom sentinel so older notes load before the edge is hit. */
export const SENTINEL_MARGIN = '600px';
