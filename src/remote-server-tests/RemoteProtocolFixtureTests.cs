using System.Text.Json;
using SweFactory.Remote.Server.Models;

namespace SweFactory.Remote.Server.Tests;

public sealed class RemoteProtocolFixtureTests
{
    private static readonly JsonSerializerOptions JsonOptions = new(JsonSerializerDefaults.Web);

    [Fact]
    public async Task CommandFixtureMatchesServerContract()
    {
        await using var stream = File.OpenRead(Path.Combine(AppContext.BaseDirectory, "fixtures", "command.json"));
        var command = await JsonSerializer.DeserializeAsync<RemoteCommand>(stream, JsonOptions);

        Assert.NotNull(command);
        Assert.Equal("1", command.ProtocolVersion);
        Assert.Equal("sessions.prompt", command.Type);
        Assert.Equal(7, command.ExpectedRevision);
    }

    [Fact]
    public async Task EventFixtureMatchesServerContract()
    {
        await using var stream = File.OpenRead(Path.Combine(AppContext.BaseDirectory, "fixtures", "event.json"));
        var remoteEvent = await JsonSerializer.DeserializeAsync<RemoteEvent>(stream, JsonOptions);

        Assert.NotNull(remoteEvent);
        Assert.Equal("1", remoteEvent.ProtocolVersion);
        Assert.Equal("tasks.changed", remoteEvent.Type);
        Assert.Equal(42, remoteEvent.Sequence);
    }
}
