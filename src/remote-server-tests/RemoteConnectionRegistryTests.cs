using SweFactory.Remote.Server.Services;

namespace SweFactory.Remote.Server.Tests;

public sealed class RemoteConnectionRegistryTests
{
    [Fact]
    public void ReplacingHostConnectionInvalidatesPreviousConnection()
    {
        var registry = new RemoteConnectionRegistry();

        registry.SetHost("host", "first");
        registry.SetHost("host", "second");

        Assert.Null(registry.RemoveHost("first"));
        Assert.Equal("second", registry.GetHostConnection("host"));
        Assert.Equal("host", registry.RemoveHost("second"));
        Assert.False(registry.IsHostOnline("host"));
    }

    [Fact]
    public void ViewerCountsAreDeduplicated()
    {
        var registry = new RemoteConnectionRegistry();

        Assert.Equal(1, registry.AddViewer("host", "viewer"));
        Assert.Equal(1, registry.AddViewer("host", "viewer"));
        Assert.Equal(0, registry.RemoveViewer("host", "viewer"));
    }

    [Fact]
    public void DisconnectRemovesViewerFromEveryHost()
    {
        var registry = new RemoteConnectionRegistry();
        registry.AddViewer("one", "viewer");
        registry.AddViewer("two", "viewer");

        var removed = registry.RemoveViewerConnection("viewer");

        Assert.Equal(2, removed.Count);
        Assert.All(removed, value => Assert.Equal(0, value.ViewerCount));
    }
}
