// appstore-connect.js
// App Store Connect API client with JWT ES256 authentication
import { importPKCS8, SignJWT } from 'jose';
import { readFileSync } from 'fs';

const ASC_BASE = 'https://api.appstoreconnect.apple.com';

export class AppStoreConnectClient {
  #keyId;
  #issuerId;
  #privateKey;
  #token;
  #tokenExpiry;

  constructor({ keyId, issuerId, privateKeyPath }) {
    if (!keyId) throw new Error('ASC_KEY_ID is required');
    if (!issuerId) throw new Error('ASC_ISSUER_ID is required');
    if (!privateKeyPath) throw new Error('ASC_PRIVATE_KEY_PATH is required');

    this.#keyId = keyId;
    this.#issuerId = issuerId;
    this.#privateKey = readFileSync(privateKeyPath, 'utf8');
    this.#token = null;
    this.#tokenExpiry = 0;
  }

  async #getToken() {
    const now = Math.floor(Date.now() / 1000);
    // Refresh if token expires within 60 seconds
    if (this.#token && this.#tokenExpiry > now + 60) {
      return this.#token;
    }

    const expiry = now + 15 * 60; // 15 minutes
    const key = await importPKCS8(this.#privateKey, 'ES256');

    this.#token = await new SignJWT({})
      .setProtectedHeader({ alg: 'ES256', kid: this.#keyId, typ: 'JWT' })
      .setIssuer(this.#issuerId)
      .setIssuedAt(now)
      .setExpirationTime(expiry)
      .setAudience('appstoreconnect-v1')
      .sign(key);

    this.#tokenExpiry = expiry;
    return this.#token;
  }

  async #request(method, path, body = null) {
    const token = await this.#getToken();
    const opts = {
      method,
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
    };
    if (body) opts.body = JSON.stringify(body);

    const url = path.startsWith('http') ? path : `${ASC_BASE}${path}`;
    const res = await fetch(url, opts);

    if (!res.ok) {
      const errBody = await res.text();
      throw new Error(`ASC API ${method} ${path} - ${res.status}: ${errBody}`);
    }

    if (res.status === 204) return null;
    return res.json();
  }

  // -- App lookup -----------------------------------------------------------

  async lookupAppByBundleId(bundleId) {
    const data = await this.#request('GET',
      `/v1/apps?filter[bundleId]=${encodeURIComponent(bundleId)}&include=appStoreVersions,appInfos`
    );
    if (!data.data || data.data.length === 0) {
      throw new Error(`No app found with bundleId: ${bundleId}`);
    }
    const app = data.data[0];
    return {
      id: app.id,
      name: app.attributes.name,
      bundleId: app.attributes.bundleId,
      sku: app.attributes.sku,
      primaryLocale: app.attributes.primaryLocale,
      included: data.included || [],
    };
  }

  // -- App Store Versions ---------------------------------------------------

  async getAppVersions(appId, { state, platform = 'IOS' } = {}) {
    let path = `/v1/apps/${appId}/appStoreVersions?filter[platform]=${platform}`;
    if (state) path += `&filter[appVersionState]=${state}`;
    const data = await this.#request('GET', path);
    return (data.data || []).map(v => ({
      id: v.id,
      versionString: v.attributes.versionString,
      state: v.attributes.appStoreState,
      platform: v.attributes.platform,
      createdDate: v.attributes.createdDate,
    }));
  }

  async getEditableVersion(appId) {
    const versions = await this.getAppVersions(appId, { state: 'PREPARE_FOR_SUBMISSION' });
    return versions.length > 0 ? versions[0] : null;
  }

  async createVersion(appId, versionString, platform = 'IOS') {
    const data = await this.#request('POST', '/v1/appStoreVersions', {
      data: {
        type: 'appStoreVersions',
        attributes: {
          versionString,
          platform,
        },
        relationships: {
          app: {
            data: { type: 'apps', id: appId },
          },
        },
      },
    });
    return {
      id: data.data.id,
      versionString: data.data.attributes.versionString,
      state: data.data.attributes.appStoreState,
    };
  }

  // -- Version Localizations (keywords, description, whatsNew, promotionalText)

  async getVersionLocalizations(versionId) {
    const data = await this.#request('GET',
      `/v1/appStoreVersions/${versionId}/appStoreVersionLocalizations`
    );
    return (data.data || []).map(loc => ({
      id: loc.id,
      locale: loc.attributes.locale,
      description: loc.attributes.description,
      keywords: loc.attributes.keywords,
      whatsNew: loc.attributes.whatsNew,
      promotionalText: loc.attributes.promotionalText,
      marketingUrl: loc.attributes.marketingUrl,
      supportUrl: loc.attributes.supportUrl,
    }));
  }

  async updateVersionLocalization(localizationId, attributes) {
    // attributes can include: description, keywords, whatsNew, promotionalText, marketingUrl, supportUrl
    const data = await this.#request('PATCH',
      `/v1/appStoreVersionLocalizations/${localizationId}`, {
        data: {
          type: 'appStoreVersionLocalizations',
          id: localizationId,
          attributes,
        },
      }
    );
    return {
      id: data.data.id,
      locale: data.data.attributes.locale,
      description: data.data.attributes.description,
      keywords: data.data.attributes.keywords,
      whatsNew: data.data.attributes.whatsNew,
      promotionalText: data.data.attributes.promotionalText,
      supportUrl: data.data.attributes.supportUrl,
      marketingUrl: data.data.attributes.marketingUrl,
    };
  }

  async createVersionLocalization(versionId, locale, attributes = {}) {
    const data = await this.#request('POST', '/v1/appStoreVersionLocalizations', {
      data: {
        type: 'appStoreVersionLocalizations',
        attributes: { locale, ...attributes },
        relationships: {
          appStoreVersion: {
            data: { type: 'appStoreVersions', id: versionId },
          },
        },
      },
    });
    return {
      id: data.data.id,
      locale: data.data.attributes.locale,
    };
  }

  // -- App Info Localizations (name, subtitle) ------------------------------

  async getAppInfos(appId) {
    const data = await this.#request('GET', `/v1/apps/${appId}/appInfos`);
    return (data.data || []).map(info => ({
      id: info.id,
      state: info.attributes.appStoreState,
    }));
  }

  async getAppInfoLocalizations(appInfoId) {
    const data = await this.#request('GET',
      `/v1/appInfos/${appInfoId}/appInfoLocalizations`
    );
    return (data.data || []).map(loc => ({
      id: loc.id,
      locale: loc.attributes.locale,
      name: loc.attributes.name,
      subtitle: loc.attributes.subtitle,
      privacyPolicyUrl: loc.attributes.privacyPolicyUrl,
    }));
  }

  async createAppInfoLocalization(appInfoId, locale, attributes = {}) {
    const data = await this.#request('POST', '/v1/appInfoLocalizations', {
      data: {
        type: 'appInfoLocalizations',
        attributes: { locale, ...attributes },
        relationships: {
          appInfo: {
            data: { type: 'appInfos', id: appInfoId },
          },
        },
      },
    });
    return {
      id: data.data.id,
      locale: data.data.attributes.locale,
      name: data.data.attributes.name,
      subtitle: data.data.attributes.subtitle,
    };
  }

  async updateAppInfoLocalization(localizationId, attributes) {
    // attributes can include: name, subtitle, privacyPolicyUrl, privacyPolicyText, privacyChoicesUrl
    const data = await this.#request('PATCH',
      `/v1/appInfoLocalizations/${localizationId}`, {
        data: {
          type: 'appInfoLocalizations',
          id: localizationId,
          attributes,
        },
      }
    );
    return {
      id: data.data.id,
      locale: data.data.attributes.locale,
      name: data.data.attributes.name,
      subtitle: data.data.attributes.subtitle,
    };
  }
}
