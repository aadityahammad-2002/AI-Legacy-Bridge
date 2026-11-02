/** Precision/recall evaluation against manually labelled expected findings. */
function normalizePath(path) {
    return String(path || '').replace(/\\/g, '/').replace(/^\.\//, '').replace(/^\/+/, '').replace(/\/{2,}/g, '/');
}
function fieldPath(item) { return normalizePath(item?.location?.path || item?.path || item?.file || item?.filePath || item?.filename); }
function fieldLine(item) { return item?.location?.startLine ?? item?.startLine ?? item?.line ?? item?.lineNumber ?? null; }
function fieldRule(item) { return String(item?.ruleId || '').trim(); }
function lineMatch(expected, actual, tolerance) {
    const expectedLine = fieldLine(expected);
    const actualLine = fieldLine(actual);
    if (expectedLine == null) return true;
    if (actualLine == null) return false;
    return Math.abs(Number(expectedLine) - Number(actualLine)) <= tolerance;
}
function ratio(numerator, denominator) { return denominator > 0 ? Math.round(numerator / denominator * 10000) / 10000 : null; }

/**
 * Expected labels must be manually reviewed. True negatives cannot be computed
 * from findings alone because the universe of all possible non-findings is undefined.
 */
export function evaluateFindingBenchmark(expectedFindings = [], actualFindings = [], options = {}) {
    if (!Array.isArray(expectedFindings) || !Array.isArray(actualFindings)) throw new TypeError('expectedFindings and actualFindings must be arrays.');
    const lineTolerance = Math.max(0, Math.min(20, Number(options.lineTolerance) || 0));
    const ignoreSuppressed = options.ignoreSuppressed !== false;
    const excludedCategories = new Set((options.excludeCategories || []).map((value) => String(value).toLowerCase()));
    const excludedRuleIds = new Set((options.excludeRuleIds || []).map((value) => String(value).toLowerCase()));
    const includedCategories = new Set((options.includeCategories || []).map((value) => String(value).toLowerCase()));
    const includedRuleIds = new Set((options.includeRuleIds || []).map((value) => String(value).toLowerCase()));
    const includedByScope = (item) => {
        const category = String(item?.category || '').toLowerCase();
        const ruleId = String(item?.ruleId || '').toLowerCase();
        const categoryAllowed = !includedCategories.size || [...includedCategories].some((include) => category === include || category.startsWith(`${include}.`));
        const ruleAllowed = !includedRuleIds.size || includedRuleIds.has(ruleId);
        return categoryAllowed && ruleAllowed;
    };
    const excludedByPolicy = (item) => {
        const category = String(item?.category || '').toLowerCase();
        const ruleId = String(item?.ruleId || '').toLowerCase();
        return !includedByScope(item) || [...excludedCategories].some((excluded) => category === excluded || category.startsWith(`${excluded}.`)) || excludedRuleIds.has(ruleId);
    };
    const expectedIncluded = expectedFindings.filter((item) => !excludedByPolicy(item));
    const actualIncluded = actualFindings.filter((item) => !excludedByPolicy(item));
    const actual = actualIncluded.filter((item) => !(ignoreSuppressed && String(item?.status || '').toLowerCase() === 'suppressed'));
    const usedActual = new Set();
    const matches = [];
    const falseNegatives = [];
    for (const expected of expectedIncluded) {
        const ruleId = fieldRule(expected);
        const path = fieldPath(expected);
        const candidateIndex = actual.findIndex((item, index) => {
            if (usedActual.has(index)) return false;
            if (ruleId && fieldRule(item) !== ruleId) return false;
            if (path && fieldPath(item) !== path) return false;
            if (!ruleId && !expected.title && !expected.category) return false;
            if (!ruleId && expected.category && String(item.category || '') !== String(expected.category)) return false;
            if (!ruleId && expected.title && String(item.title || item.name || '') !== String(expected.title)) return false;
            return lineMatch(expected, item, lineTolerance);
        });
        if (candidateIndex < 0) falseNegatives.push(expected);
        else {
            usedActual.add(candidateIndex);
            matches.push({ expectedIndex: expectedFindings.indexOf(expected), actualIndex: candidateIndex, ruleId: ruleId || fieldRule(actual[candidateIndex]), path: path || fieldPath(actual[candidateIndex]), expectedLine: fieldLine(expected), actualLine: fieldLine(actual[candidateIndex]) });
        }
    }
    const falsePositives = actual.filter((_, index) => !usedActual.has(index));
    const truePositives = matches.length;
    const precision = ratio(truePositives, truePositives + falsePositives.length);
    const recall = ratio(truePositives, truePositives + falseNegatives.length);
    const f1 = precision == null || recall == null || precision + recall === 0 ? null : Math.round((2 * precision * recall / (precision + recall)) * 10000) / 10000;
    const ruleIds = [...new Set([...expectedIncluded.map(fieldRule), ...actual.map(fieldRule)].filter(Boolean))].sort();
    const perRule = ruleIds.map((ruleId) => {
        const expectedCount = expectedIncluded.filter((item) => fieldRule(item) === ruleId).length;
        const actualCount = actual.filter((item) => fieldRule(item) === ruleId).length;
        const tp = matches.filter((item) => item.ruleId === ruleId).length;
        const fp = actualCount - tp;
        const fn = expectedCount - tp;
        return { ruleId, truePositives: tp, falsePositives: Math.max(0, fp), falseNegatives: Math.max(0, fn), precision: ratio(tp, tp + Math.max(0, fp)), recall: ratio(tp, tp + Math.max(0, fn)) };
    });
    return {
        schemaVersion: 1,
        labelledExpectedCount: expectedIncluded.length,
        actualFindingCount: actual.length,
        inputExpectedFindingCount: expectedFindings.length,
        inputActualFindingCount: actualFindings.length,
        excludedExpectedFindingCount: expectedFindings.length - expectedIncluded.length,
        excludedActualFindingCount: actualFindings.length - actualIncluded.length,
        evaluationPolicy: { includeCategories: [...includedCategories].sort(), includeRuleIds: [...includedRuleIds].sort(), excludedCategories: [...excludedCategories].sort(), excludedRuleIds: [...excludedRuleIds].sort(), ignoreSuppressed },
        truePositives,
        falsePositives: falsePositives.length,
        falseNegatives: falseNegatives.length,
        precision,
        recall,
        f1,
        lineTolerance,
        matches,
        falsePositiveSamples: falsePositives.slice(0, 100),
        falseNegativeSamples: falseNegatives.slice(0, 100),
        perRule,
        limitations: [
            'The result is only as reliable as the manually reviewed expected-findings labels and matching keys.',
            'True negatives and specificity are not computed: the universe of all possible non-findings is undefined.',
            'Labels using a path/rule without a line can match any actual line for that path/rule; use exact lines when practical.',
            'Excluded categories/rules are outside the reported precision/recall denominator; they are not treated as true positives or negatives.',
            'A benchmark repository or fixture set should include both expected findings and manually reviewed absence/negative cases for the specific rules being evaluated.',
        ],
    };
}


/**
 * Evaluate the heuristic health score against human-reviewed score labels.
 * This intentionally measures error; it does not silently rewrite/calibrate the
 * score formula. A useful cross-repository read requires a minimum label count.
 */
export function evaluateHealthScoreCalibration(samples = [], options = {}) {
    if (!Array.isArray(samples)) throw new TypeError('Health-score calibration samples must be an array.');
    const minSamples = Math.max(5, Math.floor(Number(options.minSamples) || 5));
    const valid = samples.map((sample) => ({
        repository: String(sample?.repository || sample?.name || 'unnamed-repository'),
        expectedScore: Number(sample?.expectedHealthScore ?? sample?.expectedScore),
        actualScore: Number(sample?.actualHealthScore ?? sample?.actualScore),
        expectedGrade: sample?.expectedGrade == null ? null : String(sample.expectedGrade),
        actualGrade: sample?.actualGrade == null ? null : String(sample.actualGrade),
    })).filter((sample) => Number.isFinite(sample.expectedScore) && sample.expectedScore >= 0 && sample.expectedScore <= 100
        && Number.isFinite(sample.actualScore) && sample.actualScore >= 0 && sample.actualScore <= 100);
    const errors = valid.map((sample) => sample.actualScore - sample.expectedScore);
    const absoluteErrors = errors.map(Math.abs);
    const mean = (values) => values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
    const gradePairs = valid.filter((sample) => sample.expectedGrade && sample.actualGrade);
    const gradeMatches = gradePairs.filter((sample) => sample.expectedGrade === sample.actualGrade).length;
    const count = valid.length;
    return {
        schemaVersion: 1,
        status: count >= minSamples ? 'measured' : 'insufficient-reviewed-labels',
        scoreFormulaChanged: false,
        calibrated: false,
        sampleCount: count,
        minSamplesRequired: minSamples,
        meanAbsoluteError: mean(absoluteErrors) == null ? null : Math.round(mean(absoluteErrors) * 100) / 100,
        rootMeanSquaredError: mean(errors.map((value) => value * value)) == null ? null : Math.round(Math.sqrt(mean(errors.map((value) => value * value))) * 100) / 100,
        signedBias: mean(errors) == null ? null : Math.round(mean(errors) * 100) / 100,
        gradeAccuracy: gradePairs.length ? Math.round(gradeMatches / gradePairs.length * 10000) / 10000 : null,
        gradeLabelCount: gradePairs.length,
        samples: valid.map((sample, index) => ({ ...sample, signedError: Math.round(errors[index] * 100) / 100, absoluteError: Math.round(absoluteErrors[index] * 100) / 100 })),
        semantics: 'Measures agreement with manually reviewed health-score labels; it does not alter the scoring formula. Labels must be independently reviewed and consistently defined across repositories.',
    };
}
