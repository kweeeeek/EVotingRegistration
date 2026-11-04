# Putting the Registration web page on a web host

For the administrator. About 30 minutes the first time. You need: a web address with https for the page, a place to put files on that address, and the address of the
eVoting API (`https://api.eballotsacdeco.site`).

What was run for real and what was not:

| | |
|---|---|
| **Run for real** (nginx 1.24 in the test environment, in front of a stand-in API, with Chromium) | the nginx example in section 3, `tools/check-site.mjs`, `tools/set-api-url.mjs`, `tools/check-bundle.mjs` |
| **Written, not run** | the IIS example in section 4 (no IIS in the test environment), the notes on other hosts in section 5 |
| **Not possible in the test environment** | your real host, your real certificate, the real API server and its database, a real receipt printer |

So whatever host you use, finish with section 7 (`check-site`) and the rehearsal rows TW-01 to TW-12 in `../docs/08-DEPLOYMENT-AND-MANUAL-TESTS.md` §14.

---

## 1. Decide where the API is, as the browser sees it

The page only ever talks to **one** address, the one named in `config.js` (`apiBaseUrl`) and in its Content-Security-Policy. There are two ways to arrange it:

| | **A. Same address (recommended)** | **B. The API at its own address** |
|---|---|---|
| `apiBaseUrl` | `""` | `"https://api.eballotsacdeco.site"` (the default in the ZIP) |
| How | The web server forwards everything under `/api/` to `https://api.eballotsacdeco.site/api/` (a *reverse proxy*). The browser sees one site. | The page is plain files; the browser calls the API directly. |
| API server | no change | must list the page's address in `EVOTING_ALLOWED_ORIGINS` (section 6) |
| Speed | One request, one answer. | The browser first sends a **pre-flight** (`OPTIONS`) request to the API and waits for it, because the call carries an `Authorization` header and the API does not tell the browser to remember the answer (no `Access-Control-Max-Age`). That is one extra round trip to the API for each search and each *Issue QR*. |
| Web host needs | a web server that can proxy: nginx, IIS with ARR, Apache | any host that serves files over https: also Netlify, Cloudflare Pages, GitHub Pages |
| If the API's address ever changes | change the proxy line; the PCs do not notice | run `set-api-url` again and upload `config.js`, `index.html` and `_headers` |

The pre-flight is how browsers work (the Fetch standard), not something measured on your network: the sandbox cannot measure your real round-trip time. If you can run a proxy, use A.

## 2. Step by step

1. **Choose the address** of the page (for example `https://registration.example.org`) and get a certificate for it (section 8). Sign-in passwords travel to this address: it must be https.
2. **Point the folder at the API**, on the PC where you unpacked the ZIP (needs Node.js 22 or newer, from nodejs.org; the web host needs nothing):

   ```bash
   cd EVoting.Registration.Web
   node tools/set-api-url.mjs ""                                  # option A
   node tools/set-api-url.mjs https://api.eballotsacdeco.site     # option B
   node tools/check-bundle.mjs                                    # must say: OK - the folder is ready to upload
   ```

   `set-api-url` changes `apiBaseUrl` in `config.js` **and** the `connect-src` of the Content-Security-Policy in `index.html` and `_headers` - three places that must name the same
   address, because a page may only talk to the addresses its policy lists. Never edit those by hand.
3. **Upload exactly** `index.html`, `config.js`, `_headers`, `favicon.svg` and the folders `css/`, `js/`, `vendor/`. Not `tests/`, `tools/`, `docs/`, `node_modules/`, `package*.json`.
   (`_headers` is read by Netlify and Cloudflare Pages only; on nginx or IIS it does nothing, and it is harmless there.)
