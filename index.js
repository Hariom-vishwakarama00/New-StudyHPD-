// Old address -> new address. Permanent (301) redirect keeping path and query.
export default {
  fetch(request) {
    const url = new URL(request.url);
    url.protocol = "https:";
    url.hostname = "www.studyhpd.workers.dev";
    url.port = "";
    return new Response(null, { status: 301, headers: { Location: url.toString(), "Cache-Control": "public, max-age=86400" } });
  },
};
