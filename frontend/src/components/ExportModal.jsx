import { useState } from 'react';
import { Upload, X, Image as ImageIcon, FileText, Braces, Settings2, Link2 } from 'lucide-react';

import './ExportModal.css';

/**
 * Export modal — ported from CodeFlow's own Export feature (see its
 * generateReport()/exportSVG()/exportPDF() functions), adapted to this
 * project's analysisResult shape. Intentionally skips CodeFlow's "Block
 * Diagram" section (Mermaid/architecture-diagram export) since this project
 * has no architectureDiagram data to export — everything here works from
 * data already present in analysisResult + the live graph's SVG.
 *
 * PDF export needs the `jspdf` package (not otherwise used in this project):
 *   npm install jspdf
 */
function download(filename, content, mimeType) {
    const blob = content instanceof Blob ? content : new Blob([content], { type: mimeType });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
}

function safeName(name) {
    return (name || 'repository').replace(/[^a-z0-9-_]+/gi, '-');
}

const EXPORT_STYLE_PROPS = ['fill', 'stroke', 'stroke-width', 'stroke-opacity', 'fill-opacity', 'opacity', 'font-family', 'font-size', 'font-weight', 'text-anchor'];

/**
 * Clones the live graph SVG and bakes every element's *computed* style into
 * an inline `style` attribute before serializing (see earlier fix for why —
 * XMLSerializer drops external CSS). Also resets the export to show the
 * FULL graph regardless of current pan/zoom: cloning as-is would carry over
 * whatever transform the live view currently has, so anything outside the
 * on-screen viewport would get clipped out of the export too. getBBox() on
 * the content group reads its true extent in local (untransformed) space —
 * ignoring the group's own transform entirely — so we can reset the clone's
 * transform to identity and size the SVG via viewBox to fit that real
 * extent, independent of whatever zoom level you were looking at.
 */
function serializeGraphSvg(svgEl) {
    const originalEls = svgEl.querySelectorAll('*');
    const clone = svgEl.cloneNode(true);
    const clonedEls = clone.querySelectorAll('*');

    originalEls.forEach((origEl, i) => {
        const computed = window.getComputedStyle(origEl);
        const styleStr = EXPORT_STYLE_PROPS.map((prop) => `${prop}:${computed.getPropertyValue(prop)}`).join(';');
        clonedEls[i].setAttribute('style', styleStr);
    });

    const contentG = svgEl.querySelector('g');
    const clonedContentG = clone.querySelector('g');
    if (contentG && clonedContentG) {
        const bbox = contentG.getBBox();
        const padding = 40;
        clonedContentG.setAttribute('transform', 'translate(0,0) scale(1)');
        clone.setAttribute('viewBox', `${bbox.x - padding} ${bbox.y - padding} ${bbox.width + padding * 2} ${bbox.height + padding * 2}`);
        clone.setAttribute('width', Math.max(600, Math.round(bbox.width + padding * 2)));
        clone.setAttribute('height', Math.max(400, Math.round(bbox.height + padding * 2)));
    }

    clone.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
    const bg = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
    bg.setAttribute('width', '100%');
    bg.setAttribute('height', '100%');
    bg.setAttribute('fill', '#0b0b12');
    clone.insertBefore(bg, clone.firstChild);
    return new XMLSerializer().serializeToString(clone);
}

async function exportSVG(svgEl, repoName) {
    const svgString = serializeGraphSvg(svgEl);
    download(`${safeName(repoName)}-graph.svg`, svgString, 'image/svg+xml');
}

async function exportPDF(svgEl, repoName) {
    const { jsPDF } = await import('jspdf'); // dynamic import — only pulled in when actually exporting a PDF
    const svgString = serializeGraphSvg(svgEl);
    const svgBlob = new Blob([svgString], { type: 'image/svg+xml' });
    const url = URL.createObjectURL(svgBlob);

    const img = new Image();
    await new Promise((resolve, reject) => {
        img.onload = resolve;
        img.onerror = reject;
        img.src = url;
    });

    const scale = 2; // rasterize at 2x for a crisper PDF than the on-screen SVG size
    const canvas = document.createElement('canvas');
    canvas.width = (svgEl.clientWidth || img.width) * scale;
    canvas.height = (svgEl.clientHeight || img.height) * scale;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#0b0b12';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
    URL.revokeObjectURL(url);

    const imgData = canvas.toDataURL('image/png');
    const orientation = canvas.width >= canvas.height ? 'l' : 'p';
    const pdf = new jsPDF({ orientation, unit: 'pt', format: 'a4' });
    const pageW = pdf.internal.pageSize.getWidth();
    const pageH = pdf.internal.pageSize.getHeight();
    const ratio = Math.min(pageW / canvas.width, pageH / canvas.height);
    const w = canvas.width * ratio;
    const h = canvas.height * ratio;
    pdf.addImage(imgData, 'PNG', (pageW - w) / 2, (pageH - h) / 2, w, h);
    pdf.save(`${safeName(repoName)}-graph.pdf`);
}