4. **Configure the host**: the headers of section 6 and, for option A, the proxy. Use the nginx example (section 3) or the IIS example (section 4) as the starting point.
5. **Check it from outside** - section 7. Do not skip this: it finds the mistakes people really make (a script served with the wrong type, a header that nginx silently dropped, a proxy that points nowhere).
6. **Try it** with a real user: sign in, search, issue a QR, see the slip. Then the rehearsal rows TW-01 to TW-12.
7. **Set up the desk PCs**: the receipt printer as the Windows default printer, and Chrome or Edge started with `--kiosk-printing` (see `README.md`, *Printing the slip*).

## 3. nginx - the example that was run

Save it as `/etc/nginx/conf.d/evoting-registration.conf`, change the lines marked `CHANGE`, put the files in the folder named by `root`, then `sudo nginx -t && sudo systemctl reload nginx`.

```nginx
# E-Voting Registration (web) behind nginx, with the page and the API on ONE address (apiBaseUrl is "").
# Copy this file to /etc/nginx/conf.d/evoting-registration.conf and change what says CHANGE.
# Checked with nginx 1.24 by tests/deploy/check-nginx.mjs; docs/WEB-DEPLOY.md explains each part.
#
# * Every header is set at the server level only. nginx drops ALL inherited add_header lines inside a location that has an add_header of
#   its own, so never add one inside a location. Caching is set with "expires" for that reason.
# * "expires -1" sends "Cache-Control: no-cache": the page and its scripts are re-checked at every load, so an update is picked up at once.
# * The search text travels in the address of the request (.../members/search?query=...). nginx's usual log line contains the whole address, so
#   this file logs the path only: what the clerks looked for does not end up in this server's log.

log_format evoting '$remote_addr [$time_local] "$request_method $uri" $status $body_bytes_sent $request_time';

server {
    listen 80;
    server_name registration.example.org;                                  # CHANGE: the address of this page
    return 301 https://$host$request_uri;
}

server {
    listen 443 ssl;                                                        # nginx older than 1.25.1: write "listen 443 ssl http2;"
    server_name registration.example.org;                                  # CHANGE: the address of this page

    ssl_certificate     /etc/ssl/registration.example.org/fullchain.pem;   # CHANGE
    ssl_certificate_key /etc/ssl/registration.example.org/privkey.pem;     # CHANGE
    ssl_protocols       TLSv1.2 TLSv1.3;

    root  /var/www/evoting-registration;                                   # CHANGE: the folder the files were uploaded to
    index index.html;

    access_log /var/log/nginx/evoting-registration.access.log evoting;

    add_header Content-Security-Policy "default-src 'none'; script-src 'self'; style-src 'self'; font-src 'self'; img-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'none'; object-src 'none'; frame-ancestors 'none'; require-trusted-types-for 'script'; trusted-types 'none'" always;
    add_header X-Content-Type-Options "nosniff" always;
    add_header X-Frame-Options "DENY" always;
    add_header Referrer-Policy "no-referrer" always;
    add_header Permissions-Policy "camera=(), microphone=(), geolocation=(), payment=(), usb=(), serial=()" always;
    add_header Cross-Origin-Opener-Policy "same-origin" always;
    add_header Cross-Origin-Resource-Policy "same-origin" always;

    expires -1;
    gzip on;
    gzip_types text/css text/javascript application/javascript image/svg+xml;   # nginx 1.24 types scripts as application/javascript, 1.26 and later as text/javascript

    location / {
        try_files $uri $uri/ =404;
    }

    # The API, on this same address: the page asks for /api/v1/..., the browser sees one site, so there is no CORS and no pre-flight.
    location /api/ {
        resolver 1.1.1.1 8.8.8.8 valid=60s;                                # CHANGE if these DNS servers cannot be reached from this server (add ipv6=off if it has no IPv6 route)
        set $evoting_api "https://api.eballotsacdeco.site";
        proxy_pass $evoting_api;
        proxy_ssl_server_name on;
        proxy_ssl_verify on;                                               # nginx does not check who answers unless told to; the sign-in password passes through here
        proxy_ssl_verify_depth 3;
        proxy_ssl_trusted_certificate /etc/ssl/certs/ca-certificates.crt;  # CHANGE: the Debian/Ubuntu path. Red Hat family: /etc/pki/tls/certs/ca-bundle.crt
        proxy_set_header Host api.eballotsacdeco.site;
        proxy_set_header X-Forwarded-For $remote_addr;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_connect_timeout 5s;
        proxy_read_timeout 30s;
    }
}
```

