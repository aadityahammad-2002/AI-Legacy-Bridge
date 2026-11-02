/** Source-role tags prevent examples and test fixtures from masquerading as production behavior.
 * Test code remains available to symbol/dependency extraction; only production-route
 * inventories exclude it. This is deterministic path classification, not a claim
 * about what a file executes at runtime.
 */
export function classifyAnalysisSource(path) {
    const value = String(path || '').replace(/\\/g, '/');
    if (/(?:^|\/)(?:benchmarks?|__tests__|__mocks__|__fixtures__|fixtures?|tests?|specs?|e2e)(?:\/|$)/i.test(value)
        || /(?:^|\/)[^/]+(?:\.test|\.spec)\.[^/.]+$/i.test(value)
        || /(?:^|\/)[^/]*(?:Test|Tests|Spec)\.(?:java|kt|py|js|jsx|ts|tsx)$/i.test(value)) return 'test-or-fixture';
    // `src/main/java/com/example/...` is the default Maven package name,
    // NOT an examples directory. Only explicit documentation/sample tree
    // segments signal illustrative sources.
    if (/(?:^|\/)(?:docs?|examples?|samples?)(?:\/|$)/i.test(value)
        && !/(?:^|\/)src\/main\/(?:java|kotlin)\/com\/example(?:\/|$)/i.test(value)) return 'example';
    if (/(?:^|\/)(?:dist|build|generated|vendor|node_modules)(?:\/|$)/i.test(value)) return 'generated-or-vendor';
    return 'application';
}
export function isApplicationSource(path) { return classifyAnalysisSource(path) === 'application'; }