/** Builds one shared report data object every format (JSON/MD/Text) renders from. */
function buildReportData(analysisResult, repoMeta) {
    const { files = [], classes = [], functions = [], dependencies = [], healthScore, issues = [], patterns = [], securityIssues = [], duplicates = [] } = analysisResult;
    return {
        repository: repoMeta?.name || 'repository',
        generatedAt: new Date().toISOString(),
        summary: {
            files: files.length,
            classes: classes.length,
            functions: functions.length,
            dependencies: dependencies.length,
            healthScore: healthScore?.score ?? null,
            healthGrade: healthScore?.grade ?? null,
        },
        issues: issues.map((i) => ({ title: i.title, desc: i.desc, severity: i.severity, count: i.items?.length ?? 0 })),
        patterns: patterns.map((p) => ({ name: p.name, desc: p.desc, files: p.files?.map((f) => f.path) ?? [] })),
        securityIssues: securityIssues.map((s) => ({ title: s.title, desc: s.desc, severity: s.severity, file: s.file })),
        duplicates: duplicates.map((d) => ({ type: d.type, name: d.name, locations: d.files?.map((f) => f.file) ?? [] })),
        files: files.map((f) => ({ path: f.path, loc: f.loc, layer: f.layer })),
    };
}

function reportToMarkdown(data) {
    const lines = [];
    lines.push(`# ${data.repository} — Analysis Report`);
    lines.push(`_Generated ${data.generatedAt}_\n`);
    lines.push(`## Summary`);
    lines.push(`- Files: ${data.summary.files}`);
    lines.push(`- Classes: ${data.summary.classes}`);
    lines.push(`- Functions: ${data.summary.functions}`);
    lines.push(`- Dependencies: ${data.summary.dependencies}`);
    if (data.summary.healthScore != null) lines.push(`- Health Score: ${data.summary.healthScore}/100 (${data.summary.healthGrade})`);
    lines.push('');

    if (data.issues.length) {
        lines.push(`## Architecture Issues (${data.issues.length})`);
        data.issues.forEach((i) => lines.push(`- **${i.title}** (${i.severity}, ${i.count} items) — ${i.desc}`));
        lines.push('');
    }
    if (data.patterns.length) {
        lines.push(`## Patterns (${data.patterns.length})`);
        data.patterns.forEach((p) => lines.push(`- **${p.name}** — ${p.desc} (${p.files.length} files)`));
        lines.push('');
    }
    if (data.securityIssues.length) {
        lines.push(`## Security Issues (${data.securityIssues.length})`);
        data.securityIssues.forEach((s) => lines.push(`- **${s.title}** (${s.severity}) in \`${s.file}\` — ${s.desc}`));
        lines.push('');
    }
    if (data.duplicates.length) {
        lines.push(`## Duplicate Code (${data.duplicates.length})`);
        data.duplicates.forEach((d) => lines.push(`- **${d.name}** — found in: ${d.locations.join(', ')}`));
        lines.push('');
    }
    lines.push(`## Files (${data.files.length})`);
    data.files.forEach((f) => lines.push(`- \`${f.path}\`${f.layer ? ` (${f.layer})` : ''} — ${f.loc ?? '?'} lines`));
    return lines.join('\n');
}

function reportToPlainText(data) {
    // Same content as Markdown, stripped of markdown syntax — kept as a
    // separate function (rather than regex-stripping the MD output) since
    // headings/emphasis render differently enough that a dedicated pass
    // reads more cleanly as plain text.
    const lines = [];
    lines.push(`${data.repository} — ANALYSIS REPORT`);
    lines.push(`Generated ${data.generatedAt}`);
    lines.push('='.repeat(50));
    lines.push('SUMMARY');
    lines.push(`Files: ${data.summary.files} | Classes: ${data.summary.classes} | Functions: ${data.summary.functions} | Dependencies: ${data.summary.dependencies}`);
    if (data.summary.healthScore != null) lines.push(`Health Score: ${data.summary.healthScore}/100 (${data.summary.healthGrade})`);
    lines.push('');

    if (data.issues.length) {
        lines.push(`ARCHITECTURE ISSUES (${data.issues.length})`);
        data.issues.forEach((i) => lines.push(`  - ${i.title} [${i.severity}] (${i.count} items): ${i.desc}`));
        lines.push('');
    }
    if (data.patterns.length) {
        lines.push(`PATTERNS (${data.patterns.length})`);
        data.patterns.forEach((p) => lines.push(`  - ${p.name}: ${p.desc} (${p.files.length} files)`));
        lines.push('');
    }
    if (data.securityIssues.length) {
        lines.push(`SECURITY ISSUES (${data.securityIssues.length})`);
        data.securityIssues.forEach((s) => lines.push(`  - ${s.title} [${s.severity}] in ${s.file}: ${s.desc}`));
        lines.push('');
    }
    if (data.duplicates.length) {
        lines.push(`DUPLICATE CODE (${data.duplicates.length})`);
        data.duplicates.forEach((d) => lines.push(`  - ${d.name}: ${d.locations.join(', ')}`));
        lines.push('');
    }
    lines.push(`FILES (${data.files.length})`);
    data.files.forEach((f) => lines.push(`  - ${f.path}${f.layer ? ` (${f.layer})` : ''} — ${f.loc ?? '?'} lines`));
    return lines.join('\n');
}

