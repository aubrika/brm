// Build-time constants injected by Vite `define` (see vite.config.ts). In a plain `tsc` context
// (tests, editor) they resolve to these declarations; in the bundle they are replaced by literals.
declare const __APP_VERSION__: string;
declare const __APP_COMMIT__: string;
/** 'v2' = the delivered grid game; 'v1' = the legacy falling-lanes keyboard demo. */
declare const __APP_VARIANT__: string;
