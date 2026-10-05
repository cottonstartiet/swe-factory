using System.Collections.Concurrent;

namespace SweFactory.Remote.Server.Services;

public sealed class RemoteRateLimiter
{
    private readonly ConcurrentDictionary<string, Window> windows = new();

    public bool TryAcquire(string key, int limit, TimeSpan duration)
    {
        var now = DateTimeOffset.UtcNow;
        var window = windows.AddOrUpdate(
            key,
            _ => new Window(now.Add(duration), 1),
            (_, current) =>
                current.ExpiresAt <= now
                    ? new Window(now.Add(duration), 1)
                    : current with { Count = current.Count + 1 });
        return window.Count <= limit;
    }

    private sealed record Window(DateTimeOffset ExpiresAt, int Count);
}
