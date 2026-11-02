/** Dogfood the current engine against actual shipped sources, not documentation.
 * Measures parser execution and evidence integrity, NOT semantic recall. */
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { resolve, relative, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { analyzeRepository } from '../orchestrator.js';
import { identifyCodeLanguage } from '../languageIntelligence.js';

const repo = resolve(fileURLToPath(new URL('../../../../', import.meta.url)));
const dirs = [
    join(repo, 'frontend/src/analysis-engine'),
    join(repo, 'backend/src/main'),
    join(repo, 'ai-service/app'),
];
const discovered = [];
async function walk(dir) {
    for (const item of await readdir(dir, { withFileTypes: true })) {
        if (item.name.startsWith('.')) continue;
        const file = join(dir, item.name);
        if (item.isDirectory()) { await walk(file); continue; }
        if (!item.isFile() || !identifyCodeLanguage(item.name)) continue;
        const content = await readFile(file, 'utf8');
        if (content.length > 2_000_000) continue;
        discovered.push({path: relative(repo, file).replace(/\\/g, '/'), content});
    }
}
for (const dir of dirs) await walk(dir);
assert.ok(discovered.length > 30, 'expected an actual multi-language source corpus');
const result = await analyzeRepository({name: 'self-project-corpus'}, discovered);
assert.ok(result.functions.length > 20, 'expected extracted real code symbols');
assert.equal(result.analysisCoverage.languageDepth.supportedLanguages, 30);
assert.equal(result.evidenceAudit.summary.invalid, 0, 'actual source evidence references must resolve');
console.log(JSON.stringify({status: 'passed', files: discovered.length,
    languageModes: result.analysisCoverage.languageDepth.languages,
    symbols: result.functions.length, classes: result.classes.length,
    sourceEvidence: result.evidenceAudit.summary,
    graphEvidence: result.graphQuality.summary,
    businessCandidates: result.businessIntelligence.summary,
    crossSystemCandidates: result.crossSystemIntelligence.summary,
    disclaimer: 'Real project smoke test; no manually labelled precision/recall, no runtime tests or compiler semantic checking.'}, null, 2));
