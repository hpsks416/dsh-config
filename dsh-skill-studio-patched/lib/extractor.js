/**
 * dsh-skill-studio — skill extraction core (merged from dsh-skill-extractor).
 *
 * Pure, no DSH-runtime dependency. Handles: extractor config store, session-log
 * scanning/digesting, LLM candidate extraction, the candidate queue, dedup, and
 * writing SKILL.md into the Obsidian personal skill library (2️⃣ AI/Skill/).
 */
import { readdir, readFile, writeFile, mkdir, stat, rename } from "node:fs/promises";
import { homedir } from "node:os";
import { join, basename, dirname } from "node:path";
import { zstdDecompressSync } from "node:zlib";

export const DEFAULT_CONFIG_FILE = join(homedir(), ".dsh", "dsh-skill-studio", "extractor.json");
export const DEFAULT_CANDIDATE_FILE = join(homedir(), ".dsh", "dsh-skill-studio", "candidates.json");
export const DEFAULT_SESSIONS_ROOT = join(homedir(), ".dsh", "sessions");
/**
 * Resolve the per-user agent skill root that DSH's model-facing registry auto-loads.
 * Honours DSH_AGENTS_HOME (when configured); defaults to ~/.agents/skills.
 * Never baked to a single user's path — portability across machines/users.
 */
export function defaultAgentSkillDir() {
	const agentsHome = process.env.DSH_AGENTS_HOME;
	return agentsHome ? join(agentsHome, "skills") : join(homedir(), ".agents", "skills");
}

/**
 * Extra per-user skill directories the panel should also scan on top of the
 * standard roots — currently the user-configured mirror dir (e.g. Obsidian).
 * Resolved from the extractor config, never baked to one user's path.
 */
export async function configuredExtraSkillDirs() {
	try {
		const cfg = await new ExtractorStore().load();
		return cfg.mirrorDir ? [cfg.mirrorDir] : [];
	} catch {
		return [];
	}
}

function configPath() {
	const o = process.env.DSH_SKILL_EXTRACTOR_CONFIG;
	return o !== void 0 && o !== "" ? o : DEFAULT_CONFIG_FILE;
}
function candidatePath() {
	const o = process.env.DSH_SKILL_EXTRACTOR_CANDIDATES;
	return o !== void 0 && o !== "" ? o : DEFAULT_CANDIDATE_FILE;
}
function sessionsRoot() {
	const o = process.env.DSH_SKILL_EXTRACTOR_SESSIONS;
	return o !== void 0 && o !== "" ? o : DEFAULT_SESSIONS_ROOT;
}

export function defaults() {
	return {
		enabled: true,
		intervalMinutes: 1440,
		windowDays: 7,
		maxCandidatesPerRun: 3,
		skillLanguage: "zh",
		llmBaseUrl: "",
		llmApiKey: "",
		llmModel: "",
		reasoningEffort: "low",
		agentSkillDir: defaultAgentSkillDir(),
		mirrorDir: "",
		lastRunAt: "",
		lastRunSummary: ""
	};
}

function clampInt(v, min, max) {
	if (typeof v !== "number" || !Number.isFinite(v)) return null;
	return Math.min(max, Math.max(min, Math.floor(v)));
}

export function parse(raw) {
	const r = typeof raw === "object" && raw !== null ? raw : {};
	const num = (v, f, min, max) => clampInt(v, min, max) ?? f;
	const str = (v, f = "") => typeof v === "string" ? v : f;
	const bool = (v, f) => typeof v === "boolean" ? v : f;
	const d = defaults();
	const lang = str(r.skillLanguage, d.skillLanguage).toLowerCase();
	return {
		enabled: bool(r.enabled, d.enabled),
		intervalMinutes: num(r.intervalMinutes, d.intervalMinutes, 0, 10080),
		windowDays: num(r.windowDays, d.windowDays, 1, 365),
		maxCandidatesPerRun: num(r.maxCandidatesPerRun, d.maxCandidatesPerRun, 1, 20),
		skillLanguage: lang === "en" ? "en" : "zh",
		llmBaseUrl: str(r.llmBaseUrl, d.llmBaseUrl),
		llmApiKey: str(r.llmApiKey, d.llmApiKey),
		llmModel: str(r.llmModel, d.llmModel),
		reasoningEffort: str(r.reasoningEffort, d.reasoningEffort),
		agentSkillDir: str(r.agentSkillDir, d.agentSkillDir),
		mirrorDir: str(r.mirrorDir, d.mirrorDir),
		lastRunAt: str(r.lastRunAt, d.lastRunAt),
		lastRunSummary: str(r.lastRunSummary, d.lastRunSummary)
	};
}

