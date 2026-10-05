using Microsoft.Extensions.Options;
using SweFactory.Remote.Server.Data;
using SweFactory.Remote.Server.Models;

namespace SweFactory.Remote.Server.Tests;

public sealed class RemoteMetadataStoreTests : IAsyncLifetime
{
    private readonly string databasePath =
        Path.Combine(Path.GetTempPath(), $"swe-factory-remote-{Guid.NewGuid():N}.db");
    private RemoteMetadataStore store = null!;

    public async Task InitializeAsync()
    {
        store = new RemoteMetadataStore(
            Options.Create(
                new RemoteServerOptions
                {
                    PublicOrigin = "https://remote.example",
                    DatabasePath = databasePath
                }));
        await store.InitializeAsync();
    }

    public Task DisposeAsync()
    {
        foreach (var suffix in new[] { "", "-shm", "-wal" })
        {
            var path = databasePath + suffix;
            if (File.Exists(path))
            {
                File.Delete(path);
            }
        }
        return Task.CompletedTask;
    }

    [Fact]
    public async Task ConfirmedChallengeIssuesOneHostCredential()
    {
        var challenge = await store.CreateLinkChallengeAsync(
            new CreateLinkChallengeRequest("host-1", "Laptop", "1"),
            CancellationToken.None);

        Assert.True(
            await store.ConfirmLinkChallengeAsync(
                challenge.Code,
                "demo-user",
                "Demo User",
                CancellationToken.None));

        var completion = await store.CompleteLinkChallengeAsync(
            challenge.Code,
            "host-1",
            CancellationToken.None);
        var completed = Assert.IsType<CompleteLinkChallengeResponse>(completion.Response);

        Assert.StartsWith("host_", completed.HostToken);
        Assert.False(
            (await store.CompleteLinkChallengeAsync(
                    challenge.Code,
                    "host-1",
                    CancellationToken.None))
                .Found);

        var identity = await store.AuthenticateHostAsync(
            completed.HostToken,
            CancellationToken.None);
        Assert.Equal("demo-user", identity?.OwnerSubject);
    }

    [Fact]
    public async Task RevocationRemovesOwnershipAndAuthentication()
    {
        var challenge = await store.CreateLinkChallengeAsync(
            new CreateLinkChallengeRequest("host-2", "Workstation", "1"),
            CancellationToken.None);
        await store.ConfirmLinkChallengeAsync(
            challenge.Code,
            "owner",
            "Owner",
            CancellationToken.None);
        var completed = Assert.IsType<CompleteLinkChallengeResponse>(
            (await store.CompleteLinkChallengeAsync(
                    challenge.Code,
                    "host-2",
                    CancellationToken.None))
                .Response);

        Assert.True(await store.UserOwnsHostAsync("owner", "host-2", CancellationToken.None));
        Assert.True(await store.RevokeHostAsync("owner", "host-2", CancellationToken.None));
        Assert.False(await store.UserOwnsHostAsync("owner", "host-2", CancellationToken.None));
        Assert.Null(await store.AuthenticateHostAsync(completed.HostToken, CancellationToken.None));
    }
}
