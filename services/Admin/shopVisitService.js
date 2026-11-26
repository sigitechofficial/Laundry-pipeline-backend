'use strict';

const { users, shopVisit, agentSelectServices, service, bussinessInformation, machineCount, machines } = require('../../models');
const { Op } = require('sequelize');
const { NotFoundError, ValidationError } = require('../../middlewares/universalErrorHandler');

/** What the team checks at the shop. Each answer: good | needs_work | poor | na. */
const VISIT_CHECKLIST = Object.freeze([
    { key: 'address_matches', question: 'Shop is at the registered address', group: 'Premises' },
    { key: 'clean_tidy', question: 'Shop is clean, neat and organised', group: 'Premises' },
    { key: 'customer_area', question: 'Counter / customer area is presentable', group: 'Premises' },
    { key: 'storage', question: 'Clean and dirty garments are stored separately and safely', group: 'Handling' },
    { key: 'tagging', question: 'Items are tagged and tracked so nothing gets mixed up', group: 'Handling' },
    { key: 'packaging', question: 'Finished items are packed properly (covers, folding, hangers)', group: 'Handling' },
    { key: 'machinery_condition', question: 'Machinery is in good working condition and maintained', group: 'Machinery' },
    { key: 'machinery_matches', question: 'Machinery matches what was given at registration', group: 'Machinery' },
    { key: 'pressing_finishing', question: 'Pressing / finishing equipment is suitable', group: 'Machinery' },
    { key: 'staff', question: 'Enough trained staff for the expected volume', group: 'People' },
    { key: 'hours_match', question: 'Opening hours match what was registered', group: 'People' },
    { key: 'safety', question: 'Fire safety and chemical storage look safe', group: 'Safety' },
]);
const CHECK_RESULTS = ['good', 'needs_work', 'poor', 'na'];
const SERVICE_ANSWERS = ['yes', 'partly', 'no'];
const MACHINE_ANSWERS = ['yes', 'partly', 'no'];
const RECOMMENDATIONS = ['approve', 'needs_changes', 'reject'];

const text = (v, max) => (v == null ? '' : String(v).trim().slice(0, max));
const plain = (row) => (row && typeof row.get === 'function' ? row.get({ plain: true }) : row);

async function loadAgent(agentId) {
    const agent = await users.findOne({
        where: { id: agentId, userTypeId: 4, deletedAt: { [Op.is]: null } },
        attributes: ['id', 'firstName', 'lastName'],
    });
    if (!agent) throw new NotFoundError('Shop owner not found');
    return agent;
}

/** Services and machines the shop registered: what the visit form checks against. */
async function registeredFacts(agentId) {
    const svcRows = await agentSelectServices.findAll({
        where: { agentServiceId: agentId },
        attributes: ['serviceId', 'status', 'serviceTimeRequired'],
        include: [{ model: service, attributes: ['id', 'name'], required: false, paranoid: false }],
        order: [['id', 'ASC']],
    });
    const info = await bussinessInformation.findOne({ where: { agentId }, attributes: ['id'], order: [['id', 'ASC']] });
    const machineRows = info
        ? await machineCount.findAll({
            where: { bussinessInformationId: info.id },
            attributes: ['total'],
            include: [{ model: machines, attributes: ['id', 'name'], required: false }],
        })
        : [];
    return {
        services: svcRows.map(plain).filter((s) => s.status).map((s) => ({
            serviceId: s.serviceId,
            name: s.service?.name || `Service #${s.serviceId}`,
            turnaround: s.serviceTimeRequired && s.serviceTimeRequired !== 'N/A' ? s.serviceTimeRequired : null,
        })),
        machinery: machineRows.map(plain).map((m) => ({
            name: m.machine?.name || 'Machine',
            registered: m.total != null ? String(m.total) : null,
        })),
    };
}

/** A short line for lists: how many checks were not good, and services that can't be offered. */
function summarise(visit) {
    const checks = Array.isArray(visit.checklist) ? visit.checklist : [];
    const services = Array.isArray(visit.services) ? visit.services : [];
    return {
        concerns: checks.filter((c) => c.result === 'needs_work' || c.result === 'poor').length,
        poor: checks.filter((c) => c.result === 'poor').length,
        servicesNotOffered: services.filter((s) => s.canProvide === 'no').map((s) => s.name),
        servicesPartly: services.filter((s) => s.canProvide === 'partly').map((s) => s.name),
    };
}

function toView(row) {
    const v = plain(row);
    return {
        id: v.id,
        agentId: v.agentId,
        visitedAt: v.visitedAt,
        visitedBy: v.visitedBy,
        recordedBy: v.recordedByName || null,
        recordedAt: v.createdAt,
        overallRating: v.overallRating ?? null,
        recommendation: v.recommendation,
        feedback: v.feedback || null,
        checklist: Array.isArray(v.checklist) ? v.checklist : [],
        services: Array.isArray(v.services) ? v.services : [],
        machinery: Array.isArray(v.machinery) ? v.machinery : [],
        summary: summarise(v),
    };
}

