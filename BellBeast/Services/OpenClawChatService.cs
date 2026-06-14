using System.Diagnostics;
using System.Globalization;
using System.Net;
using System.Net.Http.Headers;
using System.Net.WebSockets;
using System.Text.RegularExpressions;
using System.Text;
using System.Text.Json;
using Microsoft.Extensions.Options;

public class OpenClawOptions
{
    public string BaseUrl { get; set; } = "http://127.0.0.1:18789";
    public string ChatPath { get; set; } = "/api/chat";
    public string ApiKey { get; set; } = "";
    public int TimeoutSeconds { get; set; } = 120;
    public string DefaultProfile { get; set; } = "khaohom";
    public string AgentId { get; set; } = "bellbeast-chat";
    public string SessionKeyPrefix { get; set; } = "bellbeast-chat-user";
    public bool RestrictToRagOnly { get; set; } = true;
    public string RagOnlyFallback { get; set; } = "I don't have that information in the current RAG knowledge base.";
    public string RagCliPath { get; set; } = "";
    public string RagVaultRoot { get; set; } = "";
    public string RagIndexDir { get; set; } = "";
    public double RagMinScore { get; set; } = 0.18d;
    public Dictionary<string, OpenClawAgentProfile> Profiles { get; set; } = new(StringComparer.OrdinalIgnoreCase);
}

public sealed class OpenClawAgentProfile
{
    public string DisplayName { get; set; } = "";
    public string Mode { get; set; } = "";
    public string AgentId { get; set; } = "";
    public string SessionKeyPrefix { get; set; } = "";
    public bool? RestrictToRagOnly { get; set; }
}

public sealed class OpenClawMessage
{
    public string Role { get; set; } = "";
    public string Content { get; set; } = "";
}

public sealed class OpenClawChatRequest
{
    public List<OpenClawMessage> Messages { get; set; } = new();
    public bool Stream { get; set; }
    public string AgentProfileId { get; set; } = "";
}

public sealed class OpenClawChatResult
{
    public bool Success { get; set; }
    public int StatusCode { get; set; }
    public string Answer { get; set; } = "";
    public string Raw { get; set; } = "";
}

public sealed class OpenClawRequestContext
{
    public string ProfileId { get; set; } = "";
    public string AgentId { get; set; } = "";
    public string SessionKey { get; set; } = "";
}

public sealed class OpenClawGatewayStreamResult
{
    public bool Success { get; set; }
    public int StatusCode { get; set; }
    public string Answer { get; set; } = "";
    public string Raw { get; set; } = "";
    public TimeSpan UpstreamOpenElapsed { get; set; }
}

public sealed class LocalRagAnswer
{
    public string Language { get; set; } = "th";
    public bool Found { get; set; }
    public string Summary { get; set; } = "";
    public string Details { get; set; } = "";
    public string Confidence { get; set; } = "";
    public List<LocalRagSource> Sources { get; set; } = new();
}

public sealed class LocalRagSource
{
    public string FileName { get; set; } = "";
    public string Heading { get; set; } = "";
    public string RelativePath { get; set; } = "";
}

public sealed class LocalRagRetrievedChunk
{
    public string FileName { get; set; } = "";
    public string Heading { get; set; } = "";
    public string RelativePath { get; set; } = "";
    public string SectionText { get; set; } = "";
    public double Score { get; set; }
}

file sealed class LocalRagIndexStore
{
    public List<LocalRagIndexChunk> Chunks { get; set; } = new();
}

file sealed class LocalRagIndexChunk
{
    public string RelativePath { get; set; } = "";
    public string FileName { get; set; } = "";
    public string Heading { get; set; } = "";
    public string SectionText { get; set; } = "";
}

sealed class ResolvedOpenClawProfile
{
    public string Id { get; set; } = "";
    public string DisplayName { get; set; } = "";
    public string Mode { get; set; } = "";
    public string AgentId { get; set; } = "";
    public string SessionKeyPrefix { get; set; } = "";
    public bool RestrictToRagOnly { get; set; }
}

public class OpenClawChatService
{
    private static readonly JsonSerializerOptions JsonOptions = new()
    {
        PropertyNameCaseInsensitive = true,
        PropertyNamingPolicy = JsonNamingPolicy.CamelCase
    };

    private readonly HttpClient _http;
    private readonly OpenClawOptions _options;

    public OpenClawChatService(HttpClient http, OpenClawOptions options)
    {
        _http = http;
        _options = options;
    }

    public async Task<OpenClawChatResult> SendAsync(
        OpenClawChatRequest request,
        OpenClawRequestContext? requestContext = null,
        CancellationToken cancellationToken = default)
    {
        var collected = new StringBuilder();
        var streamResult = await SendStreamAsync(
            request,
            requestContext,
            static (delta, state) =>
            {
                if (!string.IsNullOrEmpty(delta))
                    state.Append(delta);

                return Task.CompletedTask;
            },
            collected,
            cancellationToken);

        if (string.IsNullOrWhiteSpace(streamResult.Answer) && collected.Length > 0)
            streamResult.Answer = collected.ToString();

        return new OpenClawChatResult
        {
            Success = streamResult.Success,
            StatusCode = streamResult.StatusCode,
            Answer = streamResult.Answer,
            Raw = streamResult.Raw
        };
    }

