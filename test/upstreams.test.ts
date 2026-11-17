import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	type Account,
	ANSWERED_EVENT,
	answeredUpstreams,
	fetchModelAccounts,
	likelyAccounts,
	type ModelAccounts,
	REQUEST_EVENT,
	routeOf,
	UPSTREAMS_EVENT,
	UpstreamsAnnouncer,
	upstreamOf,
} from "../extensions/upstreams.ts";

const login: Account = { provider: "claude", kind: "oauth", priority: -15 };
const key: Account = { provider: "claude", kind: "apikey", priority: -25 };
const at = (host: string, provider = "openai-compatible-mine"): Account => ({
	provider,
	kind: "apikey",
	priority: 0,
	host,
});
const listed = (accounts: Record<string, Account[]>, owners: Record<string, string> = {}): ModelAccounts => ({
	owners,
	accounts,
});

afterEach(() => {
	vi.unstubAllGlobals();
});

describe("where a credential leads", () => {
	it("by CLIProxyAPI's provider and the kind of credential", () => {
		expect(upstreamOf(login, "claude-opus-5-5")).toEqual({ provider: "anthropic", subscription: true });
		expect(upstreamOf(key, "claude-opus-5-5")).toEqual({ provider: "anthropic", subscription: false });
		expect(upstreamOf({ provider: "codex", kind: "oauth", priority: 0 }, "gpt-6.1-sol")).toEqual({
			provider: "openai-codex",
			subscription: true,
		});
		expect(upstreamOf({ provider: "codex", kind: "apikey", priority: 0 }, "gpt-6.1-sol")).toEqual({
			provider: "openai",
			subscription: false,
		});
		expect(upstreamOf({ provider: "meta", kind: "oauth", priority: 0 }, "muse-ember-1.0")?.provider).toBe("meta");
		expect(upstreamOf({ provider: "antigravity", kind: "oauth", priority: 0 }, "gemini-3.8-flash")?.provider).toBe(
			"antigravity",
		);
		expect(upstreamOf({ provider: "something-new", kind: "oauth", priority: 0 }, "x")).toBeUndefined();
	});

	it("drops a prefix the proxy puts before a credential's models, but keeps OpenRouter's lab/model names", () => {
		expect(upstreamOf({ provider: "devin", kind: "oauth", priority: 0 }, "devin/swe-2")).toEqual({
			provider: "devin",
			model: "swe-2",
			subscription: true,
		});
		expect(upstreamOf(login, "team/claude-opus-5-5")).toEqual({
			provider: "anthropic",
			model: "claude-opus-5-5",
			subscription: true,
		});
		const openrouter = { provider: "openai-compatible-openrouter", kind: "apikey", priority: 0 };
		expect(upstreamOf(openrouter, "openai/gpt-6.1-sol")).toEqual({ provider: "openrouter", subscription: false });
	});

	it("an API key goes by the host it is sent to, whatever its entry is called", () => {
		expect(upstreamOf(at("openrouter.ai"), "openai/gpt-6.1-sol")?.provider).toBe("openrouter");
		expect(upstreamOf(at("api.openai.com", "codex"), "gpt-6.1-sol")?.provider).toBe("openai");
		expect(upstreamOf(at("api.anthropic.com", "claude"), "claude-opus-5-5")?.provider).toBe("anthropic");
		// A Claude key sent elsewhere, or an entry named openrouter on another host: not what the name says.
		expect(upstreamOf(at("llm.example.com", "claude"), "claude-opus-5-5")).toBeUndefined();
		expect(upstreamOf(at("llm.example.com", "openai-compatible-openrouter"), "openai/gpt-6.1-sol")).toBeUndefined();
	});
});

