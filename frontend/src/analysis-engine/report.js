/**
 * report.js — Phase 3, batch 8 (Documentation).
 *
 * Auto-generated architecture report: aggregates everything the engine
 * already computed (Phases 1-3) into one readable Markdown document a
 * team can export/share, rather than a raw data dump. Every section
 * carries forward the confidence tags of the data it summarizes instead
 * of re-asserting them as certain.
 */

function fmtPct(n) { return `${n}%`; }

function section(title, body) {
    return `## ${title}\n\n${body}\n`;
}

function list(items, empty = '_None found._') {
    if (!items.length) return empty;
    return items.map((i) => `- ${i}`).join('\n');
}

/**
 * Builds the Markdown report. `data` is the full object analyzeRepository
 * returns (or a subset — every section guards for missing fields so this
 * still produces a partial report if some phases were skipped/failed).
 */
export function generateArchitectureReport(repoMeta, data) {
    const {
        healthScore: health, languageStats, entryPoints = [], importantFiles = [], roles = {},
        moduleBoundaries = {}, domainClusters = [], architectureDrift = {},
        apiEndpoints = [], authCoverage = {}, databaseSchema = {}, orphanTables = [],
        dependencyInventory = {}, licenseCompliance = {}, migrationRisk = {},
        issues = [], securityIssues = [], files = [], analysisCoverage = {}, analysisCache = {},
        dataFlow = {}, testLinkage = {}, callGraph = {},
    } = data;

    const roleCounts = Object.values(roles).reduce((acc, r) => { acc[r.role] = (acc[r.role] || 0) + 1; return acc; }, {});

    const md = [];
    md.push(`# Architecture Report — ${repoMeta?.name || 'Repository'}`);
    md.push(`_Auto-generated. Confidence tags (FACT/INFERENCE/UNCERTAIN) on the underlying findings are preserved in the full analysis data; this report summarizes them._\n`);

    if (health) {
        md.push(section('Health Overview', `**Score:** ${health.score ?? 'n/a'}/100  \n**Files:** ${files.length}  \n**Open issues:** ${issues.length}  \n**Security findings:** ${securityIssues.length}  \n**Analysis coverage:** ${analysisCoverage.status || 'unknown'}`));
    }

    const parserCoverage = analysisCoverage.parserCoverage || {};
    const dependencyResolution = analysisCoverage.dependencyResolution || {};
    md.push(section('Analysis Confidence and Coverage',
        `**Status:** ${analysisCoverage.status || 'unknown'}  \n` +
        `**Parser:** ${parserCoverage.astPreferredFiles ?? 0} AST, ${parserCoverage.heuristicParserFiles ?? 0} heuristic, ${parserCoverage.unknownParserFiles ?? 0} unknown  \n` +
        `**Dependency resolution:** ${dependencyResolution.resolvedEdges ?? 0} resolved, ${dependencyResolution.ambiguousEdges ?? 0} ambiguous, ${dependencyResolution.unresolvedLocalImports?.length ?? 0} unresolved local imports  \n` +
        `**Call graph:** ${analysisCoverage.callGraph?.resolvedCallNameReferences ?? 0}/${analysisCoverage.callGraph?.totalCallNameReferences ?? 0} call-name references resolved.  \n\n` +
        list((analysisCoverage.statusReasons || []).slice(0, 8)) +
        '\n\n_Heuristic parsing and incomplete resolution are not equivalent to compiler-grade semantic analysis._'));

    const languageDepth = analysisCoverage.languageDepth;
    if (languageDepth?.languages) {
        const entries = Object.entries(languageDepth.languages).sort(([a], [b]) => a.localeCompare(b));
        md.push(section('Language-Level Analysis Depth',
            `**Recognized languages:** ${languageDepth.supportedLanguages ?? 'n/a'}; **present in this repository:** ${languageDepth.parsedLanguages ?? 0}.\n\n` +
            (entries.length ? entries.map(([name, row]) =>
                `- **${name}:** ${row.files} file(s), ${row.astFiles} syntax-tree/AST extraction, ${row.lexicalFiles} lexical/fallback extraction, ${row.failedFiles} failed`)
                .join('\n') : '_No supported programming-language files discovered._') +
            '\n\n_A language being recognized or having lexical extraction is not evidence of compiler-grade semantic accuracy. Tree-sitter parsing is opt-in and requires a configured runtime/grammar._'));
    }

    const metrics = data.analysisMetrics || {};
    const findingMetrics = metrics.findings || {};
    const qualityMetrics = metrics.analysisQuality || {};
    md.push(section('Evidence Quality and Analysis Metrics',
        `**Analysis coverage:** ${qualityMetrics.status || analysisCoverage.status || 'unknown'}  \n` +
        `**Parser AST share:** ${qualityMetrics.astSharePct ?? 'n/a'}%  \n` +
        `**Finding evidence attached:** ${findingMetrics.evidenceAvailablePct ?? 'n/a'}% (${findingMetrics.evidenceAvailable ?? 0}/${findingMetrics.total ?? 0})  \n` +
        `**Findings with source location:** ${findingMetrics.sourceLocatedPct ?? 'n/a'}%  \n` +
        `**Dependency resolution among represented edges:** ${qualityMetrics.dependencyResolutionPct ?? 'n/a'}%  \n` +
        `**Exact duplicate findings merged:** ${data.findingDeduplication?.duplicateCount ?? 0}.  \n\n` +
        '_These are engine coverage/observability indicators, not precision/recall measurements or proof of semantic correctness. A resolved-edge percentage measures represented edges only._'));

    if (data.dependencyUsage) {
        md.push(section('Manifest-to-Import Usage Candidates',
            `**${data.dependencyUsage.totalDependencies ?? 0} declared dependency record(s)**; **${data.dependencyUsage.staticUseDetected ?? 0}** have matching static imports, **${data.dependencyUsage.unusedCandidates ?? 0}** are possible unused candidates, and **${data.dependencyUsage.notStaticallyMappable ?? 0}** cannot be reliably mapped.\n\n` +
            list((data.dependencyUsage.candidates || []).slice(0, 12).map((item) => `\`${item.name}\` (${item.ecosystem}) in \`${item.manifestFile || 'manifest'}\` — no matching static import found; low-confidence review candidate`)) +
            '\n\n_An absent static import does not prove a dependency is unused; dynamic loading, plugins, generated registration, and framework conventions may hide usage._'));
    }

    if (data.incrementalAnalysis?.available) {
        const diff = data.incrementalAnalysis.diff || {};
        md.push(section('Change and Impact Plan',
            `**Added:** ${(diff.added || []).length}; **modified:** ${(diff.modified || []).length}; **removed:** ${(diff.removed || []).length}; **unchanged:** ${(diff.unchanged || []).length}.\n\n` +
            list((data.incrementalAnalysis.potentiallyImpactedFiles || []).slice(0, 15).map((file) => `\`${file}\``)) +
            `\n\n_${data.incrementalAnalysis.semantics || 'Change-impact results are estimates.'} Downstream graphs still recompute; dependency-edge extraction may reuse hashes._`));
    }

    const actionItems = data.analysisMetrics?.actionPlan?.items || [];
    if (actionItems.length) {
        md.push(section('Suggested Review Actions', list(actionItems.slice(0, 10).map((item) => `**${item.title}** (${item.severity}) — ${item.action}`))));
    }

    if (data.dependencyExecution) {
        const exec = data.dependencyExecution;
        md.push(section('Actual Incremental Dependency Execution',
            `**Mode:** ${exec.mode}; **source files reused:** ${exec.reusedSourceFiles ?? 0}; ` +
            `**source files re-resolved:** ${exec.recalculatedSourceFiles ?? 0}.\n\n` +
            '_This reuses only source-owned dependency edges under verified context and source hashes. It does not skip downstream repository-wide analyses._'));
    }
    if (data.semanticIntelligence) {
        const s = data.semanticIntelligence;
        md.push(section('Symbol-Level Static Intelligence',
            `**Symbols indexed:** ${s.summary?.symbolsIndexed ?? 0}; **source-backed resolved calls:** ${s.summary?.resolvedCallRelations ?? 0}; ` +
            `**inheritance candidates:** ${s.summary?.inheritanceCandidates ?? 0}; **ambiguous bases:** ${s.summary?.ambiguousBases ?? 0}.\n\n` +
            list((s.inheritance || []).slice(0, 12).map(i => `\`${i.file}:${i.line}\` ${i.childName} → ${i.baseName}: ${i.resolution}`)) +
            '\n\n_Lexical inheritance candidates do not establish compiler-verified type binding or dynamic dispatch._'));
    }
    if (data.crossSystemIntelligence) {
        const x = data.crossSystemIntelligence;
        md.push(section('Cross-System Static Message and Database Evidence',
            `**Message operations:** ${x.summary?.detectedMessageOperations ?? 0}; **candidate channel links:** ${x.summary?.candidateMessageLinks ?? 0}; ` +
            `**literal SQL calls:** ${x.summary?.literalSqlOperations ?? 0}; **matched schema tables:** ${x.summary?.matchedSchemaTables ?? 0}.\n\n` +
            list((x.messageLinks || []).slice(0, 8).map(i => `\`${i.source.file}:${i.source.line}\` → \`${i.target.file}:${i.target.line}\` via \`${i.channel}\``)) +
            '\n\n_No broker, queue delivery, actual database access, or runtime execution is proven by these static matches._'));
    }

    const functionEdges = callGraph.functionConnections || [];
    const callGraphDiagnostics = callGraph.diagnostics || {};
    const callGraphMetrics = analysisCoverage.callGraph || {};
    const attributedSites = callGraphMetrics.attributedFunctionCallSiteCount ?? Math.max(0,
        (callGraphDiagnostics.functionCallSiteCount ?? functionEdges.length) - (callGraphDiagnostics.unattributedFunctionCallSiteCount ?? 0));
    md.push(section('Function-Level Call Relationships',
        `**${callGraphDiagnostics.functionCallSiteCount ?? functionEdges.length} resolved call-site unit(s)** counted for attribution; **${attributedSites}** attributed and **${callGraphDiagnostics.unattributedFunctionCallSiteCount ?? 0}** unattributed.\n\n` +
        `**Source-located sites:** ${callGraphDiagnostics.locatedFunctionCallSiteCount ?? 'n/a'}; **missing call-site locators:** ${callGraphDiagnostics.callSiteEvidenceMissingCount ?? 'n/a'}; **unresolved/ambiguous sites without caller attribution:** ${callGraphDiagnostics.unresolvedUnattributedCallSiteCount ?? 'n/a'}.\n\n` +
        (functionEdges.length ? `**Sample resolved relationships (up to ${functionEdges.length} serialized edge(s)):**\n\n` + list(functionEdges.slice(0, 15).map((edge) => {
            const caller = edge.callerFunctionName ? `\`${edge.callerFunctionName}()\`` : '_module scope_';
            return `\`${edge.callerFile}:${edge.callSiteLine ?? '?'}\` ${caller} → \`${edge.calleeFile}:${edge.calleeStartLine ?? '?'} ${edge.calleeFunctionName}()\` (${edge.attribution}, ${edge.confidence} confidence)`;
        })) : '_No uniquely resolved function call sites were serialized._') +
        '\n\n_Function-level links use heuristic source-line and function-range attribution. The serialized edge list is a bounded sample; unresolved calls are reported separately, so this graph is not a complete call graph._'));

    md.push(section('Test Linkage',
        `**${testLinkage.testFileCount ?? 0} test file(s)** detected; **${testLinkage.linkedTestFileCount ?? 0}** linked to source files and **${(testLinkage.unlinkedTestFiles || []).length}** unlinked.\n\n` +
        (testLinkage.links?.length ? list(testLinkage.links.slice(0, 15).map((link) => `\`${link.testFile}\` → \`${link.sourceFile}\` (${link.relationship}, ${link.confidence} confidence)`)) : '_No source links established._') +
        '\n\n_Linkage is not proof of test coverage, execution, assertions, or passing status._'));

    const potentialFlows = dataFlow.flows || [];
    md.push(section('Potential Data-Flow Leads',
        `**${dataFlow.summary?.potentialFlows ?? 0} potential source-to-sink signal(s)** detected by a bounded, low-confidence heuristic pass.\n\n` +
        (potentialFlows.length ? list(potentialFlows.slice(0, 12).map((flow) => `\`${flow.source.path}:${flow.source.line}\` (${flow.source.kind}) → \`${flow.sink.path}:${flow.sink.line}\` (${flow.sink.kind})`)) : '_No signals matched these limited rules._') +
        '\n\n_This is not a complete taint analysis and neither confirms exploitability nor proves safety._'));

    md.push(section('Where to Start Reading',
        entryPoints.length
            ? list(entryPoints.slice(0, 8).map((e) => `**${e.file}** (${e.confidence}) — ${e.reasons.join('; ')}`))
            : 'No clear entry points detected.'));

    md.push(section('5 Most Important Files',
        list(importantFiles.map((f) => `**${f.file}** — ${f.reason}`))));

    md.push(section('Architectural Roles',
        Object.entries(roleCounts).map(([role, count]) => `- ${role}: ${count} file(s)`).join('\n') || '_No roles classified._'));

    md.push(section('Business-Domain Clusters',
        list(domainClusters.slice(0, 10).map((c) => `**${c.domain}** — ${c.files.length} files`))));

    md.push(section('Module Boundaries',
        `${(moduleBoundaries.modules || []).length} module(s) detected.\n\n` +
        (moduleBoundaries.weakBoundaries?.length
            ? `**Weak boundaries:** ${list(moduleBoundaries.weakBoundaries.map((m) => `${m.name} (reaches into ${m.touchesModules} other modules)`))}`
            : '_No weak module boundaries detected._')));

    const intelligence = data.architectureIntelligence || {};
    if (intelligence.status && intelligence.status !== 'unavailable') {
        md.push(section('Dependency Cycles and Structural Hotspots',
            `**${intelligence.summary?.cycleGroupCount ?? 0} strongly connected dependency group(s)** involving **${intelligence.summary?.filesInCycles ?? 0} file(s)**, and **${intelligence.summary?.observedDependencyPairs ?? 0} observed file-dependency pairs**.\n\n` +
            (intelligence.cycles?.length ? `**Largest cycles:**\n\n` + list(intelligence.cycles.slice(0, 10).map((cycle) =>
                `${cycle.memberCount} files (${cycle.confidence} edge confidence): ${cycle.files.slice(0, 8).map((file) => `\`${file}\``).join(', ')}${cycle.memberCount > 8 ? ', …' : ''}`)) : '_No static dependency cycles detected._') +
            '\n\n**High-coupling files by observed reverse reach:**\n\n' +
            list((intelligence.hotspots || []).slice(0, 10).map((hotspot) => `\`${hotspot.path}\` — ${hotspot.directDependents} direct, ${hotspot.estimatedTransitiveDependents} reachable dependents${hotspot.reachLimitReached ? ' (bounded estimate)' : ''}`)) +
            `\n\n_${intelligence.semantics || 'Static relationships only.'} Excluded ambiguous imports: ${intelligence.uncertainty?.ambiguous ?? 0}; unresolved: ${intelligence.uncertainty?.unresolved ?? 0}._`));
    }
    const execution = data.executionIntelligence || {};
    if (execution.status && execution.status !== 'unavailable') {
        const readable = (execution.flows || []).filter((flow) => flow.handler && flow.steps?.length);
        md.push(section('Source-Backed Candidate Execution Paths',
            `**${execution.summary?.tracedEndpoints ?? 0} endpoint handler(s) located**, ` +
            `**${execution.summary?.unresolvedHandlers ?? 0} unresolved**, ` +
            `**${execution.summary?.staticClientLinks ?? 0} exact static HTTP client/route link(s)**.\n\n` +
            list(readable.slice(0, 8).map((flow) =>
                `\`${flow.endpoint.method} ${flow.endpoint.path}\` in \`${flow.endpoint.file}:${flow.endpoint.line}\`: ` +
                flow.steps.slice(0, 8).map((step) => `\`${step.name}\` (\`${step.file}:${step.line}\`)`).join(' → ') +
                `${flow.truncated ? ' (bounded)' : ''} — ${flow.edges.length} source-backed call edge(s)`)) +
            `\n\n_${execution.semantics || 'Static candidates, not runtime traces.'}_`));
    }
    const syntax = data.syntaxDiagnostics || {};
    if (syntax.status && syntax.status !== 'unavailable') {
        md.push(section('Parser-Backed Syntax Diagnostics',
            `**${syntax.summary?.verified ?? 0} parsed**, **${syntax.summary?.failed ?? 0} parser errors**, ` +
            `**${syntax.summary?.unsupported ?? 0} unverified**, **${syntax.summary?.oversized ?? 0} skipped for size**.\n\n` +
            list((syntax.checks || []).filter((check) => check.status === 'syntax-error').slice(0, 10).map((check) =>
                `\`${check.path}:${check.line || '?'}\` (${check.parser}) — ${check.message}`)) +
            `\n\n_${syntax.semantics || 'Parser checks are not type checking.'}_`));
    }
    if (data.evidenceAudit) {
        md.push(section('Source Reference Integrity',
            `**${data.evidenceAudit.summary?.valid ?? 0} source locations within bounds**, ` +
            `**${data.evidenceAudit.summary?.invalid ?? 0} invalid**, ` +
            `**${data.evidenceAudit.summary?.unavailableLine ?? 0} without source-line reference**.\n\n` +
            `_${data.evidenceAudit.semantics || 'Source-line presence does not prove semantic correctness.'}_`));
    }
    if (data.runtimeEvidence) {
        md.push(section('Runtime Instrumentation Correlation',
            data.runtimeEvidence.status === 'not-provided' ? '_No runtime spans supplied; actual execution has not been verified._' :
            `**${data.runtimeEvidence.summary?.acceptedSpans ?? 0} supplied span(s)**, ` +
            `**${data.runtimeEvidence.summary?.observedParentChildLinks ?? 0} parent/child link(s)**, ` +
            `**${data.runtimeEvidence.summary?.matchedEndpoints ?? 0} static endpoint route(s) matched**.\n\n` +
            `_${data.runtimeEvidence.semantics}_`));
    }
    if (data.extractionSnapshot?.summary) {
        md.push(section('Incremental Parsing Checkpoint',
            `**${data.extractionSnapshot.summary.savedFiles} file(s)** preserved with SHA-256 cache identities; ` +
            `**${data.analysisCache?.portableExtractionHits ?? 0} parsed file(s)** reused from a previous compatible snapshot.\n\n` +
            '_File-level extraction/complexity can be reused; whole-repository graphs and security analysis are still recomputed. This is not fully incremental graph execution._'));
    }

    if (data.changeReview?.available) {
        md.push(section('Tests to Review for Changed Files',
            `**${data.changeReview.summary?.suggestions ?? 0} linked test candidate(s)** inferred for ${data.changeReview.summary?.changedFiles ?? 0} changed file(s).\n\n` +
            list((data.changeReview.recommendedTests || []).slice(0, 15).map((test) =>
                `\`${test.testFile}\` — ${test.relationship} via \`${test.linkedSourceFile}\`, ${test.hops} dependency hop(s), ${test.confidence} confidence`)) +
            `\n\n_${data.changeReview.semantics}_`));
    }

    md.push(section('Architecture Drift',
        `**Layer-violation rate:** ${fmtPct(architectureDrift.driftPct ?? 0)} (${architectureDrift.level ?? 'n/a'})  \n` +
        (architectureDrift.worstOffenders?.length
            ? `**Worst offenders:** ${list(architectureDrift.worstOffenders.map((o) => `${o.file} (${o.violationCount} violation(s))`))}`
            : '_No repeat offenders._')));

    md.push(section('API Surface',
        `**${apiEndpoints.length} endpoint(s) discovered.** Auth coverage: ${fmtPct(authCoverage.coveragePct ?? 0)} ` +
        `(${authCoverage.protectedCount ?? 0}/${authCoverage.totalEndpoints ?? 0} protected).\n\n` +
        list(apiEndpoints.slice(0, 15).map((e) => `\`${e.method} ${e.path}\` — ${e.file}${e.authProtected ? ' 🔒' : ' 🔓'}`))));

    if ((databaseSchema.tables || []).length) {
        md.push(section('Data Model',
            `**${databaseSchema.tables.length} table(s)/entity(ies) detected.**\n\n` +
            list(databaseSchema.tables.map((t) => `${t.name} (${t.columns.length} columns, ${t.foreignKeys.length} FK(s)) — \`${t.file}\``)) +
            (orphanTables.length ? `\n\n**Possibly orphaned:** ${list(orphanTables.map((o) => o.table))}` : '')));
    }

    md.push(section('Dependencies',
        `**${dependencyInventory.totalCount ?? 0} third-party dependencies** across ${Object.keys(dependencyInventory.byEcosystem || {}).join(', ') || 'n/a'}.\n\n` +
        (licenseCompliance.copyleftFlags?.length
            ? `⚠️ **Copyleft-licensed dependencies found:** ${list(licenseCompliance.copyleftFlags.map((c) => `${c.name} (${c.license})`))}`
            : '_No copyleft licenses identified (see licenseCompliance for what could not be verified)._') +
        `\n\n_${licenseCompliance.unknownCount ?? 0} dependencies have an unverified license — this check is offline/best-effort, not a full compliance audit._`));

    const highRiskFiles = Object.entries(migrationRisk).filter(([, r]) => r.level === 'critical' || r.level === 'high');
    if (highRiskFiles.length) {
        md.push(section('Highest Migration/Change Risk',
            list(highRiskFiles.slice(0, 10).map(([file, r]) => `**${file}** — ${r.level} (score ${r.score}/100)`))));
    }

    return md.join('\n');
}
