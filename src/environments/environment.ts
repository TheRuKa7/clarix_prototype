export const environment = {
  production: false,
  demo: false,
  microsoft: {
    KEY: '<microsoft-app-client-id>',
    authorityUrl: 'https://login.microsoftonline.com/<tenant-id>/',
    tenentId: '<tenant-id>',
  },
  backendServices: {
    financeAp: {
      baseURL: 'https://api.example.com/finance-ap'
    },
    financeAr: {
      baseURL: 'https://api.example.com/finance-ap'
    },
    clarix: {
      baseURL: 'http://localhost:8081'
    },
    genbi: {
      baseURL: 'http://localhost:8000'
    }
  },
  casApi: {
    baseUrl: 'http://localhost:9000/api/v1'
  },
  genbiApi: {
    baseUrl: '/api/v1'
  },
  features: {
    genbi: true,
    workflows: true,
    analytics: true
  }
};