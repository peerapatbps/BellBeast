public sealed class OpenClawChat2Options : OpenClawOptions
{
}

public sealed class OpenClawChat2Service : OpenClawChatService
{
    public OpenClawChat2Service(HttpClient http, OpenClawChat2Options options)
        : base(http, options)
    {
    }
}