describe("a model's route", () => {
	it("the credentials at the highest priority may answer; the others are fallbacks", () => {
		expect(likelyAccounts([login, { ...login, priority: -17 }, key])).toEqual([login]);
		expect(likelyAccounts([login, key], "apikey")).toEqual([key]);
		expect(likelyAccounts([])).toEqual([]);
		expect(
			routeOf("claude-opus-5-5", listed({ "claude-opus-5-5": [login, { ...login, priority: -17 }, key, key] })),
		).toEqual({
			upstreams: [{ provider: "anthropic", subscription: true }],
			fallbacks: [{ provider: "anthropic", subscription: false }],
		});
	});

	it("with no priority set a login and a key take turns, so either may answer", () => {
		const route = routeOf(
			"claude-opus-5-5",
			listed({
				"claude-opus-5-5": [
					{ ...login, priority: 0 },
					{ ...key, priority: 0 },
				],
			}),
		);
		expect(route).toEqual({
			upstreams: [
				{ provider: "anthropic", subscription: true },
				{ provider: "anthropic", subscription: false },
			],
		});
	});

	it("a credential at the top that leads somewhere not known may answer, so the route is not known", () => {
		const mine = { provider: "openai-compatible-mine", kind: "apikey", priority: -15 };
		expect(routeOf("claude-opus-5-5", listed({ "claude-opus-5-5": [login, mine, key] }))).toEqual({
			upstreams: [],
			fallbacks: [{ provider: "anthropic", subscription: false }],
		});
	});

	it("without the credential list: the owner's lab by login or key; Devin by its prefix; other slash names not known", () => {
		const owners = {
			"claude-opus-5-5": "anthropic",
			"gpt-6.1-sol": "openai",
			"openai/gpt-6.1-sol": "openai",
			x: "antigravity",
		};
		const plain = listed({}, owners);
		expect(routeOf("claude-opus-5-5", plain)).toEqual({ upstreams: [{ provider: "anthropic" }] });
		expect(routeOf("gpt-6.1-sol", plain)).toEqual({
			upstreams: [
				{ provider: "openai-codex", subscription: true },
				{ provider: "openai", subscription: false },
			],
		});
		expect(routeOf("x", plain)).toEqual({ upstreams: [{ provider: "antigravity" }] });
		expect(routeOf("devin/swe-2", plain)).toEqual({ upstreams: [{ provider: "devin", model: "swe-2" }] });
		expect(routeOf("openai/gpt-6.1-sol", plain)).toEqual({ upstreams: [] });
		expect(routeOf("mystery", plain)).toEqual({ upstreams: [] });
	});

	it("what answered: the credentials of that kind at their highest priority", () => {
		const accounts = listed({ "claude-opus-5-5": [login, key] });
		expect(answeredUpstreams("claude-opus-5-5", "apikey", accounts)).toEqual([
			{ provider: "anthropic", subscription: false },
		]);
		expect(answeredUpstreams("claude-opus-5-5", "oauth", accounts)).toEqual([
			{ provider: "anthropic", subscription: true },
		]);
		expect(answeredUpstreams("other", "oauth", accounts)).toBeUndefined();
	});
});

describe("CLIProxyAPI's credential list", () => {
	it("is asked with the proxy's key, next to the base path, and read leniently", async () => {
		const fetchMock = vi.fn(async (url: string, init: { headers: Record<string, string> }) => {
			expect(url).toBe("http://127.0.0.1:8317/v1/models?include=accounts");
			expect(init.headers.Authorization).toBe("Bearer k");
			return new Response(
				JSON.stringify({
					data: [
						{ id: "claude-opus-5-5", owned_by: "Anthropic", accounts: [login, key, { kind: "oauth" }] },
						{
							id: "openai/gpt-6.1-sol",
							owned_by: "openai",
							accounts: [{ ...at("OpenRouter.ai"), priority: -25 }],
						},
						{ id: "claude-sonnet-4-6", owned_by: "antigravity", accounts: [] },
						{ id: "nameless" },
						"junk",
					],
				}),
			);
		});
		vi.stubGlobal("fetch", fetchMock);
		expect(await fetchModelAccounts("http://127.0.0.1:8317/v1", "k")).toEqual({
			owners: { "claude-opus-5-5": "anthropic", "openai/gpt-6.1-sol": "openai", "claude-sonnet-4-6": "antigravity" },
			accounts: {
				"claude-opus-5-5": [login, key],
				"openai/gpt-6.1-sol": [{ ...at("openrouter.ai"), priority: -25 }],
			},
		});
		vi.stubGlobal("fetch", async () => new Response(JSON.stringify({ models: [] })));
		await expect(fetchModelAccounts("http://127.0.0.1:8317", "k")).rejects.toThrow(/without a list/);
	});
});

