/**
 * Best-effort mapping between test files and production source files.
 *
 * Import/reference links are stronger evidence than filename conventions, but
 * neither proves runtime coverage or that the test actually asserts behavior.
 */
const TEST_FILE_RE = /(?:^|\/)(?:__tests__|tests?|test)(?:\/|$)|\.(?:test|spec)\.[^.]+$|(?:^|\/)(?:test_[^/]+|[^/]+_test)\.py$|(?:^|\/)[^/]+Tests?\.(?:java|kt|cs|scala)$/i;

function normalizePath(path) {
    return String(path || '').replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/{2,}/g, '/');
}

function isTestFile(path) {
    return TEST_FILE_RE.test(normalizePath(path));
}

function candidateSourcePaths(testPath) {
    const path = normalizePath(testPath);
    const candidates = new Set();
    const extMatch = path.match(/(\.[A-Za-z0-9]+)$/);
    const ext = extMatch?.[1] || '';
    const stem = ext ? path.slice(0, -ext.length) : path;
    const addSiblingVariants = (base) => {
        const baseStem = base.replace(/\.(?:test|spec)$/i, '').replace(/_test$/i, '').replace(/^test_/i, '');
        const extensions = ext ? [ext] : [];
        for (const extra of extensions) candidates.add(`${baseStem}${extra}`);
        // Common source-language alternates allow `.test.tsx` to link `.tsx`,
        // and `.spec.js` to link `.js` without guessing another basename.
        for (const alternative of ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.py', '.java', '.kt', '.cs']) {
            candidates.add(`${baseStem}${alternative}`);
        }
    };

    addSiblingVariants(stem);
    if (/(?:^|\/)(__tests__|tests?|test)\//i.test(path)) {
        const withoutTestDirectory = path.replace(/(^|\/)(__tests__|tests?|test)\//i, '$1');
        const withoutTestExt = withoutTestDirectory.replace(/\.(?:test|spec)(?=\.)/i, '').replace(/_test(?=\.)/i, '').replace(/(^|\/)test_(?=[^/]+\.py$)/i, '$1');
        addSiblingVariants(withoutTestExt.replace(/\.[A-Za-z0-9]+$/, ''));
        // Java's Maven layout commonly pairs src/test/java/X/FooTest.java with
        // src/main/java/X/Foo.java.
        const mainLayout = path.replace('/test/', '/main/').replace(/Test(?=\.(?:java|kt|cs|scala)$)/i, '');
        candidates.add(mainLayout);
    }
    // Conventional test suffixes are removed only from the terminal basename.
    candidates.add(path.replace(/\.(?:test|spec)(?=\.[^.]+$)/i, ''));
    candidates.add(path.replace(/_test(?=\.[^.]+$)/i, ''));
    candidates.add(path.replace(/(^|\/)test_(?=[^/]+\.[^.]+$)/i, '$1'));
    candidates.add(path.replace(/Tests?(?=\.(?:java|kt|cs|scala)$)/i, ''));
    return [...candidates].map(normalizePath).filter((candidate) => candidate !== path);
}

/**
 * @param {Array<{path:string,content?:string}>} files
 * @param {Array<{source:string,target:string,type?:string,resolution?:string,line?:number,evidence?:string}>} dependencies
 */
export function analyzeTestLinkage(files = [], dependencies = [], functionConnections = []) {
    const paths = new Set(files.map((file) => normalizePath(file.path)));
    const testPaths = new Set([...paths].filter(isTestFile));
    const productionPaths = new Set([...paths].filter((path) => !testPaths.has(path)));
    const linksByKey = new Map();

    const addLink = (sourceFile, testFile, relationship, confidence, evidence) => {
        if (!productionPaths.has(sourceFile) || !testPaths.has(testFile)) return;
        const key = `${sourceFile}|${testFile}`;
        const previous = linksByKey.get(key);
        const rank = { high: 3, medium: 2, low: 1 };
        const candidate = { sourceFile, testFile, relationship, confidence, evidence };
        if (!previous || rank[confidence] > rank[previous.confidence]) linksByKey.set(key, candidate);
    };

    for (const edge of dependencies) {
        const testFile = normalizePath(edge?.source);
        const sourceFile = normalizePath(edge?.target);
        if (!testPaths.has(testFile) || !productionPaths.has(sourceFile)) continue;
        if (!['resolved', 'inferred'].includes(edge?.resolution)) continue;
        addLink(sourceFile, testFile, edge.resolution === 'resolved' ? 'imports' : 'references-inferred',
            edge.resolution === 'resolved' ? 'high' : 'medium', {
                type: 'dependency-edge', path: testFile,
                ...(Number.isInteger(edge.line) ? { line: edge.line } : {}),
                ...(edge.evidence ? { excerpt: String(edge.evidence).slice(0, 300) } : {}),
            });
    }

    // Naming is a fallback only, used when no stronger imported/reference link
    // exists for a test. It is intentionally low/medium confidence.
    const linkedTests = new Set([...linksByKey.values()].map((link) => link.testFile));
    for (const testFile of testPaths) {
        if (linkedTests.has(testFile)) continue;
        for (const candidate of candidateSourcePaths(testFile)) {
            if (productionPaths.has(candidate)) {
                addLink(candidate, testFile, 'filename-convention', 'low', {
                    type: 'path-convention', testPath: testFile, candidatePath: candidate,
                });
                break;
            }
        }
    }

    const links = [...linksByKey.values()].sort((a, b) => a.sourceFile.localeCompare(b.sourceFile) || a.testFile.localeCompare(b.testFile));
    const bySource = Object.create(null);
    for (const link of links) {
        bySource[link.sourceFile] ||= [];
        bySource[link.sourceFile].push({
            testFile: link.testFile, relationship: link.relationship,
            confidence: link.confidence, evidence: link.evidence,
        });
    }
    // Function call edges provide stronger source linkage than filename
    // conventions. They still do not prove test execution or assertion quality.
    const functionLinksByKey = new Map();
    for (const edge of functionConnections || []) {
        const testFile = normalizePath(edge?.callerFile);
        const sourceFile = normalizePath(edge?.calleeFile);
        if (!testPaths.has(testFile) || !productionPaths.has(sourceFile) || edge?.resolution !== 'resolved') continue;
        const sourceFunctionKey = edge.calleeFunctionKey || `${sourceFile}|${edge.calleeStartLine || ''}|${edge.calleeFunctionName || ''}`;
        const key = `${sourceFunctionKey}|${testFile}`;
        const candidate = {
            sourceFunctionKey,
            sourceFile,
            sourceFunction: edge.calleeFunctionName || null,
            sourceLine: Number.isInteger(edge.calleeStartLine) ? edge.calleeStartLine : null,
            testFile,
            testFunction: edge.callerFunctionName || null,
            testFunctionLine: Number.isInteger(edge.callerStartLine) ? edge.callerStartLine : null,
            callSiteLine: Number.isInteger(edge.callSiteLine) ? edge.callSiteLine : null,
            confidence: edge.attribution === 'heuristic-function-line-range' ? 'medium' : 'low',
            relationship: 'test-calls-function',
            evidence: {
                type: 'resolved-function-call', path: testFile,
                ...(Number.isInteger(edge.callSiteLine) ? { line: edge.callSiteLine } : {}),
                ...(edge.callSiteExcerpt ? { excerpt: String(edge.callSiteExcerpt).slice(0, 300) } : {}),
            },
            limitations: ['Static call linkage does not prove the test is run, passes, or asserts the behavior.'],
        };
        const previous = functionLinksByKey.get(key);
        if (!previous || (candidate.confidence === 'medium' && previous.confidence !== 'medium')) functionLinksByKey.set(key, candidate);
    }
    const functionLinks = [...functionLinksByKey.values()].sort((a, b) => a.sourceFile.localeCompare(b.sourceFile) || (a.sourceLine || 0) - (b.sourceLine || 0) || a.testFile.localeCompare(b.testFile));
    const byFunction = Object.create(null);
    for (const link of functionLinks) {
        byFunction[link.sourceFunctionKey] ||= [];
        byFunction[link.sourceFunctionKey].push({ testFile: link.testFile, testFunction: link.testFunction, testFunctionLine: link.testFunctionLine, callSiteLine: link.callSiteLine, confidence: link.confidence, evidence: link.evidence });
    }
    const testedFunctionKeys = new Set(functionLinks.map((link) => link.sourceFunctionKey));
    const linkedTestPaths = new Set(links.map((link) => link.testFile));
    const functionLinkedTestPaths = new Set(functionLinks.map((link) => link.testFile));
    return {
        schemaVersion: 2,
        semantics: 'File linkage uses resolved/inferred imports or naming conventions. Function linkage uses resolved static call edges with heuristic caller attribution. Neither proves test execution, passing assertions, or runtime coverage.',
        testFileCount: testPaths.size,
        linkedTestFileCount: linkedTestPaths.size,
        linkedSourceFileCount: new Set(links.map((link) => link.sourceFile)).size,
        links,
        bySource,
        unlinkedTestFiles: [...testPaths].filter((path) => !linkedTestPaths.has(path)).sort(),
        functionLinks,
        byFunction,
        functionLinkSummary: {
            linkedFunctionCount: testedFunctionKeys.size,
            functionLinkCount: functionLinks.length,
            testFilesWithResolvedFunctionCalls: functionLinkedTestPaths.size,
            unlinkedFunctions: [...new Map([...productionPaths].flatMap((sourceFile) => (functionConnections || []).filter((edge) => normalizePath(edge?.calleeFile) === sourceFile && edge?.calleeFunctionKey).map((edge) => [edge.calleeFunctionKey, { functionKey: edge.calleeFunctionKey, name: edge.calleeFunctionName || null, file: sourceFile, line: edge.calleeStartLine || null }]))).values()].filter((fn) => !testedFunctionKeys.has(fn.functionKey)).slice(0, 500),
        },
    };
}

export { isTestFile, candidateSourcePaths };
