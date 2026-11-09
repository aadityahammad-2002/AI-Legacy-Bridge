import { useEffect, useState } from 'react';
import {
    ArrowRight, ArrowUpRight, Boxes, Braces, Check, ChevronRight,
    Code2, Database, FileArchive, FileCode2, FileSearch, FolderOpen,
    GitBranch, GitFork, Layers3, Menu, MessageSquareCode, Network,
    ScanSearch, Sparkles, Workflow, X,
} from 'lucide-react';
import './LandingPage.css';

const REPOSITORY_URL = 'https://github.com/aadityahammad-2002/AI-Legacy-Bridge';
const README_URL = `${REPOSITORY_URL}#readme`;

const NAV_ITEMS = [
    { label: 'Home', href: '#home' },
    { label: 'Features', href: '#features' },
    { label: 'How It Works', href: '#how-it-works' },
    { label: 'Architecture', href: '#architecture' },
    { label: 'Use Cases', href: '#use-cases' },
    { label: 'Demo', href: '#demo' },
];

const FEATURES = [
    {
        icon: FileSearch,
        title: 'Codebase understanding',
        description: 'Turn source files into navigable classes, functions, imports, dependencies, and structural insights.',
        tag: 'Analysis Engine',
    },
    {
        icon: MessageSquareCode,
        title: 'Source-grounded AI',
        description: 'Ask repository-aware questions and explore code with file context instead of disconnected general answers.',
        tag: 'AI Explorer',
    },
    {
        icon: Database,
        title: 'RAG + optional GraphRAG',
        description: 'Retrieve context with PostgreSQL/pgvector. Add Neo4j graph retrieval when the graph service is configured.',
        tag: 'Context retrieval',
    },
    {
        icon: Network,
        title: 'Architecture visualization',
        description: 'Trace relationships between files and modules in an interactive dependency visualization.',
        tag: 'Visualization Explorer',
    },
    {
        icon: ScanSearch,
        title: 'Source navigation',
        description: 'Move from architecture views to the underlying files, functions, and code-level context.',
        tag: 'Code references',
    },
    {
        icon: GitFork,
        title: 'Modernization assistance',
        description: 'Investigate dependencies, generate tests, and explore migration suggestions for legacy patterns.',
        tag: 'Tests + Migrate',
    },
    {
        icon: Layers3,
        title: 'Provider-based AI',
        description: 'Use configured Groq or Gemini integrations through the AI service; provider access depends on your setup.',
        tag: 'Configurable LLMs',
    },
    {
        icon: FileArchive,
        title: 'Workspace export',
        description: 'Export repository analysis together with source content from the workspace-selection flow.',
        tag: 'JSON export',
    },
];

const STEPS = [
    {
        number: '01',
        icon: FolderOpen,
        title: 'Connect your repository',
        description: 'Choose a GitHub repository, upload a ZIP archive, or select a local project folder.',
        meta: 'GitHub · ZIP · Local folder',
    },
    {
        number: '02',
        icon: Braces,
        title: 'Analyze the codebase',
        description: 'The in-browser Analysis Engine extracts structural data and prepares a repository snapshot.',
        meta: 'Files · Functions · Dependencies',
    },
    {
        number: '03',
        icon: MessageSquareCode,
        title: 'Explore with AI',
        description: 'Open AI Explorer to ask about application logic and navigate source-relevant context.',
        meta: 'Repository-aware answers',
    },
    {
        number: '04',
        icon: Network,
        title: 'Visualize and modernize',
        description: 'Inspect dependency relationships, generate tests, and review migration suggestions.',
        meta: 'Graph · Tests · Migration',
    },
];

const ARCH_LAYERS = [
    {
        icon: Code2,
        eyebrow: '01 · Experience',
        title: 'React + Vite',
        detail: 'Upload, workspaces, graph explorer, AI chat',
    },
    {
        icon: Braces,
        eyebrow: '02 · Understanding',
        title: 'Analysis Engine',
        detail: 'Source parsing, code structure, dependency extraction',
    },
    {
        icon: Database,
        eyebrow: '03 · Persistence',
        title: 'Java Spring Boot',
        detail: 'Repository APIs, snapshots, metadata, PostgreSQL',
    },
    {
        icon: Sparkles,
        eyebrow: '04 · Intelligence',
        title: 'Python FastAPI',
        detail: 'Context retrieval, agents, AI provider integration',
    },
];

