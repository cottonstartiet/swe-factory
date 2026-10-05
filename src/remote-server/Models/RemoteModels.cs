using System.ComponentModel.DataAnnotations;
using System.Text.Json;

namespace SweFactory.Remote.Server.Models;

public sealed record DemoLoginRequest(
    [property: Required] string UserName,
    [property: Required] string Password);

public sealed record AuthSession(string Subject, string DisplayName);

public sealed record CreateLinkChallengeRequest(
    [property: Required] string HostId,
    [property: Required, MaxLength(80)] string HostName,
    [property: Required] string ProtocolVersion);

public sealed record CreateLinkChallengeResponse(
    string Code,
    string LinkUrl,
    DateTimeOffset ExpiresAt);

public sealed record CompleteLinkChallengeRequest([property: Required] string HostId);

public sealed record CompleteLinkChallengeResponse(
    string HostId,
    string HostToken,
    string OwnerSubject,
    string OwnerDisplayName);

public sealed record LinkCompletionResult(bool Found, CompleteLinkChallengeResponse? Response);

public sealed record LinkChallengeView(
    string HostId,
    string HostName,
    string ProtocolVersion,
    DateTimeOffset ExpiresAt,
    bool Confirmed,
    string CurrentSubject);

public sealed record LinkChallenge(
    string Code,
    string HostId,
    string HostName,
    string ProtocolVersion,
    DateTimeOffset ExpiresAt,
    string? ConfirmedSubject);

public sealed record HostIdentity(
    string Id,
    string OwnerSubject,
    string Name,
    string ProtocolVersion);

public sealed record RemoteHostView(
    string Id,
    string Name,
    string ProtocolVersion,
    DateTimeOffset LinkedAt,
    bool Online);

public sealed record HostSubscription(string HostId, bool Online, int ViewerCount);

public sealed record RemoteCommand(
    [property: Required] string Id,
    [property: Required] string ProtocolVersion,
    [property: Required] string Type,
    long? ExpectedRevision,
    JsonElement Payload);

public sealed record RemoteCommandResult(
    string Id,
    bool Ok,
    string? ErrorCode,
    string? ErrorMessage,
    long? Revision,
    JsonElement? Payload)
{
    public static RemoteCommandResult Failure(string id, string code, string message) =>
        new(id, false, code, message, null, null);
}

public sealed record RemoteEvent(
    [property: Required] string ProtocolVersion,
    [property: Required] string Type,
    long Sequence,
    long? Revision,
    JsonElement Payload);

public sealed class RemoteServerOptions
{
    public const string SectionName = "RemoteServer";

    [Required]
    public string PublicOrigin { get; init; } = "";

    [Required]
    public string DatabasePath { get; init; } = "";

    public bool RequireHttps { get; init; } = true;
}
