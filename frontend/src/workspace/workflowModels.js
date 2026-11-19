/** Phase 3 workspace projections. These are read-only views of the captured analysis snapshot.
 * Static source/test references are NOT test executions; migration scores are inferred, not audits.
 */
import { asArray, safePath, sensitivePath, isConfirmed } from './workspaceData.js';

const valid = path => Boolean(safePath(path)) && !sensitivePath(path);
const sorted = (a, b) => a.localeCompare(b);
const pathSet = result => new Set(asArray(result?.files).map(file => file?.path).filter(valid));
const num = value => typeof value === 'number' && Number.isFinite(value) ? value : null;
const integer = value => Number.isInteger(value) && value > 0 ? value : null;

/** File-to-test links are extracted heuristics and retain their source provenance. */
export function testEvidenceModel(result = {}) {
    const linkage = result?.testLinkage;
    const known = pathSet(result);
    const available = Boolean(linkage && typeof linkage === 'object');
    const rawLinks = asArray(linkage?.links);
    const seen = new Set();
    const links = [];
    for (const item of rawLinks) {
        const source = item?.sourceFile, test = item?.testFile;
        if (!known.has(source) || !known.has(test)) continue;
        const key = JSON.stringify([source, test]);
        if (seen.has(key)) continue;
        seen.add(key);
        links.push({ sourceFile: source, testFile: test, relationship: item.relationship || 'unknown',
            confidence: ['high', 'medium', 'low'].includes(item.confidence) ? item.confidence : 'unknown',
            evidence: item.evidence || null });
    }
    links.sort((a,b) => sorted(a.sourceFile,b.sourceFile) || sorted(a.testFile,b.testFile));
    const functionLinks = asArray(linkage?.functionLinks).filter(item => known.has(item?.sourceFile) && known.has(item?.testFile))
        .map(item => ({ sourceFile: item.sourceFile, testFile: item.testFile,
            sourceFunction: item.sourceFunction || null, sourceLine: integer(item.sourceLine),
            testFunction: item.testFunction || null, testFunctionLine: integer(item.testFunctionLine),
            callSiteLine: integer(item.callSiteLine), confidence: item.confidence || 'unknown' }));
    const sourceCount = new Set(links.map(link => link.sourceFile)).size;
    const testCount = new Set(links.map(link => link.testFile)).size;
    const unlinkedTestFiles = [...new Set(asArray(linkage?.unlinkedTestFiles).filter(file => known.has(file)))].sort(sorted);
    const availableTestCount = num(linkage?.testFileCount);
    const availableLinkedCount = num(linkage?.linkedTestFileCount);
    return {
        available, linksAvailable: Array.isArray(linkage?.links),
        totalLinkRecords: Array.isArray(linkage?.links) ? rawLinks.length : null,
        testFileCount: availableTestCount, linkedTestFileCount: availableLinkedCount,
        matchedSourceCount: sourceCount, matchedTestCount: testCount,
        links, functionLinks, unlinkedTestFiles,
        confidenceSemantics: 'Static import/reference and naming evidence. Neither linked tests nor function calls prove runtime coverage, assertions or PASS/FAIL.',
    };
}

/** Display a bounded source/test graph; never create an edge not present in extracted linkage. */
export function testLinkGraph(model, options = {}) {
    const query = String(options.query || '').trim().toLowerCase();
    const focus = String(options.focus || '');
    const maxLinks = Math.max(1, Math.min(350, options.maxLinks || 100));
    const matches = model.links.filter(link => (!query || `${link.sourceFile} ${link.testFile}`.toLowerCase().includes(query)) &&
        (!focus || link.sourceFile === focus || link.testFile === focus));
    const shown = matches.slice(0, maxLinks);
    const nodes = new Map(), edges = [];
    for (const link of shown) {
        const a = `src:${link.sourceFile}`, b = `test:${link.testFile}`;
        if (!nodes.has(a)) nodes.set(a, {id:a,label:link.sourceFile.split('/').at(-1),file:link.sourceFile,kind:'source'});
        if (!nodes.has(b)) nodes.set(b, {id:b,label:link.testFile.split('/').at(-1),file:link.testFile,kind:'test'});
        edges.push({source:a,target:b,kind:'test-link-candidate',confidence:link.confidence,relationship:link.relationship});
    }
    return {nodes:[...nodes.values()],edges,shown:shown.length,matching:matches.length,truncated:shown.length<matches.length};
}

/** Only source-confirmed dependencies enter the migration graph. Scores come from the existing engine. */
export function modernizationEvidenceModel(result = {}) {
    const known = pathSet(result);
    const riskAvailable = Boolean(result?.migrationRisk && typeof result.migrationRisk === 'object' && !Array.isArray(result.migrationRisk));
    const orderAvailable = Array.isArray(result?.migrationOrder?.order);
    const entries = riskAvailable ? Object.entries(result.migrationRisk) : [];
    const riskRows = entries.filter(([path]) => known.has(path)).map(([file, value]) => ({
        file, score: num(value?.score), level: value?.level || 'unknown',
        confidence: value?.confidence || 'INFERENCE', reason: value?.confidenceReason || null,
        factors: value?.factors || {},
    })).sort((a,b) => (b.score ?? -1)-(a.score ?? -1) || sorted(a.file,b.file));
    const sourceRows = new Map(riskRows.map(row => [row.file,row]));
    const order = asArray(result?.migrationOrder?.order).filter(item => known.has(item?.file) && integer(item?.batch))
        .map(item => ({file:item.file,batch:item.batch,inCycle:Boolean(item.inCycle),reason:item.reason || null,risk:sourceRows.get(item.file) || null}));
    const batchesMap = new Map();
    for (const item of order) {
        if (!batchesMap.has(item.batch)) batchesMap.set(item.batch, []);
        batchesMap.get(item.batch).push(item);
    }
    const batches = [...batchesMap.entries()].sort((a,b) => a[0]-b[0])
        .map(([number, files]) => ({number,files:files.sort((a,b) => sorted(a.file,b.file)),hasCycle:files.some(row=>row.inCycle)}));
    const edges = asArray(result?.dependencies).filter(edge => isConfirmed(edge) && known.has(edge?.source) && known.has(edge?.target) && edge.source !== edge.target)
        .map(edge=>({source:edge.source,target:edge.target,kind:edge.type || 'dependency',line:integer(edge.line)}));
    return {
        available:riskAvailable || orderAvailable, riskAvailable, orderAvailable,
        riskRows, batches, dependencies:edges,
        riskSemantics:'Heuristic weighted risk and dependency-derived proposed ordering, not a confirmed migration outcome.',
    };
}

/** Neighborhood-only view prevents a sprawling whole-repo graph. */
export function migrationNeighborhood(model, result = {}, file = '', limit = 50) {
    const known = pathSet(result);
    if (!known.has(file)) return {nodes:[],edges:[],totalNeighbors:0,truncated:false};
    const edges = model.dependencies.filter(edge => edge.source === file || edge.target === file);
    const bounded = edges.slice(0, Math.max(1, Math.min(200, limit)));
    const paths = new Set([file]);
    for (const edge of bounded) {paths.add(edge.source);paths.add(edge.target);}
    return {nodes:[...paths].sort(sorted).map(path=>({id:path,label:path.split('/').at(-1),file:path,kind:'source'})),
        edges:bounded,totalNeighbors:edges.length,truncated:edges.length>bounded.length};
}