const USE_CASES = [
    { icon: Code2, title: 'Developer onboarding', text: 'Help new contributors find the modules and code paths that matter.' },
    { icon: FileCode2, title: 'Legacy code discovery', text: 'Understand unfamiliar services, source files, and their relationships.' },
    { icon: Layers3, title: 'System documentation', text: 'Explore application structure and explain important code paths.' },
    { icon: Network, title: 'Architecture reviews', text: 'Inspect dependencies and the way modules are connected.' },
    { icon: Workflow, title: 'Impact analysis', text: 'Investigate related code before planning changes or refactors.' },
    { icon: GitFork, title: 'Modernization planning', text: 'Explore migration options and test generation as starting points.' },
];

function Brand({ onClick }) {
    return (
        <a className="landing__brand" href="#home" onClick={onClick} aria-label="AI Legacy Bridge — back to top">
            <span className="landing__brand-icon"><GitBranch size={22} strokeWidth={2.2} /></span>
            <span>AI <strong>Legacy Bridge</strong></span>
        </a>
    );
}

function SectionIntro({ eyebrow, title, children, centered = false }) {
    return (
        <div className={`landing__section-intro${centered ? ' landing__section-intro--center' : ''}`}>
            <span className="landing__eyebrow"><span className="landing__eyebrow-dot" />{eyebrow}</span>
            <h2>{title}</h2>
            <p>{children}</p>
        </div>
    );
}

/** Intentional product illustration, not a screenshot or an actual AI response. */
function ProductIllustration() {
    return (
        <div className="landing__product-art" aria-label="Illustration of repository file exploration and a dependency graph" role="img">
            <div className="landing__art-glow" />
            <div className="landing__art-window">
                <div className="landing__art-toolbar">
                    <div className="landing__window-dots" aria-hidden="true"><i /><i /><i /></div>
                    <span><GitBranch size={12} /> legacy-project / workspace</span>
                    <span className="landing__window-tag">LIVE ANALYSIS</span>
                </div>
                <div className="landing__art-body">
                    <div className="landing__art-sidebar">
                        <div className="landing__art-sidebar-label">REPOSITORY</div>
                        <div className="landing__art-file landing__art-file--folder"><ChevronRight size={12} /> src</div>
                        <div className="landing__art-file landing__art-file--active"><FileCode2 size={12} /> Application.java</div>
                        <div className="landing__art-file"><FileCode2 size={12} /> UserService.java</div>
                        <div className="landing__art-file"><FileCode2 size={12} /> UserRepository.java</div>
                        <div className="landing__art-file landing__art-file--folder"><ChevronRight size={12} /> config</div>
                        <div className="landing__art-sidebar-stats"><span>FILES</span><strong>•••</strong></div>
                    </div>
                    <div className="landing__art-canvas">
                        <div className="landing__art-canvas-header"><Network size={13} /> Dependency explorer <span>Overview</span></div>
                        <svg className="landing__art-edges" viewBox="0 0 420 295" aria-hidden="true">
                            <defs>
                                <linearGradient id="landing-edge-gradient" x1="0%" y1="0%" x2="100%" y2="100%">
                                    <stop offset="0%" stopColor="#7c68fb" /><stop offset="100%" stopColor="#37c9df" />
                                </linearGradient>
                            </defs>
                            <path d="M210 82 C 165 105, 105 115, 100 173" />
                            <path d="M210 82 C 255 105, 310 120, 324 176" />
                            <path d="M100 173 C 147 199, 170 218, 205 246" />
                            <path d="M324 176 C 277 205, 249 220, 205 246" />
                        </svg>
                        <div className="landing__art-node landing__art-node--one"><Code2 size={15} /> <span>Application</span></div>
                        <div className="landing__art-node landing__art-node--two"><Boxes size={15} /> <span>Controller</span></div>
                        <div className="landing__art-node landing__art-node--three"><Workflow size={15} /> <span>Service</span></div>
                        <div className="landing__art-node landing__art-node--four"><Database size={15} /> <span>Repository</span></div>
                        <div className="landing__art-canvas-caption">Module relationships · conceptual preview</div>
                    </div>
                </div>
            </div>
            <div className="landing__art-ai-card">
                <span className="landing__art-ai-icon"><Sparkles size={17} /></span>
                <div><span className="landing__art-ai-kicker">AI EXPLORER</span><strong>Explore code with context</strong><span className="landing__art-ai-copy">Ask about a file, function, or dependency.</span></div>
                <span className="landing__art-ai-check"><Check size={14} /></span>
            </div>
        </div>
    );
}