describe("the events", () => {
	function fakePi() {
		const handlers = new Map<string, (event: unknown, ctx: unknown) => unknown>();
		const listeners = new Map<string, (data: unknown) => void>();
		const emitted: Array<[string, unknown]> = [];
		const pi = {
			on: (name: string, handler: (event: unknown, ctx: unknown) => unknown) => handlers.set(name, handler),
			events: {
				emit: (channel: string, data: unknown) => emitted.push([channel, data]),
				on: (channel: string, handler: (data: unknown) => void) => {
					listeners.set(channel, handler);
					return () => {};
				},
			},
		} as unknown as ExtensionAPI;
		return { pi, handlers, listeners, emitted };
	}
	const accounts = listed({ "claude-opus-5-5": [login, key] }, { "claude-opus-5-5": "anthropic" });

	it("every model's route when an extension asks, again after a refresh, and what answered a request", async () => {
		const { pi, handlers, listeners, emitted } = fakePi();
		const fetchAccounts = vi.fn(async () => accounts);
		const announcer = new UpstreamsAnnouncer(
			pi,
			"cliproxyapi",
			() => ({ baseUrlInput: "x", apiKey: "k" }),
			fetchAccounts,
		);
		announcer.register();
		// Nobody asked: nothing fetched, nothing said, not even after a refresh or a response.
		await announcer.refreshed();
		handlers.get("after_provider_response")!(
			{ status: 200, headers: { "x-cpa-auth-kind": "apikey" } },
			{ model: { provider: "cliproxyapi", id: "claude-opus-5-5" } },
		);
		expect(fetchAccounts).not.toHaveBeenCalled();
		expect(emitted).toEqual([]);

		listeners.get(REQUEST_EVENT)!({});
		await announcer.announce(); // the request's fetch, still running: joined
		await announcer.refreshed();
		expect(fetchAccounts).toHaveBeenCalledTimes(2);
		expect(emitted).toHaveLength(2);
		expect(emitted[0]).toEqual([
			UPSTREAMS_EVENT,
			{
				provider: "cliproxyapi",
				models: {
					"claude-opus-5-5": {
						upstreams: [{ provider: "anthropic", subscription: true }],
						fallbacks: [{ provider: "anthropic", subscription: false }],
					},
				},
			},
		]);

		emitted.length = 0;
		const respond = (headers: Record<string, string>, model = { provider: "cliproxyapi", id: "claude-opus-5-5" }) =>
			handlers.get("after_provider_response")!({ status: 200, headers }, { model });
		respond({ "X-CPA-Auth-Kind": "apikey" });
		expect(emitted).toEqual([
			[
				ANSWERED_EVENT,
				{
					provider: "cliproxyapi",
					model: "claude-opus-5-5",
					upstreams: [{ provider: "anthropic", subscription: false }],
				},
			],
		]);
		// No header, another value, or another provider's model: nothing said.
		emitted.length = 0;
		respond({});
		respond({ "x-cpa-auth-kind": "other" });
		respond({ "x-cpa-auth-kind": "apikey" }, { provider: "anthropic", id: "claude-opus-5-5" });
		expect(emitted).toEqual([]);
	});

	it("nothing is said when CLIProxyAPI does not answer or no connection is set up", async () => {
		const { pi, emitted } = fakePi();
		await new UpstreamsAnnouncer(
			pi,
			"cliproxyapi",
			() => ({ baseUrlInput: "x", apiKey: "k" }),
			async () => {
				throw new Error("down");
			},
		).announce();
		await new UpstreamsAnnouncer(
			pi,
			"cliproxyapi",
			() => null,
			async () => accounts,
		).announce();
		expect(emitted).toEqual([]);
	});
});
