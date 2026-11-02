import * as d3 from 'd3';
import { reportWorkerError } from './workerClient.js';
let simulation;
let byId = new Map();
let frame = 0;

self.onmessage = ({ data }) => {
    try {
        if (data.action === 'start') {
            simulation?.stop();
            const nodes = data.nodes.map((n) => ({ ...n }));
            const links = data.links.map((e) => ({ ...e }));
            byId = new Map(nodes.map((n) => [n.id, n]));
            frame = 0;
            simulation = d3.forceSimulation(nodes)
                .force('link', d3.forceLink(links).id((d) => d.id).distance(30).strength(0.3))
                .force('charge', d3.forceManyBody().strength(-60))
                .force('x', d3.forceX((d) => d.cx).strength(0.15))
                .force('y', d3.forceY((d) => d.cy).strength(0.15))
                .force('collide', d3.forceCollide(12))
                .on('tick', () => {
                    if (++frame % 3 !== 0) return;
                    self.postMessage({ type: 'positions', positions: nodes.map((n) => [n.id, n.x, n.y]) });
                })
                .on('end', () => self.postMessage({ type: 'positions', positions: nodes.map((n) => [n.id, n.x, n.y]) }));
        } else if (data.action === 'drag') {
            const node = byId.get(data.id);
            if (!node || !simulation) return;
            if (data.phase === 'start') {
                node.fx = data.x; node.fy = data.y;
                simulation.alphaTarget(0.3).restart();
            } else if (data.phase === 'move') {
                node.fx = data.x; node.fy = data.y;
            } else if (data.phase === 'end') {
                node.fx = null; node.fy = null;
                simulation.alphaTarget(0);
            }
        }
    } catch (error) { reportWorkerError(error); }
};