    public async Task<OpenClawGatewayStreamResult> SendStreamAsync(
        OpenClawChatRequest request,
        OpenClawRequestContext? requestContext,
        Func<string, StringBuilder, Task> onAssistantDelta,
        StringBuilder deltaState,
        CancellationToken cancellationToken = default)
    {
        if (request.Messages is null || request.Messages.Count == 0)
        {
            return new OpenClawGatewayStreamResult
            {
                Success = false,
                StatusCode = StatusCodes.Status400BadRequest,
                Answer = "No messages were provided.",
                Raw = ""
            };
        }

        var latestUserMessage = ExtractLatestUserMessage(request.Messages);
        if (string.IsNullOrWhiteSpace(latestUserMessage))
        {
            return new OpenClawGatewayStreamResult
            {
                Success = false,
                StatusCode = StatusCodes.Status400BadRequest,
                Answer = "No user message was provided.",
                Raw = ""
            };
        }

        using var timeoutCts = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
        timeoutCts.CancelAfter(TimeSpan.FromSeconds(Math.Max(1, _options.TimeoutSeconds)));
        var profile = ResolveProfile(requestContext?.ProfileId);

        if (IsRagOnlyProfile(profile) && IsLocalRagQueryConfigured())
        {
            var retrievedChunks = await RetrieveLocalRagContextAsync(latestUserMessage, timeoutCts.Token);
            if (retrievedChunks.Count == 0)
            {
                return await SendFallbackLocalAnswerAsync(onAssistantDelta, deltaState);
            }

            var directAnswer = await TryAnswerFromIndexedRagAsync(latestUserMessage, timeoutCts.Token);
            if (directAnswer is not null)
            {
                return await SendDirectLocalAnswerAsync(directAnswer, onAssistantDelta, deltaState);
            }
        }

        if (string.IsNullOrWhiteSpace(_options.BaseUrl))
        {
            if ((IsRagOnlyProfile(profile) || IsRagLlmProfile(profile)) && IsLocalRagQueryConfigured())
                return await SendViaLocalRagAsync(latestUserMessage, onAssistantDelta, deltaState, timeoutCts.Token);

            return new OpenClawGatewayStreamResult
            {
                Success = false,
                StatusCode = StatusCodes.Status500InternalServerError,
                Answer = "OpenClaw BaseUrl is not configured.",
                Raw = ""
            };
        }

        var outboundMessage = BuildOutboundGatewayMessage(request.Messages, profile);
        if (IsRagLlmProfile(profile) && IsLocalRagQueryConfigured())
        {
            var retrievedChunks = await RetrieveLocalRagContextAsync(latestUserMessage, timeoutCts.Token);
            if (retrievedChunks.Count == 0)
            {
                return await SendViaLocalRagAsync(latestUserMessage, onAssistantDelta, deltaState, timeoutCts.Token);
            }

            return await SendViaRetrievedContextLlmAsync(
                latestUserMessage,
                retrievedChunks,
                onAssistantDelta,
                deltaState,
                timeoutCts.Token);
        }

        if (IsRagOnlyProfile(profile) && IsLocalRagQueryConfigured())
        {
            return await SendViaLocalRagAsync(latestUserMessage, onAssistantDelta, deltaState, timeoutCts.Token);
        }

        try
        {
            using var socket = CreateGatewaySocket();
            var connectTimer = Stopwatch.StartNew();

            await socket.ConnectAsync(BuildGatewayUri(), timeoutCts.Token);
            await WaitForConnectChallengeAsync(socket, timeoutCts.Token);
            await SendGatewayRequestAsync(socket, BuildConnectRequest(), timeoutCts.Token);
            var connectResponse = await WaitForResponseAsync(socket, "connect-1", timeoutCts.Token);
            connectTimer.Stop();

            if (!connectResponse.GetProperty("ok").GetBoolean())
            {
                return BuildGatewayFailure(connectResponse, connectTimer.Elapsed, "OpenClaw gateway connect failed.");
            }

            var runId = Guid.NewGuid().ToString("N");
            await SendGatewayRequestAsync(socket, BuildChatSendRequest(runId, requestContext, outboundMessage), timeoutCts.Token);

            JsonElement? acceptedResponse = null;

            while (true)
            {
                using var frame = await ReceiveFrameAsync(socket, timeoutCts.Token);
                var root = frame.RootElement;

                if (!TryGetString(root, "type", out var frameType))
                    continue;

                if (string.Equals(frameType, "res", StringComparison.OrdinalIgnoreCase))
                {
                    if (!TryGetString(root, "id", out var responseId) || !string.Equals(responseId, "send-1", StringComparison.Ordinal))
                        continue;

                    acceptedResponse = root.Clone();
                    if (!root.GetProperty("ok").GetBoolean())
                        return BuildGatewayFailure(root, connectTimer.Elapsed, "OpenClaw gateway send failed.");

                    continue;
                }

                if (!string.Equals(frameType, "event", StringComparison.OrdinalIgnoreCase))
                    continue;

                if (!TryGetString(root, "event", out var eventName))
                    continue;

                if (!root.TryGetProperty("payload", out var payload) || payload.ValueKind != JsonValueKind.Object)
                    continue;

                if (!IsMatchingGatewayRun(payload, runId, requestContext?.SessionKey))
                    continue;

                if (string.Equals(eventName, "agent", StringComparison.OrdinalIgnoreCase) &&
                    TryGetString(payload, "stream", out var streamName) &&
                    string.Equals(streamName, "assistant", StringComparison.OrdinalIgnoreCase))
                {
                    var delta = TryReadAgentDelta(payload);
                    if (!string.IsNullOrEmpty(delta))
                        await onAssistantDelta(delta, deltaState);

                    continue;
                }

                if (!string.Equals(eventName, "chat", StringComparison.OrdinalIgnoreCase))
                    continue;

                if (!TryGetString(payload, "state", out var state))
                    continue;

                if (string.Equals(state, "error", StringComparison.OrdinalIgnoreCase))
                {
                    return new OpenClawGatewayStreamResult
                    {
                        Success = false,
                        StatusCode = StatusCodes.Status502BadGateway,
                        Answer = TryGetString(payload, "errorMessage", out var errorMessage) ? errorMessage : "OpenClaw chat failed.",
                        Raw = payload.GetRawText(),
                        UpstreamOpenElapsed = connectTimer.Elapsed
                    };
                }

                if (string.Equals(state, "aborted", StringComparison.OrdinalIgnoreCase))
                {
                    return new OpenClawGatewayStreamResult
                    {
                        Success = false,
                        StatusCode = StatusCodes.Status499ClientClosedRequest,
                        Answer = "OpenClaw chat was aborted.",
                        Raw = payload.GetRawText(),
                        UpstreamOpenElapsed = connectTimer.Elapsed
                    };
                }

                if (!string.Equals(state, "final", StringComparison.OrdinalIgnoreCase))
                    continue;

                var answer = ExtractGatewayMessageText(payload);
                if (string.IsNullOrWhiteSpace(answer))
                    answer = deltaState.ToString();

                return new OpenClawGatewayStreamResult
                {
                    Success = acceptedResponse.HasValue,
                    StatusCode = StatusCodes.Status200OK,
                    Answer = answer,
                    Raw = payload.GetRawText(),
                    UpstreamOpenElapsed = connectTimer.Elapsed
                };
            }
        }
        catch (OperationCanceledException) when (!cancellationToken.IsCancellationRequested)
        {
            return new OpenClawGatewayStreamResult
            {
                Success = false,
                StatusCode = StatusCodes.Status504GatewayTimeout,
                Answer = "OpenClaw request timed out.",
                Raw = ""
            };
        }
        catch (WebSocketException ex)
        {
            return new OpenClawGatewayStreamResult
            {
                Success = false,
                StatusCode = StatusCodes.Status502BadGateway,
                Answer = "OpenClaw gateway connection failed.",
                Raw = ex.Message
            };
        }
    }

    public async Task<object> GetHealthAsync(string? profileId = null, CancellationToken cancellationToken = default)
    {
        var profile = ResolveProfile(profileId);
        var baseUrl = (_options.BaseUrl ?? "").Trim().TrimEnd('/');
        var chatPath = (_options.ChatPath ?? "").Trim();
        var configured = !string.IsNullOrWhiteSpace(baseUrl) && !string.IsNullOrWhiteSpace(chatPath);
        var healthUrl = string.IsNullOrWhiteSpace(baseUrl) ? "" : $"{baseUrl}/health";
        var ragCliConfigured = !string.IsNullOrWhiteSpace(_options.RagCliPath);
        var ragIndexConfigured = !string.IsNullOrWhiteSpace(_options.RagIndexDir);
        var ragIndexExists = ragIndexConfigured && File.Exists(Path.Combine(_options.RagIndexDir.Trim(), "index.json"));
        var ragProductSelfTest = await TryAnswerFromIndexedRagAsync("What is the product", cancellationToken);
        var ragCriteriaSelfTest = await TryAnswerFromIndexedRagAsync("What are the water quality standards", cancellationToken);

        if (!configured)
        {
            return new
            {
                ok = false,
                configured = false,
                profileId = profile.Id,
                profileName = profile.DisplayName,
                baseUrl,
                chatPath,
                mode = profile.Mode,
                agentId = profile.AgentId,
                ragOnly = profile.RestrictToRagOnly,
                ragCliConfigured,
                ragIndexConfigured,
                ragIndexExists,
                ragProductSelfTestFound = ragProductSelfTest?.Found ?? false,
                ragCriteriaSelfTestFound = ragCriteriaSelfTest?.Found ?? false,
                hasApiKey = !string.IsNullOrWhiteSpace(_options.ApiKey),
                timeoutSeconds = Math.Max(1, _options.TimeoutSeconds),
                upstream = new
                {
                    reachable = false,
                    statusCode = 0,
                    body = "OpenClaw config is incomplete."
                }
            };
        }

        using var timeoutCts = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
        timeoutCts.CancelAfter(TimeSpan.FromSeconds(Math.Max(1, _options.TimeoutSeconds)));

        try
        {
            using var response = await _http.GetAsync(healthUrl, timeoutCts.Token);
            var body = await response.Content.ReadAsStringAsync(timeoutCts.Token);

            return new
            {
                ok = response.IsSuccessStatusCode,
                configured = true,
                profileId = profile.Id,
                profileName = profile.DisplayName,
                baseUrl,
                chatPath,
                mode = profile.Mode,
                agentId = profile.AgentId,
                ragOnly = profile.RestrictToRagOnly,
                ragCliConfigured,
                ragIndexConfigured,
                ragIndexExists,
                ragProductSelfTestFound = ragProductSelfTest?.Found ?? false,
                ragCriteriaSelfTestFound = ragCriteriaSelfTest?.Found ?? false,
                hasApiKey = !string.IsNullOrWhiteSpace(_options.ApiKey),
                timeoutSeconds = Math.Max(1, _options.TimeoutSeconds),
                upstream = new
                {
                    reachable = response.IsSuccessStatusCode,
                    statusCode = (int)response.StatusCode,
                    body
                }
            };
        }
        catch (OperationCanceledException) when (!cancellationToken.IsCancellationRequested)
        {
            return new
            {
                ok = false,
                configured = true,
                profileId = profile.Id,
                profileName = profile.DisplayName,
                baseUrl,
                chatPath,
                mode = profile.Mode,
                agentId = profile.AgentId,
                ragOnly = profile.RestrictToRagOnly,
                ragCliConfigured,
                ragIndexConfigured,
                ragIndexExists,
                ragProductSelfTestFound = ragProductSelfTest?.Found ?? false,
                ragCriteriaSelfTestFound = ragCriteriaSelfTest?.Found ?? false,
                hasApiKey = !string.IsNullOrWhiteSpace(_options.ApiKey),
                timeoutSeconds = Math.Max(1, _options.TimeoutSeconds),
                upstream = new
                {
                    reachable = false,
                    statusCode = StatusCodes.Status504GatewayTimeout,
                    body = "OpenClaw health check timed out."
                }
            };
        }
        catch (Exception ex)
        {
            return new
            {
                ok = false,
                configured = true,
                profileId = profile.Id,
                profileName = profile.DisplayName,
                baseUrl,
                chatPath,
                mode = profile.Mode,
                agentId = profile.AgentId,
                ragOnly = profile.RestrictToRagOnly,
                ragCliConfigured,
                ragIndexConfigured,
                ragIndexExists,
                ragProductSelfTestFound = ragProductSelfTest?.Found ?? false,
                ragCriteriaSelfTestFound = ragCriteriaSelfTest?.Found ?? false,
                hasApiKey = !string.IsNullOrWhiteSpace(_options.ApiKey),
                timeoutSeconds = Math.Max(1, _options.TimeoutSeconds),
                upstream = new
                {
                    reachable = false,
                    statusCode = StatusCodes.Status502BadGateway,
                    body = ex.Message
                }
            };
        }
    }

