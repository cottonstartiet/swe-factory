using System.Security.Cryptography;
using System.Text;
using Microsoft.Data.Sqlite;
using Microsoft.Extensions.Options;
using SweFactory.Remote.Server.Models;

namespace SweFactory.Remote.Server.Data;

public sealed class RemoteMetadataStore(IOptions<RemoteServerOptions> options)
{
    private readonly string databasePath = options.Value.DatabasePath;
    private readonly string connectionString =
        new SqliteConnectionStringBuilder
        {
            DataSource = options.Value.DatabasePath,
            Pooling = false
        }.ToString();

    public async Task InitializeAsync()
    {
        var directory = Path.GetDirectoryName(Path.GetFullPath(databasePath));
        if (directory is not null)
        {
            Directory.CreateDirectory(directory);
        }
        await using var connection = await OpenAsync(CancellationToken.None);
        await using var command = connection.CreateCommand();
        command.CommandText =
            """
            PRAGMA journal_mode = WAL;
            CREATE TABLE IF NOT EXISTS link_challenges (
                code_hash TEXT PRIMARY KEY,
                host_id TEXT NOT NULL,
                host_name TEXT NOT NULL,
                protocol_version TEXT NOT NULL,
                expires_at TEXT NOT NULL,
                confirmed_subject TEXT,
                confirmed_display_name TEXT,
                completed_at TEXT
            );
            CREATE TABLE IF NOT EXISTS hosts (
                id TEXT PRIMARY KEY,
                owner_subject TEXT NOT NULL,
                name TEXT NOT NULL,
                protocol_version TEXT NOT NULL,
                token_hash TEXT NOT NULL UNIQUE,
                credential_version INTEGER NOT NULL,
                linked_at TEXT NOT NULL,
                revoked_at TEXT
            );
            CREATE INDEX IF NOT EXISTS idx_hosts_owner ON hosts(owner_subject, revoked_at);
            """;
        await command.ExecuteNonQueryAsync();
    }

    public async Task<LinkChallenge> CreateLinkChallengeAsync(
        CreateLinkChallengeRequest request,
        CancellationToken cancellationToken)
    {
        var code = CryptoToken.Create("link_", 32);
        var challenge = new LinkChallenge(
            code,
            request.HostId,
            request.HostName.Trim(),
            request.ProtocolVersion,
            DateTimeOffset.UtcNow.AddMinutes(5),
            null);
        await using var connection = await OpenAsync(cancellationToken);
        await using (var cleanup = connection.CreateCommand())
        {
            cleanup.CommandText = "DELETE FROM link_challenges WHERE expires_at <= $now";
            cleanup.Parameters.AddWithValue("$now", DateTimeOffset.UtcNow.ToString("O"));
            await cleanup.ExecuteNonQueryAsync(cancellationToken);
        }
        await using var command = connection.CreateCommand();
        command.CommandText =
            """
            INSERT INTO link_challenges (
                code_hash, host_id, host_name, protocol_version, expires_at
            ) VALUES ($code_hash, $host_id, $host_name, $protocol_version, $expires_at)
            """;
        command.Parameters.AddWithValue("$code_hash", CryptoToken.Hash(code));
        command.Parameters.AddWithValue("$host_id", challenge.HostId);
        command.Parameters.AddWithValue("$host_name", challenge.HostName);
        command.Parameters.AddWithValue("$protocol_version", challenge.ProtocolVersion);
        command.Parameters.AddWithValue("$expires_at", challenge.ExpiresAt.ToString("O"));
        await command.ExecuteNonQueryAsync(cancellationToken);
        return challenge;
    }

    public async Task<LinkChallenge?> GetLinkChallengeAsync(
        string code,
        CancellationToken cancellationToken)
    {
        await using var connection = await OpenAsync(cancellationToken);
        await using var command = connection.CreateCommand();
        command.CommandText =
            """
            SELECT host_id, host_name, protocol_version, expires_at, confirmed_subject
            FROM link_challenges
            WHERE code_hash = $code_hash AND completed_at IS NULL AND expires_at > $now
            """;
        command.Parameters.AddWithValue("$code_hash", CryptoToken.Hash(code));
        command.Parameters.AddWithValue("$now", DateTimeOffset.UtcNow.ToString("O"));
        await using var reader = await command.ExecuteReaderAsync(cancellationToken);
        if (!await reader.ReadAsync(cancellationToken))
        {
            return null;
        }

        return new LinkChallenge(
            code,
            reader.GetString(0),
            reader.GetString(1),
            reader.GetString(2),
            DateTimeOffset.Parse(reader.GetString(3)),
            reader.IsDBNull(4) ? null : reader.GetString(4));
    }