function buildRawJson(analysisResult) {
    const { files = [], graph, issues = [], patterns = [], securityIssues = [] } = analysisResult;
    return {
        files: files.map((f) => f.path),
        connections: graph?.edges ?? [],
        issues,
        patterns,
        securityIssues,
    };
}

const SECTIONS = [
    {
        title: 'GRAPH VISUALIZATION',
        items: [
            { key: 'svg', label: 'SVG Image', icon: ImageIcon },
            { key: 'pdf', label: 'PDF Document', icon: FileText },
            { key: 'share', label: 'Share Link', icon: Link2 },
        ],
    },
    {
        title: 'ANALYSIS REPORT',
        desc: 'Complete analysis with files, functions, patterns, security issues, and dependencies',
        items: [
            { key: 'json', label: 'JSON Report', icon: Braces },
            { key: 'markdown', label: 'Markdown', icon: FileText },
            { key: 'text', label: 'Plain Text', icon: FileText },
        ],
    },
    {
        title: 'RAW DATA',
        items: [
            { key: 'rawjson', label: 'Raw JSON', icon: Settings2 },
        ],
    },
];

export default function ExportModal({ open, onClose, analysisResult, repoMeta, graphCanvasRef }) {
    const [busy, setBusy] = useState(null);
    const [copiedLink, setCopiedLink] = useState(false);
    const canShareLink = repoMeta?.source === 'github' && repoMeta?.owner && repoMeta?.repo;

    if (!open) return null;

    async function handleClick(key) {
        setBusy(key);
        try {
            const repoName = repoMeta?.name || 'repository';
            const svgEl = graphCanvasRef?.current?.getSvgElement?.();

            if (key === 'svg') {
                if (!svgEl) throw new Error('Graph not ready to export yet.');
                await exportSVG(svgEl, repoName);
            } else if (key === 'pdf') {
                if (!svgEl) throw new Error('Graph not ready to export yet.');
                await exportPDF(svgEl, repoName);
            } else if (key === 'share') {
                if (!canShareLink) return; // disabled state below already prevents this, belt-and-braces
                const url = `${window.location.origin}${window.location.pathname}?repo=${repoMeta.owner}/${repoMeta.repo}`;
                await navigator.clipboard.writeText(url);
                setCopiedLink(true);
                setTimeout(() => setCopiedLink(false), 2000);
            } else if (key === 'json') {
                const data = buildReportData(analysisResult, repoMeta);
                download(`${safeName(repoName)}-report.json`, JSON.stringify(data, null, 2), 'application/json');
            } else if (key === 'markdown') {
                const data = buildReportData(analysisResult, repoMeta);
                download(`${safeName(repoName)}-report.md`, reportToMarkdown(data), 'text/markdown');
            } else if (key === 'text') {
                const data = buildReportData(analysisResult, repoMeta);
                download(`${safeName(repoName)}-report.txt`, reportToPlainText(data), 'text/plain');
            } else if (key === 'rawjson') {
                download(`${safeName(repoName)}-raw.json`, JSON.stringify(buildRawJson(analysisResult), null, 2), 'application/json');
            }
        } catch (err) {
            console.error(`[ExportModal] ${key} export failed:`, err);
            alert(`Export failed: ${err.message}`);
        } finally {
            setBusy(null);
        }
    }

    return (
        <div className="export-modal__overlay" onClick={onClose}>
            <div className="export-modal" onClick={(e) => e.stopPropagation()}>
                <div className="export-modal__header">
                    <h3><Upload size={16} strokeWidth={2} /> Export</h3>
                    <button className="export-modal__close" onClick={onClose}><X size={18} strokeWidth={2} /></button>
                </div>
                <div className="export-modal__body">
                    {SECTIONS.map((section) => (
                        <div key={section.title} className="export-modal__section">
                            <h4>{section.title}</h4>
                            {section.desc && <p className="export-modal__section-desc">{section.desc}</p>}
                            <div className="export-modal__grid">
                                {section.items.map(({ key, label, icon: Icon }) => {
                                    const disabled = busy != null || (key === 'share' && !canShareLink);
                                    const showCopied = key === 'share' && copiedLink;
                                    return (
                                        <button
                                            key={key}
                                            className="export-modal__item"
                                            disabled={disabled}
                                            title={key === 'share' && !canShareLink ? 'Only available for repositories loaded from GitHub' : undefined}
                                            onClick={() => handleClick(key)}
                                        >
                                            <Icon size={20} strokeWidth={1.8} />
                                            <span>{busy === key ? 'Exporting…' : showCopied ? 'Copied!' : label}</span>
                                        </button>
                                    );
                                })}
                            </div>
                        </div>
                    ))}
                </div>
            </div>
        </div>
    );
}