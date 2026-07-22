/*
 * 正则截断 (Regex Cutoff)
 * SillyTavern 第三方 UI 扩展
 *
 * 功能：
 *  配置若干“正则组”，每组内含多条正则，组内逻辑可选：
 *    - 任一命中（并集）：组内任意一条正则匹配即视为该组命中
 *    - 全部命中（交集）：组内所有正则都匹配才视为该组命中
 *  组与组之间为并集：任何一组命中即触发。
 *
 *  触发后：
 *    1) 流式生成中实时检测，命中立即中止生成；
 *    2) 把消息从“最早命中位置”截断（命中文本及其之后全部删除），
 *       并在此基础上再往前多删 X 个字符（X 可在设置里调整）；
 *    3) 非流式或流式期间漏检时，在消息落库后兜底检测并截断。
 *
 *  分段自动续写（可选）：
 *    流式生成中按 token 计数，每段达到阈值即中止生成，然后注入“续写提示词”
 *    （只进入本次请求、不写入对话记录）并自动触发 ST 原生“继续”续写；
 *    每段开始时 token 计数自动清零；整条消息达到最大总 token 后停止续写。
 *    若正则命中导致截断，续写循环同样终止。
 */

const MODULE_NAME = 'regex_cutoff';
const LOG = '[正则截断]';

const DEFAULT_GROUP = Object.freeze({
    name: '新分组',
    enabled: true,
    mode: 'any',        // any = 任一命中（并集）；all = 全部命中（交集）
    patterns: '',       // 每行一条正则；支持 /pattern/flags 写法
});

const DEFAULT_SETTINGS = Object.freeze({
    enabled: true,
    deleteChars: 0,     // 截断点再往前多删的字符数（按码点计）
    streamAbort: true,  // 流式命中时立即中止生成
    notify: true,       // 触发时弹出提示
    groups: [],

    // —— 分段自动续写 ——
    autoContinue: {
        enabled: false,
        segmentTokens: 1000,    // 每段生成到多少 token 后截断并续写
        maxTotalTokens: 4000,   // 整条消息最大总 token，达到后不再续写
        role: 'system',         // 续写提示词的注入角色：system / user
        prompt:
            'Continue the reply seamlessly from exactly where it was cut off. ' +
            'Do not repeat any existing text, do not summarize, and do not add any preamble.',
    },
});

// —— 设置读取/初始化 ——
function getSettings() {
    const ctx = SillyTavern.getContext();
    const store = ctx.extensionSettings;
    if (!store[MODULE_NAME]) {
        store[MODULE_NAME] = structuredClone(DEFAULT_SETTINGS);
    }
    const s = store[MODULE_NAME];
    for (const k of Object.keys(DEFAULT_SETTINGS)) {
        if (!Object.hasOwn(s, k)) s[k] = structuredClone(DEFAULT_SETTINGS[k]);
    }
    if (!Array.isArray(s.groups)) s.groups = [];
    for (const g of s.groups) {
        for (const k of Object.keys(DEFAULT_GROUP)) {
            if (!Object.hasOwn(g, k)) g[k] = DEFAULT_GROUP[k];
        }
    }
    if (typeof s.autoContinue !== 'object' || s.autoContinue === null) {
        s.autoContinue = structuredClone(DEFAULT_SETTINGS.autoContinue);
    }
    for (const k of Object.keys(DEFAULT_SETTINGS.autoContinue)) {
        if (!Object.hasOwn(s.autoContinue, k)) s.autoContinue[k] = DEFAULT_SETTINGS.autoContinue[k];
    }
    return s;
}

function save() {
    SillyTavern.getContext().saveSettingsDebounced();
}

// ============================================================
//  正则编译（带缓存）
// ============================================================
// 每行一条；空行忽略；支持 /pattern/flags（g/y 会被剔除以保证 exec 无状态）
function parsePatternLine(line) {
    const m = line.match(/^\/(.+)\/([a-zA-Z]*)$/);
    if (m) {
        const flags = m[2].replace(/[gy]/g, '');
        return new RegExp(m[1], flags);
    }
    return new RegExp(line);
}