    public async Task<bool> ConfirmLinkChallengeAsync(
        string code,
        string subject,
        string displayName,
        CancellationToken cancellationToken)
    {
        await using var connection = await OpenAsync(cancellationToken);
        await using var command = connection.CreateCommand();
        command.CommandText =
            """
            UPDATE link_challenges
            SET confirmed_subject = $subject, confirmed_display_name = $display_name
            WHERE code_hash = $code_hash
              AND completed_at IS NULL
              AND confirmed_subject IS NULL
              AND expires_at > $now
            """;
        command.Parameters.AddWithValue("$subject", subject);
        command.Parameters.AddWithValue("$display_name", displayName);
        command.Parameters.AddWithValue("$code_hash", CryptoToken.Hash(code));
        command.Parameters.AddWithValue("$now", DateTimeOffset.UtcNow.ToString("O"));
        return await command.ExecuteNonQueryAsync(cancellationToken) == 1;
    }

    public async Task<LinkCompletionResult> CompleteLinkChallengeAsync(
        string code,
        string hostId,
        CancellationToken cancellationToken)
    {
        await using var connection = await OpenAsync(cancellationToken);
        await using var transaction = await connection.BeginTransactionAsync(cancellationToken);
        await using var select = connection.CreateCommand();
        select.Transaction = (SqliteTransaction)transaction;
        select.CommandText =
            """
            SELECT host_name, protocol_version, confirmed_subject, confirmed_display_name
            FROM link_challenges
            WHERE code_hash = $code_hash
              AND host_id = $host_id
              AND completed_at IS NULL
              AND expires_at > $now
            """;
        select.Parameters.AddWithValue("$code_hash", CryptoToken.Hash(code));
        select.Parameters.AddWithValue("$host_id", hostId);
        select.Parameters.AddWithValue("$now", DateTimeOffset.UtcNow.ToString("O"));
        await using var reader = await select.ExecuteReaderAsync(cancellationToken);
        if (!await reader.ReadAsync(cancellationToken))
        {
            return new LinkCompletionResult(false, null);
        }
        if (reader.IsDBNull(2))
        {
            return new LinkCompletionResult(true, null);
        }

        var hostName = reader.GetString(0);
        var protocolVersion = reader.GetString(1);
        var subject = reader.GetString(2);
        var displayName = reader.IsDBNull(3) ? subject : reader.GetString(3);
        await reader.DisposeAsync();

        var token = CryptoToken.Create("host_", 48);
        await using var upsert = connection.CreateCommand();
        upsert.Transaction = (SqliteTransaction)transaction;
        upsert.CommandText =
            """
            INSERT INTO hosts (
                id, owner_subject, name, protocol_version, token_hash,
                credential_version, linked_at, revoked_at
            ) VALUES (
                $id, $owner_subject, $name, $protocol_version, $token_hash,
                1, $linked_at, NULL
            )
            ON CONFLICT(id) DO UPDATE SET
                owner_subject = excluded.owner_subject,
                name = excluded.name,
                protocol_version = excluded.protocol_version,
                token_hash = excluded.token_hash,
                credential_version = hosts.credential_version + 1,
                linked_at = excluded.linked_at,
                revoked_at = NULL
            """;
        upsert.Parameters.AddWithValue("$id", hostId);
        upsert.Parameters.AddWithValue("$owner_subject", subject);
        upsert.Parameters.AddWithValue("$name", hostName);
        upsert.Parameters.AddWithValue("$protocol_version", protocolVersion);
        upsert.Parameters.AddWithValue("$token_hash", CryptoToken.Hash(token));
        upsert.Parameters.AddWithValue("$linked_at", DateTimeOffset.UtcNow.ToString("O"));
        await upsert.ExecuteNonQueryAsync(cancellationToken);

        await using var complete = connection.CreateCommand();
        complete.Transaction = (SqliteTransaction)transaction;
        complete.CommandText =
            "UPDATE link_challenges SET completed_at = $now WHERE code_hash = $code_hash";
        complete.Parameters.AddWithValue("$now", DateTimeOffset.UtcNow.ToString("O"));
        complete.Parameters.AddWithValue("$code_hash", CryptoToken.Hash(code));
        await complete.ExecuteNonQueryAsync(cancellationToken);
        await transaction.CommitAsync(cancellationToken);
        return new LinkCompletionResult(
            true,
            new CompleteLinkChallengeResponse(hostId, token, subject, displayName));
    }

