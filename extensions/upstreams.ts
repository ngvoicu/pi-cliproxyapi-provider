/**
 * Where each CLIProxyAPI model really comes from, told to other extensions.
 *
 * Through CLIProxyAPI pi sees one provider, but a model can be served by a subscription login or an API key, and the
 * two can differ in window, prompt-cache lifetime and price (a Claude login keeps a cache for an hour, a Claude API key
 * for 5 minutes by default). A CLIProxyAPI that lists its credentials (`/v1/models?include=accounts`) says which serve
 * each model; every response names the kind that answered (`X-CPA-AUTH-KIND`).
 *
 * This file turns that into the `model-upstreams` events other extensions read (pi-cache-keeper fills windows,
 * lifetimes and prices from providers.dev with them):
 *
 * - `model-upstreams:request` (sent by an extension that wants them): CLIProxyAPI is asked, and the answer follows.
 * - `model-upstreams`: `{ provider, models: { [id]: { upstreams, fallbacks? } } }`, after a request and, once one came,
 *   after `/cliproxyapi-refresh`. `upstreams` are what may serve the model (several: not known which), `fallbacks` what may
 *   answer when those fail.
 * - `model-upstreams:answered`: `{ provider, model, upstreams }`, after a response that names the kind that answered.
 *
 * An upstream is `{ provider, model?, subscription? }`: the pi provider the model would come from if used directly
 * (anthropic, openai-codex, openai, meta, openrouter, google) or a providers.dev provider pi has none for (devin,
 * antigravity); the model's id there when it differs; a subscription login (true) or an API key (false).
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { resolveEndpoints } from "./lib.ts";

export const REQUEST_EVENT = "model-upstreams:request";
export const UPSTREAMS_EVENT = "model-upstreams";
export const ANSWERED_EVENT = "model-upstreams:answered";
export const AUTH_KIND_HEADER = "x-cpa-auth-kind";
const REQUEST_TIMEOUT_MS = 10_000;

export interface Upstream {
	provider: string;
	model?: string;
	subscription?: boolean;
}

export interface Route {
	upstreams: Upstream[];
	fallbacks?: Upstream[];
}

/** A credential that serves a model, as `/v1/models?include=accounts` lists it. */
export interface Account {
	/** CLIProxyAPI's provider: claude, codex, meta, devin, antigravity, gemini, openai-compatible-<name> … */
	provider: string;
	/** "oauth" for a subscription login, "apikey" for an API key. */
	kind: string;
	priority: number;
	/** The host of an API key's base URL. */
	host?: string;
}

export interface ModelAccounts {
	/** Model id → the lab CLIProxyAPI names as its owner. */
	owners: Record<string, string>;
	/** Model id → the credentials that serve it; empty when CLIProxyAPI does not list them. */
	accounts: Record<string, Account[]>;
}

/** Where a CLIProxyAPI credential leads, by its provider and kind. */
const CREDENTIALS: Record<string, { oauth?: string; apikey?: string }> = {
	claude: { oauth: "anthropic", apikey: "anthropic" },
	codex: { oauth: "openai-codex", apikey: "openai" },
	meta: { oauth: "meta", apikey: "meta" },
	devin: { oauth: "devin", apikey: "devin" },
	antigravity: { oauth: "antigravity" },
	gemini: { oauth: "google", apikey: "google" },
	// Without a host, an OpenAI-compatible entry is only known by the name the operator gave it.
	"openai-compatible-openrouter": { apikey: "openrouter" },
};

/** Where an API key leads, by the host it is sent to: whatever its entry is called, and wherever a Claude key goes. */
const API_HOSTS: Record<string, string> = {
	"openrouter.ai": "openrouter",
	"api.openai.com": "openai",
	"api.anthropic.com": "anthropic",
	"generativelanguage.googleapis.com": "google",
};

