/** Compute full, immutable subway station locations away from the React thread. */
import { planSubwayClassicExpansions } from '../components/subwayClassicExpansion.js';

if (typeof self !== 'undefined' && typeof self.addEventListener === 'function') {
    self.addEventListener('message', (event) => {
        const { id, markers, options } = event.data || {};
        try {
            // All positions (including currently hidden stations) are reserved
            // once; subsequent +N clicks only reveal additional fixed slots.
            const revealAll = new Map((markers || []).map(m => [m.id, m.hidden.length]));
            const plan = planSubwayClassicExpansions(markers || [], revealAll, options);
            self.postMessage({ id, ok: true, plan: [...plan.entries()] });
        } catch (error) {
            self.postMessage({ id, ok: false, error: error?.message || String(error) });
        }
    });
}
