using System;
using System.Collections.Generic;
using System.Linq;
using System.Security.Claims;
using System.Threading.Tasks;
using MediaBrowser.Controller.Library;
using Microsoft.AspNetCore.Authentication;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Http.Extensions;
using Microsoft.AspNetCore.Mvc;
using Microsoft.AspNetCore.Mvc.Controllers;
using Microsoft.AspNetCore.Mvc.Filters;
using Microsoft.Extensions.DependencyInjection;

namespace Jellyfin.Plugin.JMSFusion.Core
{
    /// <summary>
    /// Requires a valid Jellyfin login for the plugin's API and pins the request to the logged-in user.
    /// The controllers identify the caller from the X-Emby-UserId header (and some from a userId query
    /// value), so those are overwritten with the authenticated user before the action runs.
    /// </summary>
    public sealed class PluginAuthFilter : IAsyncAuthorizationFilter
    {
        private const string AuthenticationScheme = "CustomAuthentication";
        private const string UserIdClaim = "Jellyfin-UserId";
        private const string AdministratorRole = "Administrator";

        private static readonly string[] UserIdHeaders = { "X-Emby-UserId", "X-MediaBrowser-UserId" };
        private static readonly string[] UserNameHeaders = { "X-JMSFusion-UserName", "X-Emby-UserName" };

        // Served to the browser before login, or loaded by <img>/<video>/<script> tags that can't send a token.
        private static readonly HashSet<string> AnonymousControllers = new(StringComparer.OrdinalIgnoreCase)
        {
            "SliderAssets",
            "JMSFusionAssets",
            "JMSFusionRuntime",
            "Ping"
        };

        private static readonly HashSet<string> AnonymousActions = new(StringComparer.OrdinalIgnoreCase)
        {
            "StudioHubs.GetLogo",
            "StudioHubs.GetVideo",
            "UserSettings.Get"
        };

        // Server-wide settings and maintenance.
        private static readonly HashSet<string> AdminControllers = new(StringComparer.OrdinalIgnoreCase)
        {
            "JMSFusionApi"
        };

        private static readonly HashSet<string> AdminActions = new(StringComparer.OrdinalIgnoreCase)
        {
            "Config.Update",
            "UserSettings.Publish",
            "Lyrics.Run",
            "Lyrics.Cancel",
            "Trailers.Diag"
        };

        public static bool IsAdmin(ClaimsPrincipal? user) => user?.IsInRole(AdministratorRole) == true;

        public async Task OnAuthorizationAsync(AuthorizationFilterContext context)
        {
            if (context.ActionDescriptor is not ControllerActionDescriptor action ||
                action.ControllerTypeInfo.Assembly != typeof(PluginAuthFilter).Assembly)
            {
                return;
            }

            var key = action.ControllerName + "." + action.ActionName;
            if (AnonymousControllers.Contains(action.ControllerName) || AnonymousActions.Contains(key))
            {
                return;
            }

            var http = context.HttpContext;
            var result = await http.AuthenticateAsync(AuthenticationScheme).ConfigureAwait(false);
            if (!result.Succeeded || result.Principal is null)
            {
                context.Result = new ObjectResult(new { ok = false, error = "Sign in to Jellyfin to use this." }) { StatusCode = StatusCodes.Status401Unauthorized };
                return;
            }

            var principal = result.Principal;
            http.User = principal;
            var isAdmin = IsAdmin(principal);

            if (!isAdmin && (AdminControllers.Contains(action.ControllerName) || AdminActions.Contains(key)))
            {
                context.Result = new ObjectResult(new { ok = false, error = "This action is only available to administrators." }) { StatusCode = StatusCodes.Status403Forbidden };
                return;
            }

            // API keys have no user; they are admin-level and may name any user.
            var claimUserId = principal.FindFirst(UserIdClaim)?.Value;
            if (!Guid.TryParse(claimUserId, out var userId) || userId == Guid.Empty)
            {
                return;
            }

            PinRequestToUser(http, userId, isAdmin);
        }

        private static void PinRequestToUser(HttpContext http, Guid userId, bool isAdmin)
        {
            var id = userId.ToString("N");
            var headers = http.Request.Headers;
            foreach (var header in UserIdHeaders)
            {
                headers[header] = id;
            }

            var user = http.RequestServices.GetService<IUserManager>()?.GetUserById(userId);
            foreach (var header in UserNameHeaders)
            {
                if (user is not null)
                {
                    headers[header] = user.Username;
                }
                else
                {
                    headers.Remove(header);
                }
            }

            if (isAdmin)
            {
                return;
            }

            var query = http.Request.Query;
            if (!query.Keys.Any(k => string.Equals(k, "userId", StringComparison.OrdinalIgnoreCase)))
            {
                return;
            }

            var builder = new QueryBuilder();
            foreach (var pair in query)
            {
                if (string.Equals(pair.Key, "userId", StringComparison.OrdinalIgnoreCase))
                {
                    builder.Add(pair.Key, id);
                    continue;
                }

                foreach (var value in pair.Value)
                {
                    builder.Add(pair.Key, value ?? string.Empty);
                }
            }

            http.Request.QueryString = builder.ToQueryString();
        }
    }
}
