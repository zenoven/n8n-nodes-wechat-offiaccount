import {
	IDataObject,
	IExecuteFunctions,
	IHttpRequestOptions,
	NodeOperationError,
} from 'n8n-workflow';

export const TOKEN_REFRESH_ERROR_CODES = new Set([40001, 40014, 42001]);

type WechatResponse = IDataObject & {
	errcode?: number;
	errmsg?: string;
};

export type WechatRequestOptions = IHttpRequestOptions & {
	bodyFactory?: () => Promise<IHttpRequestOptions['body']> | IHttpRequestOptions['body'];
};

export function parseWechatResponse(response: unknown): WechatResponse {
	if (typeof response === 'string') return JSON.parse(response) as WechatResponse;
	if (response && typeof response === 'object') return response as WechatResponse;
	throw new Error('WeChat returned an invalid response');
}

export function shouldRefreshAccessToken(response: WechatResponse) {
	return typeof response.errcode === 'number' && TOKEN_REFRESH_ERROR_CODES.has(response.errcode);
}

function buildWechatError(response: WechatResponse) {
	return `Request Error: ${response.errcode ?? 'unknown'}, ${response.errmsg ?? 'unknown error'}`;
}

class RequestUtils {
	static async originRequest(
		this: IExecuteFunctions,
		options: WechatRequestOptions,
		forceRefresh = false,
	) {
		const credentials = await this.getCredentials('wechatOfficialAccountCredentialsApi');
		const { bodyFactory, ...baseOptions } = options;
		const requestOptions: IHttpRequestOptions = {
			...baseOptions,
			headers: baseOptions.headers ? { ...baseOptions.headers } : undefined,
			qs: baseOptions.qs ? { ...baseOptions.qs } : undefined,
		};
		if (bodyFactory) requestOptions.body = await bodyFactory();

		requestOptions.baseURL = `https://${credentials.baseUrl}`;

		return this.helpers.httpRequestWithAuthentication.call(
			this,
			'wechatOfficialAccountCredentialsApi',
			requestOptions,
			{
				// @ts-ignore
				credentialsDecrypted: {
					data: {
						...credentials,
						accessToken: forceRefresh ? '' : credentials.accessToken,
						forceRefresh,
					},
				},
			},
		);
	}

	static async request(this: IExecuteFunctions, options: WechatRequestOptions) {
		let data = parseWechatResponse(await RequestUtils.originRequest.call(this, options));

		if (shouldRefreshAccessToken(data)) {
			data = parseWechatResponse(await RequestUtils.originRequest.call(this, options, true));
		}

		if (data.errcode && data.errcode !== 0) {
			throw new NodeOperationError(this.getNode(), buildWechatError(data));
		}
		return data;
	}
}

export default RequestUtils;