    public OpenClawRequestContext BuildRequestContext(string? userKey, string? profileId = null)
    {
        var profile = ResolveProfile(profileId);
        var agentId = profile.AgentId;
        var normalizedUserKey = NormalizeToken(userKey);

        return new OpenClawRequestContext
        {
            ProfileId = profile.Id,
            AgentId = agentId,
            SessionKey = string.IsNullOrWhiteSpace(normalizedUserKey)
                ? ""
                : $"agent:{agentId}:main:{profile.SessionKeyPrefix}:{normalizedUserKey}"
        };
    }

    private ClientWebSocket CreateGatewaySocket()
    {
        var socket = new ClientWebSocket();
        socket.Options.SetRequestHeader("Origin", ResolveGatewayOrigin());
        return socket;
    }

    private Uri BuildGatewayUri()
    {
        var baseUri = new Uri(_options.BaseUrl.Trim());
        var builder = new UriBuilder(baseUri)
        {
            Scheme = string.Equals(baseUri.Scheme, "https", StringComparison.OrdinalIgnoreCase) ? "wss" : "ws",
            Path = "/",
            Query = ""
        };

        return builder.Uri;
    }

    private string ResolveGatewayOrigin()
    {
        var baseUri = new Uri(_options.BaseUrl.Trim());
        return $"{baseUri.Scheme}://{baseUri.Authority}";
    }

    private object BuildConnectRequest()
    {
        return new
        {
            type = "req",
            id = "connect-1",
            method = "connect",
            @params = new
            {
                minProtocol = 3,
                maxProtocol = 3,
                client = new
                {
                    id = "openclaw-control-ui",
                    version = "bellbeast",
                    platform = "aspnet",
                    mode = "webchat"
                },
                role = "operator",
                scopes = new[] { "operator.admin", "operator.read", "operator.write" },
                auth = string.IsNullOrWhiteSpace(_options.ApiKey)
                    ? null
                    : new
                    {
                        token = _options.ApiKey
                    }
            }
        };
    }

    private object BuildChatSendRequest(string runId, OpenClawRequestContext? requestContext, string message)
    {
        return new
        {
            type = "req",
            id = "send-1",
            method = "chat.send",
            @params = new
            {
                sessionKey = string.IsNullOrWhiteSpace(requestContext?.SessionKey)
                    ? $"agent:{ResolveAgentId(requestContext?.ProfileId)}:main"
                    : requestContext!.SessionKey,
                message,
                deliver = false,
                idempotencyKey = runId
            }
        };
    }

    private async Task WaitForConnectChallengeAsync(ClientWebSocket socket, CancellationToken cancellationToken)
    {
        while (true)
        {
            using var frame = await ReceiveFrameAsync(socket, cancellationToken);
            var root = frame.RootElement;

            if (!TryGetString(root, "type", out var frameType) ||
                !string.Equals(frameType, "event", StringComparison.OrdinalIgnoreCase))
            {
                continue;
            }

            if (TryGetString(root, "event", out var eventName) &&
                string.Equals(eventName, "connect.challenge", StringComparison.OrdinalIgnoreCase))
            {
                return;
            }
        }
    }

    private async Task<JsonElement> WaitForResponseAsync(ClientWebSocket socket, string requestId, CancellationToken cancellationToken)
    {
        while (true)
        {
            using var frame = await ReceiveFrameAsync(socket, cancellationToken);
            var root = frame.RootElement;

            if (!TryGetString(root, "type", out var frameType) ||
                !string.Equals(frameType, "res", StringComparison.OrdinalIgnoreCase))
            {
                continue;
            }

            if (TryGetString(root, "id", out var responseId) &&
                string.Equals(responseId, requestId, StringComparison.Ordinal))
            {
                return root.Clone();
            }
        }
    }

    private async Task SendGatewayRequestAsync(ClientWebSocket socket, object payload, CancellationToken cancellationToken)
    {
        var json = JsonSerializer.Serialize(payload, JsonOptions);
        var bytes = Encoding.UTF8.GetBytes(json);
        await socket.SendAsync(bytes, WebSocketMessageType.Text, true, cancellationToken);
    }

    private static async Task<JsonDocument> ReceiveFrameAsync(ClientWebSocket socket, CancellationToken cancellationToken)
    {
        var buffer = new byte[8192];
        using var stream = new MemoryStream();

        while (true)
        {
            var segment = new ArraySegment<byte>(buffer);
            var result = await socket.ReceiveAsync(segment, cancellationToken);

            if (result.MessageType == WebSocketMessageType.Close)
                throw new WebSocketException($"OpenClaw gateway closed: {result.CloseStatus} {result.CloseStatusDescription}");

            if (result.Count > 0)
                stream.Write(buffer, 0, result.Count);

            if (result.EndOfMessage)
                break;
        }

        stream.Position = 0;
        return await JsonDocument.ParseAsync(stream, cancellationToken: cancellationToken);
    }

    private static OpenClawGatewayStreamResult BuildGatewayFailure(JsonElement responseRoot, TimeSpan upstreamOpenElapsed, string fallbackMessage)
    {
        var answer = fallbackMessage;
        if (responseRoot.TryGetProperty("error", out var error) && TryGetString(error, "message", out var message))
            answer = message;

        return new OpenClawGatewayStreamResult
        {
            Success = false,
            StatusCode = StatusCodes.Status502BadGateway,
            Answer = answer,
            Raw = responseRoot.GetRawText(),
            UpstreamOpenElapsed = upstreamOpenElapsed
        };
    }

    private string BuildOutboundGatewayMessage(List<OpenClawMessage> messages, ResolvedOpenClawProfile profile)
    {
        var userMessage = ExtractLatestUserMessage(messages);
        if (string.IsNullOrWhiteSpace(userMessage))
            return "";

        if (!profile.RestrictToRagOnly)
            return userMessage;

        return BuildRagOnlyEnvelope(userMessage);
    }

    private string ExtractLatestUserMessage(List<OpenClawMessage> messages)
    {
        var upstreamMessages = BuildUpstreamMessages(messages);
        var lastTurnMessage = upstreamMessages.LastOrDefault(static message =>
            !string.IsNullOrWhiteSpace(message.Content) &&
            (IsRole(message.Role, "user") || IsRole(message.Role, "tool")));

        return lastTurnMessage?.Content?.Trim() ?? "";
    }

