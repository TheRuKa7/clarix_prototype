export const environment = {
  production: true,
  demo: false,
  microsoft: {
    KEY: '<microsoft-app-client-id>',
    authorityUrl: 'https://login.microsoftonline.com/<tenant-id>/',
    tenentId: '<tenant-id>'
  },
  backendServices: {
    financeAp: {
      baseURL: 'https://api.example.com/finance-ap'
    },
    financeAr: {
      baseURL: 'https://api.example.com/finance-ar'
    },
    clarix: {
      baseURL: 'https://api.example.com'
    },
    genbi: {
      baseURL: 'https://api.example.com'
    }
  },
  casApi: {
    baseUrl: '/cas/api/v1'
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