/** File-backed extractor config store (mode 0600). */
export class ExtractorStore {
	async load() {
		try {
			return parse(JSON.parse(await readFile(configPath(), "utf8")));
		} catch {
			return defaults();
		}
	}
	async save(cfg) {
		await mkdir(dirname(configPath()), { recursive: true });
		const tmp = configPath() + ".tmp";
		await writeFile(tmp, JSON.stringify(cfg, null, 2), { mode: 0o600 });
		await rename(tmp, configPath());
		return cfg;
	}
	async patch(args) {
		const cur = await this.load();
		const merged = { ...cur };
		if (args !== void 0 && typeof args === "object") {
			for (const k of Object.keys(merged)) {
				if (k in args) merged[k] = args[k];
			}
		}
		const view = parse(merged);
		await this.save(view);
		return view;
	}
	async view() {
		const v = await this.load();
		return {
			...v,
			llmKeyMasked: v.llmApiKey ? v.llmApiKey.slice(0, 2) + "…" + v.llmApiKey.slice(-2) : "",
			llmApiKey: "",
			configured: v.llmBaseUrl !== "" && v.llmApiKey !== "" && v.llmModel !== "",
			configPath: configPath(),
			candidatePath: candidatePath()
		};
	}
}

async function findSessionFiles(root) {
	const out = [];
	async function walk(dir) {
		let entries;
		try {
			entries = await readdir(dir, { withFileTypes: true });
		} catch {
			return;
		}
		for (const e of entries) {
			const p = join(dir, e.name);
			if (e.isDirectory()) await walk(p);
			// Session logs are versioned JSONL + zstd: session.v3.jsonl.zstd
			// (older layouts used session.jsonl.zstd). Match both.
			else if (/^session(?:\.v\d+)?\.jsonl\.zstd$/.test(e.name)) out.push(p);
		}
	}
	await walk(root);
	return out;
}

// Zstandard frame magic (little-endian 0xFD2FB528).
const ZSTD_MAGIC = 4247762216;
/**
 * Locate complete Zstandard frame ranges without decompressing blocks.
 * DSH session logs are multi-frame append logs: every durable event batch is one
 * independently decodable frame, so a single zstdDecompressSync only yields the
 * first frame (the session header). We must split frames and decompress each.
 */
function scanZstdFrames(buffer) {
	const frames = [];
	let offset = 0;
	while (offset < buffer.length) {
		const start = offset;
		if (buffer.length - offset < 4) return { frames, tornStart: start };
		if (buffer.readUInt32LE(offset) !== ZSTD_MAGIC) throw new Error(`corrupt Zstandard session log: invalid frame magic at byte ${offset}`);
		offset += 4;
		if (offset === buffer.length) return { frames, tornStart: start };
		const descriptor = buffer.readUInt8(offset);
		offset += 1;
		if ((descriptor & 24) !== 0) throw new Error(`corrupt Zstandard session log: reserved frame-header bit at byte ${offset - 1}`);
		const contentSizeFlag = descriptor >>> 6;
		const singleSegment = (descriptor & 32) !== 0;
		const checksum = (descriptor & 4) !== 0;
		const dictionaryFlag = descriptor & 3;
		const dictionaryBytes = dictionaryFlag === 3 ? 4 : dictionaryFlag;
		const contentSizeBytes = contentSizeFlag === 0 ? (singleSegment ? 1 : 0) : (1 << contentSizeFlag);
		const remainingHeaderBytes = (singleSegment ? 0 : 1) + dictionaryBytes + contentSizeBytes;
		if (buffer.length - offset < remainingHeaderBytes) return { frames, tornStart: start };
		offset += remainingHeaderBytes;
		for (;;) {
			if (buffer.length - offset < 3) return { frames, tornStart: start };
			const blockHeader = buffer.readUIntLE(offset, 3);
			offset += 3;
			const lastBlock = (blockHeader & 1) !== 0;
			const blockType = (blockHeader >>> 1) & 3;
			const blockSize = blockHeader >>> 3;
			if (blockType === 3) throw new Error(`corrupt Zstandard session log: reserved block type at byte ${offset - 3}`);
			const payloadBytes = blockType === 1 ? 1 : blockSize;
			if (buffer.length - offset < payloadBytes) return { frames, tornStart: start };
			offset += payloadBytes;
			if (lastBlock) break;
		}
		if (checksum) {
			if (buffer.length - offset < 4) return { frames, tornStart: start };
			offset += 4;
		}
		frames.push({ start, end: offset });
	}
	return { frames };
}
/** Decompress a multi-frame session log to its full JSONL plaintext. */
function decompressSessionLog(buffer) {
	const { frames } = scanZstdFrames(buffer);
	let out = "";
	for (const fr of frames) out += zstdDecompressSync(buffer.subarray(fr.start, fr.end)).toString("utf8");
	return out;
}
/** Extract text from a message content array, joining text parts. */
function contentText(content) {
	if (!Array.isArray(content)) return "";
	return content
		.map((c) => (c && c.type === "text" ? c.text : ""))
		.join(" ")
		.trim();
}

