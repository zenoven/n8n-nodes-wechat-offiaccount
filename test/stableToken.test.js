const assert = require('node:assert/strict');
const test = require('node:test');

const {
	WechatOfficialAccountCredentialsApi,
	buildStableTokenRequest,
} = require('../dist/credentials/WechatOfficialAccountCredentialsApi.credentials.js');
const RequestUtilsModule = require('../dist/nodes/help/utils/RequestUtils.js');
const RequestUtils = RequestUtilsModule.default;

const credentials = {
	baseUrl: 'api.weixin.qq.com',
	appid: 'appid-for-test',
	appsecret: 'secret-for-test',
	accessToken: 'old-token',
};

test('stable token request uses POST JSON body and keeps secrets out of the URL', () => {
	const request = buildStableTokenRequest(credentials, true);
	assert.equal(request.method, 'POST');
	assert.equal(request.url, 'https://api.weixin.qq.com/cgi-bin/stable_token');
	assert.deepEqual(request.body, {
		grant_type: 'client_credential',
		appid: 'appid-for-test',
		secret: 'secret-for-test',
		force_refresh: true,
	});
	assert.equal(request.url.includes('secret-for-test'), false);
});

test('preAuthentication deduplicates concurrent stable token refreshes', async () => {
	let requestCount = 0;
	let release;
	const response = new Promise((resolve) => {
		release = resolve;
	});
	const context = {
		helpers: {
			httpRequest: async () => {
				requestCount += 1;
				await response;
				return { access_token: 'new-token', expires_in: 7200 };
			},
		},
	};
	const credentialType = new WechatOfficialAccountCredentialsApi();
	const forcedCredentials = { ...credentials, forceRefresh: true };
	const first = credentialType.preAuthentication.call(context, forcedCredentials);
	const second = credentialType.preAuthentication.call(context, forcedCredentials);
	release();
	assert.deepEqual(await first, { accessToken: 'new-token' });
	assert.deepEqual(await second, { accessToken: 'new-token' });
	assert.equal(requestCount, 1);
});

test('forced refresh waits for an in-flight normal refresh, then obtains a forced token', async () => {
	const calls = [];
	let releaseNormal;
	const normalResponse = new Promise((resolve) => {
		releaseNormal = resolve;
	});
	const context = {
		helpers: {
			httpRequest: async (request) => {
				calls.push(request.body.force_refresh);
				if (request.body.force_refresh === false) {
					await normalResponse;
					return { access_token: 'normal-token', expires_in: 7200 };
				}
				return { access_token: 'forced-token', expires_in: 7200 };
			},
		},
	};
	const credentialType = new WechatOfficialAccountCredentialsApi();
	const isolatedCredentials = { ...credentials, appid: 'serialized-refresh-test' };
	const normal = credentialType.preAuthentication.call(context, isolatedCredentials);
	const forced = credentialType.preAuthentication.call(context, {
		...isolatedCredentials,
		forceRefresh: true,
	});
	releaseNormal();
	assert.deepEqual(await normal, { accessToken: 'normal-token' });
	assert.deepEqual(await forced, { accessToken: 'forced-token' });
	assert.deepEqual(calls, [false, true]);
});

function createExecuteContext(responses) {
	const calls = [];
	return {
		calls,
		context: {
			getCredentials: async () => credentials,
			getNode: () => ({ name: 'Wechat node', type: 'CUSTOM.wechatOfficialAccountNode' }),
			helpers: {
				httpRequestWithAuthentication: async (_type, _options, additional) => {
					calls.push(additional.credentialsDecrypted.data);
					return JSON.stringify(responses.shift());
				},
			},
		},
	};
}

test('network failure is not retried by the node', async () => {
	let requestCount = 0;
	const context = {
		getCredentials: async () => credentials,
		getNode: () => ({ name: 'Wechat node', type: 'CUSTOM.wechatOfficialAccountNode' }),
		helpers: {
			httpRequestWithAuthentication: async () => {
				requestCount += 1;
				throw new Error('socket timeout');
			},
		},
	};
	await assert.rejects(
		RequestUtils.request.call(context, { method: 'POST', url: '/cgi-bin/draft/add' }),
		/socket timeout/,
	);
	assert.equal(requestCount, 1);
});

for (const errcode of [40001, 40014, 42001]) {
	test(`errcode ${errcode} forces exactly one refresh and succeeds`, async () => {
		const { calls, context } = createExecuteContext([
			{ errcode, errmsg: 'token error' },
			{ errcode: 0, media_id: 'media-id' },
		]);
		const result = await RequestUtils.request.call(context, { method: 'POST', url: '/test' });
		assert.equal(result.media_id, 'media-id');
		assert.equal(calls.length, 2);
		assert.equal(calls[0].forceRefresh, false);
		assert.equal(calls[1].forceRefresh, true);
		assert.equal(calls[1].accessToken, '');
	});
}

test('a second token error is returned without a third request', async () => {
	const { calls, context } = createExecuteContext([
		{ errcode: 40001, errmsg: 'first token error' },
		{ errcode: 40001, errmsg: 'second token error' },
	]);
	await assert.rejects(
		RequestUtils.request.call(context, { method: 'GET', url: '/test' }),
		/Request Error: 40001, second token error/,
	);
	assert.equal(calls.length, 2);
});

test('a retry builds a fresh multipart body instead of reusing a consumed stream', async () => {
	const bodies = [];
	let bodyCount = 0;
	const context = {
		getCredentials: async () => credentials,
		getNode: () => ({ name: 'Wechat node', type: 'CUSTOM.wechatOfficialAccountNode' }),
		helpers: {
			httpRequestWithAuthentication: async (_type, options) => {
				bodies.push(options.body);
				return JSON.stringify(
					bodies.length === 1
						? { errcode: 40001, errmsg: 'token error' }
						: { errcode: 0, media_id: 'media-id' },
				);
			},
		},
	};
	const result = await RequestUtils.request.call(context, {
		method: 'POST',
		url: '/cgi-bin/material/add_material',
		bodyFactory: () => ({ requestBody: ++bodyCount }),
	});
	assert.equal(result.media_id, 'media-id');
	assert.equal(bodyCount, 2);
	assert.notEqual(bodies[0], bodies[1]);
});

for (const errcode of [40164, 45009, 48001]) {
	test(`errcode ${errcode} is not retried and remains visible`, async () => {
		const { calls, context } = createExecuteContext([{ errcode, errmsg: 'wechat error' }]);
		await assert.rejects(
			RequestUtils.request.call(context, { method: 'GET', url: '/test' }),
			new RegExp(`Request Error: ${errcode}, wechat error`),
		);
		assert.equal(calls.length, 1);
	});
}