`tests/deploy/check-nginx.mjs` (`npm run test:deploy`) takes this very file, changes only the addresses and paths, starts a real nginx 1.24 with it in front of a stand-in API, and checks:
`tools/check-site.mjs` finds nothing to fix; http is sent to https; error pages carry the security headers; the page, its scripts and its style sheet are `no-cache`; scripts are compressed;
`/api/` reaches the server with the path unchanged; and Chromium can sign in, search, issue a QR and print a slip through it, without a single policy violation, error or warning.
It also checks the opposite: after putting an `add_header` inside a `location` (the mistake below), `check-site` complains.

**What each part does**

* `return 301 https://$host$request_uri;` - anybody who types `http://` lands on https.
* `add_header ... always;` - the security headers (section 6). `always` makes them appear on error pages too.
* `expires -1;` sends `Cache-Control: no-cache`: the browser asks at every load whether the page changed (a cheap *304* when it did not). Nothing is kept for a year: the page has no font to keep (it is set in Segoe UI, which every Windows PC already has), and a new design must reach every desk at the next load.
* `gzip` - the scripts and styles travel compressed.
* `location /api/` - the reverse proxy for option A. Delete this block for option B.
  * `set $evoting_api ...; proxy_pass $evoting_api;` with a `resolver` line: nginx then looks the API's name up again every 60 seconds instead of once at start-up - the API runs on a
    hosting platform whose IP addresses can change, and a name looked up once could one day point nowhere. Without a variable, `proxy_pass https://api.eballotsacdeco.site;` would also work, but it
    freezes the address until the next reload. Change the `resolver` addresses if this server cannot reach 1.1.1.1 / 8.8.8.8 (use the DNS servers of the network).
  * `proxy_pass $evoting_api;` has **no path** after the address: the request goes on with its path unchanged (`/api/v1/...`). Adding a path, even `/`, would strip `/api/`.
  * `proxy_ssl_server_name on;` sends the API's name during the TLS handshake. Platforms that host many sites on few addresses need it to pick the right certificate; nginx does not send it by default.
  * `proxy_set_header Host api.eballotsacdeco.site;` - the platform routes by this name.
* **The one mistake to avoid:** nginx **drops every inherited `add_header`** inside a `location` that has an `add_header` of its own. Put one in `location /` "just for caching" and the page loses its Content-Security-Policy
  without any warning. That is why every header is at server level and caching uses `expires`. If you must add a header to a location, repeat all of them there.
  `check-site` catches this (the example test proves it does).
* nginx 1.25.1 and newer: `listen 443 ssl;` and a separate line `http2 on;`; the `listen 443 ssl http2;` form still works with a deprecation warning.

## 4. IIS - written from the documentation, not run

`docs/samples/web.config` goes in the site's root folder. It needs two add-ons from Microsoft (free): **URL Rewrite** and **Application Request Routing (ARR)**. After installing ARR:
IIS Manager > the server (top node) > *Application Request Routing Cache* > *Server Proxy Settings* > tick **Enable proxy** > Apply.

