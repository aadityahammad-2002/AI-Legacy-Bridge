import * as d3 from 'd3';
import { reportWorkerError } from './workerClient.js';

/** These forces mirror GraphCanvas's historic parameters, not a new graph algorithm. */
function mainForce(nodes, edges, width, height, spread, linksParam) {
    const simNodes = nodes.map((n) => ({ ...n }));
    const simLinks = edges.map((e) => ({ source: e.source, target: e.target }));
    const sim = d3.forceSimulation(simNodes)
        .force('link', d3.forceLink(simLinks).id((d) => d.id).distance(30 + linksParam * 120).strength(0.5))
        .force('charge', d3.forceManyBody().strength(-60 - spread * 320))
        .force('center', d3.forceCenter(width / 2, height / 2))
        .force('collide', d3.forceCollide(14 + spread * 20))
        .force('x', d3.forceX(width / 2).strength(0.05))
        .force('y', d3.forceY(height / 2).strength(0.05))
        .stop();
    const ticks = Math.min(400, Math.max(120, simNodes.length * 3));
    for (let i = 0; i < ticks; i++) sim.tick();
    return simNodes.map((n) => [n.id, { x: n.x, y: n.y }]);
}

self.onmessage = ({ data }) => {
    try {
        const p = data;
        let entries;
        if (p.mode === 'force') entries = mainForce(p.nodes, p.edges, p.width, p.height, p.spread ?? 0.5, p.linksParam ?? 0.5);
        else throw new Error(`Unsupported graph layout: ${p.mode}`);
        self.postMessage({ type: 'result', result: entries });
    } catch (error) { reportWorkerError(error); }
};
