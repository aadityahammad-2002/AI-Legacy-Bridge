// Runs inside each Vitest worker before tests, unlike assignments made
// directly in vitest.config.js (which only run in the main/config process
// and don't propagate to worker threads — that's why setting this in the
// config file didn't silence the "not configured for act()" warning).
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