```xml
<?xml version="1.0" encoding="utf-8"?>
<!--
  E-Voting Registration (web) on IIS, with the page and the API on ONE address (apiBaseUrl is "").
  Put this file in the root folder of the site, next to index.html.

  NOT RUN by the authors: there was no IIS in the test environment. It is written from Microsoft's documentation. The header values
  are checked against _headers by a unit test, nothing else is. After installing it, run
      node tools/check-site.mjs https://your-address
  and fix what it reports (docs/WEB-DEPLOY.md, section 4).

  Needs the IIS modules "URL Rewrite" and "Application Request Routing" (ARR), and in ARR: Server Proxy Settings > Enable proxy.
-->
<configuration>
  <system.webServer>

    <rewrite>
      <rules>
        <rule name="http to https" stopProcessing="true">
          <match url="(.*)" />
          <conditions>
            <add input="{HTTPS}" pattern="^OFF$" />
          </conditions>
          <action type="Redirect" url="https://{HTTP_HOST}/{R:1}" redirectType="Permanent" />
        </rule>
        <!-- The API, on this same address: the page asks for /api/v1/..., the browser sees one site, so there is no CORS and no pre-flight. -->
        <rule name="API on this address" stopProcessing="true">
          <match url="^api/(.*)$" />
          <action type="Rewrite" url="https://api.eballotsacdeco.site/api/{R:1}" />
        </rule>
      </rules>
    </rewrite>

    <staticContent>
      <!-- "Cache-Control: no-cache": the page and its scripts are re-checked at every load, so an update is picked up at once. -->
      <clientCache cacheControlMode="DisableCache" />
    </staticContent>

    <httpProtocol>
      <customHeaders>
        <remove name="X-Powered-By" />
        <add name="Content-Security-Policy" value="default-src 'none'; script-src 'self'; style-src 'self'; font-src 'self'; img-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'none'; object-src 'none'; frame-ancestors 'none'; require-trusted-types-for 'script'; trusted-types 'none'" />
        <add name="X-Content-Type-Options" value="nosniff" />
        <add name="X-Frame-Options" value="DENY" />
        <add name="Referrer-Policy" value="no-referrer" />
        <add name="Permissions-Policy" value="camera=(), microphone=(), geolocation=(), payment=(), usb=(), serial=()" />
        <add name="Cross-Origin-Opener-Policy" value="same-origin" />
        <add name="Cross-Origin-Resource-Policy" value="same-origin" />
      </customHeaders>
    </httpProtocol>

  </system.webServer>
</configuration>
```

Things to watch (none of this could be tried here):

* The example only has the headers' **values** checked (a unit test compares them with `_headers`); the rest is from documentation. Run `check-site` and believe it, not this page.
* If `/api/v1/health/live` answers *404* or an error page from the hosting platform, ARR is probably sending the wrong `Host` name: the platform needs `api.eballotsacdeco.site`, not the name of your page.
  ARR's `<proxy>` element has a `preserveHostHeader` setting; it must be `false` (from the documentation: that is its default).
* *502* from `/api/` usually means the proxy is not enabled (step above) or the server cannot reach the internet.
* To stay on option B with IIS, delete the rule *API on this address* and use `node tools/set-api-url.mjs https://api.eballotsacdeco.site`; also change `connect-src 'self'` in the header to the same
  value as in `_headers` (the unit test and `check-site` tell you when they differ).

## 5. Other hosts

