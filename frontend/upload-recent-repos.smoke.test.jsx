import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createRoot } from 'react-dom/client';
import { act } from 'react';
import { fireEvent } from '@testing-library/dom';
import React from 'react';

const { mockListRepositories, mockGetRepositoryDetail, mockIngestAnalysis, mockDeleteRepository,
        mockLoadAnalysisSnapshot, mockSaveAnalysisSnapshot, mockSetActiveSession } = vi.hoisted(() => ({
    mockListRepositories: vi.fn(),
    mockGetRepositoryDetail: vi.fn(),
    mockIngestAnalysis: vi.fn(),
    mockDeleteRepository: vi.fn(),
    mockLoadAnalysisSnapshot: vi.fn(),
    mockSaveAnalysisSnapshot: vi.fn(),
    mockSetActiveSession: vi.fn(),
}));

vi.mock('./src/api/backend.js', () => ({
    listRepositories: (...args) => mockListRepositories(...args),
    getRepositoryDetail: (...args) => mockGetRepositoryDetail(...args),
    ingestAnalysis: (...args) => mockIngestAnalysis(...args),
    deleteRepository: (...args) => mockDeleteRepository(...args),
    askAi: vi.fn(),
}));

vi.mock('./src/session/session.js', () => ({
    loadAnalysisSnapshot: (...args) => mockLoadAnalysisSnapshot(...args),
    saveAnalysisSnapshot: (...args) => mockSaveAnalysisSnapshot(...args),
    setActiveSession: (...args) => mockSetActiveSession(...args),
    getActiveRepositoryId: vi.fn(),
    getCurrentWorkspace: vi.fn(),
    setCurrentWorkspace: vi.fn(),
    exitRepository: vi.fn(),
    clearAnalysisSnapshot: vi.fn(),
}));

// These tests only exercise the duplicate-detection/reopen logic, not a full
// analysis run — mock the repo sources so a test that proceeds past the
// duplicate check (the "no match" case) can't make a real network call.
vi.mock('./src/repo-sources/github.js', () => ({
    fetchGitHubRepository: vi.fn().mockRejectedValue(new Error('not exercised in this test file')),
    parseGitHubUrl: vi.fn(),
}));
vi.mock('./src/repo-sources/zip.js', () => ({ readZipRepository: vi.fn() }));
vi.mock('./src/repo-sources/localFolder.js', () => ({
    readLocalFolderFromInput: vi.fn(),
    pickAndReadLocalFolder: vi.fn(),
    isFileSystemAccessSupported: () => false,
}));

import UploadPage from './src/pages/UploadPage.jsx';

const recentReposFixture = [
    {
        id: 'repo-abc',
        name: 'demo-repo',
        source: 'github',
        url: 'https://github.com/someuser/demo-repo',
        healthScore: 88,
        healthGrade: 'A',
        createdAt: new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString(), // 3h ago
    },
    {
        id: 'repo-def',
        name: 'other-repo',
        source: 'zip',
        url: null,
        healthScore: 60,
        healthGrade: 'C',
        createdAt: new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString(), // 2d ago
    },
];

function renderAndFlush(element) {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    act(() => {
        root.render(element);
    });
    return { container, root };
}

beforeEach(() => {
    vi.clearAllMocks();
});