    private List<OpenClawMessage> BuildUpstreamMessages(List<OpenClawMessage> messages)
    {
        if (messages.Count == 0)
            return new List<OpenClawMessage>();

        var preservedSystemMessages = messages
            .Where(static message => IsRole(message.Role, "system") || IsRole(message.Role, "developer"))
            .Select(CloneMessage)
            .ToList();

        var lastTurnMessage = messages
            .LastOrDefault(static message =>
                !string.IsNullOrWhiteSpace(message.Content) &&
                (IsRole(message.Role, "user") || IsRole(message.Role, "tool")));

        if (lastTurnMessage is null)
            return messages.Select(CloneMessage).ToList();

        preservedSystemMessages.Add(CloneMessage(lastTurnMessage));
        return preservedSystemMessages;
    }

    private string ResolveAgentId(string? profileId = null)
    {
        return ResolveProfile(profileId).AgentId;
    }

    private string ResolveSessionKeyPrefix(string? profileId = null)
    {
        return ResolveProfile(profileId).SessionKeyPrefix;
    }

    private string BuildRagOnlyEnvelope(string userMessage)
    {
        var fallback = string.IsNullOrWhiteSpace(_options.RagOnlyFallback)
            ? "I don't have that information in the current RAG knowledge base."
            : _options.RagOnlyFallback.Trim();

        return
            "System policy:\n" +
            "You are BellBeast's RAG-only assistant.\n" +
            "Answer ONLY from the information available in the current RAG knowledge base and retrieved context.\n" +
            "Do NOT browse, search the web, call external sources, rely on general world knowledge, or speculate.\n" +
            "Interpret every question as a question about the current RAG corpus, not as a request for a general definition.\n" +
            "Prefer exact values, names, labels, and field contents found in the retrieved documents over broad explanations.\n" +
            "If the user asks a short noun-style question such as asking what a product, item, site, process, or owner is, answer with the specific value from RAG rather than a dictionary-style definition.\n" +
            "Keep the answer grounded in retrieved facts. If a direct value exists in RAG, return that value first, briefly and clearly.\n" +
            $"If the answer is not supported by the current RAG knowledge base, reply exactly with: \"{fallback}\"\n\n" +
            "User request:\n" +
            userMessage;
    }

    private bool IsLocalRagQueryConfigured()
    {
        return !string.IsNullOrWhiteSpace(_options.RagCliPath);
    }

    public object GetProfilesSummary()
    {
        var profiles = ResolveProfiles()
            .Select(static profile => new
            {
                id = profile.Id,
                name = profile.DisplayName,
                mode = profile.Mode,
                agentId = profile.AgentId,
                ragOnly = profile.RestrictToRagOnly,
                sessionKeyPrefix = profile.SessionKeyPrefix
            })
            .ToList();

        return new
        {
            defaultProfileId = ResolveProfile(null).Id,
            profiles
        };
    }

    private IReadOnlyList<ResolvedOpenClawProfile> ResolveProfiles()
    {
        var configuredProfiles = _options.Profiles ?? new Dictionary<string, OpenClawAgentProfile>(StringComparer.OrdinalIgnoreCase);
        var resolved = new List<ResolvedOpenClawProfile>();

        foreach (var pair in configuredProfiles)
        {
            var id = NormalizeProfileId(pair.Key);
            if (string.IsNullOrWhiteSpace(id))
                continue;

            resolved.Add(new ResolvedOpenClawProfile
            {
                Id = id,
                DisplayName = string.IsNullOrWhiteSpace(pair.Value?.DisplayName) ? id : pair.Value.DisplayName.Trim(),
                Mode = ResolveModeValue(pair.Value?.Mode, pair.Value?.RestrictToRagOnly),
                AgentId = ResolveAgentIdValue(pair.Value?.AgentId),
                SessionKeyPrefix = ResolveSessionKeyPrefixValue(pair.Value?.SessionKeyPrefix),
                RestrictToRagOnly = ResolveRestrictToRagOnly(ResolveModeValue(pair.Value?.Mode, pair.Value?.RestrictToRagOnly), pair.Value?.RestrictToRagOnly ?? _options.RestrictToRagOnly)
            });
        }

        if (resolved.Count == 0)
        {
            resolved.Add(new ResolvedOpenClawProfile
            {
                Id = NormalizeProfileId(_options.DefaultProfile),
                DisplayName = "BellBeast Chat",
                Mode = ResolveModeValue(null, _options.RestrictToRagOnly),
                AgentId = ResolveAgentIdValue(_options.AgentId),
                SessionKeyPrefix = ResolveSessionKeyPrefixValue(_options.SessionKeyPrefix),
                RestrictToRagOnly = ResolveRestrictToRagOnly(ResolveModeValue(null, _options.RestrictToRagOnly), _options.RestrictToRagOnly)
            });
        }

        return resolved;
    }

    private ResolvedOpenClawProfile ResolveProfile(string? profileId)
    {
        var profiles = ResolveProfiles();
        var normalizedRequested = NormalizeProfileId(profileId);
        if (!string.IsNullOrWhiteSpace(normalizedRequested))
        {
            var match = profiles.FirstOrDefault(profile => string.Equals(profile.Id, normalizedRequested, StringComparison.OrdinalIgnoreCase));
            if (match is not null)
                return match;
        }

        var defaultId = NormalizeProfileId(_options.DefaultProfile);
        var defaultMatch = profiles.FirstOrDefault(profile => string.Equals(profile.Id, defaultId, StringComparison.OrdinalIgnoreCase));
        return defaultMatch ?? profiles[0];
    }

    private static string NormalizeProfileId(string? value)
    {
        var normalized = NormalizeToken(value);
        return string.IsNullOrWhiteSpace(normalized) ? "default" : normalized;
    }

    private static string ResolveAgentIdValue(string? configured)
    {
        var value = (configured ?? "").Trim();
        return string.IsNullOrWhiteSpace(value) ? "bellbeast-chat" : value;
    }

    private static string ResolveSessionKeyPrefixValue(string? configured)
    {
        var value = NormalizeToken(configured);
        return string.IsNullOrWhiteSpace(value) ? "bellbeast-chat-user" : value;
    }

    private static string ResolveModeValue(string? configuredMode, bool? restrictToRagOnly)
    {
        var mode = NormalizeToken(configuredMode);
        if (!string.IsNullOrWhiteSpace(mode))
            return mode;

        return restrictToRagOnly ?? false ? "rag-only" : "rag-llm";
    }

    private static bool ResolveRestrictToRagOnly(string mode, bool configuredFallback)
    {
        if (string.Equals(mode, "rag-only", StringComparison.OrdinalIgnoreCase))
            return true;

        if (string.Equals(mode, "rag-llm", StringComparison.OrdinalIgnoreCase) ||
            string.Equals(mode, "gateway", StringComparison.OrdinalIgnoreCase))
            return false;

        return configuredFallback;
    }

    private static bool IsRagOnlyProfile(ResolvedOpenClawProfile profile)
    {
        return string.Equals(profile.Mode, "rag-only", StringComparison.OrdinalIgnoreCase);
    }

    private static bool IsRagLlmProfile(ResolvedOpenClawProfile profile)
    {
        return string.Equals(profile.Mode, "rag-llm", StringComparison.OrdinalIgnoreCase);
    }

    private double ResolveRagMinScore()
    {
        return double.IsFinite(_options.RagMinScore) && _options.RagMinScore > 0d
            ? _options.RagMinScore
            : 0.18d;
    }

    private async Task<OpenClawGatewayStreamResult> SendDirectLocalAnswerAsync(
        LocalRagAnswer answer,
        Func<string, StringBuilder, Task> onAssistantDelta,
        StringBuilder deltaState)
    {
        var formatted = FormatLocalRagAnswer(answer);

        if (!string.IsNullOrWhiteSpace(formatted))
        {
            deltaState.Append(formatted);
            await onAssistantDelta(formatted, deltaState);
        }

        return new OpenClawGatewayStreamResult
        {
            Success = true,
            StatusCode = StatusCodes.Status200OK,
            Answer = formatted,
            Raw = JsonSerializer.Serialize(answer, JsonOptions),
            UpstreamOpenElapsed = TimeSpan.Zero
        };
    }