let compiledCache = { key: null, groups: [] };

function compileGroups(s) {
    const key = JSON.stringify(s.groups);
    if (compiledCache.key === key) return compiledCache.groups;

    const groups = s.groups.map((g, idx) => {
        const regexes = [];
        const errors = [];
        const lines = String(g.patterns ?? '').split('\n');
        for (const raw of lines) {
            const line = raw.trim();
            if (!line) continue;
            try {
                regexes.push(parsePatternLine(line));
            } catch (e) {
                errors.push(`「${line}」：${e.message}`);
            }
        }
        return { idx, name: g.name || `分组${idx + 1}`, enabled: !!g.enabled, mode: g.mode === 'all' ? 'all' : 'any', regexes, errors };
    });

    compiledCache = { key, groups };
    return groups;
}

// ============================================================
//  检测：返回 { cutStart, groupNames } 或 null
//  组内：any = 任一命中，all = 全部命中；命中组的截断点取组内最早匹配位置。
//  组间为并集，多组命中时取所有命中组里最早的截断点。
// ============================================================
function detect(text, s) {
    if (!text) return null;
    const groups = compileGroups(s);
    let cutStart = -1;
    const groupNames = [];

    for (const g of groups) {
        if (!g.enabled || g.regexes.length === 0) continue;
        let earliest = -1;
        let matchedCount = 0;
        for (const re of g.regexes) {
            const m = re.exec(text);
            if (m) {
                matchedCount++;
                if (earliest === -1 || m.index < earliest) earliest = m.index;
            }
        }
        const hit = g.mode === 'all' ? (matchedCount === g.regexes.length) : (matchedCount > 0);
        if (!hit) continue;
        groupNames.push(g.name);
        if (cutStart === -1 || earliest < cutStart) cutStart = earliest;
    }

    if (cutStart === -1) return null;
    return { cutStart, groupNames };
}

// 截断点之前再按码点往前删 X 个字（对 CJK/emoji 均安全）
function cutText(text, cutStart, deleteChars) {
    const head = text.slice(0, cutStart);
    const x = Math.max(0, Number(deleteChars) || 0);
    if (x === 0) return head;
    const cps = Array.from(head);
    return cps.slice(0, Math.max(0, cps.length - x)).join('');
}

// ============================================================
//  token 计数与续写提示词注入
// ============================================================
async function countTokens(text) {
    const ctx = SillyTavern.getContext();
    try {
        if (typeof ctx.getTokenCountAsync === 'function') return await ctx.getTokenCountAsync(text);
        if (typeof ctx.getTokenCount === 'function') return ctx.getTokenCount(text);
    } catch (e) {
        console.warn(LOG, 'token 计数失败，退回估算：', e);
    }
    return Math.ceil(String(text ?? '').length / 3);
}

// 续写提示词通过 setExtensionPrompt 注入：只进入本次请求的 prompt，不写入对话记录
function setContinuePrompt(text) {
    try {
        const ctx = SillyTavern.getContext();
        if (typeof ctx.setExtensionPrompt !== 'function') {
            console.warn(LOG, '当前 ST 版本不支持 setExtensionPrompt，续写提示词无法注入');
            return;
        }
        const s = getSettings();
        const IN_CHAT = ctx.extension_prompt_types?.IN_CHAT ?? 1;
        const roles = ctx.extension_prompt_roles ?? { SYSTEM: 0, USER: 1 };
        const role = s.autoContinue.role === 'user' ? roles.USER : roles.SYSTEM;
        ctx.setExtensionPrompt(MODULE_NAME, String(text ?? ''), IN_CHAT, 0, false, role);
    } catch (e) {
        console.warn(LOG, '注入续写提示词失败：', e);
    }
}

function clearContinuePrompt() {
    setContinuePrompt('');
}

