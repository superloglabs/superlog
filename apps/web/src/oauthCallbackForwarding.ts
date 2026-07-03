type LocationLike = Pick<Location, "pathname" | "search">;

export function externalOAuthCallbackForwardUrl(
  location: LocationLike,
  apiUrl: string,
): string | null {
  if (location.pathname !== "/vercel/oauth/callback") return null;
  return `${apiUrl.replace(/\/+$/, "")}/vercel/oauth/callback${location.search}`;
}
