import { execFile } from "node:child_process";
import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";
//#region src/index.ts
const name = "dsh-usage-dashboard";
/** Services required before mounting. */
const inject = [
	"webServer",
	"sessionQuery",
	"sessionPersistence",
	"timer"
];
const HOUR_MS = 36e5;
const DAY_MS = 864e5;
/** One aggregate counter set. */
function newAgg() {
	return {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		reasoning: 0,
		total: 0,
		calls: 0
	};
}
/** Local-midnight epoch ms for a timestamp (avoids UTC drift). */
function localMidnight(timeMs) {
	const d = new Date(timeMs);
	return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
}
/** Local hour start (minute/second/ms zeroed) epoch ms. */
function localHourStart(timeMs) {
	const d = new Date(timeMs);
	d.setMinutes(0, 0, 0);
	return d.getTime();
}
const DSH_HOME = process.env.DSH_HOME || join(process.env.HOME || "", ".dsh");
const SESSIONS_ROOT = join(DSH_HOME, "sessions");
/** Decompress a session log. Session logs are CONCATENATED zstd frames (one
*  frame per append); Node's zlib only surfaces the first frame, so use the
*  `zstd` CLI which handles concatenated frames natively. */
function zstdToText(filePath) {
	return new Promise((resolve, reject) => {
		execFile("zstd", [
			"-d",
			"-c",
			filePath
		], { maxBuffer: 134217728 }, (error, stdout) => {
			if (error) reject(error);
			else resolve(stdout);
		});
	});
}
/** Parse an NDJSON log body into events (malformed lines are skipped). */
function parseLogLines(text) {
	const events = [];
	for (const line of text.split("\n")) {
		const t = line.trim();
		if (!t) continue;
		try {
			events.push(JSON.parse(t));
		} catch {}
	}
	return events;
}
/** Recursively discover every session log under the sessions root (depth ≤3):
*  map sessionId -> log path. Also locates bare-id and encoded-workspace dirs. */
function findSessionLogs(root, depth, out) {
	if (depth > 3) return;
	let entries;
	try {
		entries = readdirSync(root);
	} catch {
		return;
	}
	for (const entry of entries) {
		const p = join(root, entry);
		let st;
		try {
			st = statSync(p);
		} catch {
			continue;
		}
		if (st.isDirectory()) findSessionLogs(p, depth + 1, out);
		else if (entry === "session.jsonl.zstd") {
			const id = root.split("/").pop() || "";
			if (id) out.set(id, p);
		}
	}
}
/** Fold one usage record into one aggregate. */
function ink(agg, u) {
	const input = u.inputTokens || 0;
	const output = u.outputTokens || 0;
	const cacheRead = u.cacheReadTokens || 0;
	const cacheWrite = u.cacheWriteTokens || 0;
	const reasoning = u.reasoningTokens || 0;
	agg.input += input;
	agg.output += output;
	agg.cacheRead += cacheRead;
	agg.cacheWrite += cacheWrite;
	agg.reasoning += reasoning;
	agg.total += input + output + cacheRead + cacheWrite;
	agg.calls += 1;
}
/** Whether an event carries a usable token-usage record. */
function usable(event) {
	return !!event && event.type === "assistant/message" && !!event.data && !!event.data.usage && typeof event.data.usage.inputTokens === "number";
}
/** The model attribution of an assistant/message event. */
function modelOf(event) {
	const src = event?.data?.message?.source;
	if (src && typeof src.model === "string" && src.model) return src.model;
	const direct = event?.data?.model;
	if (typeof direct === "string" && direct) return direct;
	return "unknown";
}
const msgOf = (e) => e && typeof e === "object" && e.message ? String(e.message) : String(e);
const shortOf = (id) => typeof id === "string" && id.length > 12 ? id.slice(0, 12) + "…" : String(id);
function writeJson(res, status, body) {
	const payload = JSON.stringify(body);
	res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
	res.end(payload);
}
function writeOk(res, value) {
	writeJson(res, 200, {
		ok: true,
		value
	});
}
function writeError(res, error) {
	writeJson(res, 500, {
		ok: false,
		error: {
			code: "internal",
			message: error instanceof Error ? error.message : String(error)
		}
	});
}
/** DNS-rebinding / cross-site defense for the JSON API: only loopback
*  authorities may call it (the DSH web server binds loopback by default). */
function isLoopbackHost(hostHeader) {
	if (!hostHeader) return false;
	let hostname = hostHeader;
	const at = hostHeader.lastIndexOf("@");
	if (at !== -1) hostname = hostHeader.slice(at + 1);
	if (hostname.startsWith("[")) {
		const end = hostname.indexOf("]");
		return end !== -1 && hostname.slice(1, end) === "::1";
	}
	if (hostname === "::1") return true;
	const colon = hostname.lastIndexOf(":");
	if (colon !== -1 && hostname.indexOf("]") === -1 && hostname.indexOf(":") === colon) hostname = hostname.slice(0, colon);
	if (hostname === "localhost") return true;
	const parts = hostname.split(".");
	return parts.length === 4 && parts[0] === "127" && parts.every((part) => /^\d{1,3}$/.test(part) && Number(part) <= 255);
}
function apply(ctx) {
	const store = {
		sessions: /* @__PURE__ */ new Map(),
		allAgg: newAgg(),
		allDaily: /* @__PURE__ */ new Map(),
		allHourly: /* @__PURE__ */ new Map(),
		byModel: /* @__PURE__ */ new Map(),
		scanning: false,
		running: false,
		scans: 0,
		failed: 0,
		rawSessions: 0,
		harnessSessions: 0,
		foldedEvents: 0,
		dedupSkipped: 0,
		lastError: null,
		scanError: null,
		lastScanAt: 0
	};
	function dayAgg(map, day) {
		let a = map.get(day);
		if (!a) {
			a = newAgg();
			map.set(day, a);
		}
		return a;
	}
	function ensureSession(id) {
		let info = store.sessions.get(id);
		if (!info) {
			info = {
				daily: /* @__PURE__ */ new Map(),
				allAgg: newAgg(),
				maxSeq: -1,
				title: void 0,
				cwd: void 0,
				lastAt: 0
			};
			store.sessions.set(id, info);
		}
		return info;
	}
	/** Note the session display title (from session/title events). */
	function noteTitle(id, title) {
		if (typeof title !== "string" || title === "") return;
		const info = ensureSession(id);
		if (info.title === void 0) info.title = title;
	}
	/** Fold one usage record into every dimension. */
	function foldUsage(id, timeMs, u, model) {
		const info = ensureSession(id);
		const day = localMidnight(timeMs);
		ink(dayAgg(info.daily, day), u);
		ink(info.allAgg, u);
		ink(dayAgg(store.allDaily, day), u);
		ink(dayAgg(store.allHourly, localHourStart(timeMs)), u);
		ink(store.allAgg, u);
		ink(dayAgg(store.byModel, model), u);
		if (typeof timeMs === "number" && timeMs > info.lastAt) info.lastAt = timeMs;
	}
	/** Fold a batch of log events for one session (idempotent via maxSeq). */
	function foldSessionEvents(id, events) {
		const info = ensureSession(id);
		if (!Array.isArray(events)) return;
		for (const ev of events) {
			if (!ev || typeof ev !== "object") continue;
			if (ev.type === "session/title") {
				noteTitle(id, ev.data?.title);
				continue;
			}
			if (ev.type === "session" && typeof ev.cwd === "string" && !info.cwd) info.cwd = ev.cwd;
			if (!usable(ev)) continue;
			if (typeof ev.seq === "number" && ev.seq <= info.maxSeq) {
				store.dedupSkipped += 1;
				continue;
			}
			foldUsage(id, ev.time, ev.data.usage, modelOf(ev));
			store.foldedEvents += 1;
			if (typeof ev.seq === "number") info.maxSeq = Math.max(info.maxSeq, ev.seq);
		}
	}
	async function scanOnce(options) {
		const initial = !!(options && options.initial);
		if (initial) store.scanning = true;
		if (store.running) return;
		store.running = true;
		store.scans += 1;
		store.lastScanAt = Date.now();
		store.failed = 0;
		store.rawSessions = 0;
		store.harnessSessions = 0;
		try {
			const query = ctx.get("sessionQuery");
			const persist = ctx.get("sessionPersistence");
			const logPaths = /* @__PURE__ */ new Map();
			findSessionLogs(SESSIONS_ROOT, 0, logPaths);
			const ids = new Set(logPaths.keys());
			let records = [];
			if (query) try {
				records = await query.listSessions();
				if (!Array.isArray(records)) records = [];
			} catch (e) {
				store.scanError = "listSessions: " + msgOf(e);
				records = [];
			}
			if ((!Array.isArray(records) || records.length === 0) && persist) try {
				const headers = await persist.list();
				records = Array.isArray(headers) ? headers.map((h) => ({ header: h })) : [];
				if (records.length > 0) store.scanError = null;
			} catch (e) {
				store.scanError = "persistence.list: " + msgOf(e);
			}
			const idOf = (rec) => {
				if (!rec) return void 0;
				if (rec.header && typeof rec.header.id === "string") return rec.header.id;
				if (typeof rec.id === "string") return rec.id;
			};
			for (const rec of records) {
				const id = idOf(rec);
				if (id) ids.add(id);
			}
			const idList = [...ids];
			let i = 0;
			async function worker() {
				while (i < idList.length) {
					const id = idList[i];
					i += 1;
					try {
						const rawPath = logPaths.get(id);
						if (rawPath) try {
							foldSessionEvents(id, parseLogLines(await zstdToText(rawPath)));
							store.rawSessions += 1;
							continue;
						} catch (e) {
							store.lastError = "raw " + shortOf(id) + ": " + msgOf(e);
						}
						let events = null;
						if (query) try {
							const snap = await query.readSession(id);
							events = snap && Array.isArray(snap.events) ? snap.events : null;
						} catch (e) {
							store.lastError = "readSession " + shortOf(id) + ": " + msgOf(e);
							events = null;
						}
						if (events === null && persist) try {
							const r = await persist.readFrom(id, 0);
							events = r && Array.isArray(r.events) ? r.events : [];
						} catch (e) {
							store.lastError = "readFrom " + shortOf(id) + ": " + msgOf(e);
							events = null;
						}
						if (events && events.length) {
							foldSessionEvents(id, events);
							store.harnessSessions += 1;
						} else if (events === null) store.failed += 1;
					} catch (e) {
						store.lastError = "session " + shortOf(id) + ": " + msgOf(e);
						store.failed += 1;
					}
				}
			}
			const n = Math.max(1, Math.min(4, idList.length || 1));
			const workers = [];
			for (let k = 0; k < n; k += 1) workers.push(worker());
			await Promise.all(workers.map((w) => w.catch((e) => {
				store.lastError = "worker: " + msgOf(e);
				store.failed += 1;
			})));
		} finally {
			if (store.failed === 0) {
				store.lastError = null;
				store.scanError = null;
			}
			if (initial) store.scanning = false;
			store.running = false;
		}
	}
	ctx.on("session/event", (session, event) => {
		const id = session && typeof session.id === "string" ? session.id : void 0;
		if (!id) return;
		if (!event || typeof event !== "object") return;
		if (event.type === "session/title") {
			noteTitle(id, event.data?.title);
			return;
		}
		if (!usable(event)) return;
		const info = ensureSession(id);
		if (typeof event.seq === "number" && event.seq <= info.maxSeq) {
			store.dedupSkipped += 1;
			return;
		}
		foldUsage(id, event.time, event.data.usage, modelOf(event));
		store.foldedEvents += 1;
		if (typeof event.seq === "number") info.maxSeq = Math.max(info.maxSeq, event.seq);
	});
	scanOnce({ initial: true }).catch((e) => console.error("[usage-dashboard] initial scan failed", e));
	const timer = ctx.get("timer");
	if (timer && typeof timer.interval === "function") timer.interval(() => {
		scanOnce({ initial: false }).catch((e) => console.error("[usage-dashboard] sweep failed", e));
	}, 6e4);
	/** Fill zero buckets for the last `days` local days (oldest → newest). */
	function dailySeries(days) {
		const today = localMidnight(Date.now());
		const out = [];
		for (let i = days - 1; i >= 0; i -= 1) {
			const t = today - i * DAY_MS;
			const agg = store.allDaily.get(t);
			out.push(agg ? {
				t,
				input: agg.input,
				output: agg.output,
				cacheRead: agg.cacheRead,
				cacheWrite: agg.cacheWrite,
				reasoning: agg.reasoning,
				total: agg.total,
				calls: agg.calls
			} : {
				t,
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				reasoning: 0,
				total: 0,
				calls: 0
			});
		}
		return out;
	}
	/** Fill zero buckets for the last `hours` local hours (oldest → newest). */
	function hourlySeries(hours) {
		const now = localHourStart(Date.now());
		const out = [];
		for (let i = hours - 1; i >= 0; i -= 1) {
			const t = now - i * HOUR_MS;
			const agg = store.allHourly.get(t);
			out.push(agg ? {
				t,
				input: agg.input,
				output: agg.output,
				cacheRead: agg.cacheRead,
				cacheWrite: agg.cacheWrite,
				reasoning: agg.reasoning,
				total: agg.total,
				calls: agg.calls
			} : {
				t,
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				reasoning: 0,
				total: 0,
				calls: 0
			});
		}
		return out;
	}
	function usageOf(agg) {
		return {
			input: agg.input,
			output: agg.output,
			cacheRead: agg.cacheRead,
			cacheWrite: agg.cacheWrite,
			reasoning: agg.reasoning,
			total: agg.total,
			calls: agg.calls
		};
	}
	function dashboard(range, hours, top) {
		const days = range === "all" ? 0 : range === "30d" ? 30 : 7;
		const daily = days === 0 ? [...store.allDaily.entries()].sort((a, b) => a[0] - b[0]).map(([t, agg]) => ({
			t,
			...usageOf(agg)
		})) : dailySeries(days);
		const byModel = [...store.byModel.entries()].map(([model, agg]) => ({
			model,
			...usageOf(agg)
		})).sort((a, b) => b.total - a.total);
		const bySession = [...store.sessions.entries()].filter(([, info]) => info.allAgg.calls > 0).map(([id, info]) => ({
			id,
			title: info.title ?? void 0,
			cwd: info.cwd ?? void 0,
			lastAt: info.lastAt || 0,
			...usageOf(info.allAgg)
		})).sort((a, b) => b.total - a.total).slice(0, Math.max(1, Math.min(top, 200)));
		return {
			time: Date.now(),
			scanning: store.scanning,
			scans: store.scans,
			failed: store.failed,
			rawSessions: store.rawSessions,
			harnessSessions: store.harnessSessions,
			foldedEvents: store.foldedEvents,
			dedupSkipped: store.dedupSkipped,
			lastError: store.lastError,
			scanError: store.scanError,
			lastScanAt: store.lastScanAt,
			sessions: store.sessions.size,
			range,
			totals: usageOf(store.allAgg),
			daily,
			hourly: hourlySeries(Math.max(1, Math.min(hours, 168))),
			byModel,
			bySession
		};
	}
	const webServer = ctx.get("webServer");
	if (webServer && typeof webServer.register === "function") ctx.effect(() => webServer.register({
		kind: "exact",
		path: "/usage/api/dashboard",
		handler: async (req, res) => {
			if (!isLoopbackHost(req.headers.host)) {
				writeJson(res, 403, {
					ok: false,
					error: {
						code: "forbidden",
						message: "forbidden"
					}
				});
				return;
			}
			if (req.method !== "GET") {
				writeJson(res, 405, {
					ok: false,
					error: {
						code: "method-error",
						message: "method not allowed"
					}
				});
				return;
			}
			try {
				const q = new URL(req.url ?? "/", "http://dsh.internal").searchParams;
				const range = q.get("range") === "24h" || q.get("range") === "30d" || q.get("range") === "all" ? q.get("range") : "7d";
				const hoursRaw = Number(q.get("hours"));
				const hours = Number.isFinite(hoursRaw) && hoursRaw > 0 ? Math.round(hoursRaw) : 24;
				const topRaw = Number(q.get("top"));
				writeOk(res, dashboard(range, hours, Number.isFinite(topRaw) && topRaw > 0 ? Math.round(topRaw) : 8));
			} catch (error) {
				writeError(res, error);
			}
		}
	}), "dsh-usage-dashboard: /usage/api/dashboard route");
}
//#endregion
export { apply, inject, name };