function DemoPreview() {
    return (
        <div className="landing__demo-panel">
            <div className="landing__demo-topline">
                <span className="landing__demo-window-controls" aria-hidden="true"><i /><i /><i /></span>
                <span>AI Legacy Bridge / Example workspace</span>
                <span className="landing__demo-caption">ILLUSTRATIVE PREVIEW</span>
            </div>
            <div className="landing__demo-columns">
                <div className="landing__demo-code">
                    <div className="landing__demo-pane-title"><FileCode2 size={14} /> UserService.java <span>EXAMPLE</span></div>
                    <div className="landing__code-lines" aria-label="Illustrative code sample">
                        <div><em>01</em><span><b>public class</b> UserService {'{'}</span></div>
                        <div><em>02</em><span className="landing__code-indent"><b>private final</b> UserRepository repo;</span></div>
                        <div><em>03</em><span /></div>
                        <div><em>04</em><span className="landing__code-indent"><b>public</b> User findById(Long id) {'{'}</span></div>
                        <div><em>05</em><span className="landing__code-indent landing__code-indent--2">return repo.findById(id)</span></div>
                        <div><em>06</em><span className="landing__code-indent landing__code-indent--2">.orElseThrow();</span></div>
                        <div><em>07</em><span className="landing__code-indent">{'}'}</span></div>
                        <div><em>08</em><span>{'}'}</span></div>
                    </div>
                    <div className="landing__demo-code-bottom"><span><span className="landing__status-dot" /> Source context</span><span>Java</span></div>
                </div>
                <div className="landing__demo-chat">
                    <div className="landing__demo-pane-title"><Sparkles size={14} /> AI Explorer <span>EXAMPLE</span></div>
                    <div className="landing__demo-user-msg">Where does the user lookup happen?</div>
                    <div className="landing__demo-answer">
                        <span className="landing__demo-ai-symbol"><Sparkles size={14} /></span>
                        <div>
                            <strong>Follow the source</strong>
                            <p>In this illustrative example, <code>findById</code> delegates to <code>UserRepository</code>. Open the referenced file to trace the next step.</p>
                            <span><FileCode2 size={12} /> UserService.java · example</span>
                        </div>
                    </div>
                    <div className="landing__demo-input">Ask about your repository… <ArrowRight size={16} /></div>
                </div>
            </div>
        </div>
    );
}

