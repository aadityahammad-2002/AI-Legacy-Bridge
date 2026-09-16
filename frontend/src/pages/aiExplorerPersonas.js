import { Bot, Search, Radar } from 'lucide-react';

/**
 * AI Explorer has three presentation "personas" the user can switch between —
 * Normal, Detective, Mission Control. All three ask the exact same backend
 * (`POST /api/ai/ask`, same repository data, same underlying analysis) and
 * get back the exact same real answer. Nothing about what the AI *knows* or
 * *finds* changes — only how the surrounding UI frames it: panel names,
 * button copy, icon, and an accent color. This is a presentation layer, not
 * a different analysis engine, so switching personas mid-conversation is
 * always safe.
 *
 * `persona.id` is sent to askAi() as an optional field on the request body —
 * today the AI service ignores unknown fields, so this has no effect on the
 * actual answer text yet. If the backend is later updated to read it and
 * adjust the system prompt's tone (e.g. "found" -> "uncovered a lead"),
 * this is the hook it would use; until then, treat the persona as a UI-only
 * skin, not a guarantee that the assistant's wording changes.
 */
export const AI_PERSONAS = {
    normal: {
        id: 'normal',
        name: 'Normal',
        icon: Bot,
        treeLabel: 'Explorer',
        assistantLabel: 'AI Assistant',
        suggestedLabel: 'Suggested Questions',
        focusedLabel: (name) => `Focused on ${name}`,
        emptyState: 'Ask about this codebase — e.g. "explain UserService" or "is there a security issue here?"',
        thinkingLabel: 'Thinking…',
        placeholder: 'Ask about this codebase…',
        starterPrompts: ['What does this repository do?', 'Where should I start reading?'],
        contextPrompts: (name) => [`Explain ${name}`, `Find classes related to ${name}`, `Any issues in ${name}?`],
    },
    detective: {
        id: 'detective',
        name: 'Detective',
        icon: Search,
        treeLabel: 'Case Files',
        assistantLabel: 'AI Detective',
        suggestedLabel: 'Leads to Investigate',
        focusedLabel: (name) => `Case file open: ${name}`,
        emptyState: 'Give me a lead — e.g. "who calls UserService" or "any suspicious files here?"',
        thinkingLabel: 'Following the trail…',
        placeholder: 'Ask the detective about this codebase…',
        starterPrompts: ['What is this repository hiding?', 'Where should the investigation start?'],
        contextPrompts: (name) => [`Investigate ${name}`, `Who's connected to ${name}?`, `Any red flags in ${name}?`],
    },
    missionControl: {
        id: 'missionControl',
        name: 'Mission Control',
        icon: Radar,
        treeLabel: 'System Explorer',
        assistantLabel: 'Mission Control Co-pilot',
        suggestedLabel: 'Quick Prompts',
        focusedLabel: (name) => `Tracking: ${name}`,
        emptyState: 'Awaiting instructions — e.g. "status of UserService" or "scan for security risks".',
        thinkingLabel: 'Analyzing…',
        placeholder: 'Transmit a query about this codebase…',
        starterPrompts: ['Repository status report', 'Recommend a flight path through this codebase'],
        contextPrompts: (name) => [`Status report: ${name}`, `Map connections to ${name}`, `Flag risks in ${name}`],
    },
};

export const AI_PERSONA_LIST = Object.values(AI_PERSONAS);

export function getPersona(id) {
    return AI_PERSONAS[id] || AI_PERSONAS.normal;
}
