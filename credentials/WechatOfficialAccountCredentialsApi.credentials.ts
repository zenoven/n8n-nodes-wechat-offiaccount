import {
	IAuthenticateGeneric,
	ICredentialDataDecryptedObject,
	ICredentialTestRequest,
	ICredentialType,
	IHttpRequestHelper,
	INodeProperties,
} from 'n8n-workflow';

type StableTokenResponse = {
	access_token?: string;
	expires_in?: number;
	errcode?: number;
	errmsg?: string;
};

type TokenRequest = {
	forceRefresh: boolean;
	promise: Promise<{ accessToken: string }>;
};

const tokenRequests = new Map<string, TokenRequest>();
const recentForcedTokens = new Map<string, { accessToken: string; expiresAt: number }>();
const FORCE_REFRESH_DEDUPLICATION_MS = 30_000;

export function buildStableTokenRequest(
	credentials: ICredentialDataDecryptedObject,
	forceRefresh = false,
) {
	return {
		method: 'POST' as const,
		url: `https://${credentials.baseUrl}/cgi-bin/stable_token`,
		body: {
			grant_type: 'client_credential',
			appid: credentials.appid,
			secret: credentials.appsecret,
			force_refresh: forceRefresh,
		},
		json: true,
	};
}

function tokenRequestKey(credentials: ICredentialDataDecryptedObject) {
	return `${String(credentials.baseUrl)}:${String(credentials.appid)}`;
}

export class WechatOfficialAccountCredentialsApi implements ICredentialType {
	name = 'wechatOfficialAccountCredentialsApi';
	displayName = 'Wechat Official Account Credentials API';
	properties: INodeProperties[] = [
		{
			displayName: 'Base URL',
			name: 'baseUrl',
			type: 'string',
			default: 'api.weixin.qq.com',
			required: true,
		},
		{
			displayName: 'Appid',
			description:
				'第三方用户唯一凭证，AppID和AppSecret可在“微信公众平台-设置与开发--基本配置”页中获得',
			name: 'appid',
			type: 'string',
			default: '',
			required: true,
		},
		{
			displayName: 'AppSecret',
			name: 'appsecret',
			description: '第三方用户唯一凭证密钥',
			type: 'string',
			default: '',
			required: true,
			typeOptions: {
				password: true,
			},
		},
		{
			displayName: 'AccessToken',
			name: 'accessToken',
			type: 'hidden',
			default: '',
			// eslint-disable-next-line n8n-nodes-base/cred-class-field-type-options-password-missing
			typeOptions: {
				expirable: true,
			},
		},
	];

	async preAuthentication(this: IHttpRequestHelper, credentials: ICredentialDataDecryptedObject) {
		const forceRefresh = credentials.forceRefresh === true;
		const key = tokenRequestKey(credentials);

		while (true) {
			if (forceRefresh) {
				const recent = recentForcedTokens.get(key);
				if (recent && recent.expiresAt > Date.now()) {
					return { accessToken: recent.accessToken };
				}
				if (recent) recentForcedTokens.delete(key);
			}

			const inFlight = tokenRequests.get(key);
			if (inFlight) {
				const result = await inFlight.promise;
				if (!forceRefresh || inFlight.forceRefresh) return result;
				continue;
			}

			const promise = (async () => {
				const res = (await this.helpers.httpRequest(
					buildStableTokenRequest(credentials, forceRefresh),
				)) as StableTokenResponse;

				if (res.errcode && res.errcode !== 0) {
					throw new Error(`授权失败：${res.errcode}, ${res.errmsg ?? 'unknown error'}`);
				}
				if (!res.access_token) {
					throw new Error('授权失败：微信未返回 access_token');
				}

				const result = { accessToken: res.access_token };
				if (forceRefresh) {
					recentForcedTokens.set(key, {
						...result,
						expiresAt: Date.now() + FORCE_REFRESH_DEDUPLICATION_MS,
					});
				}
				return result;
			})();

			const request = { forceRefresh, promise };
			tokenRequests.set(key, request);
			try {
				return await promise;
			} finally {
				if (tokenRequests.get(key) === request) tokenRequests.delete(key);
			}
		}
	}

	authenticate: IAuthenticateGeneric = {
		type: 'generic',
		properties: {
			qs: {
				access_token: '={{$credentials.accessToken}}',
			},
		},
	};

	// async authenticate(
	// 	credentials: ICredentialDataDecryptedObject,
	// 	requestOptions: IHttpRequestOptions,
	// ): Promise<IHttpRequestOptions> {
	// 	requestOptions.baseURL = `https://${credentials.baseUrl}`;
	// 	requestOptions.qs = {
	// 		...(requestOptions.qs || {}),
	// 		access_token: credentials.accessToken,
	// 	};
	// 	// requestOptions.proxy = {
	// 	// 	host: '127.0.0.1',
	// 	// 	port: 8000,
	// 	// 	protocol: 'http',
	// 	// };
	// 	// requestOptions.skipSslCertificateValidation = true;
	//
	// 	return requestOptions;
	// }

	// The block below tells how this credential can be tested
	test: ICredentialTestRequest = {
		request: {
			baseURL: '=https://{{$credentials.baseUrl}}',
			url: '/cgi-bin/get_api_domain_ip',
		},
		rules: [
			{
				type: 'responseSuccessBody',
				properties: {
					key: 'errcode',
					value: 0,
					message: '凭证验证失败',
				},
			},
		],
	};
}