// ============================================================
//  流式实时检测：正则命中即中止；分段 token 达标即中止并续写
// ============================================================
let abortedThisGen = false;         // 本次生成因“正则命中”而中止
let tokenAbortedThisGen = false;    // 本次生成因“达到每段 token 上限”而中止
let pendingAutoContinue = false;    // 已请求自动续写，等待下一次生成开始
let currentIsAutoContinue = false;  // 当前生成是否为本扩展触发的自动续写
let currentGenType = '';
let roundsThisMessage = 0;          // 本条消息已自动续写的段数
let streamBaselineTokens = 0;       // 续写时流式文本包含已有前缀，作为计数基线
let tokenCheck = { busy: false, last: 0 };

function stopGenerationNow() {
    const ctx = SillyTavern.getContext();
    if (typeof ctx.stopGeneration === 'function') {
        ctx.stopGeneration();
    } else {
        $('#mes_stop').trigger('click');
    }
}

async function onGenerationStarted(type, _params, dryRun) {
    if (dryRun) return;
    currentGenType = String(type ?? '');
    abortedThisGen = false;
    tokenAbortedThisGen = false;
    tokenCheck = { busy: false, last: 0 };
    currentIsAutoContinue = pendingAutoContinue;
    pendingAutoContinue = false;
    if (!currentIsAutoContinue) {
        // 用户主动发起的生成：重置续写轮次，并确保没有残留注入
        roundsThisMessage = 0;
        clearContinuePrompt();
    }
    // 续写（continue）时流式文本会带上已有消息内容，先记下基线 token
    streamBaselineTokens = 0;
    if (currentGenType === 'continue') {
        try {
            const chat = SillyTavern.getContext().chat;
            const idx = findLastAssistantIndex(chat);
            if (idx >= 0) streamBaselineTokens = await countTokens(String(chat[idx].mes ?? ''));
        } catch (e) {
            console.warn(LOG, '计算续写基线 token 失败：', e);
        }
    }
}

async function onStreamToken(raw) {
    try {
        const s = getSettings();
        if (!s.enabled || abortedThisGen || tokenAbortedThisGen) return;
        const text = String(raw ?? '');

        // —— 正则实时检测 ——
        if (s.streamAbort) {
            const hit = detect(text, s);
            if (hit) {
                abortedThisGen = true;
                console.log(LOG, `流式命中分组 [${hit.groupNames.join('、')}]，中止生成`);
                stopGenerationNow();
                return;
            }
        }

        // —— 分段 token 检测（节流 250ms，需开启流式才生效） ——
        const ac = s.autoContinue;
        if (!ac.enabled) return;
        if (currentGenType === 'quiet' || currentGenType === 'impersonate') return;
        const now = Date.now();
        if (tokenCheck.busy || now - tokenCheck.last < 250) return;
        tokenCheck.busy = true;
        try {
            const total = await countTokens(text);
            tokenCheck.last = Date.now();
            const segment = total - streamBaselineTokens;
            if (!tokenAbortedThisGen && !abortedThisGen &&
                segment >= Math.max(1, Number(ac.segmentTokens) || 0)) {
                tokenAbortedThisGen = true;
                console.log(LOG, `本段已生成 ${segment} token，达到上限 ${ac.segmentTokens}，截断本段`);
                stopGenerationNow();
            }
        } finally {
            tokenCheck.busy = false;
        }
    } catch (e) {
        console.error(LOG, '流式检测出错：', e);
    }
}

// ============================================================
//  落库后截断（流式中止后 / 非流式兜底 / 手动触发）
// ============================================================
function findLastAssistantIndex(chat) {
    for (let i = chat.length - 1; i >= 0; i--) {
        const m = chat[i];
        if (m && m.is_user === false && m.is_system !== true) return i;
    }
    return -1;
}