async function readSessionLog(file) {
	try {
		const buffer = await readFile(file);
		const plaintext = decompressSessionLog(buffer);
		const session = {};
		const msgs = [];
		let toolCalls = 0;
		let toolResults = 0;
		const seenUser = new Set();
		for (const l of plaintext.split("\n")) {
			if (!l) continue;
			let o;
			try {
				o = JSON.parse(l);
			} catch {
				continue;
			}
			if (o === null || typeof o !== "object") continue;
			if (o.type === "session") {
				session.id = o.id;
				session.createdAt = o.createdAt;
				session.cwd = o.cwd;
			} else if (o.type === "user/message") {
				// Primary user-message event (v3 layout): data.content text parts.
				const text = contentText(o.data && o.data.content);
				if (text) {
					const id = o.data && o.data.id;
					if (id !== void 0) {
						if (seenUser.has(id)) continue;
						seenUser.add(id);
					}
					msgs.push({ role: "user", text });
				}
			} else if (o.type === "assistant/message") {
				// Final assistant text (skip reasoning/tool-call parts, which are internal).
				const msg = o.data && o.data.message;
				const text = contentText(msg && msg.content);
				if (text) msgs.push({ role: "assistant", text });
			} else if (o.type === "agent/inbox/spliced") {
				// Legacy layout fallback: user turns arrive as inbox inserts.
				const ins = o.data && o.data.inserted;
				if (Array.isArray(ins)) {
					for (const item of ins) {
						const role = item && item.role;
						const text = contentText(item && item.content);
						if (text) msgs.push({ role, text });
					}
				}
			} else if (o.type && o.type.startsWith("tool/")) {
				if (o.type === "tool/call") toolCalls++;
				else if (o.type === "tool/result") toolResults++;
			}
		}
		return { session, msgs, toolCalls, toolResults };
	} catch {
		return null;
	}
}

function truncate(s, n) {
	return s.length > n ? s.slice(0, n) + "…" : s;
}

export function buildDigest(log, maxMsgs = 20, maxMsgLen = 200) {
	const { session, msgs, toolCalls, toolResults } = log;
	const at = new Date(session.createdAt || Date.now());
	const title = session.cwd ? basename(session.cwd) : session.id || "unknown";
	const lines = [];
	lines.push(`## 会话「${title}」（${at.toISOString()}）`);
	if (session.cwd) lines.push(`工作区：${session.cwd}`);
	lines.push(`工具调用 ${toolCalls} 次 / 工具结果 ${toolResults} 次`);
	for (const m of msgs.slice(-maxMsgs)) {
		const role = m.role === "user" ? "用户" : "助手";
		lines.push(`- ${role}：${truncate(m.text, maxMsgLen)}`);
	}
	return lines.join("\n");
}

