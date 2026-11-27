// DA Logbook: this address cannot serve the app (Supabase delivers HTML from Edge Functions as plain text
// unless the project has a custom domain). The app itself is a static site hosted elsewhere.
// Set NEW_URL to that address and this function forwards old links to it.
const NEW_URL = "https://zanmander.github.io/da-logbook/";
Deno.serve((_req: Request) => {
  if (NEW_URL) return new Response(null, { status: 302, headers: { Location: NEW_URL } });
  return new Response("DA Logbook is not served from this address. Ask the owner for the current link.\n", {
    status: 200,
    headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" },
  });
});
