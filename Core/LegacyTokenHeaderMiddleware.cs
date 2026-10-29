using System;
using System.Linq;
using System.Text.RegularExpressions;
using System.Threading.Tasks;
using Microsoft.AspNetCore.Http;

namespace Jellyfin.Plugin.JMSFusion.Core
{
    /// <summary>
    /// Jellyfin 12 no longer accepts the legacy X-Emby-Token header. The plugin's scripts still send it,
    /// so for the plugin's own API paths copy it into the Authorization header Jellyfin reads.
    /// Runs before Jellyfin's authentication, and only when no Authorization header is present.
    /// </summary>
    public sealed class LegacyTokenHeaderMiddleware
    {
        private static readonly Regex TokenPattern = new("^[A-Za-z0-9._-]{8,256}$", RegexOptions.Compiled);

        private readonly RequestDelegate _next;

        public LegacyTokenHeaderMiddleware(RequestDelegate next)
        {
            _next = next;
        }

        public Task InvokeAsync(HttpContext ctx)
        {
            if (IsPluginPath(ctx.Request.Path) && string.IsNullOrEmpty(ctx.Request.Headers.Authorization))
            {
                var token =
                    ctx.Request.Headers["X-Emby-Token"].FirstOrDefault() ??
                    ctx.Request.Headers["X-MediaBrowser-Token"].FirstOrDefault();

                if (!string.IsNullOrWhiteSpace(token) && TokenPattern.IsMatch(token.Trim()))
                {
                    ctx.Request.Headers.Authorization = $"MediaBrowser Token=\"{token.Trim()}\"";
                }
            }

            return _next(ctx);
        }

        // This runs before Jellyfin strips its base URL, so match the plugin segment anywhere in the path.
        private static bool IsPluginPath(PathString path)
        {
            var value = path.Value ?? string.Empty;
            return value.Contains("/JMSFusion", StringComparison.OrdinalIgnoreCase) ||
                   value.Contains("/MonWUI", StringComparison.OrdinalIgnoreCase);
        }
    }
}