* **Netlify, Cloudflare Pages:** they read `_headers` as it is, so the headers are covered. Use option B (set the page's address in `EVOTING_ALLOWED_ORIGINS`). Netlify can also forward `/api/*`
  with a `200` rewrite rule in `_redirects` (`/api/*  https://api.eballotsacdeco.site/api/:splat  200`), which would give option A; this was not tried. Do not let the host "optimise" the files
  (minify, rewrite, inject scripts): `check-site` compares every file byte for byte and reports it.
* **Apache:** `mod_headers` (`Header always set Content-Security-Policy "..."` for each header of section 6), `mod_ssl`, and for option A `mod_proxy` + `mod_proxy_http`:
  `SSLProxyEngine on`, `ProxyPass /api/ https://api.eballotsacdeco.site/api/`, `ProxyPassReverse /api/ https://api.eballotsacdeco.site/api/`. Not tried.
* **Hosts that cannot set headers at all** (some shared hosting, GitHub Pages): the page still carries its policy in a `<meta>` tag, which the browser enforces for everything **except** `frame-ancestors`,
  so the page could be shown inside another site's frame (clickjacking). Prefer a host that can send headers. `check-site` reports every missing header.

## 6. The headers, and the API's list of allowed pages

| Header | Meaning | If it is missing |
|---|---|---|
| `Content-Security-Policy` | The page may load only its own files, run only its own scripts (no inline script), talk only to the address in `connect-src`, and put nothing on the page as markup (Trusted Types). It cannot be shown in a frame, post a form or load a plug-in. | The `<meta>` copy in `index.html` still enforces all of it except `frame-ancestors`. |
| `X-Content-Type-Options: nosniff` | The browser must trust the file type the server sends and never guess. | A server that sends a wrong type could have a file treated as a script. |
| `X-Frame-Options: DENY` | The page cannot be shown inside another page (older browsers; the policy's `frame-ancestors` does the same). | See the policy. |
| `Referrer-Policy: no-referrer` | The browser tells nobody which page a request came from. | The page already sends requests with no referrer; this is the second lock. |
| `Permissions-Policy` | The page cannot ask for the camera, microphone, location, payment, USB or serial ports. | The page never asks. |
| `Cross-Origin-Opener-Policy`, `Cross-Origin-Resource-Policy: same-origin` | Other sites cannot hold a handle on the window, or embed its files. | Defence in depth only. |
| `Cache-Control: no-cache` | A changed page is picked up at the next load. | A changed page may be shown stale until the browser's own timer runs out. |

`Strict-Transport-Security` is left out on purpose: once a browser has seen it, it refuses http for that name for the whole period, which is wrong if https is later given up or the name is reused. Once
https is permanent, `Strict-Transport-Security: max-age=31536000` is a good addition.

**Option B only - the API must allow the page.** On the server (Railway > the API service > *Variables*) set

```
EVOTING_ALLOWED_ORIGINS=https://registration.example.org
```

Several pages are separated by a comma, with **no spaces**, each exactly as the browser writes it: `https://`, the name, the port only if it is not 443, **no trailing slash**
(`https://registration.example.org/` does not match). The API restarts to read it. While the variable is empty the API accepts every origin without cookies - that also works for this page, because the page sends
no cookies and the API only trusts the bearer token; a list is the tidier setting. The Windows programs are not browsers and are unaffected either way. Setting the variable is a setting of the existing API, not a change of its code.

## 7. Check it from outside

```bash
node tools/check-site.mjs https://registration.example.org
node tools/check-site.mjs https://registration.example.org --dir ./the-folder-you-uploaded
node tools/check-site.mjs https://test-host.example.org --insecure       # a test host whose certificate is not trusted
```

It reads only; it sends no sign-in. It checks that every uploaded file is there, has the same content and the right type; that the page comes with the headers of `_headers` (and the same Content-Security-Policy
directive by directive); that http goes to https; and that the API can be reached the way `config.js` says (option A: `/api/v1/health/live` answers through this address; option B: the API answers and its
pre-flight lists this page). Exit code 0 = fine, 1 = something to fix (each line says what and where), 2 = wrong use.

Run it after every upload, and again whenever the host's configuration, the certificate or the API's address changes.

## 8. Certificates and the PCs

* A page on the internet: a free certificate from Let's Encrypt (`certbot --nginx`) renews itself; nothing needs to be installed on the PCs.
* A page on the office network only (name that only resolves inside): use the organisation's own certificate authority and install its root certificate on every desk PC (Windows: *certmgr.msc* >
  Trusted Root Certification Authorities), otherwise the browser shows a warning page and the clerks click through it - which defeats the point. A self-signed certificate on one server is the same trouble.
* The clock of each PC must be right: a PC whose date is wrong rejects every certificate.
* If the desk PCs go through a company proxy that inspects https, its certificate must be trusted too.

## 9. Updating the page

Upload the new files over the old ones, run `check-site`. The page and scripts are `no-cache`, so the desk PCs use the new version the next time the page is loaded (reload, or reopen). A clerk who is
in the middle of a session keeps the old version until the page is reloaded - and reloading signs out (the sign-in is kept in memory only) and loses the list of this session's records. Update between
sessions. Keep the previous folder until the new one is proven: going back is uploading it again.

After an update of the ZIP, run `set-api-url` again - the ZIP ships with option B's address.

## 10. When something does not work

What the desk shows, what it means, what to do.

| On the screen | Meaning | What to do |
|---|---|---|
| White page, nothing happens | A script was not run: wrong type from the host, or blocked. The browser console (F12) says *Refused to execute script ... MIME type* or *Refused to ... Content Security Policy*. | `check-site`: it names the file and the type. Fix the host's MIME table. |
| Page without its look | `css/` not uploaded, or `.css` not in the host's MIME table. | `check-site`. |
| Letters that are not Segoe UI | The PC is not a Windows PC (Segoe UI is Windows' own font; a Mac, phone or Linux PC shows its own system font instead). Nothing to fix: the page works the same. | - |
| *The server could not be reached. Check the internet connection of this PC.* | No answer from the server at all: PC offline, DNS, firewall, or (option A) the proxy does not answer at all. | Open `https://api.eballotsacdeco.site/api/v1/health/live` in the browser of that PC: a short answer instead of an error page means that PC is fine. |
| *The server could not complete the request (HTTP 502)* or *504* | Option A: the web server cannot reach the API (DNS `resolver`, firewall, API down). | On the web server: `curl -I https://api.eballotsacdeco.site/api/v1/health/live`. nginx: `/var/log/nginx/error.log`. |
| *...the browser blocked the connection (CORS): the server does not list this site...* | Option B: `EVOTING_ALLOWED_ORIGINS` does not contain the page's address exactly (section 6). | Fix the variable (no space, no trailing slash, `https://`); the API restarts to read it. |
| *This page's security policy (Content-Security-Policy) does not allow connecting to the server address.* | `connect-src` of the policy that the browser got is not the address in `config.js`: `set-api-url` was run but a file was not uploaded, or the host still sends the old header. | Run `set-api-url`, upload `config.js`, `index.html`, `_headers`; update the host's header; `check-site` says which directive differs. |
| *The server did not recognise the current-election address. Check the server address and version.* | The address answered *404* but not as the eVoting API (a different server, or a proxy that changed the path). | Option A: `proxy_pass` must not have a path after the address. Option B: the address in `config.js`. |
| *Wrong user name or password.* | The server refused the sign-in. | The same user and password as for the admin program; ask the administrator. |
| *Too many sign-in attempts right now. Wait about a minute, then try again.* | All interactive sign-ins (every desk and the admin program) share **10 per minute** on the server. | Stagger the desks' start by a minute, or raise `RateLimit__AdminLoginPerMinute` on the API server (Railway variable; needs a restart). |
| The pill says *Online - server problem* | The server answered, but with an error (HTTP 5xx). | The API's logs. The desk keeps trying; nothing is issued while it is down. |
| The slip prints with the page's title and address, or the QR is cut off | Printer settings, not the page. | `README.md`, *Printing the slip*. |
| The sign-in screen appears again by itself | The screen locks after 10 idle minutes, shortly before the 8-hour sign-in expires, and whenever the server refuses the sign-in. | Type the password again; the records of the session are kept. |

If the cause is not on this list: F12 > *Console* and *Network*. A request that shows nothing in *Network* never left the PC (a blocked address); a red request with status *(blocked)* or a CORS
message is the policy or the API's list; a status number is the server's own answer.

## 11. What the examples prove and do not prove

The nginx example was run on nginx 1.24 (Ubuntu) with the stand-in API, a self-signed certificate and Chromium 153. That proves the file is syntactically right, does what section 3 says, and
that the page works behind it with no policy violation. It does not prove: your nginx version's differences (the file has comments where known ones matter), your real certificate and DNS, the real API
behind the proxy (its real answers, its real rate limit, its real latency), or any browser but Chromium. The IIS example proves nothing beyond its header values. Hence section 7, and the rows
TW-01 to TW-12.