    private async Task<OpenClawGatewayStreamResult> SendViaLocalRagAsync(
        string userMessage,
        Func<string, StringBuilder, Task> onAssistantDelta,
        StringBuilder deltaState,
        CancellationToken cancellationToken)
    {
        try
        {
            var retrievedChunks = await RetrieveLocalRagContextAsync(userMessage, cancellationToken);
            if (retrievedChunks.Count == 0)
                return await SendFallbackLocalAnswerAsync(onAssistantDelta, deltaState);

            var answer = await QueryLocalRagAsync(userMessage, cancellationToken);
            return await SendDirectLocalAnswerAsync(answer, onAssistantDelta, deltaState);
        }
        catch (OperationCanceledException) when (!cancellationToken.IsCancellationRequested)
        {
            return new OpenClawGatewayStreamResult
            {
                Success = false,
                StatusCode = StatusCodes.Status504GatewayTimeout,
                Answer = "OpenClaw request timed out.",
                Raw = ""
            };
        }
        catch (Exception ex)
        {
            return new OpenClawGatewayStreamResult
            {
                Success = false,
                StatusCode = StatusCodes.Status502BadGateway,
                Answer = ex.Message,
                Raw = ex.ToString()
            };
        }
    }

    private async Task<OpenClawGatewayStreamResult> SendFallbackLocalAnswerAsync(
        Func<string, StringBuilder, Task> onAssistantDelta,
        StringBuilder deltaState)
    {
        return await SendDirectLocalAnswerAsync(
            new LocalRagAnswer
            {
                Language = "th",
                Found = false
            },
            onAssistantDelta,
            deltaState);
    }

    private async Task<OpenClawGatewayStreamResult> SendViaRetrievedContextLlmAsync(
        string userMessage,
        List<LocalRagRetrievedChunk> retrievedChunks,
        Func<string, StringBuilder, Task> onAssistantDelta,
        StringBuilder deltaState,
        CancellationToken cancellationToken)
    {
        try
        {
            var answer = await CompleteRetrievedContextAsync(userMessage, retrievedChunks, cancellationToken);
            if (!string.IsNullOrWhiteSpace(answer))
            {
                deltaState.Append(answer);
                await onAssistantDelta(answer, deltaState);
            }

            return new OpenClawGatewayStreamResult
            {
                Success = true,
                StatusCode = StatusCodes.Status200OK,
                Answer = answer,
                Raw = "",
                UpstreamOpenElapsed = TimeSpan.Zero
            };
        }
        catch (OperationCanceledException) when (!cancellationToken.IsCancellationRequested)
        {
            return new OpenClawGatewayStreamResult
            {
                Success = false,
                StatusCode = StatusCodes.Status504GatewayTimeout,
                Answer = "OpenClaw request timed out.",
                Raw = ""
            };
        }
        catch (Exception ex)
        {
            return new OpenClawGatewayStreamResult
            {
                Success = false,
                StatusCode = StatusCodes.Status502BadGateway,
                Answer = ex.Message,
                Raw = ex.ToString()
            };
        }
    }

    private async Task<LocalRagAnswer> QueryLocalRagAsync(string userMessage, CancellationToken cancellationToken)
    {
        var cliPath = _options.RagCliPath.Trim();
        if (string.IsNullOrWhiteSpace(cliPath))
            throw new InvalidOperationException("Local RAG CLI path is not configured.");

        var moduleUri = new Uri(Path.GetFullPath(cliPath)).AbsoluteUri;
        var script =
            $"import {{ QsheService }} from {JsonSerializer.Serialize(moduleUri)};" +
            "const service = new QsheService();" +
            "const answer = await service.queryAnswer(process.env.BB_RAG_QUESTION ?? '');" +
            "process.stdout.write(JSON.stringify(answer));";

        using var process = new Process
        {
            StartInfo = new ProcessStartInfo
            {
                FileName = "node",
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                StandardOutputEncoding = Encoding.UTF8,
                StandardErrorEncoding = Encoding.UTF8,
                UseShellExecute = false,
                CreateNoWindow = true
            }
        };

        process.StartInfo.ArgumentList.Add("--input-type=module");
        process.StartInfo.ArgumentList.Add("-e");
        process.StartInfo.ArgumentList.Add(script);
        process.StartInfo.Environment["BB_RAG_QUESTION"] = userMessage;

        if (!string.IsNullOrWhiteSpace(_options.RagVaultRoot))
            process.StartInfo.Environment["QSHE_DOC_ROOT"] = _options.RagVaultRoot.Trim();

        if (!string.IsNullOrWhiteSpace(_options.RagIndexDir))
            process.StartInfo.Environment["QSHE_DOC_INDEX_DIR"] = _options.RagIndexDir.Trim();

        process.Start();

        using var registration = cancellationToken.Register(() =>
        {
            try
            {
                if (!process.HasExited)
                    process.Kill(entireProcessTree: true);
            }
            catch
            {
            }
        });

        var stdoutTask = process.StandardOutput.ReadToEndAsync(cancellationToken);
        var stderrTask = process.StandardError.ReadToEndAsync(cancellationToken);
        await process.WaitForExitAsync(cancellationToken);

        var stdout = await stdoutTask;
        var stderr = await stderrTask;

        if (process.ExitCode != 0)
            throw new InvalidOperationException(string.IsNullOrWhiteSpace(stderr) ? "Local RAG query failed." : stderr.Trim());

        var answer = JsonSerializer.Deserialize<LocalRagAnswer>(stdout, JsonOptions);
        if (answer is null)
            throw new InvalidOperationException("Local RAG query returned an empty payload.");

        if (!answer.Found)
        {
            var fallbackQuestion = BuildRagSearchHint(userMessage);
            if (!string.IsNullOrWhiteSpace(fallbackQuestion) &&
                !string.Equals(fallbackQuestion, userMessage, StringComparison.Ordinal))
            {
                process.StartInfo.Environment["BB_RAG_QUESTION"] = fallbackQuestion;
                using var retryProcess = new Process
                {
                    StartInfo = process.StartInfo
                };

                retryProcess.Start();
                using var retryRegistration = cancellationToken.Register(() =>
                {
                    try
                    {
                        if (!retryProcess.HasExited)
                            retryProcess.Kill(entireProcessTree: true);
                    }
                    catch
                    {
                    }
                });

                var retryStdoutTask = retryProcess.StandardOutput.ReadToEndAsync(cancellationToken);
                var retryStderrTask = retryProcess.StandardError.ReadToEndAsync(cancellationToken);
                await retryProcess.WaitForExitAsync(cancellationToken);

                var retryStdout = await retryStdoutTask;
                var retryStderr = await retryStderrTask;
                if (retryProcess.ExitCode == 0)
                {
                    var retryAnswer = JsonSerializer.Deserialize<LocalRagAnswer>(retryStdout, JsonOptions);
                    if (retryAnswer is not null && retryAnswer.Found)
                        answer = retryAnswer;
                }
                else if (!string.IsNullOrWhiteSpace(retryStderr))
                {
                    throw new InvalidOperationException(retryStderr.Trim());
                }
            }
        }

        return answer;
    }