async function applyCutToLastMessage({ silent = false } = {}) {
    const ctx = SillyTavern.getContext();
    const s = getSettings();
    if (!s.enabled) return false;

    const chat = ctx.chat;
    if (!Array.isArray(chat) || chat.length === 0) return false;
    const idx = findLastAssistantIndex(chat);
    if (idx < 0) return false;

    const msg = chat[idx];
    const original = String(msg.mes ?? '');
    let text = original;
    const hitGroups = new Set();

    // 循环截断：极少数情况下截断后拼接处可能产生新的匹配
    for (let i = 0; i < 5; i++) {
        const hit = detect(text, s);
        if (!hit) break;
        hit.groupNames.forEach((n) => hitGroups.add(n));
        const next = cutText(text, hit.cutStart, s.deleteChars);
        if (next === text) break;
        text = next;
    }

    if (text === original) {
        if (!silent) toastr.info('最后一条 AI 消息未命中任何正则组', '正则截断');
        return false;
    }

    text = text.replace(/\s+$/, '');
    msg.mes = text;
    if (Array.isArray(msg.swipes) && Number.isInteger(msg.swipe_id) &&
        msg.swipe_id >= 0 && msg.swipe_id < msg.swipes.length) {
        msg.swipes[msg.swipe_id] = text;
    }

    try {
        if (typeof ctx.updateMessageBlock === 'function') {
            ctx.updateMessageBlock(idx, msg);
        } else if (ctx.reloadCurrentChat) {
            await ctx.reloadCurrentChat();
        }
    } catch (e) {
        console.warn(LOG, '刷新消息渲染失败：', e);
    }
    try {
        await ctx.eventSource.emit(ctx.event_types.MESSAGE_UPDATED, idx);
    } catch { /* 事件通知失败不影响主流程 */ }
    try {
        if (ctx.saveChat) await ctx.saveChat();
    } catch (e) {
        console.warn(LOG, 'saveChat 失败：', e);
    }

    const removed = original.length - text.length;
    console.log(LOG, `已截断消息 #${idx}，命中分组 [${[...hitGroups].join('、')}]，删除 ${removed} 个字符`);
    if (s.notify) {
        toastr.success(`命中分组 [${[...hitGroups].join('、')}]，已截断并删除 ${removed} 个字符`, '正则截断');
    }
    return true;
}

// ============================================================
//  分段自动续写：段截断落库后决定是否续写下一段
// ============================================================
async function maybeAutoContinue(regexCutApplied) {
    const ctx = SillyTavern.getContext();
    const s = getSettings();
    const ac = s.autoContinue;

    // 只有“因每段 token 上限而中止”的生成才续写；其余情况清掉注入即可
    if (!tokenAbortedThisGen) {
        if (!pendingAutoContinue) clearContinuePrompt();
        return;
    }
    tokenAbortedThisGen = false;

    if (!s.enabled || !ac.enabled) { clearContinuePrompt(); return; }
    // 正则命中截断过的消息不再续写
    if (regexCutApplied || abortedThisGen) {
        clearContinuePrompt();
        roundsThisMessage = 0;
        return;
    }

    const chat = ctx.chat;
    const idx = findLastAssistantIndex(chat);
    if (idx < 0) { clearContinuePrompt(); return; }

    const total = await countTokens(String(chat[idx].mes ?? ''));
    const maxTotal = Math.max(1, Number(ac.maxTotalTokens) || 1);
    if (total >= maxTotal) {
        clearContinuePrompt();
        roundsThisMessage = 0;
        if (s.notify) toastr.info(`已达最大总 token（${total}/${maxTotal}），停止续写`, '正则截断');
        return;
    }

    // 防失控：轮次上限 = ceil(最大总量/每段) + 3
    const cap = Math.ceil(maxTotal / Math.max(1, Number(ac.segmentTokens) || 1)) + 3;
    if (roundsThisMessage >= cap) {
        console.warn(LOG, `续写轮次达到安全上限 ${cap}，停止`);
        clearContinuePrompt();
        roundsThisMessage = 0;
        return;
    }
    roundsThisMessage++;

    setContinuePrompt(ac.prompt);
    pendingAutoContinue = true;
    if (s.notify) toastr.info(`当前 ${total}/${maxTotal} token，自动续写第 ${roundsThisMessage} 段`, '正则截断');
    try {
        if (typeof ctx.executeSlashCommandsWithOptions === 'function') {
            await ctx.executeSlashCommandsWithOptions('/continue');
        } else {
            pendingAutoContinue = false;
            clearContinuePrompt();
            console.warn(LOG, '当前 ST 版本不支持 executeSlashCommandsWithOptions，无法自动续写');
        }
    } catch (e) {
        pendingAutoContinue = false;
        clearContinuePrompt();
        console.error(LOG, '触发续写失败：', e);
    }
}

