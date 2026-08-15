window.__ModuleLoader__.load({
	id: "dsh-usage-dashboard",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		let react = require("react");
		//#region src/client/index.tsx
		/**
		* Client half of dsh-usage-dashboard: the Token-usage dashboard inside the
		* DSH Settings dialog.
		*
		* - Registers a `settings.section` entry (id `usage-dashboard`, order 40) so
		*   the settings shell's left nav lists it and the panel renders this
		*   component when active.
		* - Data comes from the host half via GET /usage/api/dashboard every 4s
		*   while the section is mounted (the settings panel only mounts the active
		*   section, so polling only runs while the dashboard is visible).
		* - Charts are hand-rolled SVG (no chart library dependency): a stacked
		*   daily bar chart (last 7 days), a dual-line hourly chart (last 7/24
		*   hours), model distribution bars, and a session distribution list.
		* - Styling reuses the shell's --dsw-alias-* design tokens, so light/dark
		*   themes and the overall look stay consistent with the app.
		*
		* Plain createElement (no JSX) to keep the bundle trivially safe.
		*/
		/** Services required by this plugin's client half. */
		const inject = ["slots"];
		const DICT = {
			zh: {
				nav: "Token 用量",
				title: "Token 消耗仪表盘",
				subtitle: "全部会话的 token 消耗统计，数据来自本机会话日志（assistant/message usage 事件）",
				total: "总消耗",
				input: "输入",
				output: "输出",
				cacheRead: "缓存读取",
				cacheWrite: "缓存写入",
				reasoning: "推理",
				calls: "调用次数",
				sessions: "会话数",
				share: "占比",
				daily: "近 7 天每日消耗",
				hourly: "逐时消耗",
				hours7: "7 小时",
				hours24: "24 小时",
				byModel: "按模型分布",
				bySession: "按会话分布",
				expand: "展开全部",
				collapse: "收起",
				noTitle: "（无标题）",
				empty: "暂无 Token 消耗记录 —— 完成一次对话后，这里会自动出现统计数据",
				error: "加载失败，请重试",
				retry: "重试",
				scanning: "正在扫描会话日志…",
				refresh: "刷新",
				foot: "数据来源：本机会话日志 · 每 4 秒自动刷新 · 总 = 输入 + 输出 + 缓存读取 + 缓存写入",
				missing: "缺",
				unknown: "未知模型",
				hitRate: "命中率",
				today: "今日",
				models: "个模型"
			},
			en: {
				nav: "Token usage",
				title: "Token usage dashboard",
				subtitle: "Token consumption across all sessions, from this machine's session logs (assistant/message usage events)",
				total: "Total",
				input: "Input",
				output: "Output",
				cacheRead: "Cache read",
				cacheWrite: "Cache write",
				reasoning: "Reasoning",
				calls: "calls",
				sessions: "sessions",
				share: "share",
				daily: "Daily consumption · last 7 days",
				hourly: "Hourly consumption",
				hours7: "7h",
				hours24: "24h",
				byModel: "By model",
				bySession: "By session",
				expand: "Show all",
				collapse: "Collapse",
				noTitle: "(no title)",
				empty: "No token usage recorded yet — stats appear here after your first conversation",
				error: "Failed to load. Retry?",
				retry: "Retry",
				scanning: "Scanning session logs…",
				refresh: "Refresh",
				foot: "Source: local session logs · auto-refresh every 4s · total = input + output + cache read + cache write",
				missing: "missing",
				unknown: "Unknown model",
				hitRate: "hit rate",
				today: "Today",
				models: "models"
			}
		};
		function t(key) {
			const lang = typeof navigator !== "undefined" && typeof navigator.language === "string" ? navigator.language.toLowerCase() : "zh";
			return DICT[lang.startsWith("zh") ? "zh" : "en"][key] ?? key;
		}
		/** Full thousand-separated integer (no abbreviation). */
		const fmtFull = (n) => {
			if (n == null || isNaN(Number(n))) return "--";
			return Math.round(Number(n)).toLocaleString("en-US");
		};
		/** Compact abbreviation for axis labels (12.3k / 4.5m). */
		const fmtCompact = (n) => {
			if (n >= 1e6) {
				const v = n / 1e6;
				return (v >= 100 ? v.toFixed(0) : v.toFixed(1)) + "M";
			}
			if (n >= 1e4) {
				const v = n / 1e3;
				return (v >= 100 ? v.toFixed(0) : v.toFixed(1)) + "k";
			}
			return String(Math.round(n));
		};
		const pct = (part, whole) => {
			if (!whole) return "--";
			return Math.round(part / whole * 1e3) / 10 + "%";
		};
		const dayTotal = (b) => b ? (b.input || 0) + (b.output || 0) + (b.cacheRead || 0) + (b.cacheWrite || 0) : 0;
		/** "M/D" for a day bucket, "M/D HH:00" for an hour bucket. */
		const timeLabel = (t, hourly) => {
			const d = new Date(t);
			const md = d.getMonth() + 1 + "/" + d.getDate();
			if (!hourly) return md;
			return md + " " + String(d.getHours()).padStart(2, "0") + ":00";
		};
		/** "D M/D" for tooltips. */
		const tipLabel = (t, hourly) => {
			const wd = [
				"日",
				"一",
				"二",
				"三",
				"四",
				"五",
				"六"
			][new Date(t).getDay()];
			return timeLabel(t, hourly) + (hourly ? "" : " 周" + wd);
		};
		/** Nice axis maximum: smallest 1/2/5 × 10^n ≥ max. */
		function niceMax(v) {
			if (v <= 0) return 4;
			const exp = Math.pow(10, Math.floor(Math.log10(v)));
			for (const m of [
				1,
				2,
				5,
				10
			]) if (v <= m * exp) return m * exp;
			return 10 * exp;
		}
		/** Short session display name: title → cwd basename → short id. */
		const sessionName = (s) => {
			if (s && typeof s.title === "string" && s.title.trim()) return s.title.trim();
			if (s && typeof s.cwd === "string" && s.cwd) {
				const parts = s.cwd.split(/[\\/]/).filter(Boolean);
				return parts.length ? parts[parts.length - 1] : s.cwd;
			}
			const id = s && s.id ? String(s.id) : "";
			return id.length > 16 ? id.slice(0, 10) + "…" + id.slice(-4) : id || "--";
		};
		const CSS = `
.udb-root{
  --udb-brand:var(--dsw-alias-brand-primary,#4d6bfe);
  --udb-success:var(--dsw-alias-state-success-primary,#30a46c);
  --udb-warn:var(--dsw-alias-state-warning-primary,#f5a524);
  display:flex;flex-direction:column;gap:12px;min-width:0;
  container-type:inline-size
}
.udb-head{display:flex;align-items:flex-start;justify-content:space-between;gap:12px;flex-wrap:wrap}
.udb-head-text{min-width:0}
.udb-title{font-size:16px;font-weight:600;line-height:24px;color:var(--dsw-alias-label-primary,#1c1c1e);
  letter-spacing:-.01em}
.udb-sub{font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary,#6e6e73);margin-top:2px;
  max-width:46em}
.udb-head-right{display:flex;align-items:center;gap:8px;flex:none}
.udb-badge{font-size:11px;line-height:20px;color:var(--udb-brand);
  border:1px solid color-mix(in srgb,var(--udb-brand) 40%,transparent);
  background:color-mix(in srgb,var(--udb-brand) 8%,transparent);
  border-radius:999px;padding:0 10px;white-space:nowrap;cursor:help}
.udb-badge.warn{color:var(--dsw-alias-state-error-primary,#e5484d);
  border-color:color-mix(in srgb,var(--dsw-alias-state-error-primary,#e5484d) 40%,transparent);
  background:color-mix(in srgb,var(--dsw-alias-state-error-primary,#e5484d) 8%,transparent)}
.udb-badge.pulse{animation:udb-pulse 1.8s ease-in-out infinite}
@keyframes udb-pulse{0%,100%{opacity:1}50%{opacity:.45}}
.udb-btn{height:28px;padding:0 12px;border:1px solid var(--dsw-alias-border-l2,rgba(0,0,0,.1));
  border-radius:8px;background:transparent;color:var(--dsw-alias-label-primary,#1c1c1e);
  font-size:12px;font-family:inherit;cursor:pointer;display:inline-flex;align-items:center;gap:4px;
  transition:background .15s ease,border-color .15s ease}
.udb-btn:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(0,0,0,.04))}
.udb-btn:active{background:var(--dsw-alias-interactive-bg-active,rgba(0,0,0,.08))}
.udb-btn:disabled{opacity:.5;cursor:default}
.udb-btn:focus-visible,.udb-link:focus-visible,.udb-seg button:focus-visible{
  outline:2px solid color-mix(in srgb,var(--udb-brand) 55%,transparent);outline-offset:2px}
.udb-metrics{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px}
@container (min-width:560px){.udb-metrics{grid-template-columns:repeat(4,minmax(0,1fr))}}
@container (max-width:380px){.udb-metrics{grid-template-columns:1fr}}
@media (max-width:420px){.udb-metrics{grid-template-columns:1fr}}
.udb-metric{background:var(--dsw-alias-bg-layer-1,#f6f6f7);border:1px solid var(--dsw-alias-border-l1,rgba(0,0,0,.06));
  border-radius:12px;padding:14px 16px;min-width:0;display:flex;flex-direction:column}
.udb-metric-total{background:color-mix(in srgb,var(--udb-brand) 6%,var(--dsw-alias-bg-layer-1,#f6f6f7));
  border-color:color-mix(in srgb,var(--udb-brand) 22%,transparent)}
.udb-metric-label{font-size:12px;color:var(--dsw-alias-label-secondary,#6e6e73);display:flex;
  align-items:center;gap:6px;white-space:nowrap}
.udb-dot{width:8px;height:8px;border-radius:50%;flex:none}
.udb-metric-value{font-size:22px;font-weight:600;line-height:1.25;margin-top:3px;
  color:var(--dsw-alias-label-primary,#1c1c1e);font-variant-numeric:tabular-nums;white-space:nowrap;
  overflow:hidden;text-overflow:ellipsis;letter-spacing:-.01em}
.udb-metric-sub{font-size:11px;line-height:16px;color:var(--dsw-alias-label-secondary,#6e6e73);margin-top:3px;
  font-variant-numeric:tabular-nums;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
@container (max-width:300px){.udb-metric-sub{white-space:normal;overflow:visible}}
.udb-card{background:var(--dsw-alias-bg-layer-1,#f6f6f7);border:1px solid var(--dsw-alias-border-l1,rgba(0,0,0,.06));
  border-radius:12px;padding:16px;min-width:0}
.udb-card-head{display:flex;align-items:center;justify-content:space-between;gap:8px;margin-bottom:12px;flex-wrap:wrap}
.udb-card-title{font-size:13px;font-weight:600;color:var(--dsw-alias-label-primary,#1c1c1e);
  display:flex;align-items:center;gap:7px;letter-spacing:-.01em}
.udb-card-title::before{content:"";width:3px;height:12px;border-radius:2px;flex:none;
  background:var(--udb-brand);opacity:.7}
.udb-card-note{font-size:11px;color:var(--dsw-alias-label-secondary,#6e6e73);font-variant-numeric:tabular-nums}
.udb-seg{display:inline-flex;padding:2px;background:var(--dsw-alias-bg-layer-2,#fff);
  border:1px solid var(--dsw-alias-border-l1,rgba(0,0,0,.08));border-radius:8px}
.udb-seg button{background:transparent;border:none;padding:3px 10px;border-radius:6px;font-size:11px;
  color:var(--dsw-alias-label-secondary,#6e6e73);cursor:pointer;font-family:inherit;transition:all .15s ease}
.udb-seg button:hover:not(.on){background:var(--dsw-alias-interactive-bg-hover,rgba(0,0,0,.04))}
.udb-seg button.on{background:var(--dsw-alias-bg-overlay,#fff);color:var(--dsw-alias-label-primary,#1c1c1e);
  font-weight:600;box-shadow:0 1px 3px rgba(0,0,0,.12)}
.udb-chart-wrap{position:relative;width:100%}
.udb-svg{display:block;width:100%;height:auto}
.udb-grid{stroke:var(--dsw-alias-border-l1,rgba(0,0,0,.1));stroke-dasharray:3 4;shape-rendering:crispEdges}
.udb-axis{font-size:10px;fill:var(--dsw-alias-label-tertiary,#8e8e93);font-variant-numeric:tabular-nums}
.udb-bar-in{fill:var(--udb-brand)}
.udb-bar-out{fill:var(--udb-success)}
.udb-bar-cache{fill:var(--udb-warn)}
.udb-line-in{stroke:var(--udb-brand);fill:none;stroke-width:2;stroke-linejoin:round;stroke-linecap:round}
.udb-line-out{stroke:var(--udb-success);fill:none;stroke-width:2;stroke-linejoin:round;stroke-linecap:round}
.udb-pt-in{fill:var(--udb-brand)}
.udb-pt-out{fill:var(--udb-success)}
.udb-tip{position:absolute;pointer-events:none;background:var(--dsw-alias-bg-overlay,#fff);
  border:1px solid var(--dsw-alias-border-l1,rgba(0,0,0,.12));border-radius:8px;padding:7px 9px;
  font-size:11px;color:var(--dsw-alias-label-primary,#1c1c1e);box-shadow:0 6px 18px rgba(0,0,0,.14);
  z-index:10;white-space:nowrap;transform:translate(-50%,-110%);line-height:1.5}
.udb-tip b{font-variant-numeric:tabular-nums}
.udb-legend{display:flex;gap:14px;flex-wrap:wrap;font-size:11px;color:var(--dsw-alias-label-secondary,#6e6e73);
  margin-top:10px}
.udb-legend span{display:inline-flex;align-items:center;gap:5px}
.udb-model-row{display:flex;align-items:center;gap:10px;padding:5px 0;min-width:0}
.udb-model-name{width:132px;flex:none;font-size:12px;color:var(--dsw-alias-label-primary,#1c1c1e);
  white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.udb-model-track{flex:1;min-width:40px;height:8px;background:var(--dsw-alias-bg-layer-2,#fff);
  border-radius:999px;overflow:hidden;border:1px solid var(--dsw-alias-border-l1,rgba(0,0,0,.06))}
.udb-model-fill{height:100%;border-radius:999px;min-width:2px}
.udb-model-val{width:110px;flex:none;text-align:right;font-size:12px;font-variant-numeric:tabular-nums;
  color:var(--dsw-alias-label-primary,#1c1c1e);white-space:nowrap}
.udb-model-pct{width:52px;flex:none;text-align:right;font-size:11px;color:var(--dsw-alias-label-secondary,#6e6e73);
  font-variant-numeric:tabular-nums;white-space:nowrap}
.udb-sess-row{display:flex;align-items:center;gap:10px;padding:7px 0;min-width:0;
  border-bottom:1px solid var(--dsw-alias-border-l1,rgba(0,0,0,.05))}
.udb-sess-row:last-child{border-bottom:none}
.udb-sess-idx{width:24px;flex:none;font-size:11px;color:var(--dsw-alias-label-tertiary,#8e8e93);
  font-variant-numeric:tabular-nums}
.udb-sess-name{flex:1;min-width:0;font-size:12px;color:var(--dsw-alias-label-primary,#1c1c1e);
  white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.udb-sess-meta{font-size:11px;color:var(--dsw-alias-label-secondary,#6e6e73);font-variant-numeric:tabular-nums;
  flex:none}
.udb-sess-val{width:96px;flex:none;text-align:right;font-size:12px;font-variant-numeric:tabular-nums;
  color:var(--dsw-alias-label-primary,#1c1c1e);white-space:nowrap}
.udb-sess-pct{width:46px;flex:none;text-align:right;font-size:11px;color:var(--dsw-alias-label-secondary,#6e6e73);
  font-variant-numeric:tabular-nums}
/* very narrow container (phone-width shell dialog): stack distribution rows */
@container (max-width:340px){
  .udb-model-row{flex-wrap:wrap;gap:4px 8px;padding:6px 0}
  .udb-model-name{width:100%}
  .udb-model-track{flex:1 1 60px}
  .udb-model-val{width:auto;text-align:left}
  .udb-model-pct{display:none}
  .udb-sess-val{width:auto;max-width:84px}
  .udb-sess-pct{display:none}
  .udb-sess-meta{max-width:96px;overflow:hidden;text-overflow:ellipsis}
}
.udb-empty{padding:30px 16px;text-align:center;font-size:12px;color:var(--dsw-alias-label-secondary,#6e6e73);
  display:flex;align-items:center;justify-content:center;gap:8px}
.udb-empty-card{border-style:dashed;background:transparent}
.udb-empty-dot{width:8px;height:8px;border-radius:50%;flex:none;background:var(--udb-brand);
  animation:udb-pulse 1.4s ease-in-out infinite}
.udb-err{padding:20px 16px;text-align:center;font-size:12px;color:var(--dsw-alias-state-error-primary,#e5484d);
  display:flex;flex-direction:column;align-items:center;gap:10px}
.udb-foot{font-size:11px;color:var(--dsw-alias-label-secondary,#6e6e73);line-height:16px}
.udb-link{color:var(--udb-brand);cursor:pointer;background:none;border:none;
  font-size:11px;font-family:inherit;padding:0;transition:opacity .15s ease}
.udb-link:hover{opacity:.75;text-decoration:underline}
@media (prefers-reduced-motion:reduce){
  .udb-badge.pulse,.udb-empty-dot{animation:none}
  .udb-btn,.udb-seg button,.udb-link{transition:none}
}
`;
		function MetricCard(props) {
			const len = props.value.length;
			const vfs = len > 12 ? 15 : len > 9 ? 18 : 22;
			return (0, react.createElement)("div", { className: "udb-metric" + (props.total ? " udb-metric-total" : "") }, (0, react.createElement)("div", { className: "udb-metric-label" }, (0, react.createElement)("span", {
				className: "udb-dot",
				style: { background: props.color }
			}), props.label), (0, react.createElement)("div", {
				className: "udb-metric-value",
				style: { fontSize: vfs + "px" },
				title: props.value
			}, props.value), (0, react.createElement)("div", { className: "udb-metric-sub" }, props.sub));
		}
		/**
		* Stacked daily bar chart (SVG). Bars stack input + output + cacheRead
		* (+ cacheWrite on top in a muted tone). Hover shows a tooltip.
		*/
		function DailyChart(props) {
			const { data } = props;
			const W = 560;
			const H = 190;
			const PL = 46;
			const PT = 10;
			const plotW = 506;
			const plotH = 158;
			const [tip, setTip] = (0, react.useState)(null);
			const wrapRef = (0, react.useRef)(null);
			const max = niceMax(Math.max(1, ...data.map(dayTotal)));
			const bw = plotW / data.length;
			const barW = Math.max(8, Math.min(30, bw * .62));
			const gridYs = [
				0,
				.25,
				.5,
				.75,
				1
			].map((f) => PT + plotH * f);
			const gridVals = [
				1,
				.75,
				.5,
				.25,
				0
			].map((f) => max * f);
			const onMove = (e) => {
				const rect = e.currentTarget.getBoundingClientRect();
				if (!rect.width) return;
				const x = (e.clientX - rect.left) / rect.width * W;
				const i = Math.min(data.length - 1, Math.max(0, Math.floor((x - PL) / bw)));
				const b = data[i];
				if (!b) return;
				const cx = PL + i * bw + bw / 2;
				setTip({
					i,
					x: cx,
					y: Math.min(168 - dayTotal(b) / max * plotH, 160)
				});
			};
			return (0, react.createElement)("div", {
				className: "udb-chart-wrap",
				ref: wrapRef
			}, (0, react.createElement)("svg", {
				className: "udb-svg",
				viewBox: `0 0 ${W} ${H}`,
				onMouseMove: onMove,
				onMouseLeave: () => setTip(null)
			}, gridYs.map((gy, gi) => (0, react.createElement)("g", { key: "g" + gi }, (0, react.createElement)("line", {
				className: "udb-grid",
				x1: PL,
				y1: gy,
				x2: 552,
				y2: gy
			}), (0, react.createElement)("text", {
				className: "udb-axis",
				x: 41,
				y: gy + 3,
				textAnchor: "end"
			}, fmtCompact(gridVals[gi])))), data.map((b, i) => {
				const x = PL + i * bw + (bw - barW) / 2;
				const input = b.input || 0;
				const output = b.output || 0;
				const cache = (b.cacheRead || 0) + (b.cacheWrite || 0);
				if (input + output + cache <= 0) return (0, react.createElement)("g", { key: "b" + i }, (0, react.createElement)("rect", {
					x,
					y: 166.5,
					width: barW,
					height: 1.5,
					fill: "var(--dsw-alias-border-l1,rgba(0,0,0,.12))",
					rx: 1
				}));
				let y = 168;
				const segs = [];
				const push = (h, cls, k) => {
					if (h <= 0) return;
					y -= h;
					segs.push((0, react.createElement)("rect", {
						key: k,
						x,
						y,
						width: barW,
						height: h,
						className: cls,
						rx: 1.5
					}));
				};
				push(cache / max * plotH, "udb-bar-cache", "c");
				push(output / max * plotH, "udb-bar-out", "o");
				push(input / max * plotH, "udb-bar-in", "i");
				return (0, react.createElement)("g", { key: "b" + i }, segs, (0, react.createElement)("text", {
					className: "udb-axis",
					x: x + barW / 2,
					y: 183,
					textAnchor: "middle"
				}, timeLabel(b.t, false)));
			})), tip && data[tip.i] && (0, react.createElement)("div", {
				className: "udb-tip",
				style: {
					left: tip.x + "px",
					top: tip.y - 4 + "px"
				}
			}, (0, react.createElement)("div", null, tipLabel(data[tip.i].t, false)), (0, react.createElement)("div", null, "总 ", (0, react.createElement)("b", null, fmtFull(dayTotal(data[tip.i]))), " tokens"), (0, react.createElement)("div", null, "输入 ", (0, react.createElement)("b", null, fmtFull(data[tip.i].input || 0)), " · 输出 ", (0, react.createElement)("b", null, fmtFull(data[tip.i].output || 0))), (0, react.createElement)("div", null, "缓存 ", (0, react.createElement)("b", null, fmtFull((data[tip.i].cacheRead || 0) + (data[tip.i].cacheWrite || 0))), " · 调用 ", (0, react.createElement)("b", null, fmtFull(data[tip.i].calls || 0)))));
		}
		/**
		* Dual-line hourly chart (SVG). Input and output lines; a 7h/24h seg
		* controls the window. Hover shows a tooltip.
		*/
		function HourlyChart(props) {
			const { data } = props;
			const [hours, setHours] = (0, react.useState)(24);
			const window = hours === 7 ? data.slice(-7) : data.slice(-24);
			const W = 560;
			const H = 190;
			const PL = 46;
			const PT = 10;
			const plotW = 506;
			const plotH = 158;
			const [tip, setTip] = (0, react.useState)(null);
			const maxV = niceMax(Math.max(1, ...window.map((b) => Math.max(b.input || 0, b.output || 0))));
			const step = plotW / Math.max(1, window.length - 1);
			const yOf = (v) => 168 - v / maxV * plotH;
			const px = (i) => PL + i * step;
			const linePath = (key) => window.map((b, i) => (i === 0 ? "M" : "L") + px(i).toFixed(1) + "," + yOf(b[key] || 0).toFixed(1)).join(" ");
			const gridYs = [
				0,
				.25,
				.5,
				.75,
				1
			].map((f) => PT + plotH * f);
			const gridVals = [
				1,
				.75,
				.5,
				.25,
				0
			].map((f) => maxV * f);
			const onMove = (e) => {
				const rect = e.currentTarget.getBoundingClientRect();
				if (!rect.width) return;
				const x = (e.clientX - rect.left) / rect.width * W;
				const i = Math.min(window.length - 1, Math.max(0, Math.round((x - PL) / step)));
				const b = window[i];
				if (!b) return;
				const cx = px(i);
				setTip({
					i,
					x: cx,
					y: Math.min(yOf(Math.max(b.input || 0, b.output || 0)), 160)
				});
			};
			return (0, react.createElement)("div", { className: "udb-chart-wrap" }, (0, react.createElement)("svg", {
				className: "udb-svg",
				viewBox: `0 0 ${W} ${H}`,
				onMouseMove: onMove,
				onMouseLeave: () => setTip(null)
			}, gridYs.map((gy, gi) => (0, react.createElement)("g", { key: "g" + gi }, (0, react.createElement)("line", {
				className: "udb-grid",
				x1: PL,
				y1: gy,
				x2: 552,
				y2: gy
			}), (0, react.createElement)("text", {
				className: "udb-axis",
				x: 41,
				y: gy + 3,
				textAnchor: "end"
			}, fmtCompact(gridVals[gi])))), (0, react.createElement)("path", {
				className: "udb-line-in",
				d: linePath("input")
			}), (0, react.createElement)("path", {
				className: "udb-line-out",
				d: linePath("output")
			}), window.map((b, i) => {
				const inV = b.input || 0;
				const outV = b.output || 0;
				return (0, react.createElement)("g", { key: "p" + i }, inV > 0 && (0, react.createElement)("circle", {
					className: "udb-pt-in",
					cx: px(i),
					cy: yOf(inV),
					r: 2.6
				}), outV > 0 && (0, react.createElement)("circle", {
					className: "udb-pt-out",
					cx: px(i),
					cy: yOf(outV),
					r: 2.6
				}), i === 0 || i === window.length - 1 || hours === 24 && i % 3 === 0 || hours === 7 && i % 2 === 0 ? (0, react.createElement)("text", {
					className: "udb-axis",
					x: px(i),
					y: 183,
					textAnchor: "middle"
				}, timeLabel(b.t, true)) : null);
			})), tip && window[tip.i] && (0, react.createElement)("div", {
				className: "udb-tip",
				style: {
					left: tip.x + "px",
					top: tip.y - 4 + "px"
				}
			}, (0, react.createElement)("div", null, tipLabel(window[tip.i].t, true)), (0, react.createElement)("div", null, "输入 ", (0, react.createElement)("b", null, fmtFull(window[tip.i].input || 0))), (0, react.createElement)("div", null, "输出 ", (0, react.createElement)("b", null, fmtFull(window[tip.i].output || 0))), (0, react.createElement)("div", null, "缓存 ", (0, react.createElement)("b", null, fmtFull((window[tip.i].cacheRead || 0) + (window[tip.i].cacheWrite || 0))), " · 调用 ", (0, react.createElement)("b", null, fmtFull(window[tip.i].calls || 0)))));
		}
		/** Horizontal distribution bars (models or sessions). */
		function DistBars(props) {
			const { rows, total, colorOf, nameOf, valueOf, subOf } = props;
			if (!rows.length) return (0, react.createElement)("div", { className: "udb-empty" }, t("empty"));
			return (0, react.createElement)("div", null, rows.map((r, i) => {
				const v = valueOf(r);
				const w = total > 0 ? Math.max(2, v / total * 100) : 0;
				return (0, react.createElement)("div", {
					className: "udb-model-row",
					key: "r" + i
				}, (0, react.createElement)("div", {
					className: "udb-model-name",
					title: nameOf(r)
				}, nameOf(r)), (0, react.createElement)("div", { className: "udb-model-track" }, (0, react.createElement)("div", {
					className: "udb-model-fill",
					style: {
						width: w + "%",
						background: colorOf(i)
					}
				})), (0, react.createElement)("div", { className: "udb-model-val" }, fmtFull(v)), (0, react.createElement)("div", { className: "udb-model-pct" }, pct(v, total)));
			}));
		}
		function DashboardSection() {
			const [data, setData] = (0, react.useState)(null);
			const [err, setErr] = (0, react.useState)(null);
			const [showAll, setShowAll] = (0, react.useState)(false);
			const [reloadTick, setReloadTick] = (0, react.useState)(0);
			const [hours, setHours] = (0, react.useState)(24);
			(0, react.useEffect)(() => {
				let live = true;
				setErr(null);
				const load = async () => {
					let parsed = null;
					try {
						parsed = await (await fetch("/usage/api/dashboard?range=7d&hours=" + hours + "&top=" + (showAll ? 200 : 8), { method: "GET" })).json().catch(() => null);
					} catch (e) {
						parsed = null;
					}
					if (!live) return;
					if (parsed && parsed.ok === true && parsed.value) {
						setData(parsed.value);
						setErr(null);
					} else setErr(String(parsed?.error?.message ?? "network error"));
				};
				load();
				const timerId = window.setInterval(load, 4e3);
				return () => {
					live = false;
					window.clearInterval(timerId);
				};
			}, [
				hours,
				showAll,
				reloadTick
			]);
			const totals = data?.totals;
			const total = totals ? dayTotal(totals) : 0;
			const calls = totals ? totals.calls || 0 : 0;
			const scanning = !!data?.scanning;
			const hasData = total > 0 || calls > 0;
			const hitDenom = totals ? (totals.input || 0) + (totals.cacheRead || 0) + (totals.cacheWrite || 0) : 0;
			const hitRate = hitDenom > 0 ? Math.round((totals.cacheRead || 0) / hitDenom * 1e3) / 10 : null;
			const modelRows = (0, react.useMemo)(() => {
				const byModel = data?.byModel || [];
				if (!byModel.length) return [];
				const top = byModel.slice(0, 6);
				const rest = byModel.slice(6);
				const restTotal = rest.reduce((s, m) => s + (m.total || 0), 0);
				if (restTotal > 0) top.push({
					model: t("unknown") + " (" + rest.length + ")",
					input: 0,
					output: 0,
					total: restTotal,
					calls: 0
				});
				return top;
			}, [data]);
			(data?.bySession || []).slice(0, showAll ? 200 : 8).length;
			const palette = [
				"var(--dsw-alias-brand-primary,#4d6bfe)",
				"color-mix(in srgb,var(--dsw-alias-brand-primary,#4d6bfe) 78%,transparent)",
				"color-mix(in srgb,var(--dsw-alias-brand-primary,#4d6bfe) 58%,transparent)",
				"color-mix(in srgb,var(--dsw-alias-brand-primary,#4d6bfe) 40%,transparent)",
				"color-mix(in srgb,var(--dsw-alias-brand-primary,#4d6bfe) 26%,transparent)",
				"color-mix(in srgb,var(--dsw-alias-brand-primary,#4d6bfe) 16%,transparent)",
				"color-mix(in srgb,var(--dsw-alias-brand-primary,#4d6bfe) 10%,transparent)"
			];
			const headRight = (0, react.createElement)("div", { className: "udb-head-right" }, scanning ? (0, react.createElement)("span", {
				className: "udb-badge pulse",
				title: "lastScanAt=" + (data?.lastScanAt ?? "")
			}, t("scanning")) : null, data && (data.failed > 0 || data.scanError) ? (0, react.createElement)("span", {
				className: "udb-badge warn",
				title: String(data.lastError || data.scanError || "")
			}, t("missing") + " " + (data.failed || 1) + " " + t("sessions")) : null, (0, react.createElement)("button", {
				type: "button",
				className: "udb-btn",
				onClick: () => setReloadTick((x) => x + 1)
			}, t("refresh")));
			if (err !== null) return (0, react.createElement)("div", { className: "udb-root" }, (0, react.createElement)("div", { className: "udb-head" }, (0, react.createElement)("div", { className: "udb-head-text" }, (0, react.createElement)("div", { className: "udb-title" }, t("title")), (0, react.createElement)("div", { className: "udb-sub" }, t("subtitle"))), headRight), (0, react.createElement)("div", { className: "udb-card" }, (0, react.createElement)("div", { className: "udb-err" }, (0, react.createElement)("span", null, t("error") + (err ? " (" + err + ")" : "")), (0, react.createElement)("button", {
				type: "button",
				className: "udb-btn",
				onClick: () => setReloadTick((x) => x + 1)
			}, t("retry")))));
			return (0, react.createElement)("div", { className: "udb-root" }, (0, react.createElement)("div", { className: "udb-head" }, (0, react.createElement)("div", { className: "udb-head-text" }, (0, react.createElement)("div", { className: "udb-title" }, t("title")), (0, react.createElement)("div", { className: "udb-sub" }, t("subtitle"))), headRight), (0, react.createElement)("div", { className: "udb-metrics" }, (0, react.createElement)(MetricCard, {
				label: t("total"),
				color: "var(--dsw-alias-brand-primary,#4d6bfe)",
				value: fmtFull(total),
				sub: t("calls") + " " + fmtFull(calls) + " · " + t("sessions") + " " + fmtFull(data?.sessions ?? 0),
				total: true
			}), (0, react.createElement)(MetricCard, {
				label: t("input"),
				color: "var(--dsw-alias-brand-primary,#4d6bfe)",
				value: fmtFull(totals?.input ?? 0),
				sub: pct(totals?.input ?? 0, total) + " · " + t("cacheWrite") + " " + fmtFull(totals?.cacheWrite ?? 0)
			}), (0, react.createElement)(MetricCard, {
				label: t("output"),
				color: "var(--dsw-alias-state-success-primary,#30a46c)",
				value: fmtFull(totals?.output ?? 0),
				sub: pct(totals?.output ?? 0, total) + " · " + t("reasoning") + " " + fmtFull(totals?.reasoning ?? 0)
			}), (0, react.createElement)(MetricCard, {
				label: t("cacheRead"),
				color: "var(--dsw-alias-state-warning-primary,#f5a524)",
				value: fmtFull(totals?.cacheRead ?? 0),
				sub: t("hitRate") + " " + (hitRate === null ? "--" : hitRate + "%")
			})), !hasData ? (0, react.createElement)("div", { className: "udb-card udb-empty-card" }, (0, react.createElement)("div", { className: "udb-empty" }, scanning ? (0, react.createElement)("span", { className: "udb-empty-dot" }) : null, (0, react.createElement)("span", null, scanning ? t("scanning") + "…" : t("empty")))) : null, hasData ? (0, react.createElement)("div", { className: "udb-card" }, (0, react.createElement)("div", { className: "udb-card-head" }, (0, react.createElement)("div", { className: "udb-card-title" }, t("daily")), (0, react.createElement)("div", { className: "udb-card-note" }, fmtFull((data?.daily || []).reduce((s, b) => s + dayTotal(b), 0)) + " tokens")), (0, react.createElement)(DailyChart, { data: data?.daily || [] }), (0, react.createElement)("div", { className: "udb-legend" }, (0, react.createElement)("span", null, (0, react.createElement)("span", {
				className: "udb-dot",
				style: { background: "var(--dsw-alias-brand-primary,#4d6bfe)" }
			}), t("input")), (0, react.createElement)("span", null, (0, react.createElement)("span", {
				className: "udb-dot",
				style: { background: "var(--dsw-alias-state-success-primary,#30a46c)" }
			}), t("output")), (0, react.createElement)("span", null, (0, react.createElement)("span", {
				className: "udb-dot",
				style: { background: "var(--dsw-alias-state-warning-primary,#f5a524)" }
			}), t("cacheRead")))) : null, hasData ? (0, react.createElement)("div", { className: "udb-card" }, (0, react.createElement)("div", { className: "udb-card-head" }, (0, react.createElement)("div", { className: "udb-card-title" }, t("hourly")), (0, react.createElement)("div", { className: "udb-seg" }, (0, react.createElement)("button", {
				type: "button",
				className: hours === 7 ? "on" : "",
				"aria-pressed": hours === 7,
				onClick: () => setHours(7)
			}, t("hours7")), (0, react.createElement)("button", {
				type: "button",
				className: hours === 24 ? "on" : "",
				"aria-pressed": hours === 24,
				onClick: () => setHours(24)
			}, t("hours24")))), (0, react.createElement)(HourlyChart, { data: data?.hourly || [] }), (0, react.createElement)("div", { className: "udb-legend" }, (0, react.createElement)("span", null, (0, react.createElement)("span", {
				className: "udb-dot",
				style: { background: "var(--dsw-alias-brand-primary,#4d6bfe)" }
			}), t("input")), (0, react.createElement)("span", null, (0, react.createElement)("span", {
				className: "udb-dot",
				style: { background: "var(--dsw-alias-state-success-primary,#30a46c)" }
			}), t("output")))) : null, hasData ? (0, react.createElement)("div", { className: "udb-card" }, (0, react.createElement)("div", { className: "udb-card-head" }, (0, react.createElement)("div", { className: "udb-card-title" }, t("byModel")), (0, react.createElement)("div", { className: "udb-card-note" }, fmtFull((data?.byModel || []).length) + " " + t("models") + " · " + fmtFull(total) + " tokens")), (0, react.createElement)(DistBars, {
				rows: modelRows,
				total,
				colorOf: (i) => palette[i % palette.length],
				nameOf: (r) => r.model,
				valueOf: (r) => r.total || 0,
				subOf: () => ""
			})) : null, hasData ? (0, react.createElement)("div", { className: "udb-card" }, (0, react.createElement)("div", { className: "udb-card-head" }, (0, react.createElement)("div", { className: "udb-card-title" }, t("bySession")), (0, react.createElement)("div", { className: "udb-card-note" }, (data?.sessions ?? 0) > 8 ? (0, react.createElement)("button", {
				type: "button",
				className: "udb-link",
				onClick: () => setShowAll((v) => !v)
			}, showAll ? t("collapse") : t("expand") + " (" + fmtFull(data?.sessions ?? 0) + ")") : null)), (0, react.createElement)("div", null, (data?.bySession || []).slice(0, showAll ? 200 : 8).map((s, i) => (0, react.createElement)("div", {
				className: "udb-sess-row",
				key: s.id || i
			}, (0, react.createElement)("span", { className: "udb-sess-idx" }, String(i + 1)), (0, react.createElement)("span", {
				className: "udb-sess-name",
				title: s.title || s.cwd || s.id
			}, sessionName(s)), (0, react.createElement)("span", { className: "udb-sess-meta" }, fmtFull(s.calls || 0) + " " + t("calls")), (0, react.createElement)("span", { className: "udb-sess-val" }, fmtFull(s.total || 0)), (0, react.createElement)("span", { className: "udb-sess-pct" }, pct(s.total || 0, total)))))) : null, (0, react.createElement)("div", { className: "udb-foot" }, t("foot")));
		}
		function apply(ctx) {
			ctx.effect(() => {
				if (typeof document === "undefined") return;
				const tag = document.createElement("style");
				tag.setAttribute("data-plugin", "dsh-usage-dashboard");
				tag.setAttribute("data-plugin-css", "dsh-usage-dashboard/widget");
				tag.textContent = CSS;
				document.head.appendChild(tag);
				return () => {
					try {
						tag.remove();
					} catch (_) {}
				};
			}, "dsh-usage-dashboard: styles");
			const slots = ctx.get("slots");
			if (slots === void 0 || typeof slots.inject !== "function") return;
			slots.inject("settings.section", () => slots.register({
				name: "settings.section",
				id: "usage-dashboard",
				order: 40,
				label: () => t("nav")
			}, (props) => (0, react.createElement)(DashboardSection, {})));
		}
		//#endregion
		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	}
});

//# sourceMappingURL=client.js.map