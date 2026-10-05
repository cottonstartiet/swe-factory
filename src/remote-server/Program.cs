using Microsoft.AspNetCore.Authentication;
using Microsoft.AspNetCore.Authentication.Cookies;
using Microsoft.AspNetCore.HttpOverrides;
using Microsoft.AspNetCore.SignalR;
using SweFactory.Remote.Server.Auth;
using SweFactory.Remote.Server.Data;
using SweFactory.Remote.Server.Hubs;
using SweFactory.Remote.Server.Models;
using SweFactory.Remote.Server.Services;

var builder = WebApplication.CreateBuilder(
    new WebApplicationOptions
    {
        Args = args,
        WebRootPath = Path.Combine(AppContext.BaseDirectory, "wwwroot")
    });
var requireHttps = builder.Configuration.GetValue("RemoteServer:RequireHttps", true);

builder.Services
    .AddOptions<DemoAuthOptions>()
    .Bind(builder.Configuration.GetSection(DemoAuthOptions.SectionName))
    .ValidateDataAnnotations()
    .ValidateOnStart();
builder.Services
    .AddOptions<RemoteServerOptions>()
    .Bind(builder.Configuration.GetSection(RemoteServerOptions.SectionName))
    .ValidateDataAnnotations()
    .ValidateOnStart();
builder.Services.AddSingleton(serviceProvider =>
    serviceProvider.GetRequiredService<Microsoft.Extensions.Options.IOptions<DemoAuthOptions>>().Value);
builder.Services.AddSingleton(serviceProvider =>
    serviceProvider.GetRequiredService<Microsoft.Extensions.Options.IOptions<RemoteServerOptions>>().Value);

builder.Services
    .AddAuthentication(options =>
    {
        options.DefaultScheme = RemoteAuthenticationDefaults.Scheme;
        options.DefaultAuthenticateScheme = RemoteAuthenticationDefaults.Scheme;
        options.DefaultChallengeScheme = CookieAuthenticationDefaults.AuthenticationScheme;
    })
    .AddPolicyScheme(
        RemoteAuthenticationDefaults.Scheme,
        RemoteAuthenticationDefaults.Scheme,
        options =>
        {
            options.ForwardDefaultSelector = context =>
                HostTokenAuthenticationHandler.HasHostToken(context.Request)
                    ? HostTokenAuthenticationDefaults.Scheme
                    : CookieAuthenticationDefaults.AuthenticationScheme;
        })
    .AddCookie(options =>
    {
            options.Cookie.Name =
                requireHttps ? "__Host-swe_factory_remote" : "swe_factory_remote";
        options.Cookie.HttpOnly = true;
        options.Cookie.SameSite = SameSiteMode.Strict;
        options.Cookie.SecurePolicy =
            requireHttps ? CookieSecurePolicy.Always : CookieSecurePolicy.SameAsRequest;
        options.SlidingExpiration = false;
        options.ExpireTimeSpan = TimeSpan.FromHours(8);
        options.Events.OnRedirectToLogin = context =>
        {
            context.Response.StatusCode = StatusCodes.Status401Unauthorized;
            return Task.CompletedTask;
        };
    })
    .AddScheme<AuthenticationSchemeOptions, HostTokenAuthenticationHandler>(
        HostTokenAuthenticationDefaults.Scheme,
        _ => { });

builder.Services.AddAuthorization();
builder.Services.AddAntiforgery(options =>
{
    options.Cookie.Name =
        requireHttps ? "__Host-swe_factory_remote_csrf" : "swe_factory_remote_csrf";
    options.Cookie.HttpOnly = true;
    options.Cookie.SameSite = SameSiteMode.Strict;
    options.Cookie.SecurePolicy =
        requireHttps ? CookieSecurePolicy.Always : CookieSecurePolicy.SameAsRequest;
    options.HeaderName = "x-swe-factory-csrf";
});
builder.Services
    .AddSignalR(options =>
    {
        options.MaximumReceiveMessageSize = 256 * 1024;
        options.EnableDetailedErrors = false;
        options.MaximumParallelInvocationsPerClient = 4;
        options.ClientTimeoutInterval = TimeSpan.FromSeconds(45);
        options.KeepAliveInterval = TimeSpan.FromSeconds(15);
    })
    .AddJsonProtocol();

