(function () {
    const rootEl = document.querySelector('[data-chat-root]');
    const messagesEl = document.getElementById('chatMessages');
    const inputEl = document.getElementById('chatInput');
    const sendButton = document.getElementById('sendButton');
    const healthButton = document.getElementById('healthButton');
    const clearHistoryButton = document.getElementById('clearHistoryButton');
    const agentSelectEl = document.getElementById('chatAgentSelect');
    const agentNoteEl = document.getElementById('chatAgentNote');
    const statusEl = document.getElementById('chatStatus');
    const statusSummaryEl = document.getElementById('chatStatusSummary');
    const statusBadgeEl = document.getElementById('chatStatusBadge');
    const statusMetricAEl = document.getElementById('chatStatusMetricA');
    const statusMetricALabelEl = document.getElementById('chatStatusMetricALabel');
    const statusMetricAValueEl = document.getElementById('chatStatusMetricAValue');
    const statusMetricBEl = document.getElementById('chatStatusMetricB');
    const statusMetricBLabelEl = document.getElementById('chatStatusMetricBLabel');
    const statusMetricBValueEl = document.getElementById('chatStatusMetricBValue');

    if (!messagesEl || !inputEl || !sendButton || !healthButton || !clearHistoryButton || !agentSelectEl || !agentNoteEl || !statusEl || !statusSummaryEl || !statusBadgeEl || !statusMetricAEl || !statusMetricALabelEl || !statusMetricAValueEl || !statusMetricBEl || !statusMetricBLabelEl || !statusMetricBValueEl) {
        return;
    }

    const apiPrefix = (rootEl?.dataset.apiPrefix || '/api/ai/chat').replace(/\/$/, '');
    const storagePrefix = rootEl?.dataset.storagePrefix || 'bellbeast-chat';
    const messageStackEl = messagesEl.querySelector('.chat-message-stack') || createMessageStack();
    const defaultProfiles = {
        angpao: {
            id: 'angpao',
            name: 'อั่งเปา',
            ragOnly: true,
            mode: 'rag-only',
            note: 'อั่งเปาใช้ RAG ตรงจาก index ร่วมเดิม เพื่อเน้นความเร็วและใช้ทดสอบ retrieval'
        },
        khaohom: {
            id: 'khaohom',
            name: 'ข้าวหอม',
            ragOnly: false,
            mode: 'rag-llm',
            note: 'ข้าวหอมใช้ RAG ร่วมกับ LLM เพื่อสรุปและตอบให้ตรงบริบทมากขึ้น'
        }
    };
    const historiesByAgent = {};
    let isSending = false;
    let activeAgentId = getInitialAgentId();

    hydrateProfiles();
    renderAgentState();
    renderConversation();
    renderStatus('Ready.', false);

    function createMessageStack() {
        const stack = document.createElement('div');
        stack.className = 'chat-message-stack';
        messagesEl.appendChild(stack);
        return stack;
    }

    function getOrCreateClientSessionKey(agentId) {
        const storageKey = storagePrefix + '-client-v3-' + agentId;
        const existing = sessionStorage.getItem(storageKey);
        if (existing) {
            return existing;
        }

        const next = 'web-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10);
        sessionStorage.setItem(storageKey, next);
        return next;
    }

    function getInitialAgentId() {
        const current = agentSelectEl.value || 'khaohom';
        const stored = sessionStorage.getItem(storagePrefix + '-active-agent');
        if (stored && agentSelectEl.querySelector('option[value="' + stored + '"]')) {
            agentSelectEl.value = stored;
            return stored;
        }

        return current;
    }

    function getActiveProfile() {
        return defaultProfiles[activeAgentId] || defaultProfiles.khaohom;
    }

    function getHistory(agentId) {
        if (!historiesByAgent[agentId]) {
            historiesByAgent[agentId] = [];
        }

        return historiesByAgent[agentId];
    }

    function renderAgentState() {
        const profile = getActiveProfile();
        agentSelectEl.value = profile.id;
        agentNoteEl.textContent = profile.note;
        inputEl.placeholder = 'Ask ' + profile.name + ' something...';
        sessionStorage.setItem(storagePrefix + '-active-agent', profile.id);
    }

    function renderConversation() {
        messageStackEl.innerHTML = '';
        const history = getHistory(activeAgentId);
        if (history.length === 0) {
            const empty = document.createElement('div');
            empty.className = 'chat-empty';
            empty.textContent = 'No messages yet. Start with a quick health check, then send your first prompt.';
            messageStackEl.appendChild(empty);
            return;
        }

        for (const item of history) {
            appendBubble(item.role === 'assistant' ? 'assistant' : 'user', item.content, false, false);
        }
    }

    async function hydrateProfiles() {
        try {
            const response = await fetch(apiPrefix + '/profiles', {
                method: 'GET',
                headers: { 'Accept': 'application/json' }
            });
            const payload = await response.json().catch(function () { return null; });
            if (!response.ok || !payload || !Array.isArray(payload.profiles)) {
                return;
            }

            for (const profile of payload.profiles) {
                if (!profile || !profile.id) {
                    continue;
                }

                defaultProfiles[profile.id] = {
                    id: profile.id,
                    name: profile.name || profile.id,
                    ragOnly: !!profile.ragOnly,
                    mode: profile.mode || (profile.ragOnly ? 'rag-only' : 'rag-llm'),
                    note: profile.mode === 'rag-only'
                        ? (profile.name || profile.id) + ' ใช้ RAG ตรงจาก index ร่วมเดิม เพื่อเน้นความเร็วและใช้ทดสอบ retrieval'
                        : (profile.name || profile.id) + ' ใช้ RAG ร่วมกับ LLM เพื่อสรุปและตอบให้ตรงบริบทมากขึ้น'
                };
            }

            agentSelectEl.innerHTML = '';
            for (const profileId of Object.keys(defaultProfiles)) {
                const option = document.createElement('option');
                const profile = defaultProfiles[profileId];
                option.value = profile.id;
                option.textContent = profile.name + (profile.mode === 'rag-only' ? ' · RAG only' : ' · RAG + LLM');
                agentSelectEl.appendChild(option);
            }

            if (payload.defaultProfileId && defaultProfiles[payload.defaultProfileId] && !sessionStorage.getItem(storagePrefix + '-active-agent')) {
                activeAgentId = payload.defaultProfileId;
            }

            renderAgentState();
        } catch {
        }
    }

    function formatSeconds(ms) {
        return (ms / 1000).toFixed(2) + 's';
    }

    function setBusy(busy) {
        isSending = busy;
        sendButton.disabled = busy;
        healthButton.disabled = busy;
        clearHistoryButton.disabled = busy;
        inputEl.disabled = busy;
    }

    function renderStatus(message, isError) {
        statusEl.innerHTML = '';
        statusEl.closest('.chat-status-card')?.classList.toggle('error', !!isError);

        const lines = String(message || '')
            .split(/\r?\n/)
            .map(function (line) { return line.trim(); })
            .filter(Boolean);

        const items = [];
        for (const line of lines) {
            const match = line.match(/^([^:]+):\s*(.+)$/);
            if (match) {
                items.push({ label: match[1], value: match[2] });
            } else {
                items.push({ label: items.length === 0 ? 'Summary' : 'Info', value: line });
            }
        }

        if (items.length === 0) {
            items.push({ label: 'Summary', value: 'Ready.' });
        }

        const mode = detectStatusMode(items, isError);
        const summaryItem = pullStatusItem(items, 'Summary');
        const reachableItem = pullStatusItem(items, 'Upstream reachable');
        const codeItem = pullStatusItem(items, 'Upstream status');
        const openedItem = pullStatusItem(items, 'BellBeast response opened');
        const firstBytesItem = pullStatusItem(items, 'First stream bytes');
        const completedItem = pullStatusItem(items, 'Completed');
        const upstreamOpenedItem = pullStatusItem(items, 'OpenClaw upstream opened');
        pullStatusItem(items, 'BaseUrl');
        pullStatusItem(items, 'ChatPath');
        pullStatusItem(items, 'ApiKey');

        statusSummaryEl.textContent = summaryItem ? summaryItem.value : 'Ready.';
        applyStatusHeader(mode, {
            summary: summaryItem ? summaryItem.value : 'Ready.',
            reachable: reachableItem ? reachableItem.value : '',
            statusCode: codeItem ? codeItem.value : '',
            opened: openedItem ? openedItem.value : '',
            firstBytes: firstBytesItem ? firstBytesItem.value : '',
            completed: completedItem ? completedItem.value : '',
            upstreamOpened: upstreamOpenedItem ? upstreamOpenedItem.value : ''
        });

        statusEl.hidden = true;
    }

    function pullStatusItem(items, label) {
        const index = items.findIndex(function (item) {
            return item.label.toLowerCase() === label.toLowerCase();
        });

        if (index === -1) {
            return null;
        }

        return items.splice(index, 1)[0];
    }

    function detectStatusMode(items, isError) {
        if (isError) {
            return 'error';
        }

        if (items.some(function (item) { return item.label === 'Timeout' || item.label === 'Upstream body' || item.label === 'Upstream reachable' || item.label === 'Upstream status'; })) {
            return 'health';
        }

        if (items.some(function (item) { return item.label === 'BellBeast response opened' || item.label === 'First stream bytes' || item.label === 'Completed' || item.label === 'OpenClaw upstream opened'; })) {
            return 'chat';
        }

        return 'idle';
    }

    function applyStatusHeader(mode, data) {
        statusBadgeEl.className = 'chat-status-badge ' + mode;

        if (mode === 'health') {
            statusBadgeEl.textContent = 'Health';
            setMetric(statusMetricAEl, statusMetricALabelEl, statusMetricAValueEl, 'Upstream reachable', data.reachable || 'unknown');
            setMetric(statusMetricBEl, statusMetricBLabelEl, statusMetricBValueEl, 'HTTP', data.statusCode || 'n/a');
            return;
        }

        if (mode === 'chat') {
            statusBadgeEl.textContent = 'Chat';
            setMetric(statusMetricAEl, statusMetricALabelEl, statusMetricAValueEl, 'Phase', summarizeChatPhase(data.summary));

            const primaryTiming = data.completed || data.firstBytes || data.opened || '';
            const primaryLabel = data.completed ? 'Completed' : (data.firstBytes ? 'First bytes' : 'Opened');
            setMetric(statusMetricBEl, statusMetricBLabelEl, statusMetricBValueEl, primaryLabel, primaryTiming);
            return;
        }

        if (mode === 'error') {
            statusBadgeEl.textContent = 'Error';
            setMetric(statusMetricAEl, statusMetricALabelEl, statusMetricAValueEl, 'State', 'Request failed');
            setMetric(statusMetricBEl, statusMetricBLabelEl, statusMetricBValueEl, '', '');
            return;
        }

        statusBadgeEl.textContent = 'Idle';
        setMetric(statusMetricAEl, statusMetricALabelEl, statusMetricAValueEl, '', '');
        setMetric(statusMetricBEl, statusMetricBLabelEl, statusMetricBValueEl, '', '');
    }

    function setMetric(wrapper, labelEl, valueEl, label, value) {
        const hasValue = !!(label && value);
        wrapper.hidden = !hasValue;
        labelEl.textContent = hasValue ? label : '';
        valueEl.textContent = hasValue ? value : '';
    }

    function summarizeChatPhase(summary) {
        const text = String(summary || '').toLowerCase();
        if (text.indexOf('thinking') >= 0) {
            return 'Thinking';
        }
        if (text.indexOf('responding') >= 0) {
            return 'Streaming';
        }
        if (text.indexOf('completed') >= 0 || text.indexOf('success') >= 0) {
            return 'Complete';
        }
        return 'In progress';
    }

    function clearEmptyState() {
        const empty = messageStackEl.querySelector('.chat-empty');
        if (empty) {
            empty.remove();
        }
    }

    function scrollToBottom() {
        requestAnimationFrame(function () {
            messagesEl.scrollTop = messagesEl.scrollHeight;
        });
    }

    function appendBubble(role, content, isError, isStreaming) {
        clearEmptyState();

        const bubble = document.createElement('div');
        bubble.className = 'chat-bubble ' + role + (isError ? ' error' : '') + (isStreaming ? ' streaming' : '');

        const meta = document.createElement('span');
        meta.className = 'chat-meta';
        meta.textContent = role === 'user' ? 'User' : (isError ? 'Error' : 'Assistant');

        const body = document.createElement('div');
        body.className = 'chat-body';
        renderContent(body, content);

        bubble.appendChild(meta);
        bubble.appendChild(body);
        messageStackEl.appendChild(bubble);
        scrollToBottom();
        return { bubble: bubble, body: body };
    }

    function updateBubble(view, content, isStreaming) {
        if (!view || !view.body || !view.bubble) {
            return;
        }

        renderContent(view.body, content);
        view.bubble.classList.toggle('streaming', !!isStreaming);
        scrollToBottom();
    }

    function renderContent(container, content) {
        container.innerHTML = '';

        for (const block of parseBlocks(String(content || ''))) {
            if (block.type === 'table') {
                container.appendChild(buildTable(block));
                continue;
            }

            const text = document.createElement('div');
            text.className = 'chat-text-block';
            text.textContent = block.text;
            container.appendChild(text);
        }
    }

    function parseBlocks(content) {
        const normalized = content.replace(/\r\n/g, '\n');
        const lines = normalized.split('\n');
        const blocks = [];
        let textBuffer = [];
        let index = 0;

        function flushText() {
            if (textBuffer.length === 0) {
                return;
            }

            blocks.push({ type: 'text', text: textBuffer.join('\n').trim() });
            textBuffer = [];
        }

        while (index < lines.length) {
            if (isMarkdownTableHeader(lines, index)) {
                flushText();
                const parsed = collectMarkdownTable(lines, index);
                blocks.push(parsed.block);
                index = parsed.nextIndex;
                continue;
            }

            if (isTabularText(lines, index)) {
                flushText();
                const parsed = collectDelimitedTable(lines, index);
                blocks.push(parsed.block);
                index = parsed.nextIndex;
                continue;
            }

            textBuffer.push(lines[index]);
            index += 1;
        }

        flushText();

        return blocks.filter(function (block) {
            return block.type !== 'text' || block.text.length > 0;
        });
    }

    function isMarkdownTableHeader(lines, index) {
        if (index + 1 >= lines.length) {
            return false;
        }

        const header = lines[index];
        const separator = lines[index + 1];
        return countPipeCells(header) >= 2 && isMarkdownSeparator(separator);
    }

    function collectMarkdownTable(lines, startIndex) {
        const header = splitPipeRow(lines[startIndex]);
        const rows = [];
        let index = startIndex + 2;

        while (index < lines.length && countPipeCells(lines[index]) >= 2) {
            rows.push(splitPipeRow(lines[index]));
            index += 1;
        }

        return {
            block: { type: 'table', headers: header, rows: rows },
            nextIndex: index
        };
    }

    function isTabularText(lines, index) {
        const line = lines[index];
        if (!line || line.trim().length === 0) {
            return false;
        }

        const next = lines[index + 1];
        if (!next || next.trim().length === 0) {
            return false;
        }

        const currentTabs = line.split('\t');
        const nextTabs = next.split('\t');
        return currentTabs.length >= 2 && currentTabs.length === nextTabs.length;
    }

    function collectDelimitedTable(lines, startIndex) {
        const headers = lines[startIndex].split('\t').map(trimCell);
        const rows = [];
        let index = startIndex + 1;

        while (index < lines.length) {
            const line = lines[index];
            if (!line || line.trim().length === 0) {
                break;
            }

            const cells = line.split('\t').map(trimCell);
            if (cells.length !== headers.length) {
                break;
            }

            rows.push(cells);
            index += 1;
        }

        return {
            block: { type: 'table', headers: headers, rows: rows },
            nextIndex: index
        };
    }

    function countPipeCells(line) {
        if (!line || line.indexOf('|') === -1) {
            return 0;
        }

        return splitPipeRow(line).length;
    }

    function splitPipeRow(line) {
        return line
            .trim()
            .replace(/^\|/, '')
            .replace(/\|$/, '')
            .split('|')
            .map(trimCell);
    }

    function trimCell(cell) {
        return String(cell || '').trim();
    }

    function isMarkdownSeparator(line) {
        const cells = splitPipeRow(line);
        return cells.length >= 2 && cells.every(function (cell) {
            return /^:?-{3,}:?$/.test(cell);
        });
    }

    function buildTable(block) {
        const wrapper = document.createElement('div');
        wrapper.className = 'chat-table-wrap';

        const table = document.createElement('table');
        table.className = 'chat-table';

        const thead = document.createElement('thead');
        const headerRow = document.createElement('tr');
        for (const header of block.headers) {
            const th = document.createElement('th');
            th.textContent = header || '-';
            headerRow.appendChild(th);
        }
        thead.appendChild(headerRow);
        table.appendChild(thead);

        const tbody = document.createElement('tbody');
        for (const row of block.rows) {
            const tr = document.createElement('tr');
            for (let i = 0; i < block.headers.length; i += 1) {
                const td = document.createElement('td');
                td.textContent = row[i] || '';
                tr.appendChild(td);
            }
            tbody.appendChild(tr);
        }
        table.appendChild(tbody);

        wrapper.appendChild(table);
        return wrapper;
    }

    async function runHealthCheck() {
        const profile = getActiveProfile();
        renderStatus('Checking ' + profile.name + ' configuration...', false);
        setBusy(true);

        try {
            const response = await fetch(apiPrefix + '/health?agent=' + encodeURIComponent(activeAgentId), {
                method: 'GET',
                headers: { 'Accept': 'application/json' }
            });

            const payload = await response.json().catch(function () { return null; });
            if (!response.ok || !payload) {
                throw new Error('Health check failed.');
            }

            const lines = [
                payload.configured ? (payload.profileName || profile.name) + ' is ready.' : (payload.profileName || profile.name) + ' is incomplete.',
                'Agent: ' + (payload.profileName || profile.name),
                'Agent mode: ' + (payload.mode || profile.mode),
                'BaseUrl: ' + (payload.baseUrl || '(empty)'),
                'ChatPath: ' + (payload.chatPath || '(empty)'),
                'ApiKey: ' + (payload.hasApiKey ? 'configured' : 'not set'),
                'Timeout: ' + payload.timeoutSeconds + 's'
            ];

            if (payload.upstream) {
                lines.push('Upstream reachable: ' + (payload.upstream.reachable ? 'yes' : 'no'));
                lines.push('Upstream status: ' + payload.upstream.statusCode);
                if (payload.upstream.body) {
                    lines.push('Upstream body: ' + payload.upstream.body);
                }
            }

            const isHealthError = !payload.configured
                || !payload.ok
                || !payload.upstream
                || !payload.upstream.reachable;

            renderStatus(lines.join('\n'), isHealthError);
        } catch (error) {
            renderStatus(error.message || 'Health check failed.', true);
        } finally {
            setBusy(false);
        }
    }

    async function sendMessage() {
        const text = inputEl.value.trim();
        if (!text || isSending) {
            return;
        }

        const profile = getActiveProfile();
        const history = getHistory(activeAgentId);
        const clientSessionKey = getOrCreateClientSessionKey(activeAgentId);
        history.push({ role: 'user', content: text });
        appendBubble('user', text, false, false);
        inputEl.value = '';
        renderStatus(profile.name + ' is thinking...', false);
        setBusy(true);
        const assistantView = appendBubble('assistant', '...', false, true);
        const clientStartedAt = performance.now();

        try {
            const response = await fetch(apiPrefix + '/send', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json; charset=utf-8',
                    'Accept': 'text/event-stream',
                    'X-BellBeast-Chat-Client': clientSessionKey
                },
                body: JSON.stringify({
                    messages: history,
                    stream: true,
                    agentProfileId: activeAgentId
                })
            });
            const responseOpenedAt = performance.now();

            if (!response.ok) {
                const failedBody = await response.text();
                throw new Error(failedBody || 'Chat request failed.');
            }

            if (!response.body) {
                throw new Error('Streaming response is not available.');
            }

            const reader = response.body.getReader();
            const decoder = new TextDecoder();
            let eventBuffer = '';
            let answer = '';
            let firstDataAt = 0;
            const upstreamOpenMs = Number(response.headers.get('X-BellBeast-Upstream-Open-Ms') || '0');

            renderStatus(
                profile.name + ' is responding...\n'
                + 'BellBeast response opened: ' + formatSeconds(responseOpenedAt - clientStartedAt)
                + '\nOpenClaw upstream opened: ' + (upstreamOpenMs > 0 ? formatSeconds(upstreamOpenMs) : 'n/a'),
                false
            );

            while (true) {
                const result = await reader.read();
                if (result.done) {
                    break;
                }

                if (!firstDataAt) {
                    firstDataAt = performance.now();
                    renderStatus(
                        profile.name + ' is responding...\n'
                        + 'BellBeast response opened: ' + formatSeconds(responseOpenedAt - clientStartedAt)
                        + '\nFirst stream bytes: ' + formatSeconds(firstDataAt - clientStartedAt)
                        + '\nOpenClaw upstream opened: ' + (upstreamOpenMs > 0 ? formatSeconds(upstreamOpenMs) : 'n/a'),
                        false
                    );
                }

                eventBuffer += decoder.decode(result.value, { stream: true });
                const chunks = eventBuffer.split('\n\n');
                eventBuffer = chunks.pop() || '';

                for (const chunk of chunks) {
                    const lines = chunk.split(/\r?\n/);
                    for (const line of lines) {
                        if (!line.startsWith('data:')) {
                            continue;
                        }

                        const data = line.slice(5).trim();
                        if (!data) {
                            continue;
                        }

                        if (data === '[DONE]') {
                            updateBubble(assistantView, answer || '(Empty response)', false);
                            continue;
                        }

                        let payload;
                        try {
                            payload = JSON.parse(data);
                        } catch {
                            continue;
                        }

                        if (payload && payload.error && typeof payload.error.message === 'string') {
                            throw new Error(payload.error.message);
                        }

                        const choice = payload && payload.choices && payload.choices[0];
                        const delta = choice && choice.delta;
                        const part = delta && typeof delta.content === 'string'
                            ? delta.content
                            : '';

                        if (part) {
                            answer += part;
                            updateBubble(assistantView, answer, true);
                        }
                    }
                }
            }

            answer = answer.trim() || '(Empty response)';
            history.push({ role: 'assistant', content: answer });
            updateBubble(assistantView, answer, false);
            renderStatus(
                'Last request completed successfully.\n'
                + 'BellBeast response opened: ' + formatSeconds(responseOpenedAt - clientStartedAt)
                + '\nFirst stream bytes: ' + (firstDataAt ? formatSeconds(firstDataAt - clientStartedAt) : 'n/a')
                + '\nCompleted: ' + formatSeconds(performance.now() - clientStartedAt)
                + '\nOpenClaw upstream opened: ' + (upstreamOpenMs > 0 ? formatSeconds(upstreamOpenMs) : 'n/a'),
                false
            );
        } catch (error) {
            const message = error.message || 'Chat request failed.';
            updateBubble(assistantView, message, false);
            assistantView.bubble.classList.add('error');
            renderStatus(message, true);
        } finally {
            setBusy(false);
            inputEl.focus();
        }
    }

    function clearActiveHistory() {
        if (isSending) {
            return;
        }

        historiesByAgent[activeAgentId] = [];
        renderConversation();
        renderStatus('Cleared history for ' + getActiveProfile().name + '.', false);
        inputEl.focus();
    }

    sendButton.addEventListener('click', sendMessage);
    healthButton.addEventListener('click', runHealthCheck);
    clearHistoryButton.addEventListener('click', clearActiveHistory);
    agentSelectEl.addEventListener('change', function () {
        if (isSending) {
            agentSelectEl.value = activeAgentId;
            return;
        }

        activeAgentId = agentSelectEl.value || 'khaohom';
        renderAgentState();
        renderConversation();
        renderStatus('Switched to ' + getActiveProfile().name + '.', false);
        inputEl.focus();
    });
    inputEl.addEventListener('keydown', function (event) {
        if (event.key === 'Enter' && !event.shiftKey) {
            event.preventDefault();
            sendMessage();
        }
    });
})();