/** Collect recent session digests within `windowDays`, most recent first. */
export async function collectSessionDigests(root, windowDays, maxSessions = 12) {
	const files = await findSessionFiles(root);
	const cutoff = Date.now() - windowDays * 86400000;
	const found = [];
	for (const f of files) {
		let st;
		try {
			st = await stat(f);
		} catch {
			continue;
		}
		if (st.mtimeMs < cutoff) continue;
		const log = await readSessionLog(f);
		if (!log || log.msgs.length === 0) continue;
		found.push({ file: f, mtime: st.mtimeMs, log });
	}
	found.sort((a, b) => b.mtime - a.mtime);
	return found.slice(0, maxSessions);
}

export function buildPrompt(digestTexts, cfg) {
	const body = digestTexts.length ? digestTexts.join("\n\n") : "（没有近期会话）";
	const langLine =
		cfg.skillLanguage === "en"
			? "- 正文（body）用英文写；description 也用英文 Use when... 开头。"
			: "- 正文（body）用中文写；当且仅当正文是英文句子时例外。description 用英文 Use when... 开头（这是 agent 判断何时加载的依据）。";
	return [
		"以下是从 DSH 会话日志里提取的摘要。请从中找出可复用的技术、模式、工作流或参考，把它们写成个人 skill。",
		"",
		"只考虑：跨项目、可复用、agent 以后能反复照做的内容。",
		"不考虑：一次性解决、项目专属约定、已被文档覆盖的标准做法、能用自动化替代的机械约束。",
		"",
		"每个 skill 给出：",
		"- name：kebab-case 英文名",
		"- description：一句话「何时使用」（用 Use when... 开头，不要概括流程）",
		"- rationale：为什么可复用（一句话）",
		"- body：markdown 正文（概述、何时用、核心模式、示例、常见错误），要简洁可复用，不要写成某次解决过程的叙事",
		langLine,
		"",
		`最多 ${cfg.maxCandidatesPerRun} 个。只输出 JSON（不要任何额外文字），格式：`,
		'{"candidates":[{"name":"","description":"","rationale":"","body":""}]}',
		"",
		"会话摘要：",
		body
	].join("\n");
}

export async function callLLM(cfg, prompt, { maxTokens = 16000 } = {}) {
	const base = (cfg.llmBaseUrl || "").replace(/\/+$/, "");
	const body = {
		model: cfg.llmModel,
		messages: [
			{ role: "system", content: "你从会话日志摘要中提取可复用的个人 skill。只输出 JSON。" },
			{ role: "user", content: prompt }
		],
		temperature: 0.2,
		max_tokens: maxTokens,
		response_format: { type: "json_object" }
	};
	// Reasoning models (deepseek-flash/reasoner) spend the max_tokens budget on
	// reasoning_content first; without a low reasoning_effort the final content can
	// come back empty (finish_reason=length). Ask for low effort when the endpoint
	// supports it, and tolerate the field being ignored by non-reasoning models.
	if (cfg.reasoningEffort) {
		body.reasoning_effort = cfg.reasoningEffort;
	}
	const res = await fetch(`${base}/chat/completions`, {
		method: "POST",
		headers: { "content-type": "application/json", authorization: `Bearer ${cfg.llmApiKey}` },
		body: JSON.stringify(body),
		signal: AbortSignal.timeout(120000)
	});
	if (!res.ok) throw new Error("LLM API responded " + res.status);
	const data = await res.json();
	const msg = data && data.choices && data.choices[0] && data.choices[0].message;
	// Prefer final content; fall back to reasoning_content only when content is
	// empty and reasoning contains a JSON block (some reasoning models emit the
	// answer inside reasoning). Never return empty silently.
	const text = (msg && msg.content) || "";
	if (text) return text;
	if (msg && msg.reasoning_content) {
		const m = String(msg.reasoning_content).match(/\{[\s\S]*\}/);
		if (m) return m[0];
	}
	throw new Error("LLM API empty completion (finish_reason=" + (data && data.choices && data.choices[0] && data.choices[0].finish_reason) + ")");
}

export function normalizeName(n) {
	return String(n)
		.trim()
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "");
}

