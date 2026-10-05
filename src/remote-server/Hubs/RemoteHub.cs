using System.Text.Json;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.SignalR;
using SweFactory.Remote.Server.Auth;
using SweFactory.Remote.Server.Data;
using SweFactory.Remote.Server.Models;
using SweFactory.Remote.Server.Services;

namespace SweFactory.Remote.Server.Hubs;

[Authorize]
public sealed class RemoteHub(
    RemoteMetadataStore metadata,
    RemoteConnectionRegistry connections,
    RemoteRateLimiter rateLimiter,
    ILogger<RemoteHub> logger)
    : Hub
{
    public override async Task OnConnectedAsync()
    {
        var hostId = Context.User?.GetHostId();
        if (hostId is not null)
        {
            connections.SetHost(hostId, Context.ConnectionId);
            await Groups.AddToGroupAsync(Context.ConnectionId, HostGroup(hostId));
            await Clients.Group(BrowserGroup(hostId)).SendAsync("HostPresenceChanged", true);
            logger.LogInformation("Host connected {HostId} {ConnectionId}", hostId, Context.ConnectionId);
        }
        await base.OnConnectedAsync();
    }

    public override async Task OnDisconnectedAsync(Exception? exception)
    {
        foreach (var (viewerHostId, viewerCount) in connections.RemoveViewerConnection(Context.ConnectionId))
        {
            var hostConnection = connections.GetHostConnection(viewerHostId);
            if (hostConnection is not null)
            {
                await Clients.Client(hostConnection)
                    .SendAsync("ViewerSubscriptionChanged", viewerCount);
            }
        }
        var hostId = connections.RemoveHost(Context.ConnectionId);
        if (hostId is not null)
        {
            await Clients.Group(BrowserGroup(hostId)).SendAsync("HostPresenceChanged", false);
            logger.LogInformation(
                "Host disconnected {HostId} {ConnectionId} {Reason}",
                hostId,
                Context.ConnectionId,
                exception?.GetType().Name ?? "closed");
        }
        await base.OnDisconnectedAsync(exception);
    }

    public async Task<HostSubscription> SubscribeHost(string hostId)
    {
        EnsureBrowser();
        var subject = Context.User!.GetRequiredSubject();
        if (!await metadata.UserOwnsHostAsync(subject, hostId, Context.ConnectionAborted))
        {
            throw new HubException("Host not found.");
        }

        await Groups.AddToGroupAsync(Context.ConnectionId, BrowserGroup(hostId));
        var viewers = connections.AddViewer(hostId, Context.ConnectionId);
        var hostConnection = connections.GetHostConnection(hostId);
        if (hostConnection is not null)
        {
            await Clients.Client(hostConnection).SendAsync("ViewerSubscriptionChanged", viewers);
        }
        return new HostSubscription(hostId, hostConnection is not null, viewers);
    }

    public async Task UnsubscribeHost(string hostId)
    {
        EnsureBrowser();
        await Groups.RemoveFromGroupAsync(Context.ConnectionId, BrowserGroup(hostId));
        var viewers = connections.RemoveViewer(hostId, Context.ConnectionId);
        var hostConnection = connections.GetHostConnection(hostId);
        if (hostConnection is not null)
        {
            await Clients.Client(hostConnection).SendAsync("ViewerSubscriptionChanged", viewers);
        }
    }

    public async Task<RemoteCommandResult> ExecuteCommand(string hostId, RemoteCommand command)
    {
        EnsureBrowser();
        var subject = Context.User!.GetRequiredSubject();
        if (!await metadata.UserOwnsHostAsync(subject, hostId, Context.ConnectionAborted))
        {
            throw new HubException("Host not found.");
        }
        var readOnly = IsReadOnlyCommand(command.Type);
        var rateLimit = readOnly ? 600 : 60;
        var rateClass = readOnly ? "query" : "mutation";
        if (!rateLimiter.TryAcquire(
                $"command:{rateClass}:{subject}:{hostId}",
                rateLimit,
                TimeSpan.FromMinutes(1)))
        {
            throw new HubException("Remote command rate limit exceeded.");
        }
        if (command.Payload.GetRawText().Length > 128 * 1024)
        {
            throw new HubException("Remote command payload is too large.");
        }

        var hostConnection = connections.GetHostConnection(hostId)
            ?? throw new HubException("Host is offline.");
        using var timeout = CancellationTokenSource.CreateLinkedTokenSource(Context.ConnectionAborted);
        timeout.CancelAfter(TimeSpan.FromSeconds(30));
        try
        {
            return await Clients.Client(hostConnection)
                .InvokeAsync<RemoteCommandResult>("ExecuteCommand", command, timeout.Token);
        }
        catch (OperationCanceledException) when (!Context.ConnectionAborted.IsCancellationRequested)
        {
            return RemoteCommandResult.Failure(command.Id, "timeout", "The desktop did not respond in time.");
        }
    }

    public async Task PublishEvent(RemoteEvent remoteEvent)
    {
        var hostId = RequireHost();
        if (remoteEvent.Payload.GetRawText().Length > 192 * 1024)
        {
            throw new HubException("Remote event payload is too large.");
        }
        await Clients.Group(BrowserGroup(hostId)).SendAsync("RemoteEvent", remoteEvent);
    }

    private void EnsureBrowser()
    {
        if (Context.User?.GetHostId() is not null)
        {
            throw new HubException("Host connections cannot invoke browser methods.");
        }
    }

    private string RequireHost() =>
        Context.User?.GetHostId() ?? throw new HubException("A linked host credential is required.");

    private static bool IsReadOnlyCommand(string type) =>
        type is "snapshot.get"
            or "repositories.list"
            or "worktrees.list"
            or "sessions.history"
            or "sessions.snapshot";

    private static string HostGroup(string hostId) => $"host:{hostId}";
    private static string BrowserGroup(string hostId) => $"browser:{hostId}";
}