builder.Services.AddSingleton<RemoteMetadataStore>();
builder.Services.AddSingleton<RemoteConnectionRegistry>();
builder.Services.AddSingleton<RemoteRateLimiter>();
builder.Services.AddHealthChecks();

var app = builder.Build();

var forwardedHeaders = new ForwardedHeadersOptions
{
    ForwardedHeaders = ForwardedHeaders.XForwardedFor | ForwardedHeaders.XForwardedProto,
    ForwardLimit = 1
};
forwardedHeaders.KnownNetworks.Clear();
forwardedHeaders.KnownProxies.Clear();
app.UseForwardedHeaders(forwardedHeaders);
if (requireHttps)
{
    app.UseHttpsRedirection();
}
app.UseDefaultFiles();
app.UseStaticFiles();
app.UseAuthentication();
app.UseAuthorization();
app.UseAntiforgery();

var store = app.Services.GetRequiredService<RemoteMetadataStore>();
await store.InitializeAsync();

static async Task<bool> HasValidAntiforgeryTokenAsync(
    HttpContext context,
    Microsoft.AspNetCore.Antiforgery.IAntiforgery antiforgery)
{
    try
    {
        await antiforgery.ValidateRequestAsync(context);
        return true;
    }
    catch (Microsoft.AspNetCore.Antiforgery.AntiforgeryValidationException)
    {
        return false;
    }
}

app.MapGet("/health/live", () => Results.Ok(new { status = "live" }));
app.MapHealthChecks("/health/ready");

app.MapPost(
    "/api/auth/login",
    async (
        DemoLoginRequest request,
        HttpContext context,
        DemoAuthOptions options,
        RemoteRateLimiter rateLimiter,
        CancellationToken cancellationToken) =>
    {
        if (!rateLimiter.TryAcquire($"login:{request.UserName}", 5, TimeSpan.FromMinutes(1)))
        {
            return Results.Problem("Too many login attempts.", statusCode: StatusCodes.Status429TooManyRequests);
        }

        if (!DemoAuthentication.Validate(request, options))
        {
            await Task.Delay(TimeSpan.FromMilliseconds(250), cancellationToken);
            return Results.Unauthorized();
        }

        await DemoAuthentication.SignInAsync(context, options);
        return Results.Ok(new AuthSession(options.Subject, options.DisplayName));
    });

app.MapPost(
        "/api/auth/logout",
        async (
            HttpContext context,
            Microsoft.AspNetCore.Antiforgery.IAntiforgery antiforgery) =>
        {
            if (!await HasValidAntiforgeryTokenAsync(context, antiforgery))
            {
                return Results.BadRequest();
            }
            await context.SignOutAsync(CookieAuthenticationDefaults.AuthenticationScheme);
            return Results.NoContent();
        })
        .RequireAuthorization();

app.MapGet(
    "/api/auth/session",
    (HttpContext context, DemoAuthOptions options, Microsoft.AspNetCore.Antiforgery.IAntiforgery antiforgery) =>
    {
        if (context.User.Identity?.IsAuthenticated != true)
        {
            return Results.Ok(new { authenticated = false });
        }

        var tokens = antiforgery.GetAndStoreTokens(context);
        return Results.Ok(new
        {
            authenticated = true,
            user = new AuthSession(options.Subject, options.DisplayName),
            csrfToken = tokens.RequestToken
        });
    });

app.MapPost(
    "/api/link/challenges",
    async (
        CreateLinkChallengeRequest request,
        RemoteMetadataStore metadata,
        RemoteServerOptions options,
        HttpContext context,
        CancellationToken cancellationToken) =>
    {
        var challenge = await metadata.CreateLinkChallengeAsync(request, cancellationToken);
        var publicOrigin = options.PublicOrigin.TrimEnd('/');
        return Results.Ok(new CreateLinkChallengeResponse(
            challenge.Code,
            $"{publicOrigin}/link?code={Uri.EscapeDataString(challenge.Code)}",
            challenge.ExpiresAt));
    });