export function parseLlmCandidates(rawText) {
	const text = String(rawText || "").trim();
	let obj = null;
	// 1. Bare parse.
	try {
		obj = JSON.parse(text);
	} catch {
		// 2. Strip markdown fences and surrounding prose.
		const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
		const candidate = fenced ? fenced[1] : text;
		// 3. Scan for the first balanced top-level { ... } block, tracking
		//    string state and escapes so braces inside string values (code
		//    blocks, JSON examples) are not miscounted.
		const brace = extractBalancedJson(candidate);
		if (brace) {
			try {
				obj = JSON.parse(brace);
			} catch {
				// 4. Repair common minor flaws then retry once.
				try {
					obj = JSON.parse(repairJson(brace));
				} catch {
					obj = null;
				}
			}
		}
	}
	if (!obj) throw new Error("LLM response is not parseable JSON");
	const arr = Array.isArray(obj)
		? obj
		: obj && Array.isArray(obj.candidates)
			? obj.candidates
			: [];
	return arr
		.map((c) => ({
			name: normalizeName(String((c && c.name) || "")),
			description: String((c && c.description) || "").trim(),
			rationale: String((c && c.rationale) || "").trim(),
			body: String((c && c.body) || "").trim()
		}))
		.filter((c) => c.name && c.description && c.body);
}

/** Find the first balanced top-level { ... } block, respecting string escapes. */
function extractBalancedJson(text) {
	const start = text.indexOf("{");
	if (start < 0) return null;
	let depth = 0;
	let inString = false;
	let escaped = false;
	for (let i = start; i < text.length; i++) {
		const ch = text[i];
		if (inString) {
			if (escaped) {
				escaped = false;
			} else if (ch === "\\") {
				escaped = true;
			} else if (ch === '"') {
				inString = false;
			}
			continue;
		}
		if (ch === '"') {
			inString = true;
		} else if (ch === "{") {
			depth++;
		} else if (ch === "}") {
			depth--;
			if (depth === 0) return text.slice(start, i + 1);
		}
	}
	return null;
}

