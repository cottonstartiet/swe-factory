using System.Security.Claims;
using System.Text.Encodings.Web;
using Microsoft.AspNetCore.Authentication;
using Microsoft.Extensions.Options;
using SweFactory.Remote.Server.Data;

namespace SweFactory.Remote.Server.Auth;

public static class HostTokenAuthenticationDefaults
{
    public const string Scheme = "HostToken";
}

public static class RemoteAuthenticationDefaults
{
    public const string Scheme = "Remote";
}

public sealed class HostTokenAuthenticationHandler(
    IOptionsMonitor<AuthenticationSchemeOptions> options,
    ILoggerFactory logger,
    UrlEncoder encoder,
    RemoteMetadataStore metadata)
    : AuthenticationHandler<AuthenticationSchemeOptions>(options, logger, encoder)
{
    public static bool HasHostToken(HttpRequest request) =>
        request.Headers.Authorization.ToString().StartsWith("Bearer host_", StringComparison.Ordinal)
        || request.Query["access_token"].ToString().StartsWith("host_", StringComparison.Ordinal);

    protected override async Task<AuthenticateResult> HandleAuthenticateAsync()
    {
        var authorization = Request.Headers.Authorization.ToString();
        var token = authorization.StartsWith("Bearer ", StringComparison.OrdinalIgnoreCase)
            ? authorization["Bearer ".Length..]
            : Request.Query["access_token"].ToString();
        if (!token.StartsWith("host_", StringComparison.Ordinal))
        {
            return AuthenticateResult.NoResult();
        }

        var host = await metadata.AuthenticateHostAsync(token, Context.RequestAborted);
        if (host is null)
        {
            return AuthenticateResult.Fail("Invalid or revoked host credential.");
        }

        var claims = new[]
        {
            new Claim(ClaimTypes.NameIdentifier, host.OwnerSubject),
            new Claim(ClaimTypes.Name, host.Name),
            new Claim(RemoteClaimTypes.HostId, host.Id),
            new Claim(RemoteClaimTypes.ProtocolVersion, host.ProtocolVersion)
        };
        var principal = new ClaimsPrincipal(new ClaimsIdentity(claims, Scheme.Name));
        return AuthenticateResult.Success(new AuthenticationTicket(principal, Scheme.Name));
    }
}

public static class RemoteClaimTypes
{
    public const string HostId = "swe_factory_host_id";
    public const string ProtocolVersion = "swe_factory_protocol_version";
}

public static class ClaimsPrincipalExtensions
{
    public static string GetRequiredSubject(this ClaimsPrincipal principal) =>
        principal.FindFirstValue(ClaimTypes.NameIdentifier)
        ?? throw new InvalidOperationException("Authenticated principal has no subject.");

    public static string? GetHostId(this ClaimsPrincipal principal) =>
        principal.FindFirstValue(RemoteClaimTypes.HostId);
}
