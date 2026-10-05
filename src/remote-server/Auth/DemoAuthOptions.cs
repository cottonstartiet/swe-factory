using System.ComponentModel.DataAnnotations;

namespace SweFactory.Remote.Server.Auth;

public sealed class DemoAuthOptions
{
    public const string SectionName = "DemoAuth";

    [Required]
    public string UserName { get; init; } = "";

    [Required]
    public string PasswordSha256 { get; init; } = "";

    [Required]
    public string Subject { get; init; } = "";

    [Required]
    public string DisplayName { get; init; } = "";
}
