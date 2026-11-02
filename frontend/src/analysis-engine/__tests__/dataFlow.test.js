import { describe, expect, it } from 'vitest';
import { analyzeHeuristicDataFlows } from '../dataFlow.js';

describe('heuristic data-flow leads', () => {
    it('traces a simple request-input assignment into a SQL sink', () => {
        const result = analyzeHeuristicDataFlows([{
            path: 'src/users.js',
            content: `export function search(req, db) {\n  const userInput = req.query.name;\n  const queryText = "SELECT * FROM users WHERE name = '" + userInput;\n  db.query(queryText);\n}`,
        }]);
        expect(result.summary.potentialFlows).toBeGreaterThan(0);
        expect(result.flows).toEqual(expect.arrayContaining([
            expect.objectContaining({ source: expect.objectContaining({ line: 2, kind: 'request-input' }), sink: expect.objectContaining({ line: 4, kind: 'sql-query' }), confidence: 'low' }),
        ]));
        expect(result.semantics).toContain('cannot confirm exploitability');
    });

    it('does not propagate stale taint after a variable is overwritten with an untainted value', () => {
        const result = analyzeHeuristicDataFlows([{
            path: 'src/reset.js',
            content: `function query(db, req) {\n  let input = req.query.name;\n  input = 'fixed';\n  db.query(input);\n}`,
        }]);
        expect(result.summary.potentialFlows).toBe(0);
    });

    it('ignores source and sink patterns inside comments and strings', () => {
        const result = analyzeHeuristicDataFlows([{
            path: 'src/safe.js',
            content: `// req.query.name; db.query(query);\nconst message = "req.body.x; db.query(x)";\nfunction safe(db) { db.query("SELECT 1"); }`,
        }]);
        expect(result.summary.potentialFlows).toBe(0);
    });

    it('preserves executable expressions inside JavaScript template interpolations', () => {
        const result = analyzeHeuristicDataFlows([{
            path: 'src/template.js',
            content: 'function query(req, db) {\n const value = req.query.name;\n db.query(`SELECT * FROM users WHERE name = ${value}`);\n}',
        }]);
        expect(result.flows).toEqual(expect.arrayContaining([
            expect.objectContaining({ source: expect.objectContaining({ kind: 'request-input', line: 2 }), sink: expect.objectContaining({ kind: 'sql-query', line: 3 }) }),
        ]));
    });

    it('resets local taint between unrelated function scopes', () => {
        const result = analyzeHeuristicDataFlows([{
            path: 'src/scopes.js',
            content: 'function first(req) {\n const secret = req.body.value;\n}\nfunction second(db) {\n db.query(secret);\n}',
        }]);
        expect(result.summary.potentialFlows).toBe(0);
        expect(result.summary.functionScopeResets).toBeGreaterThanOrEqual(2);
    });

    it('records sanitizer-like calls as review signals without asserting safety', () => {
        const result = analyzeHeuristicDataFlows([{
            path: 'src/sanitize.js',
            content: 'function render(req, node) {\n const input = req.body.value;\n const output = escapeHtml(input);\n node.innerHTML = output;\n}',
        }]);
        expect(result.flows).toEqual(expect.arrayContaining([
            expect.objectContaining({ mitigationSignals: expect.arrayContaining([expect.stringContaining('escapeHtml')]) }),
        ]));
        expect(result.semantics).toContain('not accepted as proof of safety');
    });

    it('marks supported-language scope and caps potential-flow output', () => {
        const result = analyzeHeuristicDataFlows([
            { path: 'main.go', content: 'func main() {}' },
            { path: 'main.py', content: 'x = request.args.get("x")\ncursor.execute(x)' },
        ], { maxTotalFlows: 1 });
        expect(result.summary.supportedFiles).toBe(1);
        expect(result.status).toBe('heuristic-limited');
        expect(result.semantics).toContain('not a complete taint analysis');
    });
});