    private async Task<List<LocalRagRetrievedChunk>> RetrieveLocalRagContextAsync(string userMessage, CancellationToken cancellationToken)
    {
        var cliPath = _options.RagCliPath.Trim();
        if (string.IsNullOrWhiteSpace(cliPath))
            return new List<LocalRagRetrievedChunk>();

        var effectiveQuestion = BuildTargetedReasoningHint(userMessage);
        if (string.IsNullOrWhiteSpace(effectiveQuestion))
            effectiveQuestion = userMessage;

        var moduleUri = new Uri(Path.GetFullPath(cliPath)).AbsoluteUri;
        var searchUri = new Uri(Path.Combine(Path.GetDirectoryName(Path.GetFullPath(cliPath)) ?? "", "search-index.js")).AbsoluteUri;
        var script =
            $"import {{ QsheService }} from {JsonSerializer.Serialize(moduleUri)};" +
            $"import {{ QsheSearchIndex }} from {JsonSerializer.Serialize(searchUri)};" +
            "const service = new QsheService();" +
            "const store = await service.loadIndex();" +
            "const index = new QsheSearchIndex(store);" +
            "const results = index.search(process.env.BB_RAG_QUESTION ?? '', 5).map((result) => ({ fileName: result.chunk.fileName, heading: result.chunk.heading ?? '', relativePath: result.chunk.relativePath, sectionText: result.chunk.sectionText, score: result.score }));" +
            "process.stdout.write(JSON.stringify(results));";

        using var process = new Process
        {
            StartInfo = new ProcessStartInfo
            {
                FileName = "node",
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                StandardOutputEncoding = Encoding.UTF8,
                StandardErrorEncoding = Encoding.UTF8,
                UseShellExecute = false,
                CreateNoWindow = true
            }
        };

        process.StartInfo.ArgumentList.Add("--input-type=module");
        process.StartInfo.ArgumentList.Add("-e");
        process.StartInfo.ArgumentList.Add(script);
        process.StartInfo.Environment["BB_RAG_QUESTION"] = effectiveQuestion;

        if (!string.IsNullOrWhiteSpace(_options.RagVaultRoot))
            process.StartInfo.Environment["QSHE_DOC_ROOT"] = _options.RagVaultRoot.Trim();

        if (!string.IsNullOrWhiteSpace(_options.RagIndexDir))
            process.StartInfo.Environment["QSHE_DOC_INDEX_DIR"] = _options.RagIndexDir.Trim();

        process.Start();

        using var registration = cancellationToken.Register(() =>
        {
            try
            {
                if (!process.HasExited)
                    process.Kill(entireProcessTree: true);
            }
            catch
            {
            }
        });

        var stdoutTask = process.StandardOutput.ReadToEndAsync(cancellationToken);
        var stderrTask = process.StandardError.ReadToEndAsync(cancellationToken);
        await process.WaitForExitAsync(cancellationToken);

        var stdout = await stdoutTask;
        var stderr = await stderrTask;
        if (process.ExitCode != 0)
            throw new InvalidOperationException(string.IsNullOrWhiteSpace(stderr) ? "Local RAG retrieval failed." : stderr.Trim());

        var chunks = JsonSerializer.Deserialize<List<LocalRagRetrievedChunk>>(stdout, JsonOptions) ?? new List<LocalRagRetrievedChunk>();
        var filtered = chunks
            .Where(static chunk => !string.IsNullOrWhiteSpace(chunk.SectionText))
            .OrderByDescending(static chunk => chunk.Score)
            .Where(chunk => chunk.Score >= ResolveRagMinScore())
            .Take(4)
            .ToList();

        filtered = ApplyQueryLexicalSanityFilter(userMessage, filtered);

        if (filtered.Count > 0)
            return filtered;

        var fallbackQuestion = BuildReasoningSearchHint(userMessage);
        if (string.IsNullOrWhiteSpace(fallbackQuestion) ||
            string.Equals(fallbackQuestion, effectiveQuestion, StringComparison.Ordinal))
            return filtered;

        return await RetrieveLocalRagContextAsync(fallbackQuestion, cancellationToken);
    }

    private async Task<string> CompleteRetrievedContextAsync(
        string userMessage,
        List<LocalRagRetrievedChunk> retrievedChunks,
        CancellationToken cancellationToken)
    {
        var baseUrl = (_options.BaseUrl ?? "").Trim().TrimEnd('/');
        var chatPath = (_options.ChatPath ?? "").Trim();
        if (string.IsNullOrWhiteSpace(baseUrl) || string.IsNullOrWhiteSpace(chatPath))
            throw new InvalidOperationException("OpenClaw chat completions endpoint is not configured.");

        var url = $"{baseUrl}{(chatPath.StartsWith('/') ? chatPath : "/" + chatPath)}";
        using var request = new HttpRequestMessage(HttpMethod.Post, url);
        request.Headers.Accept.Add(new MediaTypeWithQualityHeaderValue("application/json"));
        if (!string.IsNullOrWhiteSpace(_options.ApiKey))
            request.Headers.Authorization = new AuthenticationHeaderValue("Bearer", _options.ApiKey.Trim());

        var payload = new
        {
            model = "openclaw",
            temperature = 0,
            messages = new object[]
            {
                new
                {
                    role = "system",
                    content = "Answer only from the supplied RAG excerpts. Do not use outside knowledge. If the excerpts are insufficient, reply exactly with the configured fallback. Write Thai unless the user asked in English."
                },
                new
                {
                    role = "user",
                    content = BuildRetrievedContextEnvelope(userMessage, retrievedChunks)
                }
            }
        };

        request.Content = new StringContent(JsonSerializer.Serialize(payload, JsonOptions), Encoding.UTF8, "application/json");
        using var response = await _http.SendAsync(request, cancellationToken);
        var body = await response.Content.ReadAsStringAsync(cancellationToken);
        if (!response.IsSuccessStatusCode)
            throw new InvalidOperationException(string.IsNullOrWhiteSpace(body) ? "OpenClaw chat completions request failed." : body);

        using var document = JsonDocument.Parse(body);
        if (document.RootElement.TryGetProperty("choices", out var choices) &&
            choices.ValueKind == JsonValueKind.Array &&
            choices.GetArrayLength() > 0)
        {
            var first = choices[0];
            if (first.TryGetProperty("message", out var message) &&
                message.ValueKind == JsonValueKind.Object &&
                TryGetString(message, "content", out var content) &&
                !string.IsNullOrWhiteSpace(content))
            {
                return content.Trim();
            }
        }

        throw new InvalidOperationException("OpenClaw chat completions response did not contain an answer.");
    }

    private List<LocalRagRetrievedChunk> ApplyQueryLexicalSanityFilter(
        string userMessage,
        List<LocalRagRetrievedChunk> chunks)
    {
        if (chunks.Count == 0)
            return chunks;

        var tokens = ExtractLexicalQueryTokens(userMessage);
        if (tokens.Count == 0)
            return chunks;

        var matchedTokenCount = tokens.Count(token => chunks.Any(chunk => ChunkContainsToken(chunk, token)));
        if (matchedTokenCount > 0)
            return chunks;

        return new List<LocalRagRetrievedChunk>();
    }

    private static List<string> ExtractLexicalQueryTokens(string userMessage)
    {
        var expanded = NormalizeForLexicalCheck(userMessage);
        foreach (var separator in LexicalSeparatorTokens)
            expanded = expanded.Replace(separator, " ", StringComparison.Ordinal);

        return Regex.Matches(expanded, "[\\p{IsThai}a-z0-9]+")
            .Select(static match => match.Value.Trim())
            .Where(static token => !string.IsNullOrWhiteSpace(token))
            .Where(static token => token.Length > 1)
            .Where(static token => !ShouldIgnoreLexicalToken(token))
            .Distinct(StringComparer.Ordinal)
            .ToList();
    }

    private static bool ChunkContainsToken(LocalRagRetrievedChunk chunk, string token)
    {
        var haystack = NormalizeForLexicalCheck($"{chunk.Heading}\n{chunk.SectionText}");
        return haystack.Contains(token, StringComparison.Ordinal);
    }

    private static bool ShouldIgnoreLexicalToken(string token)
    {
        return LexicalStopTokens.Contains(token) || IsGenericLexicalToken(token);
    }

    private static bool IsGenericLexicalToken(string token)
    {
        return token is "อะไร" or "คือ" or "หน่อย" or "help" or "what";
    }

    private static string NormalizeForLexicalCheck(string? value)
    {
        return (value ?? "")
            .Normalize(NormalizationForm.FormKC)
            .ToLowerInvariant()
            .Replace("\u0E4D\u0E32", "\u0E33");
    }

    private static readonly HashSet<string> LexicalStopTokens = new(StringComparer.Ordinal)
    {
        "อะไร",
        "คือ",
        "หน่อย",
        "ของ",
        "ใน",
        "ที่",
        "การ",
        "และ",
        "หรือ",
        "กับ",
        "จาก",
        "เพื่อ",
        "help",
        "what",
        "the",
        "is",
        "are"
    };

    private static readonly string[] LexicalSeparatorTokens =
    {
        "ของ",
        "ใน",
        "ที่",
        "การ",
        "และ",
        "หรือ",
        "กับ",
        "จาก",
        "เพื่อ"
    };