describe('UploadPage — Recent Repositories', () => {
    it('fetches and renders the recent repositories list on mount', async () => {
        mockListRepositories.mockResolvedValueOnce(recentReposFixture);

        const { container, root } = renderAndFlush(
            React.createElement(UploadPage, { onAnalysisComplete: () => {} })
        );
        await act(async () => { await new Promise((r) => setTimeout(r, 0)); });

        expect(mockListRepositories).toHaveBeenCalledOnce();
        expect(container.textContent).toContain('demo-repo');
        expect(container.textContent).toContain('other-repo');
        expect(container.textContent).toContain('A'); // health grade
        expect(container.textContent).toContain('3h ago');

        root.unmount();
    });

    it('reopens a repo from the list using the local IndexedDB snapshot when available (no backend call)', async () => {
        mockListRepositories.mockResolvedValueOnce(recentReposFixture);
        const localSnapshot = { repository: { name: 'demo-repo', source: 'github' }, files: [], fileContents: { 'a.js': 'x' } };
        mockLoadAnalysisSnapshot.mockResolvedValueOnce(localSnapshot);

        let completedWith = null;
        const { container, root } = renderAndFlush(
            React.createElement(UploadPage, { onAnalysisComplete: (args) => { completedWith = args; } })
        );
        await act(async () => { await new Promise((r) => setTimeout(r, 0)); });

        const item = [...container.querySelectorAll('.recent-repo-item__open')].find((el) => el.textContent.includes('demo-repo'));
        await act(async () => {
            item.click();
            await new Promise((r) => setTimeout(r, 0));
        });

        expect(mockLoadAnalysisSnapshot).toHaveBeenCalledWith('repo-abc');
        expect(mockGetRepositoryDetail).not.toHaveBeenCalled(); // fast path — no backend reconstruction needed
        expect(mockSetActiveSession).toHaveBeenCalledWith('repo-abc', 'visualization');
        expect(completedWith).toBeTruthy();
        expect(completedWith.repositoryId).toBe('repo-abc');
        expect(completedWith.analysisResult).toBe(localSnapshot);

        root.unmount();
    });

    it('falls back to reconstructing from the backend when no local snapshot exists', async () => {
        mockListRepositories.mockResolvedValueOnce(recentReposFixture);
        mockLoadAnalysisSnapshot.mockResolvedValueOnce(null); // not in this browser's IndexedDB
        const backendDetail = {
            repository: { name: 'other-repo', source: 'zip' },
            files: [
                { path: 'src/main.js', language: 'javascript', loc: 10, content: 'console.log("hi");' },
                { path: 'src/legacy.js', language: 'javascript', loc: 5, content: null }, // ingested before Task 6 — no stored source
            ],
            functions: [],
        };
        mockGetRepositoryDetail.mockResolvedValueOnce(backendDetail);

        let completedWith = null;
        const { container, root } = renderAndFlush(
            React.createElement(UploadPage, { onAnalysisComplete: (args) => { completedWith = args; } })
        );
        await act(async () => { await new Promise((r) => setTimeout(r, 0)); });

        const item = [...container.querySelectorAll('.recent-repo-item__open')].find((el) => el.textContent.includes('other-repo'));
        await act(async () => {
            item.click();
            await new Promise((r) => setTimeout(r, 0));
        });

        expect(mockGetRepositoryDetail).toHaveBeenCalledWith('repo-def');
        // Task 6: the backend now stores real file content, so the reopened
        // snapshot must build a working `fileContents` map for AI Explorer's
        // editor from it — files with null content (pre-Task-6 data) are
        // simply omitted rather than included as broken/empty entries.
        const expectedSnapshot = {
            ...backendDetail,
            fileContents: { 'src/main.js': 'console.log("hi");' },
        };
        expect(mockSaveAnalysisSnapshot).toHaveBeenCalledWith('repo-def', expectedSnapshot);
        expect(completedWith.analysisResult).toEqual(expectedSnapshot);

        root.unmount();
    });

    it('detects a duplicate GitHub URL and offers to open the existing analysis instead of re-analyzing', async () => {
        mockListRepositories.mockResolvedValueOnce(recentReposFixture);

        const { container, root } = renderAndFlush(
            React.createElement(UploadPage, { onAnalysisComplete: () => {} })
        );
        await act(async () => { await new Promise((r) => setTimeout(r, 0)); });

        const urlInput = container.querySelector('#github-url');
        act(() => {
            fireEvent.change(urlInput, { target: { value: 'https://github.com/someuser/demo-repo.git' } }); // trailing .git — should still match
        });

        const analyzeBtn = container.querySelector('.upload-card__analyze-btn');
        act(() => { analyzeBtn.click(); });

        expect(container.textContent).toContain('already analyzed');
        expect(container.querySelector('.upload-duplicate__open-btn')).toBeTruthy();
        expect(container.querySelector('.upload-duplicate__reanalyze-btn')).toBeTruthy();

        root.unmount();
    });

    it('does not flag a duplicate for a URL that does not match any recent repository', async () => {
        mockListRepositories.mockResolvedValueOnce(recentReposFixture);

        const { container, root } = renderAndFlush(
            React.createElement(UploadPage, { onAnalysisComplete: () => {} })
        );
        await act(async () => { await new Promise((r) => setTimeout(r, 0)); });

        const urlInput = container.querySelector('#github-url');
        act(() => {
            fireEvent.change(urlInput, { target: { value: 'https://github.com/someone-else/unrelated-repo' } });
        });

        const analyzeBtn = container.querySelector('.upload-card__analyze-btn');
        act(() => { analyzeBtn.click(); });

        expect(container.textContent).not.toContain('already analyzed');

        root.unmount();
    });

    it('deletes a repository after confirmation and removes it from the list without navigating away', async () => {
        mockListRepositories.mockResolvedValueOnce(recentReposFixture);
        mockDeleteRepository.mockResolvedValueOnce(undefined);
        const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true);

        const { container, root } = renderAndFlush(
            React.createElement(UploadPage, { onAnalysisComplete: () => {} })
        );
        await act(async () => { await new Promise((r) => setTimeout(r, 0)); });

        expect(container.textContent).toContain('demo-repo');

        const deleteBtn = container.querySelector('.recent-repo-item__icon-btn--danger');
        await act(async () => {
            deleteBtn.click();
            await new Promise((r) => setTimeout(r, 0));
        });

        expect(confirmSpy).toHaveBeenCalled();
        expect(mockDeleteRepository).toHaveBeenCalledWith('repo-abc');
        expect(container.textContent).not.toContain('demo-repo');
        expect(container.textContent).toContain('other-repo'); // untouched

        confirmSpy.mockRestore();
        root.unmount();
    });

    it('does not delete when the confirmation is declined', async () => {
        mockListRepositories.mockResolvedValueOnce(recentReposFixture);
        const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(false);

        const { container, root } = renderAndFlush(
            React.createElement(UploadPage, { onAnalysisComplete: () => {} })
        );
        await act(async () => { await new Promise((r) => setTimeout(r, 0)); });

        const deleteBtn = container.querySelector('.recent-repo-item__icon-btn--danger');
        await act(async () => {
            deleteBtn.click();
            await new Promise((r) => setTimeout(r, 0));
        });

        expect(mockDeleteRepository).not.toHaveBeenCalled();
        expect(container.textContent).toContain('demo-repo');

        confirmSpy.mockRestore();
        root.unmount();
    });

    it('only shows the Reanalyze action for GitHub-sourced repositories (zip/local have no source to re-read)', async () => {
        mockListRepositories.mockResolvedValueOnce(recentReposFixture);

        const { container, root } = renderAndFlush(
            React.createElement(UploadPage, { onAnalysisComplete: () => {} })
        );
        await act(async () => { await new Promise((r) => setTimeout(r, 0)); });

        const items = [...container.querySelectorAll('.recent-repo-item')];
        const githubItem = items.find((el) => el.textContent.includes('demo-repo'));
        const zipItem = items.find((el) => el.textContent.includes('other-repo'));

        expect(githubItem.querySelector('.recent-repo-item__icon-btn:not(.recent-repo-item__icon-btn--danger)')).toBeTruthy();
        expect(zipItem.querySelector('.recent-repo-item__icon-btn:not(.recent-repo-item__icon-btn--danger)')).toBeFalsy();

        root.unmount();
    });

    it('Reanalyze re-fetches the same GitHub URL without depending on stale state (regression check)', async () => {
        mockListRepositories.mockResolvedValueOnce(recentReposFixture);

        const { container, root } = renderAndFlush(
            React.createElement(UploadPage, { onAnalysisComplete: () => {} })
        );
        await act(async () => { await new Promise((r) => setTimeout(r, 0)); });

        const githubItem = [...container.querySelectorAll('.recent-repo-item')].find((el) => el.textContent.includes('demo-repo'));
        const reanalyzeBtn = githubItem.querySelector('.recent-repo-item__icon-btn:not(.recent-repo-item__icon-btn--danger)');

        await act(async () => {
            reanalyzeBtn.click();
            await new Promise((r) => setTimeout(r, 0));
        });

        // fetchGitHubRepository is mocked to reject, but the important thing here is
        // that it's called with the *repo's* URL, not an empty/stale githubUrl state.
        const github = await import('./src/repo-sources/github.js');
        expect(github.fetchGitHubRepository).toHaveBeenCalledWith(
            'https://github.com/someuser/demo-repo', undefined, expect.any(Function)
        );

        root.unmount();
    });
});
