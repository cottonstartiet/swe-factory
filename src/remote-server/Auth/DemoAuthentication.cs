using System.Security.Claims;
using System.Security.Cryptography;
using System.Text;
using Microsoft.AspNetCore.Authentication;
using Microsoft.AspNetCore.Authentication.Cookies;
using Microsoft.Extensions.Options;
using SweFactory.Remote.Server.Models;

namespace SweFactory.Remote.Server.Auth;

public static class DemoAuthentication
{
    public static bool Validate(DemoLoginRequest request, DemoAuthOptions options)
    {
        var userMatches = FixedTimeEquals(request.UserName, options.UserName);
        var suppliedHash = Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(request.Password)))
            .ToLowerInvariant();
        var passwordMatches = FixedTimeEquals(suppliedHash, options.PasswordSha256.ToLowerInvariant());
        return userMatches && passwordMatches;
    }

    public static Task SignInAsync(HttpContext context, DemoAuthOptions options)
    {
        var claims = new[]
        {
            new Claim(ClaimTypes.NameIdentifier, options.Subject),
            new Claim(ClaimTypes.Name, options.DisplayName)
        };
        var principal = new ClaimsPrincipal(
            new ClaimsIdentity(claims, CookieAuthenticationDefaults.AuthenticationScheme));
        return context.SignInAsync(
            CookieAuthenticationDefaults.AuthenticationScheme,
            principal,
            new AuthenticationProperties
            {
                AllowRefresh = false,
                IsPersistent = false,
                ExpiresUtc = DateTimeOffset.UtcNow.AddHours(8)
            });
    }

    private static bool FixedTimeEquals(string left, string right)
    {
        var leftBytes = Encoding.UTF8.GetBytes(left);
        var rightBytes = Encoding.UTF8.GetBytes(right);
        return leftBytes.Length == rightBytes.Length
            && CryptographicOperations.FixedTimeEquals(leftBytes, rightBytes);
    }
}