    private async Task<LocalRagAnswer?> TryAnswerFromIndexedRagAsync(string question, CancellationToken cancellationToken)
    {
        var indexDir = (_options.RagIndexDir ?? "").Trim();
        if (string.IsNullOrWhiteSpace(indexDir))
            return null;

        var indexPath = Path.Combine(indexDir, "index.json");
        if (!File.Exists(indexPath))
            return null;

        await using var stream = File.OpenRead(indexPath);
        var store = await JsonSerializer.DeserializeAsync<LocalRagIndexStore>(stream, JsonOptions, cancellationToken);
        var chunks = store?.Chunks?.ToList();

        if (chunks is null || chunks.Count == 0)
            return null;

        var normalized = question.Normalize(NormalizationForm.FormKC).ToLowerInvariant().Replace("\u0E4D\u0E32", "\u0E33");

        var productChunks = chunks
            .Where(static chunk => string.Equals(chunk.RelativePath, "REQ-02-Product Description.md", StringComparison.OrdinalIgnoreCase))
            .ToList();
        var haccpPlanChunks = chunks
            .Where(static chunk => string.Equals(chunk.RelativePath, "REQ-08-HACCP Plan.md", StringComparison.OrdinalIgnoreCase))
            .ToList();

        if ((normalized.Contains("ผลิตภัณฑ์") || normalized.Contains("product")) &&
            (normalized.Contains("คือ") || normalized.Contains("อะไร") || normalized.Contains("what")))
        {
            var chunk = productChunks.FirstOrDefault(static chunk => string.Equals(chunk.Heading, "1. Product Identification", StringComparison.Ordinal));
            var implementation = ExtractOrganizationImplementation(chunk?.SectionText ?? "");
            var match = implementation is null ? null : Regex.Match(implementation, "คือ\\s*\"([^\"]+)\"");
            var productName = match is { Success: true } ? match.Groups[1].Value.Trim() : "";

            if (!string.IsNullOrWhiteSpace(productName) && chunk is not null)
            {
                return new LocalRagAnswer
                {
                    Language = "th",
                    Found = true,
                    Summary = $"คำตอบจาก RAG ระบุว่าผลิตภัณฑ์ขององค์กรคือ {productName}",
                    Details = productName,
                    Confidence = "high",
                    Sources = new List<LocalRagSource>
                    {
                        new()
                        {
                            FileName = chunk.FileName,
                            Heading = chunk.Heading,
                            RelativePath = chunk.RelativePath
                        }
                    }
                };
            }
        }

        if ((normalized.Contains("เกณฑ์") || normalized.Contains("คุณภาพ") || normalized.Contains("มาตรฐาน") || normalized.Contains("standard")) &&
            (normalized.Contains("ประปา") || normalized.Contains("tap water") || normalized.Contains("water")))
        {
            var chunk = productChunks.FirstOrDefault(static chunk => string.Equals(chunk.Heading, "2. Product Characteristics", StringComparison.Ordinal));
            var implementation = ExtractOrganizationImplementation(chunk?.SectionText ?? "");
            var bullets = ExtractBulletLines(implementation);
            if (bullets.Count > 0 && chunk is not null)
            {
                return new LocalRagAnswer
                {
                    Language = "th",
                    Found = true,
                    Summary = "คำตอบจาก RAG ระบุเกณฑ์คุณภาพน้ำประปาไว้ในหัวข้อ Product Characteristics",
                    Details = string.Join("\n", bullets.Select(static bullet => $"- {bullet}")),
                    Confidence = "high",
                    Sources = new List<LocalRagSource>
                    {
                        new()
                        {
                            FileName = chunk.FileName,
                            Heading = chunk.Heading,
                            RelativePath = chunk.RelativePath
                        }
                    }
                };
            }
        }

        var asksForCorrectiveAction = normalized.Contains("ตกเกณฑ์")
            || normalized.Contains("critical limit")
            || normalized.Contains("operating limit")
            || normalized.Contains("corrective action")
            || normalized.Contains("ค่าควบคุม")
            || normalized.Contains("ควบคุมทำยังไง");

        if (asksForCorrectiveAction)
        {
            var decisionTreeChunk = haccpPlanChunks.FirstOrDefault(static chunk => string.Equals(chunk.Heading, "Corrective Action Decision Tree", StringComparison.Ordinal));
            var ccpSummaryChunk = haccpPlanChunks.FirstOrDefault(static chunk => string.Equals(chunk.Heading, "CCP Summary", StringComparison.Ordinal));
            if (decisionTreeChunk is not null)
            {
                var lines = ExtractDecisionTreeLines(decisionTreeChunk.SectionText);
                var details = new List<string>();

                if (normalized.Contains("operating limit"))
                {
                    details.AddRange(lines.Where(static line => line.Contains("Operating Limit", StringComparison.OrdinalIgnoreCase) || line.Contains("ปรับอัตราจ่ายคลอรีนทันที", StringComparison.Ordinal)));
                }
                else if (normalized.Contains("critical limit") || normalized.Contains("ตกเกณฑ์") || normalized.Contains("ค่าควบคุม"))
                {
                    details.AddRange(lines.Where(static line =>
                        line.Contains("Critical Limit", StringComparison.OrdinalIgnoreCase) ||
                        line.Contains("รายงานผู้บังคับบัญชา", StringComparison.Ordinal) ||
                        line.Contains("ตรวจ DPS", StringComparison.Ordinal) ||
                        line.Contains("จ่ายคลอรีนปลายสาย", StringComparison.Ordinal) ||
                        line.Contains("เรียกคืนผลิตภัณฑ์", StringComparison.Ordinal) ||
                        line.Contains("กักเก็บและระบายน้ำ", StringComparison.Ordinal) ||
                        line.Contains("ออกใบ CAR", StringComparison.Ordinal)));
                }

                if (details.Count == 0)
                    details = lines;

                if (ccpSummaryChunk is not null)
                {
                    var criticalLimitLine = ExtractMarkdownTableValue(ccpSummaryChunk.SectionText, "Critical Limit");
                    if (!string.IsNullOrWhiteSpace(criticalLimitLine))
                        details.Insert(0, $"Critical Limit: {criticalLimitLine}");
                }

                return new LocalRagAnswer
                {
                    Language = "th",
                    Found = true,
                    Summary = "คำตอบจาก RAG ระบุแนวทางเมื่อค่าตกเกณฑ์ควบคุมไว้ใน Corrective Action Decision Tree",
                    Details = string.Join("\n", details.Distinct().Select(static line => $"- {line}")),
                    Confidence = "high",
                    Sources = new List<LocalRagSource>
                    {
                        new()
                        {
                            FileName = decisionTreeChunk.FileName,
                            Heading = decisionTreeChunk.Heading,
                            RelativePath = decisionTreeChunk.RelativePath
                        }
                    }
                };
            }
        }

        return null;
    }

    private string FormatLocalRagAnswer(LocalRagAnswer answer)
    {
        var fallback = string.IsNullOrWhiteSpace(_options.RagOnlyFallback)
            ? "I don't have that information in the current RAG knowledge base."
            : _options.RagOnlyFallback.Trim();

        if (!answer.Found)
            return fallback;

        var details = answer.Details?.Trim() ?? "";
        var summary = answer.Summary?.Trim() ?? "";
        var sources = answer.Sources ?? new List<LocalRagSource>();

        if (!string.IsNullOrWhiteSpace(details) &&
            !details.Contains('\n') &&
            details.Length <= 120)
        {
            return details;
        }

        var builder = new StringBuilder();
        if (!string.IsNullOrWhiteSpace(summary))
            builder.AppendLine(summary);

        if (!string.IsNullOrWhiteSpace(details))
        {
            if (builder.Length > 0)
                builder.AppendLine();

            builder.Append(details);
        }

        if (sources.Count > 0)
        {
            if (builder.Length > 0)
                builder.AppendLine().AppendLine();

            builder.AppendLine("Sources:");
            for (var i = 0; i < sources.Count; i++)
            {
                var source = sources[i];
                builder.Append(i + 1)
                    .Append(". ")
                    .Append(source.FileName);

                if (!string.IsNullOrWhiteSpace(source.Heading))
                    builder.Append(" > ").Append(source.Heading);

                builder.Append(" (").Append(source.RelativePath).AppendLine(")");
            }
        }

        return builder.ToString().Trim();
    }

