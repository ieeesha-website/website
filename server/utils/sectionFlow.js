const { slugifyFieldLabel } = require('./fieldId');

const SUBMIT = '__submit__';
const SECTION_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const CHOICE_TYPES = ['Dropdown', 'Checkbox'];

const asList = (value) => Array.isArray(value) ? value : [];

/**
 * Resolve stable string IDs for sections.
 *
 * Existing IDs are preserved. Missing IDs are generated from section titles
 * and de-duplicated. The caller must persist the returned IDs.
 */
function resolveSectionIds(sections) {
    const list = asList(sections);
    const ids = list.map(section =>
        typeof section?.id === 'string' ? section.id.trim() : ''
    );

    const used = new Set(ids.filter(Boolean));

    list.forEach((section, i) => {
        if (ids[i]) return;

        const base = (slugifyFieldLabel(section?.title) || 'section')
            .slice(0, 48);

        let candidate = base;
        let n = 2;

        while (used.has(candidate) || candidate === SUBMIT) {
            candidate = `${base}_${n++}`;
        }

        used.add(candidate);
        ids[i] = candidate;
    });

    return ids;
}

/**
 * Validate section IDs, targets, routing fields and routing options.
 */
function validateSectionFlow(sections) {
    const list = asList(sections);
    const ids = resolveSectionIds(list);
    const problems = [];
    const indexById = new Map();

    ids.forEach((id, i) => {
        if (!SECTION_ID_RE.test(id)) {
            problems.push(
                `Section ${i + 1} has an invalid ID. IDs must contain letters, numbers, "-" or "_" and be at most 64 characters.`
            );
        }

        if (id === SUBMIT) {
            problems.push(`Section ${i + 1} uses the reserved ID "${SUBMIT}".`);
        }

        if (indexById.has(id)) {
            problems.push(
                `Sections ${indexById.get(id) + 1} and ${i + 1} share the ID "${id}".`
            );
        } else {
            indexById.set(id, i);
        }
    });

    const checkTarget = (target, fromIndex, where) => {
        if (typeof target !== 'string' || !target.trim()) {
            return `${where} points to an invalid section.`;
        }

        if (target === SUBMIT) return null;

        const toIndex = indexById.get(target);

        if (toIndex === undefined) {
            return `${where} points to a section that does not exist ("${target}").`;
        }

        if (toIndex <= fromIndex) {
            return `${where} must point to a later section or submit the form.`;
        }

        return null;
    };

    list.forEach((section, i) => {
        const label = `Section "${section?.title || i + 1}"`;

        if (
            section?.nextSection !== undefined &&
            section.nextSection !== null &&
            section.nextSection !== ''
        ) {
            const problem = checkTarget(
                section.nextSection,
                i,
                `${label}: default target`
            );

            if (problem) problems.push(problem);
        }

        let routingFields = 0;

        asList(section?.fields).forEach(field => {
            const routes = asList(field?.routes);

            if (routes.length === 0) return;

            const fieldLabel = `${label}, field "${field?.label || field?.id}"`;

            if (!CHOICE_TYPES.includes(field.type)) {
                problems.push(
                    `${fieldLabel}: only Dropdown and Checkbox fields can have routes.`
                );
                return;
            }

            routingFields++;

            const seenOptions = new Set();

            routes.forEach(route => {
                if (
                    !route ||
                    typeof route.option !== 'string' ||
                    !route.option.trim()
                ) {
                    problems.push(`${fieldLabel}: every route needs an option.`);
                    return;
                }

                if (!asList(field.options).includes(route.option)) {
                    problems.push(
                        `${fieldLabel}: route option "${route.option}" is not an available option.`
                    );
                }

                if (seenOptions.has(route.option)) {
                    problems.push(
                        `${fieldLabel}: option "${route.option}" has duplicate routes.`
                    );
                }

                seenOptions.add(route.option);

                const problem = checkTarget(
                    route.goToSection,
                    i,
                    `${fieldLabel}, option "${route.option}"`
                );

                if (problem) problems.push(problem);
            });
        });

        if (routingFields > 1) {
            problems.push(
                `${label}: only one field per section may control navigation.`
            );
        }
    });

    return problems;
}

function assertValidSectionFlow(sections, AppError) {
    const problems = validateSectionFlow(sections);

    if (problems.length) {
        throw new AppError(
            problems.join(' '),
            400,
            'INVALID_SECTION_FLOW'
        );
    }
}

function hasBranching(sections) {
    return asList(sections).some(section =>
        Boolean(section?.nextSection) ||
        asList(section?.fields).some(field =>
            asList(field?.routes).length > 0
        )
    );
}

/**
 * Sections which cannot be skipped by any single forward jump.
 */
function getMandatorySectionIndexes(sections) {
    const list = asList(sections);
    const ids = resolveSectionIds(list);
    const indexById = new Map(ids.map((id, i) => [id, i]));
    const jumps = [];

    const addJump = (from, target) => {
        if (!target) return;

        const to = target === SUBMIT
            ? list.length
            : indexById.get(target);

        if (to !== undefined && to > from) {
            jumps.push([from, to]);
        }
    };

    list.forEach((section, i) => {
        addJump(i, section?.nextSection);

        asList(section?.fields).forEach(field => {
            asList(field?.routes).forEach(route => {
                addJump(i, route.goToSection);
            });
        });
    });

    return list.map((_, i) => i).filter(i =>
        !jumps.some(([from, to]) => from < i && i < to)
    );
}