/** Without the credential list: the lab CLIProxyAPI names as the owner, reached by login or key. */
const OWNERS: Record<string, Upstream[]> = {
	anthropic: [{ provider: "anthropic" }],
	openai: [
		{ provider: "openai-codex", subscription: true },
		{ provider: "openai", subscription: false },
	],
	meta: [{ provider: "meta" }],
};

/** A credential's upstream for a model; undefined when it leads somewhere not known. */
export function upstreamOf(account: Account, modelId: string): Upstream | undefined {
	const provider =
		account.kind === "apikey" && account.host
			? API_HOSTS[account.host]
			: CREDENTIALS[account.provider]?.[account.kind as "oauth" | "apikey"];
	if (!provider) return undefined;
	// OpenRouter's names are `lab/model`; nobody else's have a slash, so one there is a prefix the proxy added.
	const model = provider === "openrouter" ? modelId : modelId.slice(modelId.lastIndexOf("/") + 1);
	return { provider, ...(model !== modelId ? { model } : {}), subscription: account.kind !== "apikey" };
}

/**
 * The credentials CLIProxyAPI may answer with: those at the highest priority. It uses the highest priority that is
 * free in every routing mode, and picks among the credentials sharing it (round-robin by default; with no priority
 * set, all share 0). Given a kind, among the credentials of that kind.
 */
export function likelyAccounts(accounts: Account[], kind?: string): Account[] {
	const candidates = kind ? accounts.filter((account) => account.kind === kind) : accounts;
	if (candidates.length === 0) return [];
	const top = Math.max(...candidates.map((account) => account.priority));
	return candidates.filter((account) => account.priority === top);
}

const unique = (upstreams: Upstream[]): Upstream[] => {
	const seen = new Set<string>();
	return upstreams.filter((upstream) => {
		const key = JSON.stringify([upstream.provider, upstream.model, upstream.subscription]);
		return !seen.has(key) && seen.add(key);
	});
};

/** The upstreams of some credentials; empty when one of them leads somewhere not known (it may answer). */
function upstreamsOf(accounts: Account[], modelId: string): Upstream[] {
	const upstreams = accounts.map((account) => upstreamOf(account, modelId));
	return upstreams.every((upstream) => upstream !== undefined) ? unique(upstreams as Upstream[]) : [];
}

/** A model's route: from its credentials when CLIProxyAPI lists them, else from its owner and CLIProxyAPI's own prefix. */
export function routeOf(modelId: string, listed: ModelAccounts): Route {
	const accounts = listed.accounts[modelId];
	if (accounts && accounts.length > 0) {
		const likely = likelyAccounts(accounts);
		const upstreams = upstreamsOf(likely, modelId);
		const main = new Set(upstreams.map((upstream) => JSON.stringify(upstream)));
		const fallbacks = unique(
			accounts
				.filter((account) => !likely.includes(account))
				.map((account) => upstreamOf(account, modelId))
				.filter((upstream): upstream is Upstream => upstream !== undefined && !main.has(JSON.stringify(upstream))),
		);
		return { upstreams, ...(fallbacks.length > 0 ? { fallbacks } : {}) };
	}
	if (modelId.startsWith("devin/"))
		return { upstreams: [{ provider: "devin", model: modelId.slice("devin/".length) }] };
	// Any OpenAI-compatible entry can use `lab/model`: the name says nothing about who serves it.
	const owner = listed.owners[modelId];
	if (modelId.includes("/") || !owner) return { upstreams: [] };
	return { upstreams: OWNERS[owner] ?? [{ provider: owner }] };
}

/** What answered a request to a model, from the kind of credential CLIProxyAPI names; undefined when not known. */
export function answeredUpstreams(modelId: string, kind: string, listed: ModelAccounts): Upstream[] | undefined {
	const upstreams = upstreamsOf(likelyAccounts(listed.accounts[modelId] ?? [], kind), modelId);
	return upstreams.length > 0 ? upstreams : undefined;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value);

