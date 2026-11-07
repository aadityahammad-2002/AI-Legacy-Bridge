import { afterEach, describe, expect, it, vi } from 'vitest';
import { askAi } from './backend.js';

afterEach(() => {
    vi.unstubAllGlobals();
});

describe('AI Explorer request contract', () => {
    it('sends the active chat session identifier to Python', async () => {
        let body;
        vi.stubGlobal('fetch', vi.fn(async (_url, options) => {
            body = JSON.parse(options.body);
            return { ok: true, json: async () => ({ answer: 'ok', sourceFiles: [] }) };
        }));
        await askAi('repo-1', 'Where?', null, null, 'normal', 's_123_abc');
        expect(body.sessionId).toBe('s_123_abc');
        expect(body.persona).toBe('normal');
    });

    it('uses FastAPI detail messages for non-2xx errors', async () => {
        vi.stubGlobal('fetch', vi.fn(async () => ({
            ok: false, status: 429, json: async () => ({ detail: 'Rate limit exceeded' }),
        })));
        await expect(askAi('repo-1', 'Hello')).rejects.toThrow('Rate limit exceeded');
    });
});