    public async Task<HostIdentity?> AuthenticateHostAsync(
        string token,
        CancellationToken cancellationToken)
    {
        await using var connection = await OpenAsync(cancellationToken);
        await using var command = connection.CreateCommand();
        command.CommandText =
            """
            SELECT id, owner_subject, name, protocol_version
            FROM hosts
            WHERE token_hash = $token_hash AND revoked_at IS NULL
            """;
        command.Parameters.AddWithValue("$token_hash", CryptoToken.Hash(token));
        await using var reader = await command.ExecuteReaderAsync(cancellationToken);
        return await reader.ReadAsync(cancellationToken)
            ? new HostIdentity(reader.GetString(0), reader.GetString(1), reader.GetString(2), reader.GetString(3))
            : null;
    }

    public async Task<IReadOnlyList<RemoteHostView>> ListHostsAsync(
        string subject,
        CancellationToken cancellationToken)
    {
        var hosts = new List<RemoteHostView>();
        await using var connection = await OpenAsync(cancellationToken);
        await using var command = connection.CreateCommand();
        command.CommandText =
            """
            SELECT id, name, protocol_version, linked_at
            FROM hosts
            WHERE owner_subject = $subject AND revoked_at IS NULL
            ORDER BY name COLLATE NOCASE, id
            """;
        command.Parameters.AddWithValue("$subject", subject);
        await using var reader = await command.ExecuteReaderAsync(cancellationToken);
        while (await reader.ReadAsync(cancellationToken))
        {
            hosts.Add(new RemoteHostView(
                reader.GetString(0),
                reader.GetString(1),
                reader.GetString(2),
                DateTimeOffset.Parse(reader.GetString(3)),
                false));
        }
        return hosts;
    }

    public async Task<bool> UserOwnsHostAsync(
        string subject,
        string hostId,
        CancellationToken cancellationToken)
    {
        await using var connection = await OpenAsync(cancellationToken);
        await using var command = connection.CreateCommand();
        command.CommandText =
            """
            SELECT EXISTS(
                SELECT 1 FROM hosts
                WHERE id = $host_id AND owner_subject = $subject AND revoked_at IS NULL
            )
            """;
        command.Parameters.AddWithValue("$host_id", hostId);
        command.Parameters.AddWithValue("$subject", subject);
        return Convert.ToInt32(await command.ExecuteScalarAsync(cancellationToken)) == 1;
    }

    public async Task<bool> RevokeHostAsync(
        string subject,
        string hostId,
        CancellationToken cancellationToken)
    {
        await using var connection = await OpenAsync(cancellationToken);
        await using var command = connection.CreateCommand();
        command.CommandText =
            """
            UPDATE hosts
            SET revoked_at = $now
            WHERE id = $host_id AND owner_subject = $subject AND revoked_at IS NULL
            """;
        command.Parameters.AddWithValue("$now", DateTimeOffset.UtcNow.ToString("O"));
        command.Parameters.AddWithValue("$host_id", hostId);
        command.Parameters.AddWithValue("$subject", subject);
        return await command.ExecuteNonQueryAsync(cancellationToken) == 1;
    }

    private async Task<SqliteConnection> OpenAsync(CancellationToken cancellationToken)
    {
        var connection = new SqliteConnection(connectionString);
        await connection.OpenAsync(cancellationToken);
        return connection;
    }
}

internal static class CryptoToken
{
    public static string Create(string prefix, int byteLength) =>
        prefix + Base64UrlEncode(RandomNumberGenerator.GetBytes(byteLength));

    public static string Hash(string value) =>
        Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(value))).ToLowerInvariant();

    private static string Base64UrlEncode(byte[] value) =>
        Convert.ToBase64String(value).TrimEnd('=').Replace('+', '-').Replace('/', '_');
}
