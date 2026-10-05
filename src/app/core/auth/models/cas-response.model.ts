export interface CasVerifyRequest {
  email: string;
  idToken: string;
  provider: string;
}

export interface CountryInfo {
  idCountry: number;
  name: string;
  countryCode: number;
  idSubsidiary: number;
  subsidiary: string;
  idCurrency: number;
  currency: string;
  idTaxType: number;
  taxType: string;
}

export interface CasResponseData {
  token: string;
  email: string;
  countryResponseSet: CountryInfo[];
  roles: string[] | null;
}

export interface CasVerifyResponse {
  status: number;
  message: string;
  data: CasResponseData;
  showMessage: boolean;
  success: boolean;
}
