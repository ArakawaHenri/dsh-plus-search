export function searchPrompt(query) {
	return `Perform a web search for the query: ${query}`;
}

export function appendSource(sources, seen, rawUrl, rawTitle, rawSnippet, rawDate) {
	const url = typeof rawUrl === 'string' ? rawUrl.trim() : '';
	if (!url || seen.has(url)) return;
	seen.add(url);
	const source = { url };
	const title = typeof rawTitle === 'string' ? rawTitle.trim() : '';
	const snippet = typeof rawSnippet === 'string' ? rawSnippet.trim() : '';
	const publishedAt = typeof rawDate === 'string' ? rawDate.trim() : '';
	if (title) source.title = title;
	if (snippet) source.snippet = snippet;
	if (publishedAt) source.publishedAt = publishedAt;
	sources.push(source);
}

function citationSnippets(blocks) {
	const snippets = new Map();
	for (const block of blocks) {
		if (block?.type !== 'text' || !Array.isArray(block.citations)) continue;
		for (const cite of block.citations) {
			const url = typeof cite?.url === 'string' ? cite.url.trim() : '';
			const text = typeof cite?.cited_text === 'string' ? cite.cited_text.trim() : '';
			if (url && text && !snippets.has(url)) snippets.set(url, text);
		}
	}
	return snippets;
}

export function buildMessagesRequest(profile, request, defaults, toolType) {
	return {
		model: profile.model,
		max_tokens: profile.maxTokens ?? defaults.maxTokens,
		messages: [{
			role: 'user',
			content: [{ type: 'text', text: searchPrompt(request.query) }],
		}],
		tools: [{
			type: toolType,
			name: 'web_search',
			max_uses: profile.maxUses ?? defaults.maxUses,
		}],
		tool_choice: profile.toolChoice ?? { type: 'any' },
	};
}

export function parseMessagesResponse(payload) {
	const sources = [];
	const toolErrors = [];
	const seen = new Set();
	let searched = false;
	const blocks = Array.isArray(payload?.content) ? payload.content : [];
	const snippets = citationSnippets(blocks);
	for (const block of blocks) {
		if (block?.type !== 'web_search_tool_result') continue;
		searched = true;
		const inner = block.content;
		if (!Array.isArray(inner)) {
			if (typeof inner?.error_code === 'string') toolErrors.push(inner.error_code);
			continue;
		}
		for (const item of inner) {
			if (item?.type !== 'web_search_result') continue;
			const url = typeof item.url === 'string' ? item.url.trim() : '';
			appendSource(sources, seen, url, item.title, item.snippet ?? snippets.get(url), item.page_age);
		}
	}
	return { sources, toolErrors, searched };
}

export function buildResponsesRequest(profile, request, defaults, toolType) {
	return {
		model: profile.model,
		input: searchPrompt(request.query),
		tools: [{ type: toolType }],
		tool_choice: profile.toolChoice ?? { type: toolType },
		max_output_tokens: profile.maxTokens ?? defaults.maxTokens,
	};
}

export function parseResponsesResponse(payload) {
	const sources = [];
	const toolErrors = [];
	const seen = new Set();
	let searched = false;
	if (payload?.error) {
		const msg = typeof payload.error === 'string' ? payload.error : payload.error?.message ?? 'response error';
		toolErrors.push(msg);
	} else if (payload?.status === 'failed' || payload?.status === 'incomplete') {
		toolErrors.push(payload.status);
	}
	const output = Array.isArray(payload?.output) ? payload.output : [];
	for (const item of output) {
		if (item?.type === 'web_search_call') {
			searched = true;
			if (typeof item.status === 'string' && item.status !== 'completed') {
				toolErrors.push(item.status);
			}
			const list = item.action?.sources;
			if (Array.isArray(list)) {
				for (const entry of list) {
					appendSource(sources, seen, entry?.url, entry?.title, entry?.snippet, entry?.published_at);
				}
			}
		} else if (item?.type === 'message' && Array.isArray(item.content)) {
			for (const part of item.content) {
				if (!Array.isArray(part?.annotations)) continue;
				for (const ann of part.annotations) {
					if (ann?.type !== 'url_citation') continue;
					searched = true;
					appendSource(sources, seen, ann.url, ann.title);
				}
			}
		}
	}
	return { sources, toolErrors, searched };
}