class ShopVisitService {
    /** Visits for a shop, newest first, plus what a new visit form needs. */
    async listVisits(agentId) {
        await loadAgent(agentId);
        const rows = await shopVisit.findAll({ where: { agentId }, order: [['visitedAt', 'DESC'], ['id', 'DESC']] });
        return {
            checklist: VISIT_CHECKLIST,
            registered: await registeredFacts(agentId),
            visits: rows.map(toView),
        };
    }

    async getVisit(agentId, visitId) {
        const row = await shopVisit.findOne({ where: { id: visitId, agentId } });
        if (!row) throw new NotFoundError('Visit not found');
        return toView(row);
    }

    /**
     * Saves a visit report. Every checklist question and every registered
     * service must be answered; the recommendation is required.
     */
    async createVisit(agentId, body = {}, admin = {}) {
        await loadAgent(agentId);
        const visitedAt = new Date(body.visitedAt);
        if (!body.visitedAt || Number.isNaN(visitedAt.getTime())) {
            throw new ValidationError('Enter the date and time of the visit');
        }
        if (visitedAt.getTime() > Date.now() + 5 * 60 * 1000) {
            throw new ValidationError('The visit date cannot be in the future');
        }
        const visitedBy = text(body.visitedBy, 120);
        if (!visitedBy) throw new ValidationError('Enter who visited the shop');

        const answers = new Map((Array.isArray(body.checklist) ? body.checklist : []).map((c) => [c?.key, c]));
        const checklist = VISIT_CHECKLIST.map((q) => {
            const a = answers.get(q.key);
            if (!a || !CHECK_RESULTS.includes(a.result)) {
                throw new ValidationError(`Answer: "${q.question}"`);
            }
            const remark = text(a.remark, 500);
            if ((a.result === 'poor' || a.result === 'needs_work') && !remark) {
                throw new ValidationError(`Add a remark for: "${q.question}"`);
            }
            return { key: q.key, group: q.group, question: q.question, result: a.result, remark: remark || null };
        });

        const registered = await registeredFacts(agentId);
        const svcAnswers = new Map((Array.isArray(body.services) ? body.services : []).map((s) => [Number(s?.serviceId), s]));
        const services = registered.services.map((s) => {
            const a = svcAnswers.get(Number(s.serviceId));
            if (!a || !SERVICE_ANSWERS.includes(a.canProvide)) {
                throw new ValidationError(`Say whether the shop can provide ${s.name}`);
            }
            const remark = text(a.remark, 500);
            if (a.canProvide !== 'yes' && !remark) {
                throw new ValidationError(`Add a remark for ${s.name}`);
            }
            return { serviceId: s.serviceId, name: s.name, canProvide: a.canProvide, remark: remark || null };
        });

        const machAnswers = Array.isArray(body.machinery) ? body.machinery : [];
        const machinery = registered.machinery.map((m, i) => {
            const a = machAnswers[i] || {};
            const matches = MACHINE_ANSWERS.includes(a.matches) ? a.matches : null;
            return { name: m.name, registered: m.registered, matches, seen: text(a.seen, 40) || null, remark: text(a.remark, 300) || null };
        });

        const rating = body.overallRating == null || body.overallRating === '' ? null : Number(body.overallRating);
        if (rating != null && !(Number.isInteger(rating) && rating >= 1 && rating <= 5)) {
            throw new ValidationError('Overall rating must be 1 to 5');
        }
        if (!RECOMMENDATIONS.includes(body.recommendation)) {
            throw new ValidationError('Choose a recommendation');
        }
        const feedback = text(body.feedback, 4000);
        if (body.recommendation !== 'approve' && !feedback) {
            throw new ValidationError('Add overall feedback explaining the recommendation');
        }

        const row = await shopVisit.create({
            agentId: Number(agentId),
            visitedAt,
            visitedBy,
            recordedByAdminId: admin.id || null,
            recordedByName: text(admin.name, 120) || null,
            checklist,
            services,
            machinery,
            overallRating: rating,
            recommendation: body.recommendation,
            feedback: feedback || null,
        });
        return toView(row);
    }

    /** Latest visit and count, for the registration summary. */
    async latestFor(agentId) {
        const [count, latest] = await Promise.all([
            shopVisit.count({ where: { agentId } }),
            shopVisit.findOne({ where: { agentId }, order: [['visitedAt', 'DESC'], ['id', 'DESC']] }),
        ]);
        return { count, latest: latest ? toView(latest) : null };
    }
}

module.exports = new ShopVisitService();
module.exports.VISIT_CHECKLIST = VISIT_CHECKLIST;