/** Repair common minor JSON flaws (trailing commas, unclosed string at EOF). */
function repairJson(text) {
	let s = text.trim();
	// Strip trailing commas before } or ].
	s = s.replace(/,\s*([}\]])/g, "$1");
	// If the last non-whitespace char is a quote with no closing pair, drop it
	// only when the quote count is odd (a lone unterminated trailing quote).
	const quotes = (s.match(/"/g) || []).length;
	if (quotes % 2 === 1 && s.endsWith('"')) {
		s = s.slice(0, -1);
	}
	return s;
}

export async function loadCandidates() {
	try {
		const arr = JSON.parse(await readFile(candidatePath(), "utf8"));
		return Array.isArray(arr) ? arr : [];
	} catch {
		return [];
	}
}

export async function saveCandidates(arr) {
	await mkdir(dirname(candidatePath()), { recursive: true });
	await writeFile(candidatePath(), JSON.stringify(arr, null, 2), { mode: 0o600 });
	return arr;
}

/**
 * Update one pending candidate's draft fields in the queue (by id). Accepts
 * `{ name, description, rationale, body }`; the name is re-normalized to
 * kebab-case. Returns the updated candidate or null when not found.
 */
export async function updateCandidate(id, patch) {
	const queue = await loadCandidates();
	const target = queue.find((c) => c.id === id && c.status === "pending");
	if (!target) return null;
	if (patch && typeof patch.body === "string") target.body = patch.body.trim();
	if (patch && typeof patch.rationale === "string") target.rationale = patch.rationale.trim();
	if (patch && typeof patch.description === "string") target.description = patch.description.trim();
	if (patch && typeof patch.name === "string") {
		const norm = normalizeName(patch.name);
		if (norm) target.name = norm;
	}
	await saveCandidates(queue);
	return target;
}

export async function existingSkillNames(targetDir) {
	try {
		const entries = await readdir(targetDir, { withFileTypes: true });
		const names = [];
		for (const e of entries) {
			if (e.isDirectory()) names.push(e.name);
			else if (e.name.endsWith(".md")) names.push(basename(e.name, ".md"));
		}
		return names;
	} catch {
		return [];
	}
}

export async function writeSkill(targetDir, cand, { force = false } = {}) {
	if (!cand || !cand.name) return { ok: false, message: "candidate 缺少 name" };
	const names = await existingSkillNames(targetDir);
	if (names.includes(cand.name) && !force) {
		return { ok: false, message: `已存在同名 skill ${cand.name}` };
	}
	const dir = join(targetDir, cand.name);
	await mkdir(dir, { recursive: true });
	const frontmatter = `---\nname: ${cand.name}\ndescription: ${cand.description}\n---\n`;
	const body = cand.body.startsWith("#") ? cand.body : `# ${cand.name}\n\n${cand.body}`;
	const file = join(dir, "SKILL.md");
	await writeFile(file, frontmatter + "\n" + body + "\n", { encoding: "utf8" });
	return { ok: true, message: `已写入 ${file}`, path: file };
}

/**
 * Write a candidate skill to the mandatory agent skill root (so DSH's
 * model-facing registry can load it) and, only when `mirrorDir` is set, to the
 * user-defined mirror dir. Each write dedups against its own dir; the result is
 * ok when at least one wrote.
 */
export async function writeSkillDual(agentDir, mirrorDir, cand, { force = false } = {}) {
	const results = [];
	if (agentDir) results.push({ dir: agentDir, ...(await writeSkill(agentDir, cand, { force })) });
	if (mirrorDir) results.push({ dir: mirrorDir, ...(await writeSkill(mirrorDir, cand, { force })) });
	const ok = results.some((r) => r.ok);
	return { ok, written: results.filter((r) => r.ok).map((r) => r.path), results };
}

export function shortenSummary(s) {
	return s.length > 400 ? s.slice(0, 400) + "…" : s;
}

/** Build the full SKILL.md text (frontmatter + body) for a candidate. */
export function assembleCandidateFile(cand) {
	const frontmatter = `---\nname: ${cand.name}\ndescription: ${cand.description}\n---\n`;
	const body = cand.body.startsWith("#") ? cand.body : `# ${cand.name}\n\n${cand.body}`;
	return frontmatter + "\n" + body + "\n";
}

/**
 * Run one extraction pass: scan recent logs, prompt the LLM, stage the fresh
 * candidates into the queue (dedup against existing skills and queued names).
 * Returns a result; caller persists lastRunAt/lastRunSummary.
 */
export async function runExtraction(cfg, root = sessionsRoot(), { now = Date.now() } = {}) {
	if (!cfg.enabled) return { ok: false, message: "提取已禁用" };
	if (!(cfg.llmBaseUrl && cfg.llmApiKey && cfg.llmModel)) {
		return { ok: false, message: "LLM 未配置：请先设置 baseUrl/apiKey/model" };
	}
	const digs = await collectSessionDigests(root, cfg.windowDays);
	if (digs.length === 0) return { ok: true, message: "近期无会话可提取", candidates: [], digests: 0 };
	const digestsText = digs.map((d) => buildDigest(d.log));
	const raw = await callLLM(cfg, buildPrompt(digestsText, cfg));
	const cands = parseLlmCandidates(raw).slice(0, cfg.maxCandidatesPerRun);
	const existing = new Set([
		...(cfg.agentSkillDir ? await existingSkillNames(cfg.agentSkillDir) : []),
		...(cfg.mirrorDir ? await existingSkillNames(cfg.mirrorDir) : [])
	]);
	const queue = await loadCandidates();
	const queuedNames = new Set(queue.map((c) => c.name));
	const fresh = cands.filter((c) => !existing.has(c.name) && !queuedNames.has(c.name));
	const staged = fresh.map((c, i) => ({
		id: `${now}-${i}`,
		status: "pending",
		created: now,
		sourceCount: digs.length,
		...c
	}));
	const nextQueue = [...queue, ...staged];
	await saveCandidates(nextQueue);
	return {
		ok: true,
		message: `扫描 ${digs.length} 个会话，产出 ${staged.length} 个候选（跳过 ${cands.length - staged.length} 个重复/已存在）`,
		candidates: staged,
		digests: digs.length,
		queued: nextQueue.length,
		site: { lastRunAt: new Date(now).toISOString(), lastRunSummary: shortenSummary(`扫描 ${digs.length} 个会话，产出 ${staged.length} 个候选`) }
	};
}

export const _internal = { configPath, candidatePath, sessionsRoot };