/** `/v1/models?include=accounts`. A CLIProxyAPI that does not know the parameter answers the plain list. */
export async function fetchModelAccounts(
	baseUrlInput: string,
	apiKey: string,
	signal?: AbortSignal,
): Promise<ModelAccounts> {
	const url = `${resolveEndpoints(baseUrlInput).plainModelsUrl}?include=accounts`;
	const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
	const response = await fetch(url, {
		headers: { Authorization: `Bearer ${apiKey}`, Accept: "application/json" },
		signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
	});
	if (!response.ok) throw new Error(`${url} answered ${response.status}`);
	const body: unknown = await response.json();
	if (!isRecord(body) || !Array.isArray(body.data)) throw new Error(`${url} answered without a list`);
	const listed: ModelAccounts = { owners: {}, accounts: {} };
	for (const model of body.data) {
		if (!isRecord(model) || typeof model.id !== "string") continue;
		if (typeof model.owned_by === "string") listed.owners[model.id] = model.owned_by.trim().toLowerCase();
		if (!Array.isArray(model.accounts)) continue;
		const accounts: Account[] = [];
		for (const account of model.accounts) {
			if (!isRecord(account) || typeof account.provider !== "string" || typeof account.kind !== "string") continue;
			accounts.push({
				provider: account.provider,
				kind: account.kind,
				priority: typeof account.priority === "number" ? account.priority : 0,
				...(typeof account.host === "string" && account.host ? { host: account.host.toLowerCase() } : {}),
			});
		}
		if (accounts.length > 0) listed.accounts[model.id] = accounts;
	}
	return listed;
}

/** Tells other extensions where this provider's models come from, and what answered each request. */
export class UpstreamsAnnouncer {
	private listed: ModelAccounts | undefined;
	private running: Promise<void> | undefined;
	/** Whether an extension asked: nothing is fetched for nobody. */
	private wanted = false;

	constructor(
		private readonly pi: ExtensionAPI,
		private readonly providerId: string,
		private readonly connection: () => { baseUrlInput: string; apiKey: string } | null,
		private readonly fetchAccounts: typeof fetchModelAccounts = fetchModelAccounts,
	) {}

	register(): void {
		// pi without a bus between extensions (older, or a test's stand-in): nobody to tell.
		if (!this.pi.events) return;
		this.pi.events.on(REQUEST_EVENT, () => {
			this.wanted = true;
			void this.announce();
		});
		this.pi.on("after_provider_response", (event, ctx) => {
			const model = ctx.model;
			if (!model || model.provider !== this.providerId || !this.listed) return;
			const headers = (event as { headers?: Record<string, string | undefined> }).headers ?? {};
			const kind = Object.entries(headers)
				.find(([name]) => name.toLowerCase() === AUTH_KIND_HEADER)?.[1]
				?.trim()
				.toLowerCase();
			if (kind !== "oauth" && kind !== "apikey") return;
			const upstreams = answeredUpstreams(model.id, kind, this.listed);
			if (upstreams) this.pi.events.emit(ANSWERED_EVENT, { provider: this.providerId, model: model.id, upstreams });
		});
	}

	/** After the model list was fetched again: tells the routes again, if an extension asked for them. */
	refreshed(): Promise<void> {
		return this.wanted ? this.announce() : Promise.resolve();
	}

	/** Asks CLIProxyAPI for its credentials and tells the routes. When it does not answer, nothing is said. */
	announce(): Promise<void> {
		this.running ??= (async () => {
			const connection = this.connection();
			if (!connection) return;
			try {
				this.listed = await this.fetchAccounts(connection.baseUrlInput, connection.apiKey);
			} catch {
				return;
			}
			const models: Record<string, Route> = {};
			for (const id of new Set([...Object.keys(this.listed.owners), ...Object.keys(this.listed.accounts)])) {
				models[id] = routeOf(id, this.listed);
			}
			this.pi.events.emit(UPSTREAMS_EVENT, { provider: this.providerId, models });
		})().finally(() => {
			this.running = undefined;
		});
		return this.running;
	}
}