    private string BuildRetrievedContextEnvelope(string userMessage, List<LocalRagRetrievedChunk> chunks)
    {
        var fallback = string.IsNullOrWhiteSpace(_options.RagOnlyFallback)
            ? "I don't have that information in the current RAG knowledge base."
            : _options.RagOnlyFallback.Trim();

        var builder = new StringBuilder();
        builder.AppendLine("System policy:")
            .AppendLine("You are BellBeast's RAG-only assistant.")
            .AppendLine("Answer ONLY from the evidence excerpts provided below.")
            .AppendLine("Do NOT browse, search externally, rely on general world knowledge, or invent missing facts.")
            .AppendLine("For analytical questions such as why, how, or whether something is a CCP, synthesize the explanation from the supplied excerpts only.")
            .AppendLine("Prefer a direct answer first, then a short explanation grounded in the excerpts.")
            .Append("If the excerpts are insufficient, reply exactly with: \"")
            .Append(fallback)
            .AppendLine("\"")
            .AppendLine()
            .AppendLine("User request:")
            .AppendLine(userMessage)
            .AppendLine()
            .AppendLine("Retrieved RAG excerpts:");

        for (var i = 0; i < chunks.Count; i++)
        {
            var chunk = chunks[i];
            builder.AppendLine($"[{i + 1}] {chunk.FileName} > {chunk.Heading} ({chunk.RelativePath})")
                .AppendLine(chunk.SectionText.Trim())
                .AppendLine();
        }

        builder.AppendLine("Write the answer in Thai unless the user asked in English. Include a short sources list at the end.");
        return builder.ToString().Trim();
    }

    private static string BuildRagSearchHint(string question)
    {
        if (string.IsNullOrWhiteSpace(question))
            return "";

        var normalized = question.Normalize(NormalizationForm.FormKC).ToLowerInvariant();
        normalized = normalized.Replace("\u0E4D\u0E32", "\u0E33");

        if ((normalized.Contains("ผลิตภัณฑ์") || normalized.Contains("product")) &&
            (normalized.Contains("คือ") || normalized.Contains("อะไร") || normalized.Contains("what")))
        {
            return "What is the product";
        }

        if ((normalized.Contains("เกณฑ์") || normalized.Contains("คุณภาพ") || normalized.Contains("มาตรฐาน")) &&
            (normalized.Contains("ประปา") || normalized.Contains("tap water") || normalized.Contains("water")))
        {
            return "What are the water quality standards";
        }

        if (normalized.Contains("ความขุ่น") || normalized.Contains("turbidity"))
            return "What is the turbidity limit for tap water";

        if (normalized.Contains("คลอรีน") || normalized.Contains("chlorine"))
            return "What is the chlorine residual requirement";

        if (normalized.Contains("ph"))
            return "What is the pH range for tap water";

        if (normalized.Contains("e.coli") || normalized.Contains("แบคทีเรีย"))
            return "What bacteria must not be found in tap water";

        return "";
    }

    private static string BuildReasoningSearchHint(string question)
    {
        var targeted = BuildTargetedReasoningHint(question);
        return string.IsNullOrWhiteSpace(targeted) ? BuildRagSearchHint(question) : targeted;
    }

    private static string BuildTargetedReasoningHint(string question)
    {
        if (string.IsNullOrWhiteSpace(question))
            return "";

        var normalized = question.Normalize(NormalizationForm.FormKC).ToLowerInvariant()
            .Replace("\u0E4D\u0E32", "\u0E33");

        if (normalized.Contains("ccp") && (normalized.Contains("why") || normalized.Contains("ทำไม")))
            return "Why is this point a CCP in the HACCP plan";

        if (normalized.Contains("ccp") && (normalized.Contains("what") || normalized.Contains("คือ")))
            return "What is the CCP in the HACCP plan";

        return "";
    }

    private static string? ExtractOrganizationImplementation(string sectionText)
    {
        if (string.IsNullOrWhiteSpace(sectionText))
            return null;

        var match = Regex.Match(
            sectionText,
            @"\[!success\]\s*Organization Implementation\s*>?\s*([\s\S]*?)(?:\n\s*---|\s*$)",
            RegexOptions.IgnoreCase);

        if (!match.Success)
            return null;

        return string.Join(
                "\n",
                match.Groups[1].Value
                    .Split('\n')
                    .Select(static line => Regex.Replace(line, @"^\s*>\s?", "").TrimEnd()))
            .Trim();
    }

    private static List<string> ExtractBulletLines(string? text)
    {
        if (string.IsNullOrWhiteSpace(text))
            return new List<string>();

        return text
            .Split('\n')
            .Select(static line => line.Trim())
            .Where(static line => line.StartsWith("- ", StringComparison.Ordinal))
            .Select(static line => line[2..].Trim())
            .Where(static line => !string.IsNullOrWhiteSpace(line))
            .ToList();
    }

    private static List<string> ExtractDecisionTreeLines(string? text)
    {
        if (string.IsNullOrWhiteSpace(text))
            return new List<string>();

        return text
            .Split('\n')
            .Select(static line => line.Trim())
            .Where(static line =>
                !string.IsNullOrWhiteSpace(line) &&
                !line.StartsWith("## ", StringComparison.Ordinal) &&
                !line.StartsWith("```", StringComparison.Ordinal) &&
                !line.StartsWith("---", StringComparison.Ordinal))
            .ToList();
    }

    private static string ExtractMarkdownTableValue(string? sectionText, string headerLabel)
    {
        if (string.IsNullOrWhiteSpace(sectionText))
            return "";

        foreach (var rawLine in sectionText.Split('\n'))
        {
            var line = rawLine.Trim();
            if (!line.StartsWith("|", StringComparison.Ordinal))
                continue;

            var cells = line.Trim('|').Split('|').Select(static cell => cell.Trim()).ToArray();
            if (cells.Length < 2)
                continue;

            var key = cells[0].Replace("*", "", StringComparison.Ordinal).Trim();
            if (string.Equals(key, headerLabel, StringComparison.OrdinalIgnoreCase))
                return cells[1].Replace("*", "", StringComparison.Ordinal).Trim();
        }

        return "";
    }

    private static OpenClawMessage CloneMessage(OpenClawMessage message)
    {
        return new OpenClawMessage
        {
            Role = message.Role,
            Content = message.Content
        };
    }

    private static bool IsMatchingGatewayRun(JsonElement payload, string runId, string? sessionKey)
    {
        if (TryGetString(payload, "runId", out var payloadRunId) &&
            !string.Equals(payloadRunId, runId, StringComparison.Ordinal))
        {
            return false;
        }

        if (!string.IsNullOrWhiteSpace(sessionKey) &&
            TryGetString(payload, "sessionKey", out var payloadSessionKey) &&
            !string.Equals(payloadSessionKey, sessionKey, StringComparison.OrdinalIgnoreCase))
        {
            return false;
        }

        return true;
    }

    private static string TryReadAgentDelta(JsonElement payload)
    {
        if (!payload.TryGetProperty("data", out var data) || data.ValueKind != JsonValueKind.Object)
            return "";

        return TryGetString(data, "delta", out var delta) ? delta : "";
    }

    private static string ExtractGatewayMessageText(JsonElement payload)
    {
        if (!payload.TryGetProperty("message", out var message) || message.ValueKind != JsonValueKind.Object)
            return "";

        if (TryGetString(message, "text", out var directText))
            return directText;

        if (!message.TryGetProperty("content", out var content) || content.ValueKind != JsonValueKind.Array)
            return "";

        var builder = new StringBuilder();
        foreach (var item in content.EnumerateArray())
        {
            if (item.ValueKind != JsonValueKind.Object)
                continue;

            if (TryGetString(item, "text", out var text) && !string.IsNullOrEmpty(text))
                builder.Append(text);
        }

        return builder.ToString();
    }

    private static bool IsRole(string? role, string expectedRole)
    {
        return string.Equals(role?.Trim(), expectedRole, StringComparison.OrdinalIgnoreCase);
    }

    private static string NormalizeToken(string? value)
    {
        if (string.IsNullOrWhiteSpace(value))
            return "";

        var builder = new StringBuilder(value.Length);
        foreach (var ch in value.Trim().ToLowerInvariant())
        {
            if (char.IsLetterOrDigit(ch) || ch is '-' or '_')
            {
                builder.Append(ch);
            }
            else if (builder.Length == 0 || builder[^1] != '-')
            {
                builder.Append('-');
            }
        }

        return builder.ToString().Trim('-');
    }

    private static bool TryGetString(JsonElement element, string name, out string value)
    {
        value = "";

        foreach (var prop in element.EnumerateObject())
        {
            if (!string.Equals(prop.Name, name, StringComparison.OrdinalIgnoreCase))
                continue;

            if (prop.Value.ValueKind == JsonValueKind.String)
            {
                value = prop.Value.GetString() ?? "";
                return true;
            }

            return false;
        }

        return false;
    }
}