export default function LandingPage({ onLaunch }) {
    const [menuOpen, setMenuOpen] = useState(false);

    useEffect(() => {
        if (!menuOpen) return undefined;
        const closeOnEscape = (event) => { if (event.key === 'Escape') setMenuOpen(false); };
        window.addEventListener('keydown', closeOnEscape);
        return () => window.removeEventListener('keydown', closeOnEscape);
    }, [menuOpen]);

    const closeMenu = () => setMenuOpen(false);
    const launchApp = () => { closeMenu(); onLaunch?.(); };

    return (
        <div className="landing">
            <a className="landing__skip-link" href="#main">Skip to content</a>
            <header className="landing__header">
                <div className="landing__container landing__header-inner">
                    <Brand onClick={closeMenu} />
                    <nav className={`landing__nav${menuOpen ? ' landing__nav--open' : ''}`} id="landing-navigation" aria-label="Main navigation">
                        {NAV_ITEMS.map(({ label, href }) => <a href={href} key={href} onClick={closeMenu}>{label}</a>)}
                        <a className="landing__nav-github" href={REPOSITORY_URL} target="_blank" rel="noopener noreferrer" onClick={closeMenu}>GitHub <ArrowUpRight size={14} /></a>
                        <button type="button" className="landing__mobile-cta" onClick={launchApp}>Get Started <ArrowRight size={15} /></button>
                    </nav>
                    <button className="landing__header-cta" type="button" onClick={launchApp}>Get Started <ArrowUpRight size={15} /></button>
                    <button className="landing__menu-toggle" type="button" aria-label={menuOpen ? 'Close navigation menu' : 'Open navigation menu'} aria-expanded={menuOpen} aria-controls="landing-navigation" onClick={() => setMenuOpen((open) => !open)}>{menuOpen ? <X size={23} /> : <Menu size={23} />}</button>
                </div>
            </header>

            <main id="main">
                <section className="landing__hero" id="home" aria-labelledby="landing-headline">
                    <div className="landing__hero-grid" aria-hidden="true" />
                    <div className="landing__container landing__hero-inner">
                        <div className="landing__hero-content">
                            <div className="landing__announcement"><span className="landing__announcement-indicator" /> SOURCE-AWARE CODE INTELLIGENCE <ChevronRight size={13} /></div>
                            <h1 id="landing-headline">Understand complex codebases.<span>Modernize with confidence.</span></h1>
                            <p>Turn unfamiliar and legacy repositories into clear architecture, navigable source context, and AI-powered exploration — all in one workspace.</p>
                            <div className="landing__hero-actions">
                                <button type="button" className="landing__button landing__button--primary" onClick={launchApp}>Start analyzing <ArrowRight size={18} /></button>
                                <a className="landing__button landing__button--secondary" href="#demo">Explore preview <ArrowUpRight size={17} /></a>
                            </div>
                            <div className="landing__hero-proof"><span><Check size={14} /> GitHub, ZIP & local folders</span><span><Check size={14} /> Source-grounded exploration</span></div>
                        </div>
                        <ProductIllustration />
                    </div>
                    <div className="landing__container landing__hero-footer">
                        <span>BUILT AROUND YOUR EXISTING CODEBASE</span>
                        <div><span><Code2 size={15} /> React</span><span><Braces size={15} /> Spring Boot</span><span><Sparkles size={15} /> FastAPI</span><span><Database size={15} /> PostgreSQL</span><span><Network size={15} /> Neo4j <small>(optional)</small></span></div>
                    </div>
                </section>

                <section id="features" className="landing__section landing__features" aria-labelledby="features-heading">
                    <div className="landing__container">
                        <SectionIntro eyebrow="The capabilities" title={<span id="features-heading">From tangled code to actionable context.</span>}>Understand structure, explore source, and plan changes without losing sight of how the pieces connect.</SectionIntro>
                        <div className="landing__features-grid">
                            {FEATURES.map(({ icon: Icon, title, description, tag }) => (
                                <article className="landing__feature-card" key={title}>
                                    <span className="landing__feature-icon"><Icon size={22} strokeWidth={1.8} /></span>
                                    <h3>{title}</h3>
                                    <p>{description}</p>
                                    <span className="landing__feature-tag">{tag}</span>
                                </article>
                            ))}
                        </div>
                    </div>
                </section>

                <section id="how-it-works" className="landing__section landing__workflow" aria-labelledby="workflow-heading">
                    <div className="landing__container">
                        <SectionIntro eyebrow="How it works" title={<span id="workflow-heading">Connect. Understand. Explore. Evolve.</span>} centered>Go from a raw repository to a more understandable codebase in four practical steps.</SectionIntro>
                        <div className="landing__steps">
                            {STEPS.map(({ number, icon: Icon, title, description, meta }, index) => (
                                <article className="landing__step" key={number}>
                                    <div className="landing__step-top"><span className="landing__step-number">{number}</span><span className="landing__step-icon"><Icon size={22} /></span></div>
                                    <h3>{title}</h3><p>{description}</p><span className="landing__step-meta">{meta}</span>
                                    {index < STEPS.length - 1 && <ArrowRight className="landing__step-arrow" size={19} aria-hidden="true" />}
                                </article>
                            ))}
                        </div>
                    </div>
                </section>

                <section id="architecture" className="landing__section landing__architecture" aria-labelledby="architecture-heading">
                    <div className="landing__container landing__architecture-layout">
                        <div className="landing__architecture-copy">
                            <SectionIntro eyebrow="Under the hood" title={<span id="architecture-heading">A clear view across the entire stack.</span>}>Built around the existing React Analysis Engine, a Spring Boot persistence API, and a Python AI retrieval service.</SectionIntro>
                            <div className="landing__architecture-points">
                                <div><Check size={17} /><span>Analysis starts in the browser using repository source files.</span></div>
                                <div><Check size={17} /><span>Spring Boot persists repository information in PostgreSQL.</span></div>
                                <div><Check size={17} /><span>AI retrieval uses pgvector and supports optional Neo4j graph context.</span></div>
                            </div>
                            <a className="landing__text-link" href={README_URL} target="_blank" rel="noopener noreferrer">Explore technical documentation <ArrowUpRight size={16} /></a>
                        </div>
                        <div className="landing__architecture-card">
                            <div className="landing__architecture-card-head"><span><span className="landing__status-dot" /> SYSTEM FLOW</span><span>CODE → CONTEXT</span></div>
                            <div className="landing__arch-layers">
                                {ARCH_LAYERS.map(({ icon: Icon, eyebrow, title, detail }, index) => (
                                    <div className="landing__arch-entry" key={title}>
                                        <div className="landing__arch-node"><span className="landing__arch-icon"><Icon size={21} /></span><div><span>{eyebrow}</span><strong>{title}</strong><p>{detail}</p></div></div>
                                        {index !== ARCH_LAYERS.length - 1 && <span className="landing__arch-line" aria-hidden="true" />}
                                    </div>
                                ))}
                            </div>
                            <div className="landing__arch-storage"><div><Database size={18} /><span>PostgreSQL + pgvector</span><small>Primary retrieval</small></div><div><Network size={18} /><span>Neo4j GraphRAG</span><small>Optional when connected</small></div></div>
                        </div>
                    </div>
                </section>

                <section id="use-cases" className="landing__section landing__use-cases" aria-labelledby="use-cases-heading">
                    <div className="landing__container">
                        <SectionIntro eyebrow="Made for real work" title={<span id="use-cases-heading">Practical intelligence for engineering teams.</span>}>From a developer's first day to a major refactor, explore the code with more confidence and less guesswork.</SectionIntro>
                        <div className="landing__use-grid">{USE_CASES.map(({ icon: Icon, title, text }) => <article className="landing__use-card" key={title}><Icon size={21} /><h3>{title}</h3><p>{text}</p></article>)}</div>
                    </div>
                </section>

                <section id="demo" className="landing__section landing__demo" aria-labelledby="demo-heading">
                    <div className="landing__container">
                        <SectionIntro eyebrow="Product preview" title={<span id="demo-heading">See how source meets intelligence.</span>} centered>Explore a conceptual example of the workspace, then launch the real application with your own codebase.</SectionIntro>
                        <DemoPreview />
                        <div className="landing__demo-actions"><p>Ready to work with a real repository?</p><button type="button" className="landing__button landing__button--primary" onClick={launchApp}>Launch the application <ArrowRight size={17} /></button></div>
                    </div>
                </section>

                <section className="landing__final" aria-labelledby="final-heading"><div className="landing__container"><div className="landing__final-card"><div className="landing__final-orb" aria-hidden="true" /><span className="landing__eyebrow"><span className="landing__eyebrow-dot" /> START WITH YOUR SOURCE</span><h2 id="final-heading">Your next codebase should be easier to understand.</h2><p>Connect a repository and start exploring its structure, source context, and modernization opportunities.</p><div className="landing__final-actions"><button type="button" className="landing__button landing__button--light" onClick={launchApp}>Get Started <ArrowRight size={17} /></button><a className="landing__button landing__button--outline" href={REPOSITORY_URL} target="_blank" rel="noopener noreferrer">View on GitHub <ArrowUpRight size={17} /></a></div></div></div></section>
            </main>

            <footer className="landing__footer"><div className="landing__container landing__footer-inner"><div><Brand /><p>Make sense of legacy code, one repository at a time.</p></div><nav aria-label="Footer navigation"><a href="#features">Features</a><a href="#architecture">Architecture</a><a href={README_URL} target="_blank" rel="noopener noreferrer">Docs <ArrowUpRight size={12} /></a><a href={REPOSITORY_URL} target="_blank" rel="noopener noreferrer">GitHub <ArrowUpRight size={12} /></a><button type="button" onClick={launchApp}>Launch App <ArrowRight size={12} /></button></nav></div><div className="landing__container landing__footer-bottom"><span>AI Legacy Bridge · Developer tooling</span><span>React · Spring Boot · FastAPI · PostgreSQL</span></div></footer>
        </div>
    );
}