function defaultDestination(sections, index, indexById) {
    const destination = sections[index]?.nextSection;

    if (destination === SUBMIT) return sections.length;

    if (destination) {
        const target = indexById.get(destination);
        if (target !== undefined && target > index) return target;
    }

    return index + 1;
}

function possibleNextIndexes(sections, index, indexById) {
    const section = sections[index];
    const routingField = asList(section?.fields).find(
        field => asList(field?.routes).length > 0
    );

    if (!routingField) {
        return [defaultDestination(sections, index, indexById)];
    }

    const routes = asList(routingField.routes);
    const destinations = routes.map(route => {
        if (route?.goToSection === SUBMIT) return sections.length;
        return indexById.get(route?.goToSection);
    }).filter(destination => destination !== undefined && destination > index);

    const routedOptions = new Set(routes.map(route => route?.option));
    const hasFallbackAnswer =
        !routingField.required ||
        asList(routingField.options).some(option => !routedOptions.has(option));

    if (hasFallbackAnswer) {
        destinations.push(defaultDestination(sections, index, indexById));
    }

    return [...new Set(destinations)];
}

/**
 * Whether every valid forward path includes at least one section matching the
 * predicate. Unrouted options and optional unanswered routing fields use the
 * section's normal fallback destination.
 */
function everyPathVisitsSection(sections, predicate) {
    const list = asList(sections);
    if (list.length === 0) return false;

    const ids = resolveSectionIds(list);
    const indexById = new Map(ids.map((id, index) => [id, index]));
    const matching = new Set(
        list.flatMap((section, index) =>
            predicate(section) ? [index] : []
        )
    );
    if (matching.size === 0) return false;

    const canFinishWithoutMatch = new Set();
    const terminal = list.length;

    const canReachTerminal = (index, active = new Set()) => {
        if (index === terminal) return true;
        if (index < 0 || index > terminal || matching.has(index)) return false;
        if (canFinishWithoutMatch.has(index)) return true;
        if (active.has(index)) return false;

        const nextActive = new Set(active);
        nextActive.add(index);

        const reachable = possibleNextIndexes(list, index, indexById)
            .some(next => canReachTerminal(next, nextActive));

        if (reachable) canFinishWithoutMatch.add(index);
        return reachable;
    };

    return !canReachTerminal(0);
}

/**
 * Return the first matching route according to the field's option order.
 */
function routeTargetFor(section, answers) {
    for (const field of asList(section?.fields)) {
        const routes = asList(field?.routes);

        if (!routes.length) continue;

        const answer = answers?.[field.id];

        if (
            answer === undefined ||
            answer === null ||
            answer === ''
        ) continue;

        const selected = Array.isArray(answer) ? answer : [answer];

        for (const option of asList(field.options)) {
            if (!selected.includes(option)) continue;

            const route = routes.find(r => r?.option === option);

            if (route) return route.goToSection;
        }
    }

    return undefined;
}

function buildIndex(sections) {
    const indexById = new Map();
    const ids = resolveSectionIds(sections);

    asList(sections).forEach((section, i) => {
        if (ids[i]) indexById.set(ids[i], i);
    });

    return indexById;
}

/**
 * Choice routes take precedence over section defaults.
 * If neither exists, proceed sequentially.
 */
function nextIndex(sections, index, answers, indexById) {
    const section = sections[index];

    const destinations = [
        routeTargetFor(section, answers),
        section?.nextSection
    ];

    for (const destination of destinations) {
        if (!destination) continue;

        if (destination === SUBMIT) return sections.length;

        const targetIndex = indexById.get(destination);

        if (targetIndex !== undefined && targetIndex > index) {
            return targetIndex;
        }
    }

    return index + 1;
}

function getNextSectionIndex(sections, index, answers = {}) {
    const list = asList(sections);

    if (index < 0 || index >= list.length) {
        return list.length;
    }

    return nextIndex(list, index, answers, buildIndex(list));
}

/**
 * Resolve sections visited by the submitted answers.
 */
function resolveVisitedSections(sections, answers = {}) {
    const list = asList(sections);
    const safeAnswers = answers && typeof answers === 'object'
        ? answers
        : {};

    const indexById = buildIndex(list);
    const visited = [];

    let index = 0;

    while (index >= 0 && index < list.length) {
        visited.push(list[index]);

        const next = nextIndex(list, index, safeAnswers, indexById);

        // Defensive protection against malformed navigation.
        if (next <= index) break;

        index = next;
    }

    return visited;
}

module.exports = {
    SUBMIT,
    SECTION_ID_RE,
    resolveSectionIds,
    validateSectionFlow,
    assertValidSectionFlow,
    hasBranching,
    getMandatorySectionIndexes,
    everyPathVisitsSection,
    getNextSectionIndex,
    resolveVisitedSections
};