// 生成结束后延迟一点再兜底截断，确保消息已落库；随后决定是否自动续写
let finalizeTimer = null;
function scheduleFinalize() {
    const s = getSettings();
    if (!s.enabled) return;
    if (finalizeTimer) clearTimeout(finalizeTimer);
    finalizeTimer = setTimeout(async () => {
        finalizeTimer = null;
        try {
            const regexCut = await applyCutToLastMessage({ silent: true });
            await maybeAutoContinue(regexCut);
        } catch (e) {
            console.error(LOG, '收尾处理出错：', e);
        }
    }, 300);
}

// ============================================================
//  设置面板 UI
// ============================================================
function escapeHtml(str) {
    return String(str ?? '')
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function buildSettingsHtml() {
    return `
    <div class="regex-cutoff-settings">
      <div class="inline-drawer">
        <div class="inline-drawer-toggle inline-drawer-header">
          <b>正则截断</b>
          <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
        </div>
        <div class="inline-drawer-content">

          <label class="checkbox_label" for="rc_enabled">
            <input id="rc_enabled" type="checkbox" />
            <span>启用本扩展</span>
          </label>

          <label class="checkbox_label" for="rc_stream_abort">
            <input id="rc_stream_abort" type="checkbox" />
            <span>流式生成中命中时立即中止生成</span>
          </label>

          <label class="checkbox_label" for="rc_notify">
            <input id="rc_notify" type="checkbox" />
            <span>触发时弹出提示</span>
          </label>

          <div class="flex-container" style="align-items:center; gap:6px; margin-top:6px;">
            <span>截断点再往前多删</span>
            <input id="rc_delete_chars" type="number" min="0" step="1" class="text_pole" style="max-width:80px;" />
            <span>个字符</span>
          </div>
          <small class="notes">截断规则：删除“最早命中位置”及其之后的全部文本，再在此基础上往前多删 X 个字符。</small>

          <hr>
          <h4>正则组</h4>
          <small class="notes">组内每行一条正则，支持 <code>/pattern/flags</code> 写法（如 <code>/结局/i</code>），普通写法默认无 flags。组内逻辑可选“任一命中（并）”或“全部命中（交）”；组与组之间为并集，任何一组命中即触发。</small>

          <div id="rc_groups"></div>
          <div class="menu_button" id="rc_add_group" style="margin-top:6px;">
            <i class="fa-solid fa-plus"></i> 添加分组
          </div>

          <hr>
          <h4>分段自动续写</h4>

          <label class="checkbox_label" for="rc_ac_enabled">
            <input id="rc_ac_enabled" type="checkbox" />
            <span>启用：每段生成到指定 token 数即截断，并自动续写下一段</span>
          </label>

          <div class="flex-container" style="align-items:center; gap:6px; margin-top:6px;">
            <span>每段</span>
            <input id="rc_ac_segment" type="number" min="50" step="50" class="text_pole" style="max-width:90px;" />
            <span>token 截断续写；总量达</span>
            <input id="rc_ac_max" type="number" min="100" step="100" class="text_pole" style="max-width:90px;" />
            <span>token 后停止</span>
          </div>

          <label for="rc_ac_prompt" style="margin-top:6px;">续写提示词（只注入本次请求，不进对话记录）</label>
          <textarea id="rc_ac_prompt" class="text_pole textarea_compact" rows="3"></textarea>

          <div class="flex-container" style="align-items:center; gap:6px;">
            <span>注入角色</span>
            <select id="rc_ac_role" class="text_pole" style="max-width:120px;">
              <option value="system">system</option>
              <option value="user">user</option>
            </select>
          </div>
          <small class="notes">需要开启流式输出才能按段截断。续写走 ST 原生“继续”机制，每段开始时 token 计数自动清零；手动点停止不会触发续写；若正则命中截断，续写同样终止。</small>

          <hr>
          <h4>测试与手动执行</h4>
          <textarea id="rc_test_input" class="text_pole textarea_compact" rows="3" placeholder="粘贴一段文本，测试当前规则的命中与截断效果"></textarea>
          <div class="flex-container" style="gap:6px; margin-top:4px;">
            <div class="menu_button" id="rc_test_run">测试</div>
            <div class="menu_button" id="rc_apply_last">对最后一条 AI 消息执行截断</div>
          </div>
          <div id="rc_test_result" class="notes" style="white-space:pre-wrap;"></div>

        </div>
      </div>
    </div>`;
}

function groupHtml(g, i) {
    return `
    <div class="rc_group" data-idx="${i}">
      <div class="flex-container rc_group_header" style="align-items:center; gap:6px;">
        <input type="checkbox" class="rc_g_enabled" title="启用该组" ${g.enabled ? 'checked' : ''} />
        <input type="text" class="rc_g_name text_pole" style="flex:1;" placeholder="分组名" value="${escapeHtml(g.name)}" />
        <select class="rc_g_mode text_pole" style="max-width:150px;">
          <option value="any" ${g.mode !== 'all' ? 'selected' : ''}>任一命中（并）</option>
          <option value="all" ${g.mode === 'all' ? 'selected' : ''}>全部命中（交）</option>
        </select>
        <div class="menu_button rc_g_del" title="删除该组"><i class="fa-solid fa-trash-can"></i></div>
      </div>
      <textarea class="rc_g_patterns text_pole textarea_compact" rows="3"
        placeholder="每行一条正则，例如：\n(?:未完待续|全文完)\n/to be continued/i">${escapeHtml(g.patterns)}</textarea>
      <small class="rc_g_err notes"></small>
    </div>`;
}

function renderGroups() {
    const s = getSettings();
    const $box = $('#rc_groups');
    $box.empty();
    s.groups.forEach((g, i) => $box.append(groupHtml(g, i)));
    refreshGroupErrors();
}

function refreshGroupErrors() {
    const s = getSettings();
    const compiled = compileGroups(s);
    $('#rc_groups .rc_group').each(function () {
        const i = Number($(this).data('idx'));
        const g = compiled[i];
        const $err = $(this).find('.rc_g_err');
        if (g && g.errors.length > 0) {
            $err.text('正则错误：' + g.errors.join('；')).addClass('rc_err_on');
        } else {
            $err.text('').removeClass('rc_err_on');
        }
    });
}

function refreshUI() {
    const s = getSettings();
    $('#rc_enabled').prop('checked', s.enabled);
    $('#rc_stream_abort').prop('checked', s.streamAbort);
    $('#rc_notify').prop('checked', s.notify);
    $('#rc_delete_chars').val(s.deleteChars);
    $('#rc_ac_enabled').prop('checked', s.autoContinue.enabled);
    $('#rc_ac_segment').val(s.autoContinue.segmentTokens);
    $('#rc_ac_max').val(s.autoContinue.maxTotalTokens);
    $('#rc_ac_prompt').val(s.autoContinue.prompt);
    $('#rc_ac_role').val(s.autoContinue.role);
    renderGroups();
}

function bindUI() {
    const s = getSettings();

    $('#rc_enabled').on('change', function () { s.enabled = $(this).prop('checked'); save(); });
    $('#rc_stream_abort').on('change', function () { s.streamAbort = $(this).prop('checked'); save(); });
    $('#rc_notify').on('change', function () { s.notify = $(this).prop('checked'); save(); });
    $('#rc_delete_chars').on('input', function () {
        s.deleteChars = Math.max(0, parseInt($(this).val()) || 0);
        save();
    });

    $('#rc_ac_enabled').on('change', function () { s.autoContinue.enabled = $(this).prop('checked'); save(); });
    $('#rc_ac_segment').on('input', function () {
        s.autoContinue.segmentTokens = Math.max(1, parseInt($(this).val()) || 1000);
        save();
    });
    $('#rc_ac_max').on('input', function () {
        s.autoContinue.maxTotalTokens = Math.max(1, parseInt($(this).val()) || 4000);
        save();
    });
    $('#rc_ac_prompt').on('input', function () { s.autoContinue.prompt = String($(this).val()); save(); });
    $('#rc_ac_role').on('change', function () {
        s.autoContinue.role = String($(this).val()) === 'user' ? 'user' : 'system';
        save();
    });

    $('#rc_add_group').on('click', function () {
        s.groups.push(structuredClone(DEFAULT_GROUP));
        save();
        renderGroups();
    });

    // 组内控件走事件委托，增删组后无需重新绑定
    const $box = $('#rc_groups');
    const groupOf = (el) => s.groups[Number($(el).closest('.rc_group').data('idx'))];

    $box.on('change', '.rc_g_enabled', function () {
        const g = groupOf(this); if (!g) return;
        g.enabled = $(this).prop('checked'); save();
    });
    $box.on('input', '.rc_g_name', function () {
        const g = groupOf(this); if (!g) return;
        g.name = String($(this).val()); save();
    });
    $box.on('change', '.rc_g_mode', function () {
        const g = groupOf(this); if (!g) return;
        g.mode = String($(this).val()) === 'all' ? 'all' : 'any'; save();
    });
    $box.on('input', '.rc_g_patterns', function () {
        const g = groupOf(this); if (!g) return;
        g.patterns = String($(this).val()); save();
        refreshGroupErrors();
    });
    $box.on('click', '.rc_g_del', function () {
        const i = Number($(this).closest('.rc_group').data('idx'));
        if (!Number.isInteger(i) || i < 0 || i >= s.groups.length) return;
        s.groups.splice(i, 1);
        save();
        renderGroups();
    });

    $('#rc_test_run').on('click', function () {
        const text = String($('#rc_test_input').val() ?? '');
        const $out = $('#rc_test_result');
        if (!text) { $out.text('请先输入测试文本'); return; }
        const hit = detect(text, s);
        if (!hit) { $out.text('未命中任何分组'); return; }
        const result = cutText(text, hit.cutStart, s.deleteChars);
        $out.text(
            `命中分组：[${hit.groupNames.join('、')}]，命中位置：${hit.cutStart}\n` +
            `截断后（删除 ${text.length - result.length} 个字符）：\n${result || '（空）'}`
        );
    });

    $('#rc_apply_last').on('click', async function () {
        await applyCutToLastMessage({ silent: false });
    });
}

// ============================================================
//  斜杠命令
// ============================================================
function registerSlashCommand() {
    const ctx = SillyTavern.getContext();
    try {
        const { SlashCommandParser, SlashCommand } = ctx;
        if (!SlashCommandParser || !SlashCommand) return;
        SlashCommandParser.addCommandObject(SlashCommand.fromProps({
            name: 'regexcut',
            helpString: '按「正则截断」扩展的规则，对最后一条 AI 消息执行检测并截断。',
            callback: async () => {
                await applyCutToLastMessage({ silent: false });
                return '';
            },
        }));
    } catch (e) {
        console.warn(LOG, '注册斜杠命令失败（可忽略）：', e);
    }
}

// ============================================================
//  初始化
// ============================================================
jQuery(async () => {
    try {
        const ctx = SillyTavern.getContext();
        getSettings();
        $('#extensions_settings2').append(buildSettingsHtml());
        refreshUI();
        bindUI();
        registerSlashCommand();

        const { eventSource, event_types } = ctx;
        eventSource.on(event_types.GENERATION_STARTED, onGenerationStarted);
        eventSource.on(event_types.STREAM_TOKEN_RECEIVED, onStreamToken);
        eventSource.on(event_types.MESSAGE_RECEIVED, scheduleFinalize);
        eventSource.on(event_types.GENERATION_STOPPED, scheduleFinalize);
        eventSource.on(event_types.GENERATION_ENDED, scheduleFinalize);
        eventSource.on(event_types.CHAT_CHANGED, () => {
            // 切换聊天时终止续写循环并清掉注入
            pendingAutoContinue = false;
            tokenAbortedThisGen = false;
            roundsThisMessage = 0;
            clearContinuePrompt();
        });

        // 清理可能残留的注入
        clearContinuePrompt();

        console.log(LOG, '已加载');
    } catch (e) {
        console.error(LOG, '初始化失败：', e);
    }
});