app.MapGet(
    "/api/link/challenges/{code}",
    async (
        string code,
        RemoteMetadataStore metadata,
        HttpContext context,
        CancellationToken cancellationToken) =>
    {
        var subject = context.User.GetRequiredSubject();
        var challenge = await metadata.GetLinkChallengeAsync(code, cancellationToken);
        return challenge is null
            ? Results.NotFound()
            : Results.Ok(new LinkChallengeView(
                challenge.HostId,
                challenge.HostName,
                challenge.ProtocolVersion,
                challenge.ExpiresAt,
                challenge.ConfirmedSubject is not null,
                subject));
    })
    .RequireAuthorization();

app.MapPost(
    "/api/link/challenges/{code}/confirm",
    async (
        string code,
        RemoteMetadataStore metadata,
        HttpContext context,
        Microsoft.AspNetCore.Antiforgery.IAntiforgery antiforgery,
        CancellationToken cancellationToken) =>
    {
        if (!await HasValidAntiforgeryTokenAsync(context, antiforgery))
        {
            return Results.BadRequest();
        }
        var subject = context.User.GetRequiredSubject();
        var displayName = context.User.Identity?.Name ?? subject;
        var confirmed = await metadata.ConfirmLinkChallengeAsync(
            code,
            subject,
            displayName,
            cancellationToken);
        return confirmed ? Results.NoContent() : Results.NotFound();
    })
    .RequireAuthorization();

app.MapPost(
    "/api/link/challenges/{code}/complete",
    async (
        string code,
        CompleteLinkChallengeRequest request,
        RemoteMetadataStore metadata,
        RemoteRateLimiter rateLimiter,
        CancellationToken cancellationToken) =>
    {
        if (!rateLimiter.TryAcquire($"link:{request.HostId}", 30, TimeSpan.FromMinutes(1)))
        {
            return Results.Problem("Too many link attempts.", statusCode: StatusCodes.Status429TooManyRequests);
        }

        var result = await metadata.CompleteLinkChallengeAsync(code, request.HostId, cancellationToken);
        if (!result.Found)
        {
            return Results.NotFound();
        }
        return result.Response is null ? Results.Accepted() : Results.Ok(result.Response);
    });

app.MapGet(
    "/api/hosts",
    async (
        HttpContext context,
        RemoteMetadataStore metadata,
        RemoteConnectionRegistry connections,
        CancellationToken cancellationToken) =>
    {
        var subject = context.User.GetRequiredSubject();
        var hosts = await metadata.ListHostsAsync(subject, cancellationToken);
        return Results.Ok(hosts.Select(host => host with { Online = connections.IsHostOnline(host.Id) }));
    })
    .RequireAuthorization();

app.MapDelete(
    "/api/hosts/{hostId}",
    async (
        string hostId,
        HttpContext context,
        RemoteMetadataStore metadata,
        RemoteConnectionRegistry connections,
        IHubContext<RemoteHub> hub,
        Microsoft.AspNetCore.Antiforgery.IAntiforgery antiforgery,
        CancellationToken cancellationToken) =>
    {
        if (!await HasValidAntiforgeryTokenAsync(context, antiforgery))
        {
            return Results.BadRequest();
        }
        var subject = context.User.GetRequiredSubject();
        if (!await metadata.RevokeHostAsync(subject, hostId, cancellationToken))
        {
            return Results.NotFound();
        }

        var connectionId = connections.GetHostConnection(hostId);
        if (connectionId is not null)
        {
            await hub.Clients.Client(connectionId).SendAsync("LinkRevoked", cancellationToken);
            connections.RemoveHost(connectionId);
        }

        return Results.NoContent();
    })
    .RequireAuthorization();

app.MapHub<RemoteHub>("/hubs/remote");
app.MapFallbackToFile("index.html");

app.Run();

public partial class Program;
