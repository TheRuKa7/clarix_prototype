import { environment } from "../environments/environment"

const { financeAp, clarix, genbi } = environment.backendServices;

export const ENDPOINTS = {
    financeap: {
        login: `${financeAp.baseURL}/public/auth/login`,
    },
    workflows: {
        list: `${clarix.baseURL}/api/v1/workflows`,
        listByTemplate: (templateId: string) => `${clarix.baseURL}/api/v1/workflows/by-template/${templateId}`,
        reportByTemplate: (templateId: string) => `${clarix.baseURL}/api/v1/workflows/by-template/${templateId}/report`,
        getById: (executionId: string) => `${clarix.baseURL}/api/v1/workflows/${executionId}`,
        triggerBulk: `${clarix.baseURL}/api/v1/workflows/trigger/bulk`,
        dashboard: (templateId: string) => `${clarix.baseURL}/api/v1/workflows/dashboard/${templateId}`,
        orgSummary: `${clarix.baseURL}/api/v1/workflows/dashboard/org-summary`,
        reschedule: (executionId: string) => `${clarix.baseURL}/api/v1/workflows/${executionId}/schedule`,
        executeNow: (executionId: string) => `${clarix.baseURL}/api/v1/workflows/${executionId}/execute-now`,
        cancel: (executionId: string) => `${clarix.baseURL}/api/v1/workflows/${executionId}/cancel`,
        stop: (executionId: string) => `${clarix.baseURL}/api/v1/workflows/${executionId}/stop`,
        events: (executionId: string) => `${clarix.baseURL}/api/v1/workflows/${executionId}/events`,
        syncStatus: (executionId: string) => `${clarix.baseURL}/api/v1/workflows/${executionId}/sync-status`,
    },
    conversations: {
        getById: (conversationId: string) => `${clarix.baseURL}/api/v1/conversations/${conversationId}`,
        audio: (conversationId: string) => `${clarix.baseURL}/api/v1/conversations/${conversationId}/audio`,
        transcript: (conversationId: string) => `${clarix.baseURL}/api/v1/conversations/${conversationId}/transcript`,
    },
    dashboard: {
        overview: `${clarix.baseURL}/api/v1/dashboard`,
    },
    /** Reports: the dashboard numbers split by anything, the spreadsheet of the same, and reports sent by email. */
    reports: {
        summary: `${clarix.baseURL}/api/v1/reports/summary`,
        exportXlsx: `${clarix.baseURL}/api/v1/reports/export.xlsx`,
        schedules: `${clarix.baseURL}/api/v1/report-schedules`,
        schedule: (id: string) => `${clarix.baseURL}/api/v1/report-schedules/${id}`,
        sendNow: (id: string) => `${clarix.baseURL}/api/v1/report-schedules/${id}/send-now`,
    },
    /** Follow ups: rows that calling alone cannot settle. */
    followUps: {
        list: `${clarix.baseURL}/api/v1/follow-ups`,
        one: (id: string) => `${clarix.baseURL}/api/v1/follow-ups/${id}`,
        callAgain: (id: string) => `${clarix.baseURL}/api/v1/follow-ups/${id}/call-again`,
    },
    transformationCatalog: {
        list: `${clarix.baseURL}/api/v1/transformation-catalog`,
    },
    orchestration: {
        list: `${clarix.baseURL}/api/v1/workflows/orchestration`,
        create: `${clarix.baseURL}/api/v1/workflows/orchestration`,
        getById: (id: string) => `${clarix.baseURL}/api/v1/workflows/orchestration/${id}`,
        update: (id: string) => `${clarix.baseURL}/api/v1/workflows/orchestration/${id}`,
        delete: (id: string) => `${clarix.baseURL}/api/v1/workflows/orchestration/${id}`,
        preview: (id: string) => `${clarix.baseURL}/api/v1/workflows/orchestration/${id}/preview`,
        samples: `${clarix.baseURL}/api/v1/workflows/orchestration/samples`,
        sample: (id: string) => `${clarix.baseURL}/api/v1/workflows/orchestration/samples/${encodeURIComponent(id)}`,
        previewFile: `${clarix.baseURL}/api/v1/workflows/orchestration/preview`,
    },
    callProviders: {
        list: `${clarix.baseURL}/api/v1/call-providers`,
        campaigns: (key: string) => `${clarix.baseURL}/api/v1/call-providers/${key}/campaigns`,
        campaign: (key: string, campaignId: string) =>
            `${clarix.baseURL}/api/v1/call-providers/${key}/campaigns/${campaignId}`,
    },
    workflowTemplates: {
        list: `${clarix.baseURL}/api/v1/workflow-templates`,
        stats: `${clarix.baseURL}/api/v1/workflow-templates/stats`,
        create: `${clarix.baseURL}/api/v1/workflow-templates`,
        getById: (templateId: string) => `${clarix.baseURL}/api/v1/workflow-templates/${templateId}`,
        update: (templateId: string) => `${clarix.baseURL}/api/v1/workflow-templates/${templateId}`,
        delete: (templateId: string) => `${clarix.baseURL}/api/v1/workflow-templates/${templateId}`,
        activate: (templateId: string) => `${clarix.baseURL}/api/v1/workflow-templates/${templateId}/activate`,
        deactivate: (templateId: string) => `${clarix.baseURL}/api/v1/workflow-templates/${templateId}/deactivate`,
        agentSchema: (templateId: string) => `${clarix.baseURL}/api/v1/workflow-templates/${templateId}/agent-schema`,
    },
    auth: {
        myPermissions: `${clarix.baseURL}/api/v1/auth/me/permissions`,
        refreshPermissions: `${clarix.baseURL}/api/v1/auth/me/permissions/refresh`,
        modulesAccess: `${clarix.baseURL}/api/v1/auth/modules-access`,
    },
    adminPermissions: {
        list: `${clarix.baseURL}/api/v1/admin/permissions`,
        create: `${clarix.baseURL}/api/v1/admin/permissions`,
        categories: `${clarix.baseURL}/api/v1/admin/permissions/categories`,
        getById: (id: string) => `${clarix.baseURL}/api/v1/admin/permissions/${id}`,
        update: (id: string) => `${clarix.baseURL}/api/v1/admin/permissions/${id}`,
        delete: (id: string) => `${clarix.baseURL}/api/v1/admin/permissions/${id}`,
    },
    adminModules: {
        list: `${clarix.baseURL}/api/v1/admin/modules`,
        create: `${clarix.baseURL}/api/v1/admin/modules`,
        getById: (id: string) => `${clarix.baseURL}/api/v1/admin/modules/${id}`,
        update: (id: string) => `${clarix.baseURL}/api/v1/admin/modules/${id}`,
        setEnabled: (id: string) => `${clarix.baseURL}/api/v1/admin/modules/${id}/enabled`,
        delete: (id: string) => `${clarix.baseURL}/api/v1/admin/modules/${id}`,
    },
    dataFunctions: {
        list: `${clarix.baseURL}/api/v1/admin/data-functions`,
        create: `${clarix.baseURL}/api/v1/admin/data-functions`,
        getById: (id: string) => `${clarix.baseURL}/api/v1/admin/data-functions/${id}`,
        update: (id: string) => `${clarix.baseURL}/api/v1/admin/data-functions/${id}`,
        setEnabled: (id: string) => `${clarix.baseURL}/api/v1/admin/data-functions/${id}/enabled`,
        delete: (id: string) => `${clarix.baseURL}/api/v1/admin/data-functions/${id}`,
        test: (id: string) => `${clarix.baseURL}/api/v1/admin/data-functions/${id}/test`,
    },
    executionReports: {
        list: `${clarix.baseURL}/api/v1/workflows/reports`,
        create: `${clarix.baseURL}/api/v1/workflows/reports`,
        getById: (id: string) => `${clarix.baseURL}/api/v1/workflows/reports/${id}`,
        update: (id: string) => `${clarix.baseURL}/api/v1/workflows/reports/${id}`,
        delete: (id: string) => `${clarix.baseURL}/api/v1/workflows/reports/${id}`,
        download: (id: string) => `${clarix.baseURL}/api/v1/workflows/reports/${id}/download`,
        schedules: (reportId: string) => `${clarix.baseURL}/api/v1/workflows/reports/${reportId}/schedules`,
        schedule: (reportId: string, sid: string) => `${clarix.baseURL}/api/v1/workflows/reports/${reportId}/schedules/${sid}`,
        scheduleEnabled: (reportId: string, sid: string) => `${clarix.baseURL}/api/v1/workflows/reports/${reportId}/schedules/${sid}/enabled`,
        scheduleRunNow: (reportId: string, sid: string) => `${clarix.baseURL}/api/v1/workflows/reports/${reportId}/schedules/${sid}/run-now`,
        schedulesUpcoming: (reportId: string) => `${clarix.baseURL}/api/v1/workflows/reports/${reportId}/schedules/upcoming`,
    },
    executionSheets: {
        list: `${clarix.baseURL}/api/v1/workflows/sheets`,
        getById: (id: string) => `${clarix.baseURL}/api/v1/workflows/sheets/${id}`,
        stop: (id: string) => `${clarix.baseURL}/api/v1/workflows/sheets/${id}/stop`,
    }
}