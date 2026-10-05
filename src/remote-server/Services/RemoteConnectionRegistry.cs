using System.Collections.Concurrent;

namespace SweFactory.Remote.Server.Services;

public sealed class RemoteConnectionRegistry
{
    private readonly ConcurrentDictionary<string, string> hosts = new();
    private readonly ConcurrentDictionary<string, string> hostByConnection = new();
    private readonly ConcurrentDictionary<string, ConcurrentDictionary<string, byte>> viewers = new();
    private readonly ConcurrentDictionary<string, ConcurrentDictionary<string, byte>> hostsByViewer = new();

    public void SetHost(string hostId, string connectionId)
    {
        if (hosts.TryGetValue(hostId, out var previous))
        {
            hostByConnection.TryRemove(previous, out _);
        }
        hosts[hostId] = connectionId;
        hostByConnection[connectionId] = hostId;
    }

    public string? RemoveHost(string connectionId)
    {
        if (!hostByConnection.TryRemove(connectionId, out var hostId))
        {
            return null;
        }
        hosts.TryRemove(new KeyValuePair<string, string>(hostId, connectionId));
        return hostId;
    }

    public string? GetHostConnection(string hostId) =>
        hosts.TryGetValue(hostId, out var connectionId) ? connectionId : null;

    public bool IsHostOnline(string hostId) => hosts.ContainsKey(hostId);

    public int AddViewer(string hostId, string connectionId)
    {
        var group = viewers.GetOrAdd(hostId, _ => new ConcurrentDictionary<string, byte>());
        group[connectionId] = 0;
        hostsByViewer
            .GetOrAdd(connectionId, _ => new ConcurrentDictionary<string, byte>())[hostId] = 0;
        return group.Count;
    }

    public int RemoveViewer(string hostId, string connectionId)
    {
        if (!viewers.TryGetValue(hostId, out var group))
        {
            return 0;
        }
        group.TryRemove(connectionId, out _);
        if (hostsByViewer.TryGetValue(connectionId, out var viewerHosts))
        {
            viewerHosts.TryRemove(hostId, out _);
            if (viewerHosts.IsEmpty)
            {
                hostsByViewer.TryRemove(
                    new KeyValuePair<string, ConcurrentDictionary<string, byte>>(
                        connectionId,
                        viewerHosts));
            }
        }
        if (group.IsEmpty)
        {
            viewers.TryRemove(new KeyValuePair<string, ConcurrentDictionary<string, byte>>(hostId, group));
            return 0;
        }
        return group.Count;
    }

    public IReadOnlyList<(string HostId, int ViewerCount)> RemoveViewerConnection(
        string connectionId)
    {
        if (!hostsByViewer.TryRemove(connectionId, out var hostIds))
        {
            return [];
        }
        return hostIds.Keys.Select(hostId => (hostId, RemoveViewer(hostId, connectionId))).ToArray();
    }
}
