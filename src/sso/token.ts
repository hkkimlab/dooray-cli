/** The personal token name created in Dooray unless `auth sso --token-name` overrides it. */
export const DEFAULT_TOKEN_NAME = "dooray-cli";

export interface Credentials {
  username: string;
  password: string;
}

export type Progress = (percent: number, step: string) => void;

/** Signs in to the tenant's Dooray at `url` through the organization's SSO and mints a personal API token. */
export type Scraper = (url: string, creds: Credentials, tokenName: string, onProgress: Progress) => Promise<string>;

export const extractToken = (raw: string): string => raw.trim();
